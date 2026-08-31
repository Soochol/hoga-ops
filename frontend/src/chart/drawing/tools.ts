// frontend/src/chart/drawing/tools.ts
//
// Drawing Tool Spec — the deepened module that owns per-tool pointer
// interaction for the Drawing Overlay (CONTEXT.md).
//
// Background. The original DrawingOverlay had ~170 lines of activeTool
// switching split across onPointerDown / onPointerMove / onPointerUp.
// Each tool's behaviour was scattered across three places, and the
// DrawingMenu had to duplicate the tool list (label + glyph) because
// the bare `DrawingTool` union doesn't carry UI metadata. Adding a new
// drawing primitive meant editing four files in sync.
//
// Shape. Each tool is a DrawingToolSpec value — a small bag of
// {kind, label, glyph, cursor, onPointerDown?, onPointerMove?, onPointerUp?}.
// The TOOLS registry exposes them all in display order. The overlay
// looks up `TOOLS[activeTool]` and forwards pointer events; the menu
// iterates the registry to render rows. Adding a tool is now one new
// spec object plus a registry entry — locality is restored, depth is
// gained.
//
// Mirrors the existing RangeSeriesPane deepening pattern (see
// CONTEXT.md "RangeSeriesPane") which replaced five near-clone pane
// components with a single owner driven by per-spec data.
//
// Tools are pure (no React imports). They receive a ToolCtx that
// exposes the world they need — coordinate helpers, hit-test, store
// actions, and per-gesture draft refs — and call back through it.
// This makes each tool unit-testable in isolation (see tools.test.ts).

import { nanoid } from 'nanoid';
import {
  type Drawing,
  type DrawingStyle,
  type DrawingTool,
  type PaneId,
  type Point,
  type Rect,
  PENCIL_MAX_POINTS,
  HIT_THRESHOLD,
  isLocked,
} from './types';
import { translateDrawing, clampDPriceForDrawing, clampDBarForDrawing } from './translate';
import { constrainAngle } from './snap';
import { simplifyByPixels, PENCIL_SIMPLIFY_EPSILON } from './simplify';
import type { DragBarDomain } from './chartCoordinates';

/** Constrain the free endpoint (cursor px,py) to 0°/45°/90° relative to anchor
 *  `a`, in pixel space, then convert back to a data Point. Returns null when the
 *  anchor can't be projected. Used by trendline/measure Shift-drag. */
function angleConstrainedPoint(
  ctx: ToolCtx,
  a: Point,
  px: number,
  py: number,
  paneId: PaneId,
): Point | null {
  const ax = ctx.realMsToCanvasX(a.realMs);
  const ay = ctx.priceToCanvasY(a.price, paneId);
  if (ax == null || ay == null) return null;
  const c = constrainAngle({ x: ax, y: ay }, { x: px, y: py });
  return ctx.pixelToData(c.x, c.y, paneId);
}

/** A per-gesture draft for the trendline tool — first point captured on
 *  pointer-down, committed on pointer-up. */
export type TrendlineDraft = { a: Point; b?: Point; pointerId: number; paneId: PaneId };

/**
 * A per-gesture draft for the pencil tool.
 *
 * `subX` is parallel to `points` and carries each vertex's sub-bar offset (see
 * `Pencil.subX`) — the draft has to hold it too, or the LIVE PREVIEW would
 * render on the bar grid and then visibly snap into place on pointer-up.
 *
 * `lastPx`/`lastPy` are the last APPENDED sample, for the minimum-movement
 * gate. It replaced a 16ms clock gate: the clock capped capture at ~62
 * points/second regardless of how fast the cursor was moving, so a quick
 * stroke came out sparse and angular. Distance is the property actually worth
 * gating on — a stationary pointer adds nothing at any event rate, and a fast
 * one is exactly when the extra samples matter. Redraw stays frame-paced
 * regardless (`requestRedraw` coalesces via lwc's `requestUpdate`).
 */
export type PencilDraft = {
  points: Point[];
  subX: number[];
  pointerId: number;
  lastPx: number;
  lastPy: number;
  paneId: PaneId;
};

/** Minimum cursor movement (canvas px) between two captured pencil samples.
 *  Below one pixel because coalesced/pen samples are sub-pixel and the RDP
 *  pass at commit is what actually decides the stored point count; this only
 *  keeps a resting pointer from piling up duplicates. */
export const PENCIL_MIN_SAMPLE_PX = 0.5;

/** A per-gesture draft for the rect tool — one corner captured on pointer-down,
 *  the opposite corner tracked on move, committed on pointer-up. */
export type RectDraft = { a: Point; b?: Point; pointerId: number; paneId: PaneId };

/** A per-gesture draft for the measure tool. Same 2-point drag shape as rect. */
export type MeasureDraft = { a: Point; b?: Point; pointerId: number; paneId: PaneId };

/** Active drag in select mode. `body` translates the whole drawing;
 *  `handle` moves one endpoint of a trendline only. */
