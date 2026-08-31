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
  isExtendedRight,
} from './types';
import {
  translateDrawing, clampDPriceForDrawing, clampDBarForDrawing, planGroupTranslate,
  type GroupTranslateCoords,
} from './translate';
import { marqueeRect, type MarqueeRect } from './hitTest';
import { constrainAngle } from './snap';
import {
  alignSnapBox,
  anchorsOf,
  pointAnchors,
  type AlignGuide,
  type Anchors,
  type RawAlignGuide,
  type SnapBox,
} from './alignSnap';
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

/**
 * An in-flight 마퀴 (Shift+드래그 on empty space). Pixel-space, because that is
 * what the user is aiming with — it is never converted to data coordinates, and
 * it dies at pointerup. `additive` is not a field: a marquee only exists under
 * Shift, so union is its only reading.
 */
export type MarqueeDraft = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  pointerId: number;
};

/** Movement below this (px, from the press point) is a click, not a drag. Used
 *  ONLY by the multi-selection body drag, where it decides whether a plain
 *  click on a member collapses the set to that one member. Single-drag keeps
 *  its zero-slop behavior — it has no such decision to make. */
export const MULTI_DRAG_SLOP_PX = 3;

/** A marquee smaller than this in BOTH axes is treated as a stray Shift+click
 *  on empty space and selects nothing (rather than "everything under a 1px
 *  box", which reads as a random selection). */
export const MARQUEE_MIN_PX = 4;

/** Active drag in select mode. `body` translates the whole drawing;
 *  `handle` moves one endpoint of a trendline only. */
