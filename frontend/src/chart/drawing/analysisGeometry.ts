import type { AnalysisDrawing, Drawing, Point, Position, Trendline } from './types';

export type XY = { x: number; y: number };
export type Segment = { a: XY; b: XY; dashed?: boolean };
export type AnalysisProjection = {
  segments: Segment[];
  fills: { points: XY[]; opacity: number; role?: 'target' | 'stop' }[];
  labels: { at: XY; text: string }[];
  handles: { key: 'a' | 'b' | 'c' | 'at' | 'stop'; at: XY }[];
};
export type AnalysisCoords = {
  x(ms: number): number | null;
  xClamped?(ms: number): number | null;
  y(price: number): number | null;
  width: number;
};
export function isAnalysisDrawing(d: Drawing): d is AnalysisDrawing {
  return d.kind === 'hray' || d.kind === 'fib' || d.kind === 'channel'
    || d.kind === 'long-position' || d.kind === 'short-position';
}

/** Shared by painting, picking and marquee selection, including extensions. */
export function extendSegment(a: XY, b: XY, width: number, left = false, right = false): Segment {
  const first = a.x <= b.x ? a : b, last = a.x <= b.x ? b : a;
  const dx = last.x - first.x, dy = last.y - first.y;
  if (Math.abs(dx) < 0.001) {
    return { a: { x: a.x, y: left ? -1e6 : Math.min(a.y, b.y) },
      b: { x: b.x, y: right ? 1e6 : Math.max(a.y, b.y) } };
  }
  const at = (x: number): XY => ({ x, y: first.y + (x - first.x) * dy / dx });
  return { a: left ? at(Math.min(0, first.x)) : first,
    b: right ? at(Math.max(width, last.x)) : last };
}

export function positionStats(d: Position) {
  const risk = Math.abs(d.a.price - d.stop);
  const reward = Math.abs(d.b.price - d.a.price);
  return { risk, reward, ratio: risk > 0 ? reward / risk : null,
    loss: risk * d.quantity, profit: reward * d.quantity };
}
export function validPosition(d: Position): boolean {
  return Number.isFinite(d.a.price) && Number.isFinite(d.b.price) && Number.isFinite(d.stop)
    && d.a.price > 0 && d.b.price > 0 && d.stop > 0 && Number.isFinite(d.quantity) && d.quantity >= 0
    && (d.kind === 'long-position' ? d.stop < d.a.price && d.a.price < d.b.price
      : d.b.price < d.a.price && d.a.price < d.stop);
}

export function projectAnalysis(d: AnalysisDrawing | Trendline, coords: AnalysisCoords): AnalysisProjection {
  const out: AnalysisProjection = { segments: [], fills: [], labels: [], handles: [] };
  const point = (p: Point): XY | null => {
    const x = coords.x(p.realMs), y = coords.y(p.price);
    return x == null || y == null ? null : { x, y };
  };
  const price = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
  if (d.kind === 'hray') {
    const x = coords.x(d.at.realMs) ?? coords.xClamped?.(d.at.realMs);
    const y = coords.y(d.at.price);
    if (x == null || y == null) return out;
    const a = { x, y };
    out.segments.push({ a, b: { x: Math.max(coords.width, a.x), y: a.y } });
    out.handles.push({ key: 'at', at: a });
    if (!d.labelHidden) out.labels.push({ at: a, text: `${d.name ? d.name + ' · ' : ''}${price(d.at.price)}` });
    return out;
  }
  const a = point(d.a), b = point(d.b); if (!a || !b) return out;
  out.handles.push({ key: 'a', at: a }, { key: 'b', at: b });
  if (d.kind === 'trendline') {
    out.segments.push(extendSegment(a, b, coords.width, d.extendLeft, d.extendRight));
  } else if (d.kind === 'fib') {
    const x1 = Math.min(a.x, b.x), x2 = d.extendRight ? Math.max(coords.width, a.x, b.x) : Math.max(a.x, b.x);
    for (const level of d.levels) {
      const r = d.reverse ? 1 - level : level;
      const value = d.b.price + (d.a.price - d.b.price) * r;
      const y = coords.y(value); if (y == null) continue;
      out.segments.push({ a: { x: x1, y }, b: { x: x2, y } });
      if (!d.labelHidden) out.labels.push({ at: { x: x1, y }, text: `${level} · ${price(value)}` });
    }
    out.segments.push({ a, b, dashed: true });
  } else if (d.kind === 'channel') {
    const c = point(d.c); if (!c) return out;
    const t = Math.abs(b.x - a.x) < 0.001 ? 0 : (c.x - a.x) / (b.x - a.x);
    const offset = c.y - (a.y + t * (b.y - a.y));
    const base = extendSegment(a, b, coords.width, false, d.extendRight);
    const upper = { a: { x: base.a.x, y: base.a.y + offset }, b: { x: base.b.x, y: base.b.y + offset } };
    out.segments.push(base, upper);
    if (!d.middleHidden) out.segments.push({ a: { x: base.a.x, y: base.a.y + offset / 2 }, b: { x: base.b.x, y: base.b.y + offset / 2 }, dashed: true });
    out.fills.push({ points: [base.a, base.b, upper.b, upper.a], opacity: d.fillOpacity });
    out.handles.push({ key: 'c', at: c });
  } else {
    const stopY = coords.y(d.stop); if (stopY == null) return out;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    for (const y of [a.y, b.y, stopY]) out.segments.push({ a: { x: x1, y }, b: { x: x2, y } });
    out.fills.push({ points: [{x:x1,y:a.y},{x:x2,y:a.y},{x:x2,y:b.y},{x:x1,y:b.y}], opacity: 0.12, role: 'target' },
      { points: [{x:x1,y:a.y},{x:x2,y:a.y},{x:x2,y:stopY},{x:x1,y:stopY}], opacity: 0.12, role: 'stop' });
    out.handles.push({ key: 'stop', at: { x: b.x, y: stopY } });
    const s = positionStats(d), percent = (delta: number) => d.a.price === 0 ? '—' : `${delta > 0 ? '+' : ''}${(delta / Math.abs(d.a.price) * 100).toFixed(2)}%`;
    out.labels.push({ at: {x:x1,y:b.y}, text: `목표 ${price(d.b.price)} · ${price(d.b.price - d.a.price)} (${percent(d.b.price - d.a.price)})${d.quantity ? ' · 예상 이익 ' + price(s.profit) : ''}` },
      { at: {x:x1,y:a.y}, text: `진입 ${price(d.a.price)} · 손익비 ${s.ratio?.toFixed(2) ?? '—'}` },
      { at: {x:x1,y:stopY}, text: `손절 ${price(d.stop)} · ${price(d.stop - d.a.price)} (${percent(d.stop - d.a.price)})${d.quantity ? ' · 예상 손실 ' + price(s.loss) : ''}` });
  }
  return out;
}

export function analysisHandlePatch(d: AnalysisDrawing, key: AnalysisProjection['handles'][number]['key'], p: Point): Partial<Drawing> | null {
  if (d.kind === 'hray') return { at: p };
  if (key === 'at') return null;
  if (d.kind === 'long-position' || d.kind === 'short-position') {
    const patch = key === 'stop' ? { stop: p.price } : key === 'a' ? { a: p } : { b: p };
    return validPosition({ ...d, ...patch }) ? patch : null;
  }
  if (key === 'stop' || (key === 'c' && d.kind !== 'channel')) return null;
  return { [key]: p };
}