export type DragMode =
  | {
      kind: 'body';
      id: string;
      /** Last cursor realMs, or null when the drag is over the chart's empty
       *  right band where the time axis can't resolve a coordinate. Only used
       *  to derive the horizontal (Δms) shift for trendline/pencil; hline
       *  ignores it (see translateHline). Stays frozen at the last resolvable
       *  value while the cursor is in the empty band so vertical drag still
       *  works there. */
      lastRealMs: number | null;
      lastPrice: number;
      pointerId: number;
      paneId: PaneId;
    }
  | { kind: 'handle'; id: string; endpoint: 'a' | 'b'; pointerId: number; paneId: PaneId }
  // Rect corner drag. A corner is identified by which stored point supplies its
  // X (msKey) and which supplies its Y (priceKey): the top-left corner of a
  // non-crossed rect is {msKey:'a', priceKey:'a'}, the top-right {msKey:'b',
  // priceKey:'a'}, etc. Dragging updates exactly those two coordinates.
  | {
      kind: 'rect-handle';
      id: string;
      msKey: 'a' | 'b';
      priceKey: 'a' | 'b';
      pointerId: number;
      paneId: PaneId;
    }
  // Vline body drag — horizontal only, resolved off the time axis alone so it
  // survives its origin pane being toggled off (no price scale needed).
  | { kind: 'vline-body'; id: string; lastRealMs: number | null; pointerId: number; paneId: PaneId };

/** A React-style ref bucket. Spec'd as the minimal shape the tools
 *  mutate, so tests can pass plain `{ current: null }` objects. */
export type Ref<T> = { current: T };

/**
 * The "world" each tool sees. Built once per pointer event by the
 * overlay's buildCtx helper. Coordinate helpers return null when
 * conversion isn't possible (price scale absent, realMs outside axis,
 * etc.) — tools must guard.
 *
 * Store actions are surfaced explicitly so tests can stub them; tools
 * never reach into `useDrawingsStore` directly.
 */
export type ToolCtx = {
  /** Cursor pixel X relative to the overlay container. */
  px: number;
  /** Cursor pixel Y relative to the overlay container. */
  py: number;
  /**
   * Every pointer sample the browser merged into this one event
   * (`PointerEvent.getCoalescedEvents`), already in overlay-container pixels
   * and ordered oldest→newest, with the event's own position last. Empty when
   * the platform coalesced nothing.
   *
   * Freehand capture reads this instead of `px`/`py`: a 1000Hz mouse or a pen
   * emits many samples per frame, and the browser hands the page ONE
   * pointermove for the lot. Taking only that one throws the rest away — the
   * stroke gets frame-rate resolution rather than device resolution. Only the
   * pencil uses it; every other tool wants the final position.
   */
  coalesced: readonly { px: number; py: number }[];
  /** PointerEvent.pointerId — needed for setPointerCapture / release. */
  pointerId: number;
  /** Shift held — constrains trendline/measure drags to 0°/45°/90°. */
  shiftKey: boolean;
  /**
   * Pin the active pointer to the overlay until releasePointer is called.
   *
   * **Neither of these throws** — that is part of the contract, enforced by
   * the overlay's `buildCtx`. Tools sequence `releasePointer` before the
   * `ctx.add` that commits the gesture, so a throwing release would silently
   * destroy the drawing the user just made. Treat a failed capture as "the
   * pointer isn't pinned" (the gesture still runs) and a failed release as a
   * no-op; neither is a reason to abort.
   */
  capturePointer(): void;
  releasePointer(): void;

  /** Convert (px, py) → (realMs, price) using `paneId`'s price scale. */
  pixelToData(px: number, py: number, paneId: PaneId): Point | null;
  /** Convert a stored realMs to a canvas X. Returns null when the realMs
   *  falls outside every Virtual Axis segment. */
  realMsToCanvasX(realMs: number): number | null;
  /** Convert a canvas X to realMs — the time-only half of `pixelToData`, used
   *  by the vline tool and vline body-drag (price-independent). Returns null in
   *  the chart's empty band where the time axis can't resolve. */
  canvasXToRealMs(px: number): number | null;
  /** Convert a stored price to a canvas Y using `paneId`'s price scale. */
  priceToCanvasY(price: number, paneId: PaneId): number | null;
  /** Convert a canvas Y to a price using `paneId`'s price scale — the
   *  time-independent half of `pixelToData`. Resolves everywhere the price
   *  scale is mounted, including the chart's empty right band where
   *  `coordinateToTime` (and thus `pixelToData`) returns null. The body-drag
   *  path uses this so a price-only drawing (hline) keeps dragging in the
   *  empty band instead of freezing. Returns null only when the pane's price
   *  scale is genuinely unavailable. */
  canvasYToPrice(py: number, paneId: PaneId): number | null;
  /** Hit-test all drawings (reverse / topmost-first). */
  hitTestAt(px: number, py: number): Drawing | null;
  /**
   * Same, but over `unlockedOnly(drawings)` — the topmost drawing the overlay
   * can actually act on.
   *
   * This is the SAME question the pointer-events gate asks, and select mode has
   * to ask it too or the two disagree: the gate opens because an unlocked shape
   * is here, then `hitTestAt` hands the tool a locked shape lying on top of it,
   * and the result is a click that neither grabs the live shape nor pans the
   * chart. See ADR-0164.
   */
  hitTestUnlockedAt(px: number, py: number): Drawing | null;

  /** PaneId of the pane the cursor is currently in. */
  paneIdAtY(py: number): PaneId;
  /** Clamp a pixel Y to the vertical span of the given pane. */
  clampYToPane(paneId: PaneId, py: number): number;
  /** Domain price values at the top and bottom of `paneId`'s pane, derived
   *  from the registered series' coordinateToPrice at the pane's top/bottom
   *  pixels. Returns null if the pane or its series isn't mounted. */
  priceBoundsForPane(paneId: PaneId): { top: number; bottom: number } | null;
  /** Screen-uniform domain for body-drag translation. Horizontal drag deltas
   *  are computed and applied in BAR ORDINALS so shifted vertices always land
   *  back on-axis (a flat Δ-real-ms swallowed inter-session gaps and stranded
   *  rect/measure corners inside them — stretched or vanished drawings) AND
   *  move by the same number of columns as the cursor (Δ-virtual-ms did not:
   *  a day boundary is worth 1 000 virtual ms but a whole column, so vertices
   *  straddling one moved twice as far as the cursor). */
  dragBars: DragBarDomain;

  /** The current Drawing list for the active Code. */
  drawings: readonly Drawing[];
  /** Currently selected drawing id, if any. */
  selectedId: string | null;
  /** The sticky style for the ACTIVE tool (this gesture's kind). The overlay
   *  narrows the per-kind defaults down to one slot before building the ctx, so
   *  a constructor just reads `ctx.defaults.color/width/lineStyle` (+ fillOpacity
   *  for rect) and gets that tool's own last-used values. See ADR-0032. */
  defaults: DrawingStyle;

  /** Per-gesture draft refs. The overlay owns them as React refs; tools
   *  read and mutate `.current` directly. */
  trendlineDraft: Ref<TrendlineDraft | null>;
  pencilDraft: Ref<PencilDraft | null>;
  rectDraft: Ref<RectDraft | null>;
  measureDraft: Ref<MeasureDraft | null>;
  dragRef: Ref<DragMode | null>;

  /** Open the text editor at `at` in `paneId` to author a new label. `px`/`py`
   *  are the raw click pixels so the overlay can always position the DOM
   *  <input> at the click even if `at` can't be re-projected. The overlay owns
   *  the input (IME-safe) and commits on Enter/blur. */
  beginTextEdit(at: Point, paneId: PaneId, px: number, py: number): void;

  /** Effective bar width in canvas px, or null when the time scale can't
   *  report it (`barPitchPx`). The pencil turns the pixel remainder its
   *  bar-anchored `realMs` discarded into a fraction of this. */
  barPx(): number | null;

  /** Trigger a single canvas redraw on the next animation frame. Tools
   *  call this after mutating a draft ref to surface a live preview
   *  (pencil during drag, future trendline preview, …) — store
   *  mutations already trigger redraws via the effect's `drawings` dep,
   *  but draft refs are not React state and need an explicit hint. */
  requestRedraw(): void;

  // Store actions — surfaced as plain functions so tests inject stubs.
  add(d: Drawing): void;
  update(id: string, patch: Partial<Drawing>): void;
  remove(id: string): void;
  setSelected(id: string | null): void;
  /** Legacy post-commit hook kept in the context for compatibility with older
   *  tests/callers. Current drawing tools keep their active tool after commit
   *  and select the new drawing through `setSelected` instead. */
  revertToSelectMode(newId: string): void;
};

