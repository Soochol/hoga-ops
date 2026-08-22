// frontend/src/chart/drawing/smooth.test.ts
import { describe, expect, it } from 'vitest';
import { catmullRomSpans, type BezierSpan, type Px } from './smooth';

/**
 * Independent reference: the Barry–Goldman pyramidal form of a centripetal
 * Catmull–Rom span, evaluated directly.
 *
 * This exists so the Bézier control points are checked against the DEFINITION
 * rather than against a remembered closed-form coefficient. A wrong constant in
 * `smooth.ts` would still produce a plausible-looking curve and would still
 * pass "it goes through the vertices" and "straight input stays straight" — the
 * only test that catches it is one that computes the same curve a different
 * way. Deliberately written as nested lerps, i.e. as close to the textbook
 * pyramid as possible.
 */
function barryGoldman(p0: Px, p1: Px, p2: Px, p3: Px, u: number): Px {
  const alpha = 0.5;
  const d = (a: Px, b: Px) => Math.hypot(b.x - a.x, b.y - a.y) ** alpha;
  const t0 = 0;
  const t1 = t0 + d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const t = t1 + u * (t2 - t1);
  const lerp = (A: Px, B: Px, ta: number, tb: number): Px => ({
    x: ((tb - t) * A.x + (t - ta) * B.x) / (tb - ta),
    y: ((tb - t) * A.y + (t - ta) * B.y) / (tb - ta),
  });
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/** de Casteljau evaluation of the cubic Bézier `from → span`. */
function bezierAt(from: Px, span: BezierSpan, u: number): Px {
  const v = 1 - u;
  const c = (a: number, b: number, cc: number, d: number) =>
    v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * cc + u * u * u * d;
  return {
    x: c(from.x, span.c1.x, span.c2.x, span.to.x),
    y: c(from.y, span.c1.y, span.c2.y, span.to.y),
  };
}

/** The phantom flank `catmullRomSpans` reflects in at a free end. */
const reflect = (inner: Px, edge: Px): Px => ({
  x: 2 * edge.x - inner.x,
  y: 2 * edge.y - inner.y,
});

describe('catmullRomSpans — 정의와 대조', () => {
  // 불균일 간격 + 방향 전환. 균일 파라미터화라면 여기서 오버슈트가 난다.
  const pts: Px[] = [
    { x: 0, y: 0 },
    { x: 12, y: 40 },
    { x: 60, y: 44 },
    { x: 72, y: 8 },
    { x: 130, y: 30 },
  ];

  it('모든 스팬이 Barry–Goldman 평가와 일치한다', () => {
    const spans = catmullRomSpans(pts);
    expect(spans).toHaveLength(pts.length - 1);
    for (let i = 0; i < spans.length; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      // 끝 스팬은 반사된 phantom 을 쓰므로 참조 평가에도 같은 것을 넣는다.
      const p0 = i > 0 ? pts[i - 1] : reflect(p2, p1);
      const p3 = i + 2 < pts.length ? pts[i + 2] : reflect(p1, p2);
      for (const u of [0.25, 0.5, 0.75]) {
        const ref = barryGoldman(p0, p1, p2, p3, u);
        const got = bezierAt(p1, spans[i], u);
        expect(got.x).toBeCloseTo(ref.x, 6);
        expect(got.y).toBeCloseTo(ref.y, 6);
      }
    }
  });

  it('모든 원래 꼭짓점을 지난다 — 연필의 계약', () => {
    const spans = catmullRomSpans(pts);
    spans.forEach((s, i) => {
      expect(s.to.x).toBe(pts[i + 1].x);
      expect(s.to.y).toBe(pts[i + 1].y);
      // 스팬 시작점도 원래 꼭짓점이다(u=0 은 항상 from).
      expect(bezierAt(pts[i], s, 0)).toEqual(pts[i]);
    });
  });

  it('직선 입력은 직선으로 남는다 — 컨트롤이 현 위에 온다', () => {
    const line: Px[] = [
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 40, y: 10 },
      { x: 45, y: 10 },
    ];
    for (const s of catmullRomSpans(line)) {
      expect(s.c1.y).toBeCloseTo(10, 9);
      expect(s.c2.y).toBeCloseTo(10, 9);
    }
    // 중간 어디를 찍어도 현 위 — 부풀지 않는다.
    const spans = catmullRomSpans(line);
    expect(bezierAt(line[1], spans[1], 0.5).y).toBeCloseTo(10, 9);
  });

  it('centripetal 이라 급한 전환에서도 현 범위를 크게 벗어나지 않는다', () => {
    // 균일(α=0) 파라미터화가 오버슈트를 내는 고전적 배치: 한쪽 간격이 다른
    // 쪽의 수십 배다.
    const spiky: Px[] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 60 },
      { x: 100, y: 60 },
    ];
    const spans = catmullRomSpans(spiky);
    for (let i = 0; i < spans.length; i++) {
      const from = i === 0 ? spiky[0] : spans[i - 1].to;
      const loX = Math.min(from.x, spans[i].to.x);
      const hiX = Math.max(from.x, spans[i].to.x);
      const loY = Math.min(from.y, spans[i].to.y);
      const hiY = Math.max(from.y, spans[i].to.y);
      const reach = Math.max(hiX - loX, hiY - loY);
      for (const u of [0.2, 0.4, 0.6, 0.8]) {
        const p = bezierAt(from, spans[i], u);
        // 현의 bounding box 를 그 길이의 25% 넘게 벗어나지 않는다.
        expect(p.x).toBeGreaterThanOrEqual(loX - reach * 0.25);
        expect(p.x).toBeLessThanOrEqual(hiX + reach * 0.25);
        expect(p.y).toBeGreaterThanOrEqual(loY - reach * 0.25);
        expect(p.y).toBeLessThanOrEqual(hiY + reach * 0.25);
      }
    }
  });
});

describe('catmullRomSpans — 축퇴 입력', () => {
  it('점이 2개 미만이면 스팬이 없다', () => {
    expect(catmullRomSpans([])).toEqual([]);
    expect(catmullRomSpans([{ x: 1, y: 2 }])).toEqual([]);
  });

  it('두 점이면 현 위의 스팬 하나 — 직선으로 그려진다', () => {
    const spans = catmullRomSpans([
      { x: 0, y: 0 },
      { x: 30, y: 30 },
    ]);
    expect(spans).toHaveLength(1);
    expect(bezierAt({ x: 0, y: 0 }, spans[0], 0.5)).toEqual({ x: 15, y: 15 });
  });

  it('겹친 점이 있어도 NaN 을 내지 않는다', () => {
    // 투영이 두 샘플을 같은 픽셀로 접으면 실제로 생긴다. 나눗셈 가드가
    // 없으면 여기서 NaN 이 나오고, 캔버스는 NaN 좌표를 만나는 순간 그
    // 경로 전체를 조용히 버린다 — 스트로크가 통째로 사라진다.
    const dup: Px[] = [
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 40, y: 20 },
      { x: 40, y: 20 },
      { x: 80, y: 0 },
    ];
    const spans = catmullRomSpans(dup);
    expect(spans).toHaveLength(4);
    for (const s of spans) {
      for (const v of [s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('모든 점이 같아도 유한한 스팬을 낸다', () => {
    const same: Px[] = Array.from({ length: 4 }, () => ({ x: 5, y: 5 }));
    for (const s of catmullRomSpans(same)) {
      expect(Number.isFinite(s.c1.x + s.c1.y + s.c2.x + s.c2.y)).toBe(true);
    }
  });
});
