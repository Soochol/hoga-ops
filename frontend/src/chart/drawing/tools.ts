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
  type DrawingTool,
  type Point,
  PENCIL_MAX_POINTS,
  HIT_THRESHOLD,
} from './types';
import { translateDrawing } from './translate';

/** A per-gesture draft for the trendline tool — first point captured on
 *  pointer-down, committed on pointer-up. */
export type TrendlineDraft = { a: Point; pointerId: number };

/** A per-gesture draft for the pencil tool. `lastFrame` carries the
 *  performance.now() of the last appended point so the move handler can
 *  throttle to RAF cadence (~16ms). */
export type PencilDraft = {
  points: Point[];
  pointerId: number;
  lastFrame: number;
};

/** Active drag in select mode. `body` translates the whole drawing;
 *  `handle` moves one endpoint of a trendline only. */
export type DragMode =
  | { kind: 'body'; id: string; lastRealMs: number; lastPrice: number; pointerId: number }
  | { kind: 'handle'; id: string; endpoint: 'a' | 'b'; pointerId: number };

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

  /** Convert (px, py) → (realMs, price). Returns null if either axis can't
   *  resolve the coordinate (e.g. price series not mounted yet). */
  pixelToData(px: number, py: number): Point | null;
  /** Convert a stored realMs to a canvas X. Returns null when the realMs
   *  falls outside every Virtual Axis segment. */
  realMsToCanvasX(realMs: number): number | null;
  /** Convert a stored price to a canvas Y. Returns null when no price
   *  series is available. */
  priceToCanvasY(price: number): number | null;
  /** Hit-test all drawings (reverse / topmost-first). */
  hitTestAt(px: number, py: number): Drawing | null;

  /** The current Drawing list for the active Code. */
  drawings: readonly Drawing[];
  /** Currently selected drawing id, if any. */
  selectedId: string | null;
  /** Resolved accent hex (canvas-safe — no CSS `var(--…)`). */
  accentColor: string;

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
  /** Helper that selects the just-committed drawing and reverts the active
   *  tool to `select`. Called by tools that auto-revert after commit
   *  (hline, trendline, pencil). The overlay's buildCtx wires this to
   *  `setSelected(id)` + `setActiveTool('select')` on the store. */
  commitAndRevert(id: string): void;
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

const DRAWING_WIDTH = 1.5;

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
    // Trendline handle hit-test first (only if a trendline is selected).
    const selected = ctx.selectedId
      ? ctx.drawings.find((d) => d.id === ctx.selectedId)
      : null;
    if (selected && selected.kind === 'trendline') {
      const xa = ctx.realMsToCanvasX(selected.a.realMs);
      const ya = ctx.priceToCanvasY(selected.a.price);
      const xb = ctx.realMsToCanvasX(selected.b.realMs);
      const yb = ctx.priceToCanvasY(selected.b.price);
      if (xa != null && ya != null && Math.hypot(ctx.px - xa, ctx.py - ya) <= HIT_THRESHOLD.trendlineHandle) {
        ctx.dragRef.current = { kind: 'handle', id: selected.id, endpoint: 'a', pointerId: ctx.pointerId };
        ctx.capturePointer();
        return;
      }
      if (xb != null && yb != null && Math.hypot(ctx.px - xb, ctx.py - yb) <= HIT_THRESHOLD.trendlineHandle) {
        ctx.dragRef.current = { kind: 'handle', id: selected.id, endpoint: 'b', pointerId: ctx.pointerId };
        ctx.capturePointer();
        return;
      }
    }
    const hit = ctx.hitTestAt(ctx.px, ctx.py);
    ctx.setSelected(hit?.id ?? null);
    if (hit) {
      const data = ctx.pixelToData(ctx.px, ctx.py);
      if (!data) return;
      ctx.dragRef.current = {
        kind: 'body',
        id: hit.id,
        lastRealMs: data.realMs,
        lastPrice: data.price,
        pointerId: ctx.pointerId,
      };
      ctx.capturePointer();
    }
  },
  onPointerMove(ctx) {
    const drag = ctx.dragRef.current;
    if (!drag || drag.pointerId !== ctx.pointerId) return;
    const data = ctx.pixelToData(ctx.px, ctx.py);
    if (!data) return;
    const target = ctx.drawings.find((d) => d.id === drag.id);
    if (!target) return;
    if (drag.kind === 'handle' && target.kind === 'trendline') {
      const patch = drag.endpoint === 'a' ? { a: data } : { b: data };
      ctx.update(target.id, patch as Partial<Drawing>);
      return;
    }
    if (drag.kind === 'body') {
      const dMs = data.realMs - drag.lastRealMs;
      const dPrice = data.price - drag.lastPrice;
      ctx.update(target.id, translateDrawing(target, dMs, dPrice));
      drag.lastRealMs = data.realMs;
      drag.lastPrice = data.price;
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
    const data = ctx.pixelToData(ctx.px, ctx.py);
    if (!data) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'hline',
      price: data.price,
      color: ctx.accentColor,
      width: DRAWING_WIDTH,
    });
    ctx.commitAndRevert(id);
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
    const data = ctx.pixelToData(ctx.px, ctx.py);
    if (!data) return;
    ctx.trendlineDraft.current = { a: data, pointerId: ctx.pointerId };
    ctx.capturePointer();
  },
  // No onPointerMove — preview-during-drag is a v1 follow-up.
  onPointerUp(ctx) {
    const draft = ctx.trendlineDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const data = ctx.pixelToData(ctx.px, ctx.py);
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
      color: ctx.accentColor,
      width: DRAWING_WIDTH,
    });
    ctx.commitAndRevert(id);
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
    const data = ctx.pixelToData(ctx.px, ctx.py);
    if (!data) return;
    ctx.pencilDraft.current = { points: [data], pointerId: ctx.pointerId, lastFrame: 0 };
    ctx.capturePointer();
  },
  onPointerMove(ctx) {
    const draft = ctx.pencilDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const now = performance.now();
    if (now - draft.lastFrame < 16) return; // RAF-aligned throttle (spec G11)
    draft.lastFrame = now;
    const data = ctx.pixelToData(ctx.px, ctx.py);
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
      color: ctx.accentColor,
      width: DRAWING_WIDTH,
    });
    ctx.commitAndRevert(id);
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