export interface DrawingToolSpec {
  kind: DrawingTool;
  /** Korean menu label rendered in DrawingMenu. */
  label: string;
  /** Single-char glyph rendered in the toolbar button and menu. */
  glyph: string;
  /** CSS cursor when this tool is active. Unused by v1 overlay (the
   *  overlay's pointer-events gating already differentiates), kept on
   *  the spec for future styling. */
  cursor: string;
  /** Optional keyboard shortcut (Alt + key). DrawingOverlay's keydown
   *  effect iterates TOOLS to dispatch. `key` is lowercase ASCII. */
  shortcut?: { alt: true; key: string };
  onPointerDown?(ctx: ToolCtx): void;
  onPointerMove?(ctx: ToolCtx): void;
  onPointerUp?(ctx: ToolCtx): void;
}

/**
 * Which rect corner (if any) is under the cursor, expressed as the (msKey,
 * priceKey) pair whose stored points supply that corner's X and Y. Returns null
 * when no corner is within threshold. Corners are derived from the projected,
 * min/max-normalized box so a crossed rect still yields the visually-correct
 * corners.
 */
function hitRectCorner(
  ctx: ToolCtx,
  r: Rect,
): { msKey: 'a' | 'b'; priceKey: 'a' | 'b' } | null {
  const xa = ctx.realMsToCanvasX(r.a.realMs);
  const xb = ctx.realMsToCanvasX(r.b.realMs);
  const ya = ctx.priceToCanvasY(r.a.price, r.paneId);
  const yb = ctx.priceToCanvasY(r.b.price, r.paneId);
  if (xa == null || xb == null || ya == null || yb == null) return null;
  // Each corner keeps the identity of which point owns its X and Y.
  const corners: { x: number; y: number; msKey: 'a' | 'b'; priceKey: 'a' | 'b' }[] = [
    { x: xa, y: ya, msKey: 'a', priceKey: 'a' },
    { x: xb, y: ya, msKey: 'b', priceKey: 'a' },
    { x: xb, y: yb, msKey: 'b', priceKey: 'b' },
    { x: xa, y: yb, msKey: 'a', priceKey: 'b' },
  ];
  for (const c of corners) {
    if (Math.hypot(ctx.px - c.x, ctx.py - c.y) <= HIT_THRESHOLD.rectHandle) {
      return { msKey: c.msKey, priceKey: c.priceKey };
    }
  }
  return null;
}

