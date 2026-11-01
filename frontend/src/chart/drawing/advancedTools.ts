import { nanoid } from 'nanoid';
import type { DrawingToolSpec, ToolCtx } from './tools';
import type { AdvancedDrawing, DrawingStyle, PaneId, Point } from './types';
import { FIB_EXTENSION_LEVELS, PATH_MAX_POINTS } from './types';
import { fitRegression } from './regression';

type DraftBase = { paneId: PaneId; pointerId: number; style: DrawingStyle };
export type AdvancedDraft = DraftBase & (
  | { kind: 'path'; points: Point[]; hover?: Point; lastClickAdded?: boolean }
  | { kind: 'callout'; a: Point; offsetX: number; offsetY: number; startPx: number; startPy: number }
  | { kind: 'fib-extension'; a: Point; b: Point; c: Point; phase: 'baseline' | 'third' }
  | { kind: 'regression'; a: Point; b: Point }
);

export function drawingFromAdvancedDraft(d: AdvancedDraft, preview = true): AdvancedDrawing | null {
  const base = { id: '__advanced_draft__', color: d.style.color, width: d.style.width,
    lineStyle: d.style.lineStyle, paneId: d.paneId };
  if (d.kind === 'path') {
    const points = [...d.points, ...(preview && d.hover ? [d.hover] : [])];
    return points.length < 2 ? null : { ...base, kind: 'path', points, arrowEnd: true };
  }
  if (d.kind === 'callout') return { ...base, kind: 'callout', a: d.a, offsetX: d.offsetX,
    offsetY: d.offsetY, text: '메모', fontSize: d.style.fontSize };
  if (d.kind === 'fib-extension') return { ...base, kind: d.kind, a: d.a, b: d.b, c: d.c,
    levels: [...FIB_EXTENSION_LEVELS], extendRight: true, ...(d.style.labelHidden ? { labelHidden: true } : {}) };
  return { ...base, kind: 'regression', a: d.a, b: d.b, source: 'close', upperDeviation: 2,
    lowerDeviation: 2, fillOpacity: d.style.fillOpacity };
}

export function finishPath(ctx: Pick<ToolCtx, 'advancedDraft' | 'add' | 'requestRedraw'>, doubleClick = false): boolean {
  const draft = ctx.advancedDraft?.current;
  if (!draft || draft.kind !== 'path') return false;
  const points = doubleClick && draft.lastClickAdded !== false ? draft.points.slice(0, -1) : draft.points;
  const unique = points.filter((p, i) => i === 0 || p.realMs !== points[i - 1].realMs || p.price !== points[i - 1].price);
  if (unique.length < 2) return false;
  const drawing = drawingFromAdvancedDraft({ ...draft, points: unique }, false)!;
  drawing.id = nanoid(8);
  ctx.advancedDraft!.current = null; ctx.add(drawing); ctx.requestRedraw(); return true;
}

export const pathTool: DrawingToolSpec = {
  kind: 'path', label: '경로', glyph: '↗', cursor: 'crosshair',
  onPointerDown(ctx) {
    if (!ctx.advancedDraft) return;
    const draft = ctx.advancedDraft.current;
    const paneId = draft?.paneId ?? ctx.paneIdAtY(ctx.py);
    const p = ctx.pixelToData(ctx.px, ctx.py, paneId); if (!p) return;
    if (draft?.kind === 'path') {
      draft.lastClickAdded = draft.points.length < PATH_MAX_POINTS;
      if (draft.lastClickAdded) draft.points.push(p);
      draft.hover = undefined;
    } else ctx.advancedDraft.current = { kind: 'path', points: [p], paneId,
      pointerId: ctx.pointerId, style: { ...ctx.defaults } };
    ctx.requestRedraw();
  },
  onPointerMove(ctx) {
    const draft = ctx.advancedDraft?.current;
    if (draft?.kind !== 'path' || draft.points.length >= PATH_MAX_POINTS) return;
    draft.hover = ctx.pixelToData(ctx.px, ctx.py, draft.paneId) ?? undefined;
    ctx.requestRedraw();
  },
};

export function advancedTool(kind: 'fib-extension' | 'callout' | 'regression', label: string): DrawingToolSpec {
  const move = (ctx: ToolCtx) => {
    const d = ctx.advancedDraft?.current; if (!d || d.kind === 'path') return;
    if (d.kind === 'callout') {
      d.offsetX = ctx.px - d.startPx; d.offsetY = ctx.py - d.startPy;
    } else {
      const p = ctx.pixelToData(ctx.px, ctx.py, d.paneId); if (!p) return;
      if (d.kind === 'fib-extension' && d.phase === 'third') d.c = p; else d.b = p;
    }
    ctx.requestRedraw();
  };
  return {
    kind, label, glyph: '╱', cursor: 'crosshair',
    onPointerDown(ctx) {
      if (!ctx.advancedDraft) return;
      const d = ctx.advancedDraft.current;
      if (d?.kind === 'fib-extension' && d.phase === 'third') {
        move(ctx); const drawing = drawingFromAdvancedDraft(d)!; drawing.id = nanoid(8);
        ctx.advancedDraft.current = null; ctx.add(drawing); ctx.requestRedraw(); return;
      }
      const paneId = ctx.paneIdAtY(ctx.py);
      if (kind === 'regression' && paneId !== 'candle') return;
      const a = ctx.pixelToData(ctx.px, ctx.py, paneId); if (!a) return;
      const base = { paneId, pointerId: ctx.pointerId, style: { ...ctx.defaults }, a };
      ctx.advancedDraft.current = kind === 'callout'
        ? { ...base, kind, startPx: ctx.px, startPy: ctx.py, offsetX: 80, offsetY: -50 }
        : kind === 'fib-extension' ? { ...base, kind, b: a, c: a, phase: 'baseline' }
          : { ...base, kind, b: a };
      ctx.capturePointer(); ctx.requestRedraw();
    },
    onPointerMove(ctx) {
      const d = ctx.advancedDraft?.current;
      if (d && (d.pointerId === ctx.pointerId || d.kind === 'fib-extension' && d.phase === 'third')) move(ctx);
    },
    onPointerUp(ctx) {
      const d = ctx.advancedDraft?.current;
      if (!d || !ctx.advancedDraft || d.kind === 'path' || d.pointerId !== ctx.pointerId
        || d.kind === 'fib-extension' && d.phase === 'third') return;
      move(ctx); ctx.releasePointer();
      if (d.kind === 'callout') {
        ctx.advancedDraft.current = null;
        const small = Math.hypot(d.offsetX, d.offsetY) < 3;
        ctx.beginCalloutEdit?.(d.a, d.paneId, small ? 80 : d.offsetX, small ? -50 : d.offsetY);
        ctx.requestRedraw(); return;
      }
      if (d.kind === 'fib-extension') {
        if (d.a.price === d.b.price) { ctx.advancedDraft.current = null; ctx.requestRedraw(); return; }
        d.phase = 'third'; d.c = d.b; ctx.requestRedraw(); return;
      }
      const drawing = drawingFromAdvancedDraft(d)!;
      ctx.advancedDraft.current = null;
      if (drawing.kind === 'regression' && fitRegression(drawing, ctx.candles)) {
        drawing.id = nanoid(8); ctx.add(drawing);
      }
      ctx.requestRedraw();
    },
  };
}