export type DragMode =
  | {
      kind: 'body';
      id: string;
      /**
       * The drawing as it was when the drag STARTED, and the anchor every
       * frame measures from. Body drag is absolute, not incremental: each
       * pointermove recomputes the total (Δbar, Δprice) against this snapshot
       * and re-derives the shape from it.
       *
       * Why it has to be this way. Alignment snapping ADDS a correction to the
       * delta, and under the old frame-to-frame accumulation that correction
       * fed straight back into the anchor on the next move — so the moment the
       * shape unsnapped it stayed permanently offset from the cursor by
       * however much the magnet had pulled it. The invariant that kills that
       * class of bug: **a snap correction never enters an accumulator.** With
       * an absolute anchor there is no accumulator to poison.
       *
       * Safe to hold by reference: the store replaces the object on every
       * update (`{ ...d, ...patch }`), so this snapshot is never mutated
       * underneath us.
       */
      origin: Drawing;
      /** Cursor bar ordinal at grab time, or null when the grab began in the
       *  empty right band where the time axis can't resolve. Adopted from the
       *  first resolvable sample instead (see onPointerMove) so re-entering
       *  the data area doesn't jump the shape. */
      startBar: number | null;
      /** Cursor price at grab time — the vertical anchor. */
      startPrice: number;
      /** Most recent resolvable cursor bar. Frozen while the cursor sits in
       *  the empty band, which holds the shape's X still and lets the vertical
       *  drag keep working there. */
      lastBar: number | null;
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
  | { kind: 'vline-body'; id: string; lastRealMs: number | null; pointerId: number; paneId: PaneId }
  // Group body drag: every member of a multi-selection moves together.
  //
  // ⚠ 단건 `body` 와 달리 여기는 **프레임 간 누적**이다(lastRealMs/lastPy 를 매
  // 프레임 커서로 옮긴다). 그 방식이 성립하는 이유는 하나뿐이다 — **그룹 이동은
  // 이제 **단일 드래그와 같은 절대 앵커링**이고, 정렬 스냅도 함께 쓴다.
  // 그 전환이 선행 조건이었다 — 스냅 보정이 누적기에 들어가면 스냅이 풀린 뒤에도
  // 그룹이 그만큼 커서에서 영구히 어긋난다. 순서를 바꿨다면 그 버그가 그대로
  // 되살아났을 것이다.
  | {
      kind: 'body-multi';
      /**
       * The members as they were when the drag STARTED — the group's anchor,
       * same role `origin` plays for a single body drag and for the same
       * reason: alignment snapping adds a correction to the delta, and under
       * frame-to-frame accumulation that correction feeds back into the anchor,
       * so the group stays permanently offset from the cursor once it unsnaps.
       *
       * Holding the drawings themselves (not ids) also frees the move path from
       * re-filtering `ctx.drawings` every frame, and pins the SET: a member
       * deleted mid-drag simply stops receiving patches instead of silently
       * changing what "the group" means.
       */
      origins: readonly Drawing[];
      /** Cursor bar ordinal at grab time, or null when the grab began in the
       *  empty right band. Adopted from the first resolvable sample. */
      startBar: number | null;
      /** Most recent resolvable cursor bar — freezes X in the empty band. */
      lastBar: number | null;
      /** Press point, for the click-vs-drag slop test AND the vertical anchor.
       *  Vertical travels in PIXELS, not price: members may live on panes with
       *  different price scales, so a price delta is not shareable. */
      startPx: number;
      startPy: number;
      /** Which member was pressed. On a click (slop never crossed) the set
       *  collapses to it — the standard editor behavior: press-and-drag moves
       *  the group, press-and-release picks one out of it. */
      pressedId: string;
      /** Latched once the slop is crossed. Until then NO patch is issued, so a
       *  1px hand tremor cannot write a translate (and an undo entry) that the
       *  collapse would then have to talk around. */
      moved: boolean;
      pointerId: number;
      paneId: PaneId;
    };

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
  /**
   * The selected drawing id **when exactly one is selected**, else null.
   *
   * Deliberately not "the primary of the set": every reader of this field is a
   * handle path (trendline endpoints, rect corners), and handles must not
   * appear during a multi-selection — a handle and the group-drag would then
   * both claim the same pixel, and the invisible-to-the-user winner decides
   * whether the user resizes one shape or moves five. Collapsing the field to
   * "single selection only" makes that gate structural instead of a condition
   * every handle path has to remember.
   */
  selectedId: string | null;
  /** The whole selection, in order (empty = nothing selected). */
  selectedIds: readonly string[];
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
  marqueeDraft: Ref<MarqueeDraft | null>;
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

  /**
   * Whether shape-to-shape alignment snapping is armed — the magnet toggle is
   * on and the per-event Ctrl/Meta override is not held.
   *
   * Separate from the candle magnet's gate even though the same toggle drives
   * both: candle snapping needs loaded candles and lives inside `pixelToData`,
   * while this one needs only other rectangles and has to be visible to the
   * TOOL (it changes geometry, not a coordinate lookup). See alignSnap.ts.
   */
  alignSnapEnabled: boolean;
  /** Publish this frame's alignment guide lines, or `[]` to clear them. Tools
   *  MUST call it on every move — including the moves that snap nothing — or a
   *  stale guide stays painted after the shape has left it. */
  setAlignGuides(guides: readonly AlignGuide[]): void;

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
  /** Shift+click: add/remove one id from the selection. */
  toggleSelected(id: string): void;
  /** Marquee commit: union `ids` into the selection. */
  addToSelection(ids: readonly string[]): void;
  /** Batch patch — one undo step for the whole group (see the store action). */
  updateMany(patches: ReadonlyArray<{ id: string; patch: Partial<Drawing> }>): void;
  /** Every UNLOCKED drawing intersecting a pixel rectangle (marquee commit).
   *  The overlay binds `drawingsInRect` over `unlockedOnly(drawings)`. */
  drawingsInRect(rect: MarqueeRect): Drawing[];
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
  // 우측 확장 중이면 **오른쪽 두 코너를 후보에서 뺀다** — 그 변은 뷰포트 가장자리에
  // 고정이라 끌 대상이 아니고, 렌더도 그 핸들을 그리지 않는다(renderRectShape).
  // 어느 쪽이 오른쪽인지는 저장 순서(a/b)가 아니라 **투영된 픽셀**로 정한다: 코너를
  // 가로질러 끌면 a 가 b 의 오른쪽에 놓이므로, 저장 키로 판정하면 확장 후 엉뚱한
  // 두 핸들이 사라진다.
  const suppressedMsKey: 'a' | 'b' | null = isExtendedRight(r) ? (xb >= xa ? 'b' : 'a') : null;
  for (const c of corners) {
    if (c.msKey === suppressedMsKey) continue;
    if (Math.hypot(ctx.px - c.x, ctx.py - c.y) <= HIT_THRESHOLD.rectHandle) {
      return { msKey: c.msKey, priceKey: c.priceKey };
    }
  }
  return null;
}