// ─── select ────────────────────────────────────────────────────────────────
//
// Select mode owns hit-test → selection update → optional drag. Trendline
// endpoint handles take precedence over body hit-test when the currently
// selected drawing is a trendline (so a click on a handle moves only that
// endpoint, not the whole line).
export const selectTool: DrawingToolSpec = {
  kind: 'select',
  label: '선택',
  // Northwest arrow reads as a cursor; the old '↶' looked like Undo, which now
  // has a real Ctrl+Z binding it would be confused with.
  glyph: '↖',
  cursor: 'default',
  shortcut: { alt: true, key: 'v' },
  onPointerDown(ctx) {
    const rawSelected = ctx.selectedId
      ? ctx.drawings.find((d) => d.id === ctx.selectedId)
      : null;
    // 잠긴 도형은 핸들 경로에서 아예 빠진다 — 아래 두 블록은 `selected` 가
    // null 이면 통째로 건너뛴다. 스토어가 어차피 update 를 거부하므로 이건
    // 정확성이 아니라 감촉이다: 게이트가 없으면 dragRef 가 서서 포인터를
    // 캡처하고, 사용자는 잡아서 끌고 있는데 도형만 안 따라오는 상태를 본다.
    const selected = isLocked(rawSelected) ? null : rawSelected;
    // Trendline and measure share the 2-endpoint (a/b) handle-drag path.
    if (selected && (selected.kind === 'trendline' || selected.kind === 'measure')) {
      const xa = ctx.realMsToCanvasX(selected.a.realMs);
      const ya = ctx.priceToCanvasY(selected.a.price, selected.paneId);
      const xb = ctx.realMsToCanvasX(selected.b.realMs);
      const yb = ctx.priceToCanvasY(selected.b.price, selected.paneId);
      if (xa != null && ya != null && Math.hypot(ctx.px - xa, ctx.py - ya) <= HIT_THRESHOLD.trendlineHandle) {
        ctx.dragRef.current = {
          kind: 'handle',
          id: selected.id,
          endpoint: 'a',
          pointerId: ctx.pointerId,
          paneId: selected.paneId,
        };
        ctx.capturePointer();
        return;
      }
      if (xb != null && yb != null && Math.hypot(ctx.px - xb, ctx.py - yb) <= HIT_THRESHOLD.trendlineHandle) {
        ctx.dragRef.current = {
          kind: 'handle',
          id: selected.id,
          endpoint: 'b',
          pointerId: ctx.pointerId,
          paneId: selected.paneId,
        };
        ctx.capturePointer();
        return;
      }
    }
    // Rect corner handles take precedence over body hit when a rect is selected.
    if (selected && selected.kind === 'rect') {
      const corner = hitRectCorner(ctx, selected);
      if (corner) {
        ctx.dragRef.current = {
          kind: 'rect-handle',
          id: selected.id,
          msKey: corner.msKey,
          priceKey: corner.priceKey,
          pointerId: ctx.pointerId,
          paneId: selected.paneId,
        };
        ctx.capturePointer();
        return;
      }
    }
    // **잠긴 것을 건너뛰고** 고른다. 게이트가 이 오버레이에 포인터를 준 이유가
    // "여기 잠기지 않은 도형이 있다" 이므로, 도구도 같은 것을 집어야 한다.
    // 전체 목록으로 고르면 위에 얹힌 잠긴 도형이 최상단으로 이겨서, 아래 살아
    // 있는 도형을 **잡지도 못하고 차트 팬도 안 되는** 죽은 클릭이 된다(ADR-0164).
    //
    // 잠긴 도형의 선택은 여기가 아니라 window mousedown 리스너의 몫이다
    // (`resolveSelectModeMouseDown`) — 그쪽은 게이트가 'none' 일 때, 즉 이
    // 오버레이가 클릭을 아예 못 받을 때 작동한다. 둘의 담당 구역이 게이트를
    // 경계로 정확히 나뉘고 겹치지 않는다.
    const hit = ctx.hitTestUnlockedAt(ctx.px, ctx.py);
    ctx.setSelected(hit?.id ?? null);
    // vline body drag is horizontal-only and resolved off the time axis alone,
    // so it doesn't touch (and doesn't require) any pane's price scale.
    if (hit && hit.kind === 'vline') {
      ctx.dragRef.current = {
        kind: 'vline-body',
        id: hit.id,
        lastRealMs: ctx.canvasXToRealMs(ctx.px),
        pointerId: ctx.pointerId,
        paneId: hit.paneId,
      };
      ctx.capturePointer();
      return;
    }
    if (hit) {
      // Body drag runs off the price axis alone: resolve price (works in the
      // empty right band too, where the time axis can't) and best-effort
      // realMs (null in that band). Bail only if the price scale itself can't
      // resolve — without this guard a grab in the empty band froze (the old
      // `if (!pixelToData) return` killed the drag before it started).
      const price = ctx.canvasYToPrice(ctx.py, hit.paneId);
      if (price == null) return;
      const data = ctx.pixelToData(ctx.px, ctx.py, hit.paneId);
      ctx.dragRef.current = {
        kind: 'body',
        id: hit.id,
        lastRealMs: data?.realMs ?? null,
        lastPrice: price,
        pointerId: ctx.pointerId,
        paneId: hit.paneId,
      };
      ctx.capturePointer();
    }
  },
  onPointerMove(ctx) {
    const drag = ctx.dragRef.current;
    if (!drag || drag.pointerId !== ctx.pointerId) return;
    // vline body drag: horizontal only, no price scale involved. The delta is
    // taken in bar ordinals (see the body branch below for why).
    if (drag.kind === 'vline-body') {
      const target = ctx.drawings.find((d) => d.id === drag.id);
      if (!target || target.kind !== 'vline') return;
      const curRealMs = ctx.canvasXToRealMs(ctx.px);
      const dBar =
        curRealMs != null && drag.lastRealMs != null
          ? ctx.dragBars.toBar(curRealMs) - ctx.dragBars.toBar(drag.lastRealMs)
          : 0;
      if (dBar !== 0) {
        const shift = (ms: number) => ctx.dragBars.toReal(ctx.dragBars.toBar(ms) + dBar);
        ctx.update(target.id, translateDrawing(target, shift, 0));
      }
      if (curRealMs != null) drag.lastRealMs = curRealMs;
      return;
    }
    if (drag.kind === 'rect-handle') {
      const target = ctx.drawings.find((d) => d.id === drag.id);
      if (!target || target.kind !== 'rect') return;
      const clampedY = ctx.clampYToPane(drag.paneId, ctx.py);
      const price = ctx.canvasYToPrice(clampedY, drag.paneId);
      if (price == null) return;
      const data = ctx.pixelToData(ctx.px, clampedY, drag.paneId);
      const curRealMs = data?.realMs ?? null;
      // Update the corner's X (msKey point) and Y (priceKey point). In the empty
      // band keep the existing realMs (X unresolvable) and move vertically only.
      const msPoint = drag.msKey === 'a' ? target.a : target.b;
      const prPoint = drag.priceKey === 'a' ? target.a : target.b;
      const newMs = curRealMs ?? msPoint.realMs;
      const patch: Partial<Pick<Rect, 'a' | 'b'>> = {};
      if (drag.msKey === drag.priceKey) {
        patch[drag.msKey] = { realMs: newMs, price };
      } else {
        patch[drag.msKey] = { realMs: newMs, price: msPoint.price };
        patch[drag.priceKey] = { realMs: prPoint.realMs, price };
      }
      ctx.update(target.id, patch as Partial<Drawing>);
      return;
    }
    const clampedY = ctx.clampYToPane(drag.paneId, ctx.py);
    // Price resolves off the Y axis everywhere the pane is mounted; realMs is
    // null in the empty right band (coordinateToTime can't resolve a coordinate
    // past the last candle). Decoupling them is what lets an hline keep
    // dragging there instead of freezing.
    const price = ctx.canvasYToPrice(clampedY, drag.paneId);
    if (price == null) return;
    const data = ctx.pixelToData(ctx.px, clampedY, drag.paneId);
    const curRealMs = data?.realMs ?? null;
    const target = ctx.drawings.find((d) => d.id === drag.id);
    if (!target) return;
    if (drag.kind === 'handle' && (target.kind === 'trendline' || target.kind === 'measure')) {
      // In the empty band keep the endpoint's realMs (X unresolvable) and move
      // it vertically; over data, move both axes.
      const endpoint = drag.endpoint === 'a' ? target.a : target.b;
      const moved: Point = { realMs: curRealMs ?? endpoint.realMs, price };
      const patch = drag.endpoint === 'a' ? { a: moved } : { b: moved };
      ctx.update(target.id, patch as Partial<Drawing>);
      return;
    }
    if (drag.kind === 'body') {
      // Horizontal shift only when both ends resolve; otherwise 0 — hline
      // discards it anyway, and trendline/pencil degrade to vertical-only
      // rather than freezing. The delta lives in BAR ORDINALS: shifting stored
      // real timestamps by a flat Δ-real-ms stranded vertices inside
      // inter-session gaps whenever the cursor crossed a day boundary (the
      // gap's whole duration entered the delta), which rendered rect/measure
      // stretched to the canvas edge or not at all. Δ-virtual-ms fixed that but
      // is not uniform on screen — a day boundary spans 1 000 virtual ms and a
      // full column — so a vertex straddling one moved two columns per one of
      // the cursor's and the shape stretched. Ordinals are the screen's own
      // units, so cursor and every vertex move together.
      const rawDBar =
        curRealMs != null && drag.lastRealMs != null
          ? ctx.dragBars.toBar(curRealMs) - ctx.dragBars.toBar(drag.lastRealMs)
          : 0;
      // Shape-preserving cap against the axis origin — the time-axis sibling
      // of the price cap below. Without it a leftward overshoot would floor
      // vertices one by one at the first session's open, compressing the shape.
      const dBar = clampDBarForDrawing(
        target,
        rawDBar,
        ctx.dragBars.originBar,
        ctx.dragBars.toBar,
      );
      const rawDPrice = price - drag.lastPrice;
      // Shape-preserving cap: compute the largest |dPrice| that keeps every
      // vertex inside the pane, then translate once. Post-translate per-vertex
      // clamping would have collapsed a trendline/pencil that touched the
      // boundary asymmetrically.
      const paneBounds = ctx.priceBoundsForPane(drag.paneId);
      const dPrice = paneBounds
        ? clampDPriceForDrawing(target, rawDPrice, paneBounds)
        : rawDPrice;
      // The round-trip runs even when dBar is 0: for a healthy vertex it is the
      // identity, and for one stranded in a gap by the old real-ms drags it
      // snaps forward to the next session open — grabbing a broken drawing
      // heals it.
      const shift = (ms: number) => ctx.dragBars.toReal(ctx.dragBars.toBar(ms) + dBar);
      ctx.update(target.id, translateDrawing(target, shift, dPrice));
      // Advance the horizontal anchor only when X resolved, so re-entering the
      // data area computes the delta from the last real position (no jump).
      if (curRealMs != null) drag.lastRealMs = curRealMs;
      drag.lastPrice = price;
    }
  },
  onPointerUp(ctx) {
    const drag = ctx.dragRef.current;
    if (!drag || drag.pointerId !== ctx.pointerId) return;
    ctx.dragRef.current = null;
    ctx.releasePointer();
  },
};

