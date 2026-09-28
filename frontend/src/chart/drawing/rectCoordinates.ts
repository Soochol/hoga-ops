import type { Point, Rect } from './types';

/** A corner while capturing/editing. Persisted separately as Rect.subX. */
export type RectCorner = Point & { subX?: number };
export type RectBarDomain = {
  toBar(realMs: number): number;
  toReal(bar: number): number;
};

export function rectCorner(r: Pick<Rect, 'a' | 'b' | 'subX'>, key: 'a' | 'b'): RectCorner {
  return { ...r[key], subX: finiteSubX(r.subX?.[key]) };
}

export function finiteSubX(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function projectRectX(
  realMs: number,
  subX: number | undefined,
  project: (ms: number) => number | null,
  barPx: number | null | undefined,
): number | null {
  const x = project(realMs);
  if (x == null) return null;
  return x + (barPx != null && Number.isFinite(barPx) && barPx > 0 ? finiteSubX(subX) * barPx : 0);
}

export function captureRectCorner(
  point: Point,
  px: number,
  project: (ms: number) => number | null,
  barPx: number | null,
  snapX: boolean,
): RectCorner {
  const x = project(point.realMs);
  const subX = !snapX && x != null && barPx != null && Number.isFinite(barPx) && barPx > 0
    ? (px - x) / barPx : 0;
  return { ...point, ...(subX !== 0 ? { subX } : {}) };
}

export function rectCornerBar(corner: RectCorner, domain: Pick<RectBarDomain, 'toBar'>): number {
  return domain.toBar(corner.realMs) + finiteSubX(corner.subX);
}

/** Resolve an actual bar first; carry everything its round-trip discarded. */
export function rectCornerAtBar(bar: number, price: number, domain: RectBarDomain): RectCorner {
  const realMs = domain.toReal(Math.round(bar));
  const subX = bar - domain.toBar(realMs);
  return { realMs, price, ...(subX !== 0 ? { subX } : {}) };
}

export function rectGeometry(a: RectCorner, b: RectCorner, keepSubX = false): Pick<Rect, 'a' | 'b' | 'subX'> {
  const subA = finiteSubX(a.subX), subB = finiteSubX(b.subX);
  return {
    a: { realMs: a.realMs, price: a.price },
    b: { realMs: b.realMs, price: b.price },
    ...(keepSubX || subA !== 0 || subB !== 0 ? { subX: { a: subA, b: subB } } : {}),
  };
}

export function translateRectBars(r: Rect, dBar: number, dPrice: number, domain: RectBarDomain): Pick<Rect, 'a' | 'b' | 'subX'> {
  const move = (key: 'a' | 'b') => rectCornerAtBar(
    rectCornerBar(rectCorner(r, key), domain) + dBar, r[key].price + dPrice, domain,
  );
  return rectGeometry(move('a'), move('b'), r.subX != null);
}

/** Extend the visually right corner, including crossed corners on one candle. */
export function extendRectToTime(r: Rect, realMs: number, domain?: Pick<RectBarDomain, 'toBar'>): Partial<Rect> | null {
  const toBar = domain?.toBar ?? ((ms: number) => ms);
  const a = rectCornerBar(rectCorner(r, 'a'), { toBar });
  const b = rectCornerBar(rectCorner(r, 'b'), { toBar });
  const key = b >= a ? 'b' : 'a';
  if (r[key].realMs === realMs && finiteSubX(r.subX?.[key]) === 0) return null;
  return {
    [key]: { realMs, price: r[key].price },
    ...(r.subX ? { subX: { ...r.subX, [key]: 0 } } : {}),
  };
}