// ─── alignment snapping helpers ────────────────────────────────────────────
//
// The kernel in alignSnap.ts is domain-agnostic; these three bind it to the
// chart. X travels as a BAR ORDINAL, never as realMs — that is the domain body
// drag already translates in, and the reason is the same one spelled out in
// `DragBarDomain`: a flat Δ-real-ms swallows inter-session gaps and strands
// corners inside them.

/**
 * Rectangles on `paneId` that a moving shape may align to.
 *
 * Same pane only — each pane has its own Y domain (KRW here, share counts
 * there), so a price from one is not comparable with a price from another.
 *
 * LOCKED rectangles are deliberately included. A lock says "don't edit me",
 * not "don't measure against me", and a locked shape is in fact the ideal
 * reference: the user pinned it precisely so other things could line up on it.
 *
 * Off-screen candidates need no filter — they fail the kernel's pixel
 * threshold on their own, and one that is merely unprojectable comes back as
 * a null pixel and is skipped there too.
 *
 * `exclude` is a SET, not one id, because a group drag has to remove every
 * member: leave one in and the group aligns to its own moving part, which is
 * the multi-selection version of a shape snapping to where it used to be.
 */
function alignTargets(ctx: ToolCtx, paneId: PaneId, exclude?: ReadonlySet<string>): SnapBox[] {
  const out: SnapBox[] = [];
  for (const d of ctx.drawings) {
    if (d.kind !== 'rect' || d.paneId !== paneId || exclude?.has(d.id)) continue;
    out.push({
      id: d.id,
      x: anchorsOf(ctx.dragBars.toBar(d.a.realMs), ctx.dragBars.toBar(d.b.realMs)),
      y: anchorsOf(d.a.price, d.b.price),
    });
  }
  return out;
}

/** Lift kernel guides (bar ordinals / prices) into the domain coordinates the
 *  renderer projects — the same shape `GhostPreview` travels in, for the same
 *  reason: one description, drawn by whichever pane canvas owns it. */
function toPaneGuides(
  ctx: ToolCtx,
  paneId: PaneId,
  raw: readonly RawAlignGuide[],
): AlignGuide[] {
  return raw.map((g) =>
    g.axis === 'x'
      ? { axis: 'x' as const, paneId, at: ctx.dragBars.toReal(g.at), from: g.from, to: g.to }
      : {
          axis: 'y' as const,
          paneId,
          at: g.at,
          from: ctx.dragBars.toReal(g.from),
          to: ctx.dragBars.toReal(g.to),
        },
  );
}

/**
 * Align a single point to neighbouring rectangles — the creation and
 * corner-resize path.
 *
 * A point, not the whole box, because in both gestures exactly ONE corner
 * moves. Feeding the resulting rectangle in would let the FIXED corner's
 * accidental alignment with some neighbour yank the corner the user is
 * actually dragging.
 *
 * `snapX: false` when the time axis can't resolve the cursor (the empty band
 * right of the last candle): the caller is holding X still there, and a magnet
 * that moved it anyway would look like the shape jumping on its own.
 */