// 그리기 모드는 **항상 그린다**. 기존 도형 위를 눌러도 잡히지 않고 새 도형이
// 시작된다 — 이동·크기조절·스타일 변경은 전부 select 모드의 일이다.
//
// 한때 그 반대였다: 커밋 시 방금 그린 도형을 선택하고, 선택된 도형 위에서 시작한
// press 를 이동으로 넘기는 게이트가 있었다(#1227). 사용자가 그 모델을 써 본 뒤
// **2026-08-08 에 폐기를 결정했다** — 커밋 후 선택 자체를 없애고, 방금 그린 자리
// 위에 곧바로 다음 도형을 그릴 수 있는 쪽을 택했다.
//
// ⚠ 그래서 "연필 획 위에서 좌우로 끌면 긴 가로 획이 새로 생긴다" 는 **버그가 아니라
// 설계다**. 그건 연필이 그려진 것이다. 예전에 그것이 버그로 신고된 이유는 커밋 직후
// 도형에 선택 헤일로가 깔려 "잡을 수 있다" 고 약속했기 때문이고, 그 약속을 지우는
// 것이 지금의 해법이다. 같은 증상을 다시 보더라도 게이트를 되살리지 말 것 —
// 선택 효과가 없는지부터 확인한다.

// ─── hline ─────────────────────────────────────────────────────────────────
export const hlineTool: DrawingToolSpec = {
  kind: 'hline',
  label: '수평선',
  glyph: '━',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'h' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    // hline is price-only, so resolve the level off the Y axis alone via
    // canvasYToPrice. Routing through pixelToData (the old code) coupled
    // creation to the time axis and aborted in the chart's empty right band,
    // where coordinateToTime — and thus pixelToData — returns null: the user
    // could add an hline over candles but not in the empty area. This mirrors
    // the body-drag fix in selectTool, which already decoupled the same way.
    // Magnet: pixelToData is the snapped path (price → nearest candle OHLC), so
    // prefer it and take just the price. Fall back to the price-only
    // canvasYToPrice in the empty band where the time axis can't resolve (no
    // future ref) — there's nothing to snap to there anyway.
    const snapped = ctx.pixelToData(ctx.px, ctx.py, paneId);
    const price = snapped ? snapped.price : ctx.canvasYToPrice(ctx.py, paneId);
    if (price == null) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'hline',
      price,
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId,
    });
  },
};

