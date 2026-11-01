import { nanoid } from 'nanoid';
import type { DrawingToolSpec, ToolCtx } from './tools';
import type { AnalysisDrawing, DrawingStyle, PaneId, Point } from './types';
import { FIB_LEVELS } from './types';
import { validPosition } from './analysisGeometry';

export type AnalysisDraft = {
  kind: Exclude<AnalysisDrawing['kind'], 'hray'>;
  a: Point; b: Point; c?: Point;
  paneId: PaneId; pointerId: number;
  phase: 'baseline' | 'width';
  style: DrawingStyle;
};

export function drawingFromAnalysisDraft(d: AnalysisDraft): AnalysisDrawing {
  const base = { id: '__analysis_draft__', color: d.style.color, width: d.style.width,
    lineStyle: d.style.lineStyle, paneId: d.paneId, a: { ...d.a }, b: { ...d.b } };
  switch (d.kind) {
    case 'fib': return { ...base, kind: 'fib', levels: [...FIB_LEVELS], extendRight: true, ...(d.style.labelHidden === true ? { labelHidden: true } : {}) };
    case 'channel': return { ...base, kind: 'channel', c: { ...(d.c ?? d.a) }, fillOpacity: d.style.fillOpacity, extendRight: true };
    case 'long-position': case 'short-position': {
      const direction = d.kind === 'long-position' ? 1 : -1;
      const distance = Math.abs(d.b.price - d.a.price);
      return { ...base, kind: d.kind, b: { ...d.b, price: d.a.price + direction * distance },
        stop: d.a.price - direction * distance / 2, quantity: 0 };
    }
  }
}

export const horizontalRayTool: DrawingToolSpec = {
  kind: 'hray', label: '수평 레이', glyph: '→', cursor: 'crosshair',
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py), at = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!at) return;
    ctx.add({ id: nanoid(8), kind: 'hray', paneId, at, ...(ctx.defaults.labelHidden === true ? { labelHidden: true } : {}), color: ctx.defaults.color,
      width: ctx.defaults.width, lineStyle: ctx.defaults.lineStyle });
  },
};

function moveDraft(ctx: ToolCtx) {
  const draft = ctx.analysisDraft?.current; if (!draft) return;
  const p = ctx.pixelToData(ctx.px, ctx.py, draft.paneId); if (!p) return;
  if (draft.phase === 'width') draft.c = p; else draft.b = p;
  ctx.requestRedraw();
}

export function analysisTool(kind: AnalysisDraft['kind'], label: string): DrawingToolSpec {
  return {
    kind, label, glyph: '╱', cursor: 'crosshair',
    onPointerDown(ctx) {
      if (!ctx.analysisDraft) return;
      const draft = ctx.analysisDraft.current;
      if (draft?.phase === 'width') {
        moveDraft(ctx);
        const d = drawingFromAnalysisDraft(draft); d.id = nanoid(8);
        ctx.analysisDraft.current = null;
        ctx.add(d); ctx.requestRedraw(); return;
      }
      const paneId = ctx.paneIdAtY(ctx.py);
      // Position values are prices, never an indicator's volume/ratio domain.
      if ((kind === 'long-position' || kind === 'short-position') && paneId !== 'candle') return;
      const a = ctx.pixelToData(ctx.px, ctx.py, paneId); if (!a) return;
      ctx.analysisDraft.current = { kind, a, b: a, paneId, pointerId: ctx.pointerId,
        phase: 'baseline', style: { ...ctx.defaults } };
      ctx.capturePointer(); ctx.requestRedraw();
    },
    onPointerMove(ctx) {
      const d = ctx.analysisDraft?.current;
      if (d && (d.phase === 'width' || d.pointerId === ctx.pointerId)) moveDraft(ctx);
    },
    onPointerUp(ctx) {
      const d = ctx.analysisDraft?.current;
      if (!d || !ctx.analysisDraft || d.phase === 'width' || d.pointerId !== ctx.pointerId) return;
      moveDraft(ctx); ctx.releasePointer();
      if (d.a.realMs === d.b.realMs && d.a.price === d.b.price
        || (d.kind === 'channel' && d.a.realMs === d.b.realMs)
        || ((d.kind === 'long-position' || d.kind === 'short-position') && d.a.price === d.b.price)) {
        ctx.analysisDraft.current = null; ctx.requestRedraw(); return;
      }
      if (d.kind === 'channel') { d.phase = 'width'; d.c = { ...d.a }; ctx.requestRedraw(); return; }
      const drawing = drawingFromAnalysisDraft(d); drawing.id = nanoid(8);
      ctx.analysisDraft.current = null;
      if ((drawing.kind === 'long-position' || drawing.kind === 'short-position') && !validPosition(drawing)) {
        ctx.requestRedraw(); return;
      }
      ctx.add(drawing); ctx.requestRedraw();
    },
  };
}