function snapPointToRects(
  ctx: ToolCtx,
  p: Point,
  paneId: PaneId,
  opts: { excludeId?: string; snapX?: boolean } = {},
): { point: Point; guides: AlignGuide[] } {
  if (!ctx.alignSnapEnabled) return { point: p, guides: [] };
  const targets = alignTargets(ctx, paneId, opts.excludeId ? new Set([opts.excludeId]) : undefined);
  if (targets.length === 0) return { point: p, guides: [] };
  const bar = ctx.dragBars.toBar(p.realMs);
  const snapped = alignSnapBox({ x: pointAnchors(bar), y: pointAnchors(p.price) }, targets, {
    xToPx:
      opts.snapX === false ? () => null : (b) => ctx.realMsToCanvasX(ctx.dragBars.toReal(b)),
    yToPx: (v) => ctx.priceToCanvasY(v, paneId),
  });
  return {
    point: {
      // toReal only when the magnet actually fired: it rounds onto the bar
      // grid, and an untouched realMs must come through byte-identical.
      realMs: snapped.dx === 0 ? p.realMs : ctx.dragBars.toReal(bar + snapped.dx),
      price: p.price + snapped.dy,
    },
    guides: toPaneGuides(ctx, paneId, snapped.guides),
  };
}

/** Plan entries keyed by drawing id, for reading a planned position back. */
type GroupPlan = ReturnType<typeof planGroupTranslate>;

/**
 * Bounding box of the group's RECTANGLES after a plan is applied, in the
 * kernel's domains (bar ordinals for x, prices for y).
 *
 * Read from the PLAN's patches rather than recomputed from the originals plus
 * a delta: the vertical delta enters `planGroupTranslate` as PIXELS and is
 * converted per member against that member's own reference price, so the plan's
 * output is the only place the resulting prices actually exist.
 *
 * Rectangles only — they are what alignment is defined on. A group may also
 * hold lines and labels; they ride along on whatever the rectangles decide.
 */
function groupRectBox(
  rects: readonly Rect[],
  plan: GroupPlan,
  toBar: (realMs: number) => number,
): { x: Anchors; y: Anchors } | null {
  const byId = new Map(plan.map((e) => [e.id, e.patch as Partial<Rect>]));
  let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
  for (const r of rects) {
    const patch = byId.get(r.id);
    const a = patch?.a ?? r.a;
    const b = patch?.b ?? r.b;
    for (const bar of [toBar(a.realMs), toBar(b.realMs)]) {
      xLo = Math.min(xLo, bar); xHi = Math.max(xHi, bar);
    }
    for (const price of [a.price, b.price]) {
      yLo = Math.min(yLo, price); yHi = Math.max(yHi, price);
    }
  }
  if (!Number.isFinite(xLo) || !Number.isFinite(yLo)) return null;
  return { x: anchorsOf(xLo, xHi), y: anchorsOf(yLo, yHi) };
}

/** Agreement tolerance in canvas px when checking whether the clamps let a
 *  group snap through intact. Sub-pixel, because the question is "did the plan
 *  land where the magnet asked", not "is it close enough to look right". */
const GROUP_SNAP_EPS_PX = 0.5;

/**
 * Alignment snapping for a GROUP body drag: the selection's rectangle bounding
 * box grabs its neighbours' edges, and every member moves with it.
 *
 * Two passes, because the vertical delta is denominated in pixels and the
 * clamps are computed for the whole set: the only way to know where the group
 * WOULD land is to plan it. So pass 1 plans without the magnet, the box that
 * produces is what gets matched against the neighbours, and pass 2 re-plans
 * with the correction folded into the same raw deltas.
 *
 * Then the result is CHECKED before it is accepted. A group clamp can trim the
 * correction (a member hitting its pane's edge caps the whole set), and a
 * trimmed snap is the one outcome worse than none: the guide line claims the
 * edges are flush while the group sits a few pixels off. If pass 2 did not land
 * where the magnet asked, pass 1 stands and no guide is drawn.
 *
 * Snapping needs every rectangle on ONE pane. The candidate list is per-pane
 * (prices are only comparable within a scale), so a selection straddling panes
 * has no single place to take its references from — and unlike the single-shape
 * path there is no obvious pane to prefer. Such a group drags unsnapped.
 */