// ─── vline ─────────────────────────────────────────────────────────────────
export const vlineTool: DrawingToolSpec = {
  kind: 'vline',
  label: '수직선',
  glyph: '│',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'u' },
  onPointerDown(ctx) {
    // vline is time-only: resolve realMs off the X axis alone. Null in the
    // empty right band (coordinateToTime unresolvable) → no creation there.
    const realMs = ctx.canvasXToRealMs(ctx.px);
    if (realMs == null) return;
    const paneId = ctx.paneIdAtY(ctx.py);
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'vline',
      realMs,
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId,
    });
  },
};

// ─── trendline ─────────────────────────────────────────────────────────────
export const trendlineTool: DrawingToolSpec = {
  kind: 'trendline',
  label: '추세선',
  glyph: '╱',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'j' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    ctx.trendlineDraft.current = { a: data, pointerId: ctx.pointerId, paneId };
    ctx.capturePointer();
  },
  onPointerMove(ctx) {
    const draft = ctx.trendlineDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.shiftKey
      ? angleConstrainedPoint(ctx, draft.a, ctx.px, clampedY, draft.paneId)
      : ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    if (!data) return;
    draft.b = data;
    ctx.requestRedraw();
  },
  onPointerUp(ctx) {
    const draft = ctx.trendlineDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.shiftKey
      ? angleConstrainedPoint(ctx, draft.a, ctx.px, clampedY, draft.paneId)
      : ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    ctx.trendlineDraft.current = null;
    ctx.releasePointer();
    if (!data) return;
    // Reject zero-length trendlines (click without drag).
    if (data.realMs === draft.a.realMs && data.price === draft.a.price) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'trendline',
      a: draft.a,
      b: data,
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId: draft.paneId,
    });
  },
};

