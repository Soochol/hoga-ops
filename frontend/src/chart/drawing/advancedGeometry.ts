import type { AdvancedDrawing, Drawing, DrawingCandle, Point } from './types';
import type { AnalysisCoords, AnalysisProjection, XY } from './analysisGeometry';
import { extendSegment } from './lineGeometry';
import { fitRegression } from './regression';
import { textLayout } from './textLayout';

export function isAdvancedDrawing(d: Drawing): d is AdvancedDrawing {
  return d.kind === 'fib-extension' || d.kind === 'path' || d.kind === 'callout' || d.kind === 'regression';
}

export function projectAdvanced(d: AdvancedDrawing, coords: AnalysisCoords): AnalysisProjection {
  const out: AnalysisProjection = { segments: [], fills: [], labels: [], handles: [] };
  const point = (p: Point, clamp = false): XY | null => {
    const x = coords.x(p.realMs) ?? (clamp ? coords.xClamped?.(p.realMs) : null), y = coords.y(p.price);
    return x == null || y == null ? null : { x, y };
  };
  if (d.kind === 'path') {
    const projected = d.points.map(p => point(p, true));
    projected.forEach((p, i) => { if (p) out.handles.push({ key: i, at: p }); });
    for (let i = 1; i < projected.length; i++) {
      const a = projected[i - 1], b = projected[i];
      if (a && b) out.segments.push({ a, b, arrowStart: i === 1 && d.arrowStart === true,
        arrowEnd: i === projected.length - 1 && d.arrowEnd !== false });
    }
    return out;
  }
  if (d.kind === 'callout') {
    const a = point(d.a, true); if (!a) return out;
    const layout = textLayout(d.text, d.fontSize, coords.measureTextWidth ?? ((s, size) => s.length * size * 0.6));
    const box = { x: a.x + d.offsetX, y: a.y + d.offsetY, width: layout.width + 16, height: layout.height + 12 };
    const edge = { x: Math.max(box.x, Math.min(a.x, box.x + box.width)), y: Math.max(box.y, Math.min(a.y, box.y + box.height)) };
    if (Math.hypot(edge.x-a.x,edge.y-a.y)>1) out.segments.push({ a: edge, b: a, arrowEnd: true });
    out.fills.push({ points: [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }], opacity: 0 });
    out.annotations = [{ box, text: d.text, fontSize: d.fontSize }];
    out.handles.push({ key: 'a', at: a }, { key: 'box', at: { x: box.x, y: box.y } });
    return out;
  }
  if (d.kind === 'regression') {
    const fit = fitRegression(d, coords.candles); if (!fit) return out;
    const a = point(fit.first), b = point(fit.last); if (!a || !b) return out;
    const base = extendSegment(a, b, coords.width, false, d.extendRight);
    out.segments.push(base);
    const edges = [d.upperDeviation, -d.lowerDeviation].map(multiplier => {
      const first = point({ ...fit.first, price: fit.first.price + multiplier * fit.deviation });
      const last = point({ ...fit.last, price: fit.last.price + multiplier * fit.deviation });
      return first && last ? extendSegment(first, last, coords.width, false, d.extendRight) : null;
    });
    edges.forEach(edge => { if (edge) out.segments.push({ ...edge, dashed: true }); });
    if (edges[0] && edges[1]) out.fills.push({ points: [edges[0].a, edges[0].b, edges[1].b, edges[1].a], opacity: d.fillOpacity });
    const ordered = d.a.realMs <= d.b.realMs;
    out.handles.push({ key: 'a', at: ordered ? a : b }, { key: 'b', at: ordered ? b : a });
    out.labels.push({ at: a, text: `회귀 · 로드된 ${fit.count}봉 · +${d.upperDeviation}σ / −${d.lowerDeviation}σ` });
    return out;
  }
  const a = point(d.a), b = point(d.b), c = point(d.c); if (!a || !b || !c) return out;
  out.handles.push({ key: 'a', at: a }, { key: 'b', at: b }, { key: 'c', at: c });
  out.segments.push({ a, b, dashed: true }, { a: b, b: c, dashed: true });
  const x1 = Math.min(a.x, b.x, c.x), x2 = d.extendRight ? Math.max(coords.width, a.x, b.x, c.x) : Math.max(a.x, b.x, c.x);
  for (const level of d.levels) {
    const value = d.c.price + (d.b.price - d.a.price) * level, y = coords.y(value);
    if (y == null) continue;
    out.segments.push({ a: { x: x1, y }, b: { x: x2, y } });
    if (!d.labelHidden) out.labels.push({ at: { x: x1, y }, text: `${level} · ${value.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}` });
  }
  return out;
}

export function advancedHandlePatch(d: AdvancedDrawing, key: AnalysisProjection['handles'][number]['key'], p: Point, candles?: readonly DrawingCandle[]): Partial<Drawing> | null {
  if (d.kind === 'path') {
    return typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < d.points.length
      ? { points: d.points.map((point, i) => i === key ? p : point) } : null;
  }
  if (d.kind === 'callout') return key === 'a' ? { a: p } : null;
  if (key !== 'a' && key !== 'b' && key !== 'c') return null;
  if (d.kind === 'fib-extension') {
    if (key === 'a' && p.price === d.b.price || key === 'b' && p.price === d.a.price) return null;
    return { [key]: p };
  }
  if (key === 'c') return null;
  const patch = { [key]: { ...d[key], realMs: p.realMs } };
  return fitRegression({ ...d, ...patch }, candles) ? patch : null;
}
