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
  PENCIL_MAX_POINTS,
  HIT_THRESHOLD,
} from './types';
import { translateDrawing, clampDPriceForDrawing } from './translate';

/** A per-gesture draft for the trendline tool — first point captured on
 *  pointer-down, committed on pointer-up. */
export type TrendlineDraft = { a: Point; pointerId: number; paneId: PaneId };

/** A per-gesture draft for the pencil tool. `lastFrame` carries the
 *  performance.now() of the last appended point so the move handler can
 *  throttle to RAF cadence (~16ms). */
export type PencilDraft = {
  points: Point[];
  pointerId: number;
  lastFrame: number;
  paneId: PaneId;
};

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
  | { kind: 'handle'; id: string; endpoint: 'a' | 'b'; pointerId: number; paneId: PaneId };

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
  /** Pin the active pointer to the overlay until releasePointer is called. */
  capturePointer(): void;
  releasePointer(): void;

  /** Convert (px, py) → (realMs, price) using `paneId`'s price scale. */
  pixelToData(px: number, py: number, paneId: PaneId): Point | null;
  /** Convert a stored realMs to a canvas X. Returns null when the realMs
   *  falls outside every Virtual Axis segment. */
  realMsToCanvasX(realMs: number): number | null;
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
  dragRef: Ref<DragMode | null>;

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
  /** Returns the overlay to select mode with the just-added drawing selected,
   *  so the property panel attaches to the new shape. See ADR-0032 (supersedes
   *  ADR-0030's "clears selection" semantic). */
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

// ─── select ────────────────────────────────────────────────────────────────
//
// Select mode owns hit-test → selection update → optional drag. Trendline
// endpoint handles take precedence over body hit-test when the currently
// selected drawing is a trendline (so a click on a handle moves only that
// endpoint, not the whole line).
export const selectTool: DrawingToolSpec = {
  kind: 'select',
  label: '선택',
  glyph: '↶',
  cursor: 'default',
  shortcut: { alt: true, key: 'v' },
  onPointerDown(ctx) {
    const selected = ctx.selectedId
      ? ctx.drawings.find((d) => d.id === ctx.selectedId)
      : null;
    if (selected && selected.kind === 'trendline') {
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
    const hit = ctx.hitTestAt(ctx.px, ctx.py);
    ctx.setSelected(hit?.id ?? null);
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
    if (drag.kind === 'handle' && target.kind === 'trendline') {
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
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'hline',
      price: data.price,
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId,
    });
    ctx.revertToSelectMode(id);
  },
};

// ─── trendline ─────────────────────────────────────────────────────────────
export const trendlineTool: DrawingToolSpec = {
  kind: 'trendline',
  label: '추세선',
  glyph: '╱',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 't' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    ctx.trendlineDraft.current = { a: data, pointerId: ctx.pointerId, paneId };
    ctx.capturePointer();
  },
  onPointerUp(ctx) {
    const draft = ctx.trendlineDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.pixelToData(ctx.px, clampedY, draft.paneId);
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
    ctx.revertToSelectMode(id);
  },
};

// ─── pencil ────────────────────────────────────────────────────────────────
export const pencilTool: DrawingToolSpec = {
  kind: 'pencil',
  label: '연필',
  glyph: '✎',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'p' },
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
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'pencil',
      points: draft.points,
      color: ctx.defaults.color,
      width: ctx.defaults.width,
      lineStyle: ctx.defaults.lineStyle,
      paneId: draft.paneId,
    });
    ctx.revertToSelectMode(id);
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
  trendline: trendlineTool,
  pencil: pencilTool,
  eraser: eraserTool,
};

export const DRAWABLE_TOOLS_ORDER: readonly DrawingTool[] = [
  'hline',
  'trendline',
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