// ─── rect ──────────────────────────────────────────────────────────────────
export const rectTool: DrawingToolSpec = {
  kind: 'rect',
  label: '사각형',
  glyph: '▭',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'r' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    ctx.rectDraft.current = { a: data, pointerId: ctx.pointerId, paneId };
    ctx.capturePointer();
  },
  onPointerMove(ctx) {
    const draft = ctx.rectDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    if (!data) return;
    draft.b = data;
    ctx.requestRedraw();
  },
  onPointerUp(ctx) {
    const draft = ctx.rectDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    ctx.rectDraft.current = null;
    ctx.releasePointer();
    if (!data) return;
    // Reject a zero-area rect: EITHER axis collapsing (same time OR same price)
    // makes it a degenerate line, not a box.
    if (data.realMs === draft.a.realMs || data.price === draft.a.price) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'rect',
      a: draft.a,
      b: data,
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId: draft.paneId,
      // Sticky fill: a new rect inherits the rect tool's last-used fill alpha.
      fillOpacity: ctx.defaults.fillOpacity,
    });
  },
};

// ─── measure ───────────────────────────────────────────────────────────────
export const measureTool: DrawingToolSpec = {
  kind: 'measure',
  label: '측정자',
  glyph: '⇲',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'm' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    ctx.measureDraft.current = { a: data, pointerId: ctx.pointerId, paneId };
    ctx.capturePointer();
  },
  onPointerMove(ctx) {
    const draft = ctx.measureDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.shiftKey
      ? angleConstrainedPoint(ctx, draft.a, ctx.px, clampedY, draft.paneId)
      : ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    if (!data) return;
    draft.b = data;
    ctx.requestRedraw();
  },
  onPointerUp(ctx) {
    const draft = ctx.measureDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.shiftKey
      ? angleConstrainedPoint(ctx, draft.a, ctx.px, clampedY, draft.paneId)
      : ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    ctx.measureDraft.current = null;
    ctx.releasePointer();
    if (!data) return;
    if (data.realMs === draft.a.realMs && data.price === draft.a.price) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'measure',
      a: draft.a,
      b: data,
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId: draft.paneId,
    });
    // One-shot: revert to select after a measurement (like a ruler). Otherwise
    // the tool stays active and the user's next click/drag — meant to adjust the
    // measure — draws a NEW overlapping one (grows/vanishes). In select mode the
    // same gesture moves or resizes the existing measure instead.
    ctx.revertToSelectMode(id);
  },
};

// ─── text ──────────────────────────────────────────────────────────────────
export const textTool: DrawingToolSpec = {
  kind: 'text',
  label: '텍스트',
  glyph: 'T',
  cursor: 'text',
  shortcut: { alt: true, key: 't' },
  onPointerDown(ctx) {
    // Anchor the label at the click; the overlay opens a DOM <input> there and
    // commits the text on Enter/blur (IME-safe). If an edit is already open the
    // overlay commits it first (pointerdown precedes the input's blur).
    const paneId = ctx.paneIdAtY(ctx.py);
    // Resolve an anchor; fall back to a price-only point in the empty band so a
    // label can still be placed to the right of the last candle.
    const data =
      ctx.pixelToData(ctx.px, ctx.py, paneId) ??
      (() => {
        const price = ctx.canvasYToPrice(ctx.py, paneId);
        const realMs = ctx.canvasXToRealMs(ctx.px);
        return price != null && realMs != null ? { realMs, price } : null;
      })();
    if (!data) return;
    ctx.beginTextEdit(data, paneId, ctx.px, ctx.py);
  },
};

