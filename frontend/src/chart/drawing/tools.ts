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
  type DrawingDefaults,
  type DrawingTool,
  type PaneId,
  type Point,
  type Rect,
  PENCIL_MAX_POINTS,
  HIT_THRESHOLD,
  RECT_DEFAULT_FILL_OPACITY,
} from './types';
import { translateDrawing, clampDPriceForDrawing } from './translate';
import { constrainAngle } from './snap';
import { simplifyByPixels, PENCIL_SIMPLIFY_EPSILON } from './simplify';

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

/** A per-gesture draft for the pencil tool. `lastFrame` carries the
 *  performance.now() of the last appended point so the move handler can
 *  throttle to RAF cadence (~16ms). */
export type PencilDraft = {
  points: Point[];
  pointerId: number;
  lastFrame: number;
  paneId: PaneId;
};

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
  /** PointerEvent.pointerId — needed for setPointerCapture / release. */
  pointerId: number;
  /** Shift held — constrains trendline/measure drags to 0°/45°/90°. */
  shiftKey: boolean;
  /** Pin the active pointer to the overlay until releasePointer is called. */
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

  /** PaneId of the pane the cursor is currently in. */
  paneIdAtY(py: number): PaneId;
  /** Clamp a pixel Y to the vertical span of the given pane. */
  clampYToPane(paneId: PaneId, py: number): number;
  /** Domain price values at the top and bottom of `paneId`'s pane, derived
   *  from the registered series' coordinateToPrice at the pane's top/bottom
   *  pixels. Returns null if the pane or its series isn't mounted. */
  priceBoundsForPane(paneId: PaneId): { top: number; bottom: number } | null;

  /** The current Drawing list for the active Code. */
  drawings: readonly Drawing[];
  /** Currently selected drawing id, if any. */
  selectedId: string | null;
  /** The user's sticky drawing defaults. Tool constructors read these
   *  to seed color / width / lineStyle on new Drawings. See ADR-0032. */
  defaults: DrawingDefaults;

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
    const selected = ctx.selectedId
      ? ctx.drawings.find((d) => d.id === ctx.selectedId)
      : null;
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
    const hit = ctx.hitTestAt(ctx.px, ctx.py);
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
    // vline body drag: horizontal only, no price scale involved.
    if (drag.kind === 'vline-body') {
      const target = ctx.drawings.find((d) => d.id === drag.id);
      if (!target || target.kind !== 'vline') return;
      const curRealMs = ctx.canvasXToRealMs(ctx.px);
      const dMs =
        curRealMs != null && drag.lastRealMs != null ? curRealMs - drag.lastRealMs : 0;
      if (dMs !== 0) ctx.update(target.id, translateDrawing(target, dMs, 0));
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
      // discards Δms anyway, and trendline/pencil degrade to vertical-only in
      // the band rather than freezing.
      const dMs =
        curRealMs != null && drag.lastRealMs != null ? curRealMs - drag.lastRealMs : 0;
      const rawDPrice = price - drag.lastPrice;
      // Shape-preserving cap: compute the largest |dPrice| that keeps every
      // vertex inside the pane, then translate once. Post-translate per-vertex
      // clamping would have collapsed a trendline/pencil that touched the
      // boundary asymmetrically.
      const paneBounds = ctx.priceBoundsForPane(drag.paneId);
      const dPrice = paneBounds
        ? clampDPriceForDrawing(target, rawDPrice, paneBounds)
        : rawDPrice;
      ctx.update(target.id, translateDrawing(target, dMs, dPrice));
      // Advance the horizontal anchor only when X resolved, so re-entering the
      // data area computes Δms from the last real position (no jump for hline).
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
    ctx.setSelected(id);
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
    ctx.setSelected(id);
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
    ctx.setSelected(id);
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
      fillOpacity: RECT_DEFAULT_FILL_OPACITY,
    });
    ctx.setSelected(id);
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
      pointerId: ctx.pointerId,
      lastFrame: 0,
      paneId,
    };
    ctx.capturePointer();
  },
  onPointerMove(ctx) {
    const draft = ctx.pencilDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const now = performance.now();
    if (now - draft.lastFrame < 16) return; // RAF-aligned throttle (spec G11)
    draft.lastFrame = now;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    if (!data) return;
    if (draft.points.length >= PENCIL_MAX_POINTS) return;
    draft.points.push(data);
    // Live preview: redraw so the in-flight polyline appears under the
    // cursor. Without this the stroke only materialises on pointer-up.
    ctx.requestRedraw();
  },
  onPointerUp(ctx) {
    const draft = ctx.pencilDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    ctx.pencilDraft.current = null;
    ctx.releasePointer();
    if (draft.points.length < 2) return;
    // RDP-simplify in pixel space at commit — trims the dense freehand capture
    // to the points that actually define the curve's shape.
    const simplified = simplifyByPixels(
      draft.points,
      (pt) => {
        const x = ctx.realMsToCanvasX(pt.realMs);
        const y = ctx.priceToCanvasY(pt.price, draft.paneId);
        return x != null && y != null ? { x, y } : null;
      },
      PENCIL_SIMPLIFY_EPSILON,
    );
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'pencil',
      points: simplified,
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId: draft.paneId,
    });
    ctx.setSelected(id);
  },
};

// ─── eraser ────────────────────────────────────────────────────────────────
export const eraserTool: DrawingToolSpec = {
  kind: 'eraser',
  label: '지우개',
  glyph: '⌫',
  cursor: 'not-allowed',
  shortcut: { alt: true, key: 'e' },
  onPointerDown(ctx) {
    const hit = ctx.hitTestAt(ctx.px, ctx.py);
    if (hit) ctx.remove(hit.id);
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