function groupAlignSnap(
  ctx: ToolCtx,
  members: readonly Drawing[],
  plan0: GroupPlan,
  dBarRaw: number,
  dyPxRaw: number,
  coords: GroupTranslateCoords,
): { plan: GroupPlan; guides: AlignGuide[] } {
  const none = { plan: plan0, guides: [] as AlignGuide[] };
  if (!ctx.alignSnapEnabled) return none;
  const rects = members.filter((m): m is Rect => m.kind === 'rect');
  if (rects.length === 0) return none;
  const paneId = rects[0].paneId;
  if (rects.some((r) => r.paneId !== paneId)) return none;

  const box = groupRectBox(rects, plan0, coords.toBar);
  if (box == null) return none;
  // Every member leaves the candidate list, not just the rectangles: an id that
  // stayed in would let the group align to a piece of itself.
  const targets = alignTargets(ctx, paneId, new Set(members.map((m) => m.id)));
  if (targets.length === 0) return none;

  const xToPx = (bar: number) => ctx.realMsToCanvasX(coords.toReal(bar));
  const yToPx = (price: number) => ctx.priceToCanvasY(price, paneId);
  const snap = alignSnapBox(box, targets, { xToPx, yToPx });
  if (snap.dx === 0 && snap.dy === 0) return none;

  // The kernel speaks prices; the group plan takes pixels. Convert against the
  // box's own top edge so the two agree on this pane's scale.
  let dyPxSnap = 0;
  if (snap.dy !== 0) {
    const y0 = yToPx(box.y.min);
    const y1 = yToPx(box.y.min + snap.dy);
    if (y0 == null || y1 == null) return none;
    dyPxSnap = y1 - y0;
  }

  const plan1 = planGroupTranslate(members, dBarRaw + snap.dx, dyPxRaw + dyPxSnap, coords);
  const landed = groupRectBox(rects, plan1, coords.toBar);
  if (landed == null) return none;
  const agrees = (
    got: number | null,
    want: number | null,
  ) => got != null && want != null && Math.abs(got - want) < GROUP_SNAP_EPS_PX;
  const okX = snap.dx === 0 || agrees(xToPx(landed.x.min), xToPx(box.x.min + snap.dx));
  const okY = snap.dy === 0 || agrees(yToPx(landed.y.min), yToPx(box.y.min + snap.dy));
  if (!okX || !okY) return none;

  return { plan: plan1, guides: toPaneGuides(ctx, paneId, snap.guides) };
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
    // ── Shift: 선택을 편집하는 제스처. 드래그는 절대 시작하지 않는다 ────────
    //
    // 도형 위면 토글, 빈 곳이면 마퀴. 둘을 한 modifier 로 묶는 이유는 사용자가
    // 겨냥한 것이 "선택에 더하기" 하나로 같기 때문이다 — 도형을 정확히 맞히면
    // 그 하나가, 빗나가면 감싼 범위가 들어온다. Shift 를 누른 채 도형을 끌어
    // 옮기는 경로가 없는 것도 의도다: 그러면 토글과 이동이 같은 픽셀에서
    // 경합하고, 사용자는 "고르려다 옮겨 버린" 상태를 되돌려야 한다.
    if (ctx.shiftKey) {
      const shiftHit = ctx.hitTestUnlockedAt(ctx.px, ctx.py);
      if (shiftHit) {
        ctx.toggleSelected(shiftHit.id);
        return;
      }
      ctx.marqueeDraft.current = {
        ax: ctx.px,
        ay: ctx.py,
        bx: ctx.px,
        by: ctx.py,
        pointerId: ctx.pointerId,
      };
      ctx.capturePointer();
      return;
    }
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
    // 여러 개가 선택된 상태에서 **그중 하나**를 잡았다면 집합 전체를 끈다. 선택은
    // 여기서 건드리지 않는다 — 끌지 않고 놓았을 때만(slop 미달) pointerUp 이
    // 이 하나로 접는다.
    if (hit && ctx.selectedIds.length > 1 && ctx.selectedIds.includes(hit.id)) {
      ctx.dragRef.current = {
        kind: 'body-multi',
        // Snapshot the members as grabbed. Locked ones are dropped HERE rather
        // than every frame: the set the user grabbed is the set that moves.
        origins: ctx.drawings.filter((d) => ctx.selectedIds.includes(d.id) && !isLocked(d)),
        startBar: (() => {
          const ms = ctx.canvasXToRealMs(ctx.px);
          return ms == null ? null : ctx.dragBars.toBar(ms);
        })(),
        lastBar: (() => {
          const ms = ctx.canvasXToRealMs(ctx.px);
          return ms == null ? null : ctx.dragBars.toBar(ms);
        })(),
        startPx: ctx.px,
        startPy: ctx.py,
        pressedId: hit.id,
        moved: false,
        pointerId: ctx.pointerId,
        paneId: hit.paneId,
      };
      ctx.capturePointer();
      return;
    }
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
      const startBar = data ? ctx.dragBars.toBar(data.realMs) : null;
      ctx.dragRef.current = {
        kind: 'body',
        id: hit.id,
        // Snapshot the shape as grabbed — every later frame is measured from
        // here rather than from the previous frame. See DragMode.origin.
        origin: hit,
        startBar,
        startPrice: price,
        lastBar: startBar,
        pointerId: ctx.pointerId,
        paneId: hit.paneId,
      };
      ctx.capturePointer();
    }
  },
  onPointerMove(ctx) {
    const marquee = ctx.marqueeDraft.current;
    if (marquee && marquee.pointerId === ctx.pointerId) {
      marquee.bx = ctx.px;
      marquee.by = ctx.py;
      // 드래프트는 React state 가 아니므로 스스로 리렌더를 못 낸다.
      ctx.requestRedraw();
      return;
    }
    const drag = ctx.dragRef.current;
    if (!drag || drag.pointerId !== ctx.pointerId) return;
    if (drag.kind === 'body-multi') {
      // 클릭/드래그 판정: slop 을 넘기 전엔 **아무 패치도 내지 않는다**. 절대
      // 앵커링에서는 이 성질이 공짜다 — 앵커(startBar/startPy)가 애초에 움직이지
      // 않으므로, 넘는 순간 눌린 지점부터의 이동량이 한 번에 반영된다.
      if (!drag.moved) {
        if (Math.hypot(ctx.px - drag.startPx, ctx.py - drag.startPy) < MULTI_DRAG_SLOP_PX) return;
        drag.moved = true;
      }
      // 멤버는 그랩 시점 스냅샷이다 — 드래그 중에 집합이 바뀌지 않는다.
      //
      // 잠금은 **두 번** 거른다. onPointerDown 이 스냅샷을 만들 때 한 번(그래야
      // 그룹 클램프가 "움직일 수 없는 도형" 때문에 전체를 얼리지 않는다), 그리고
      // 여기서 한 번 — 스냅샷을 든 사이에 다른 창이 일괄 잠금을 걸 수 있고,
      // 스토어가 어차피 거부할 패치를 내보내지 않는 편이 정직하다.
      const members = drag.origins.filter((d) => !isLocked(d));
      if (members.length === 0) return;
      const curRealMs = ctx.canvasXToRealMs(ctx.px);
      // 빈 밴드에서 시작한 그랩은 첫 해석 샘플을 원점으로 삼는다(단일 body 와 동일).
      if (drag.startBar == null && curRealMs != null) {
        drag.startBar = ctx.dragBars.toBar(curRealMs);
      }
      if (curRealMs != null) drag.lastBar = ctx.dragBars.toBar(curRealMs);
      const dBarRaw =
        drag.lastBar != null && drag.startBar != null ? drag.lastBar - drag.startBar : 0;
      const dyPxRaw = ctx.py - drag.startPy;
      const coords: GroupTranslateCoords = {
        priceToCanvasY: ctx.priceToCanvasY,
        canvasYToPrice: ctx.canvasYToPrice,
        priceBoundsForPane: ctx.priceBoundsForPane,
        toBar: ctx.dragBars.toBar,
        toReal: ctx.dragBars.toReal,
        originBar: ctx.dragBars.originBar,
      };
      // 스냅 보정은 plan 에만 들어가고 startBar/startPy 는 건드리지 않는다 —
      // 단일 드래그와 같은 불변식이다.
      const planned = groupAlignSnap(
        ctx,
        members,
        planGroupTranslate(members, dBarRaw, dyPxRaw, coords),
        dBarRaw,
        dyPxRaw,
        coords,
      );
      ctx.setAlignGuides(planned.guides);
      ctx.updateMany(planned.plan);
      return;
    }
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
      // The moving corner, aligned to neighbouring rects. Resize is already
      // absolute (the corner is assigned, not accumulated), so the snap needs
      // no anchoring machinery here — only the point.
      const corner = snapPointToRects(
        ctx,
        { realMs: curRealMs ?? msPoint.realMs, price },
        drag.paneId,
        { excludeId: target.id, snapX: curRealMs != null },
      );
      ctx.setAlignGuides(corner.guides);
      const newMs = corner.point.realMs;
      const newPrice = corner.point.price;
      const patch: Partial<Pick<Rect, 'a' | 'b'>> = {};
      if (drag.msKey === drag.priceKey) {
        patch[drag.msKey] = { realMs: newMs, price: newPrice };
      } else {
        patch[drag.msKey] = { realMs: newMs, price: msPoint.price };
        patch[drag.priceKey] = { realMs: prPoint.realMs, price: newPrice };
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
      // ABSOLUTE anchoring: both deltas are measured from the grab, never from
      // the previous frame. The horizontal one lives in BAR ORDINALS because
      // shifting stored real timestamps by a flat Δ-real-ms stranded vertices
      // inside inter-session gaps whenever the cursor crossed a day boundary
      // (the gap's whole duration entered the delta), which rendered
      // rect/measure stretched to the canvas edge or not at all. Δ-virtual-ms
      // fixed that but is not uniform on screen — a day boundary spans 1 000
      // virtual ms and a full column — so a vertex straddling one moved two
      // columns per one of the cursor's and the shape stretched. Ordinals are
      // the screen's own units, so cursor and every vertex move together.
      const origin = drag.origin;
      // A grab that began in the empty band has no origin bar yet; adopt the
      // first resolvable sample instead of measuring from nothing, or the
      // shape would leap by the whole absolute ordinal on re-entry.
      if (drag.startBar == null && curRealMs != null) {
        drag.startBar = ctx.dragBars.toBar(curRealMs);
      }
      if (curRealMs != null) drag.lastBar = ctx.dragBars.toBar(curRealMs);
      // `lastBar` (not the live cursor) so the X freezes in the empty band
      // where the time axis can't resolve, while vertical drag keeps working.
      const rawDBar =
        drag.lastBar != null && drag.startBar != null ? drag.lastBar - drag.startBar : 0;
      // Shape-preserving cap against the axis origin — the time-axis sibling
      // of the price cap below. Without it a leftward overshoot would floor
      // vertices one by one at the first session's open, compressing the shape.
      let dBar = clampDBarForDrawing(
        origin,
        rawDBar,
        ctx.dragBars.originBar,
        ctx.dragBars.toBar,
      );
      // Shape-preserving cap: compute the largest |dPrice| that keeps every
      // vertex inside the pane, then translate once. Post-translate per-vertex
      // clamping would have collapsed a trendline/pencil that touched the
      // boundary asymmetrically.
      const paneBounds = ctx.priceBoundsForPane(drag.paneId);
      let dPrice = paneBounds
        ? clampDPriceForDrawing(origin, price - drag.startPrice, paneBounds)
        : price - drag.startPrice;

      // Alignment snapping rides on TOP of the clamped delta, and its result is
      // written to the locals only — `drag.startBar`/`startPrice` never see it.
      // That is the invariant from DragMode.origin: a correction that entered
      // the anchor would survive the unsnap as a permanent cursor offset.
      let guides: AlignGuide[] = [];
      if (origin.kind === 'rect' && ctx.alignSnapEnabled) {
        const targets = alignTargets(ctx, drag.paneId, new Set([origin.id]));
        const snapped = alignSnapBox(
          {
            x: anchorsOf(
              ctx.dragBars.toBar(origin.a.realMs) + dBar,
              ctx.dragBars.toBar(origin.b.realMs) + dBar,
            ),
            y: anchorsOf(origin.a.price + dPrice, origin.b.price + dPrice),
          },
          targets,
          {
            xToPx: (bar) => ctx.realMsToCanvasX(ctx.dragBars.toReal(bar)),
            yToPx: (v) => ctx.priceToCanvasY(v, drag.paneId),
            // Refuse a correction the caps would trim. A TRIMMED snap is the
            // one outcome worse than no snap: the guide line claims the edges
            // are flush while the shape sits a few pixels off it.
            acceptX: (d) =>
              clampDBarForDrawing(
                origin,
                dBar + d,
                ctx.dragBars.originBar,
                ctx.dragBars.toBar,
              ) === dBar + d,
            acceptY: (d) =>
              paneBounds == null ||
              clampDPriceForDrawing(origin, dPrice + d, paneBounds) === dPrice + d,
          },
        );
        dBar += snapped.dx;
        dPrice += snapped.dy;
        guides = toPaneGuides(ctx, drag.paneId, snapped.guides);
      }
      ctx.setAlignGuides(guides);

      // The round-trip runs even when dBar is 0: for a healthy vertex it is the
      // identity, and for one stranded in a gap by the old real-ms drags it
      // snaps forward to the next session open — grabbing a broken drawing
      // heals it.
      const shift = (ms: number) => ctx.dragBars.toReal(ctx.dragBars.toBar(ms) + dBar);
      ctx.update(origin.id, translateDrawing(origin, shift, dPrice));
    }
  },
  onPointerUp(ctx) {
    const marquee = ctx.marqueeDraft.current;
    if (marquee && marquee.pointerId === ctx.pointerId) {
      ctx.marqueeDraft.current = null;
      ctx.releasePointer();
      const rect = marqueeRect(marquee.ax, marquee.ay, marquee.bx, marquee.by);
      // 빈 곳 Shift+클릭(사실상 0px 박스)은 아무것도 고르지 않는다 — 선택을
      // 지우지도 않는다. 마퀴를 놓친 클릭이 애써 모은 집합을 날리면 안 된다.
      const wide = rect.x2 - rect.x1 >= MARQUEE_MIN_PX;
      const tall = rect.y2 - rect.y1 >= MARQUEE_MIN_PX;
      if (wide || tall) {
        ctx.addToSelection(ctx.drawingsInRect(rect).map((d) => d.id));
      }
      ctx.requestRedraw(); // 마퀴 사각형을 화면에서 지운다
      return;
    }
    const drag = ctx.dragRef.current;
    if (!drag || drag.pointerId !== ctx.pointerId) return;
    // 끌지 않고 놓은 멤버 클릭 → 집합을 그 하나로 접는다.
    if (drag.kind === 'body-multi' && !drag.moved) ctx.setSelected(drag.pressedId);
    ctx.dragRef.current = null;
    // Guides are per-gesture: leaving them up would paint a line against a
    // shape that is no longer moving.
    ctx.setAlignGuides([]);
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
    // The first corner aligns too — a new rect can be born flush against its
    // neighbour, which is the whole point of drawing one next to another. No
    // exclude id: the shape being drawn is not in the store yet.
    const anchor = snapPointToRects(ctx, data, paneId);
    ctx.setAlignGuides(anchor.guides);
    ctx.rectDraft.current = { a: anchor.point, pointerId: ctx.pointerId, paneId };
    ctx.capturePointer();
  },
  onPointerMove(ctx) {
    const draft = ctx.rectDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    if (!data) return;
    const moving = snapPointToRects(ctx, data, draft.paneId);
    ctx.setAlignGuides(moving.guides);
    draft.b = moving.point;
    ctx.requestRedraw();
  },
  onPointerUp(ctx) {
    const draft = ctx.rectDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const raw = ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    // Commit the SNAPPED corner, not the raw one: the preview showed the
    // aligned box, so anything else would visibly shift on pointer-up.
    const data = raw ? snapPointToRects(ctx, raw, draft.paneId).point : null;
    ctx.rectDraft.current = null;
    ctx.setAlignGuides([]);
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