// ─── pencil ────────────────────────────────────────────────────────────────
export const pencilTool: DrawingToolSpec = {
  kind: 'pencil',
  label: '연필',
  glyph: '✎',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'b' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    ctx.pencilDraft.current = {
      points: [data],
      subX: [subBarFraction(ctx, data, ctx.px)],
      pointerId: ctx.pointerId,
      lastPx: ctx.px,
      lastPy: ctx.py,
      paneId,
    };
    ctx.capturePointer();
  },
  onPointerMove(ctx) {
    const draft = ctx.pencilDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    // Device resolution, not frame resolution: walk every sample the browser
    // folded into this event. Falls back to the event's own position when the
    // platform coalesced nothing (and in tests, which stub `coalesced: []`).
    const samples =
      ctx.coalesced.length > 0 ? ctx.coalesced : [{ px: ctx.px, py: ctx.py }];
    let appended = false;
    for (const s of samples) {
      if (draft.points.length >= PENCIL_MAX_POINTS) break;
      if (Math.hypot(s.px - draft.lastPx, s.py - draft.lastPy) < PENCIL_MIN_SAMPLE_PX) continue;
      const clampedY = ctx.clampYToPane(draft.paneId, s.py);
      const data = ctx.pixelToData(s.px, clampedY, draft.paneId);
      if (!data) continue;
      draft.points.push(data);
      draft.subX.push(subBarFraction(ctx, data, s.px));
      draft.lastPx = s.px;
      draft.lastPy = s.py;
      appended = true;
    }
    // Live preview: redraw so the in-flight polyline appears under the
    // cursor. Without this the stroke only materialises on pointer-up.
    // One request per EVENT, not per sample — lwc coalesces to the next frame
    // anyway, and the draft is read at draw time (see DrawingsSource).
    if (appended) ctx.requestRedraw();
  },
  onPointerUp(ctx) {
    const draft = ctx.pencilDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    ctx.pencilDraft.current = null;
    ctx.releasePointer();
    if (draft.points.length < 2) return;
    const barPx = ctx.barPx();
    // RDP-simplify in pixel space at commit — trims the dense freehand capture
    // to the points that actually define the curve's shape. The sub-bar offset
    // travels WITH its point through the filter (same index, one array of
    // pairs) so simplification can't shear the two arrays apart, and it is
    // included in the projection so RDP measures the pixels the user will
    // actually see rather than the bar-snapped ones.
    const simplified = simplifyByPixels(
      draft.points.map((pt, i) => ({ pt, sub: draft.subX[i] ?? 0 })),
      ({ pt, sub }) => {
        const x = ctx.realMsToCanvasX(pt.realMs);
        const y = ctx.priceToCanvasY(pt.price, draft.paneId);
        return x != null && y != null ? { x: x + sub * (barPx ?? 0), y } : null;
      },
      PENCIL_SIMPLIFY_EPSILON,
    );
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'pencil',
      points: simplified.map((s) => s.pt),
      // Rounded to 3 decimals: at any plausible bar pitch that is far below a
      // pixel, and the full float would roughly double each point's JSON
      // footprint against PENCIL_MAX_POINTS' ~250KB budget.
      subX: simplified.map((s) => Math.round(s.sub * 1000) / 1000),
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId: draft.paneId,
    });
  },
};

/**
 * The pixel remainder `pixelToData` threw away at `px`, as a fraction of one
 * bar (see `Pencil.subX`).
 *
 * `data.realMs` names a BAR, because `coordinateToTime` is `Math.ceil` on the
 * float bar index. Re-projecting that bar back to a coordinate and subtracting
 * recovers exactly what the rounding discarded — no second trip through the
 * time scale's internals, and it stays correct wherever `realMsToCanvasX` is
 * (extrapolated future band included).
 *
 * Returns 0 when the pitch is unknown or the anchor won't re-project, which is
 * the pre-subX behaviour: anchored to the bar, never to a guess.
 */
function subBarFraction(ctx: ToolCtx, data: Point, px: number): number {
  const barPx = ctx.barPx();
  if (barPx == null) return 0;
  const anchorX = ctx.realMsToCanvasX(data.realMs);
  if (anchorX == null) return 0;
  return (px - anchorX) / barPx;
}

// ─── eraser ────────────────────────────────────────────────────────────────
export const eraserTool: DrawingToolSpec = {
  kind: 'eraser',
  label: '지우개',
  glyph: '⌫',
  // `not-allowed` 였다 — 표준 의미가 "이 동작은 불가" 라, 지우개를 켠 사용자에게
  // "여긴 못 지운다" 로 읽힌다(실제로는 클릭하면 지워진다). 다른 그리기 도구와 같은
  // 조준 커서로 맞춘다. 어느 도구인지는 헤더의 `그리기: 지우개` 라벨이 말한다.
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'e' },
  onPointerDown(ctx) {
    const hit = ctx.hitTestAt(ctx.px, ctx.py);
    // 잠긴 것은 지우개가 **통과한다** — 지우개는 연속 삭제가 정상 흐름이라
    // (그래서 auto-revert 에서도 빠져 있다) 잠긴 도형 위를 지나가는 일이 잦다.
    // 스토어가 어차피 거부하므로 여기 게이트는 의도의 표명이다.
    if (hit && !isLocked(hit)) ctx.remove(hit.id);
  },
};

/**
 * Tool registry. Keyed by `DrawingTool` for O(1) overlay dispatch.
 * `DRAWABLE_TOOLS_ORDER` is the display order DrawingMenu uses for the
 * 4 actual drawing tools (select sits separately under "선택").
 */
export const TOOLS: Record<DrawingTool, DrawingToolSpec> = {
  select: selectTool,
  hline: hlineTool,
  vline: vlineTool,
  trendline: trendlineTool,
  rect: rectTool,
  measure: measureTool,
  text: textTool,
  pencil: pencilTool,
  eraser: eraserTool,
};

export const DRAWABLE_TOOLS_ORDER: readonly DrawingTool[] = [
  'hline',
  'vline',
  'trendline',
  'rect',
  'measure',
  'text',
  'pencil',
  'eraser',
];

/**
 * Match a keyboard event against the `shortcut` field of every tool in
 * the registry. Returns the tool kind to activate, or null if no spec
 * matches or a non-Alt modifier is also held (Ctrl/Meta combos are
 * reserved for the browser/OS — we don't want to clobber Ctrl+H "history"
 * or Cmd+T "new tab"). Shift is allowed because the user may have
 * Caps-Lock on or hold Shift incidentally; key matching is
 * case-insensitive.
 */
export function matchShortcut(e: KeyboardEvent): DrawingTool | null {
  if (!e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return null;
  const k = e.key.toLowerCase();
  for (const spec of Object.values(TOOLS)) {
    if (spec.shortcut && spec.shortcut.key === k) return spec.kind;
  }
  return null;
}
