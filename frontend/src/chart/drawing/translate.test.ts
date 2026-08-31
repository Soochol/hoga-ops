// frontend/src/chart/drawing/translate.test.ts

import { describe, expect, it } from 'vitest';
import type { Drawing, Hline, Measure, Pencil, Rect, Text, Trendline, Vline } from './types';
import {
  clampDPriceForDrawing,
  clampDBarForDrawing,
  eligibleFor,
  hasAxis,
  planAlign,
  planDistribute,
  planGroupTranslate,
  pricesOf,
  timesOf,
  translateDrawing,
} from './translate';

const baseStyle = { color: '#14B8A6', width: 1.5, lineStyle: 'solid' as const };

describe('translateDrawing — hline', () => {
  it('shifts price by dPrice and ignores dMs (hline has no time coordinate)', () => {
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, ...baseStyle, paneId: 'candle' };
    expect(translateDrawing(h, 999, 5)).toEqual({ price: 105 });
    expect(translateDrawing(h, -1_000_000, -10)).toEqual({ price: 90 });
  });
});

describe('translateDrawing — vline', () => {
  it('shifts realMs by dMs and ignores dPrice (vline has no price)', () => {
    const v: Vline = { id: 'v1', kind: 'vline', realMs: 1_000, ...baseStyle, paneId: 'candle' };
    expect(translateDrawing(v, 500, 9999)).toEqual({ realMs: 1_500 });
  });

  it('pricesOf(vline) is empty so its Δprice clamp is a pass-through', () => {
    const v: Vline = { id: 'v1', kind: 'vline', realMs: 1_000, ...baseStyle, paneId: 'candle' };
    expect(pricesOf(v)).toEqual([]);
    expect(clampDPriceForDrawing(v, 42, { top: 100, bottom: 0 })).toBe(42);
  });
});

describe('translateDrawing — rect', () => {
  it('shifts both corners by (dMs, dPrice)', () => {
    const r: Rect = {
      id: 'r1', kind: 'rect',
      a: { realMs: 1_000, price: 100 }, b: { realMs: 2_000, price: 200 },
      fillOpacity: 0.1, ...baseStyle, paneId: 'candle',
    };
    expect(translateDrawing(r, 500, 5)).toEqual({
      a: { realMs: 1_500, price: 105 },
      b: { realMs: 2_500, price: 205 },
    });
    expect(pricesOf(r)).toEqual([100, 200]);
  });
});

describe('translateDrawing — measure', () => {
  it('shifts both endpoints and reports both prices', () => {
    const m: Measure = {
      id: 'm1', kind: 'measure',
      a: { realMs: 1_000, price: 100 }, b: { realMs: 2_000, price: 200 },
      ...baseStyle, paneId: 'candle',
    };
    expect(translateDrawing(m, 500, 5)).toEqual({
      a: { realMs: 1_500, price: 105 },
      b: { realMs: 2_500, price: 205 },
    });
    expect(pricesOf(m)).toEqual([100, 200]);
  });
});

describe('translateDrawing — text', () => {
  it('shifts the anchor by (dMs, dPrice)', () => {
    const t: Text = {
      id: 't1', kind: 'text', at: { realMs: 1_000, price: 100 },
      text: '메모', fontSize: 13, ...baseStyle, paneId: 'candle',
    };
    expect(translateDrawing(t, 500, 5)).toEqual({ at: { realMs: 1_500, price: 105 } });
    expect(pricesOf(t)).toEqual([100]);
  });
});

describe('translateDrawing — trendline', () => {
  it('shifts both endpoints by (dMs, dPrice)', () => {
    const t: Trendline = {
      id: 't1',
      kind: 'trendline',
      a: { realMs: 1_000, price: 100 },
      b: { realMs: 2_000, price: 200 },
      ...baseStyle,
      paneId: 'candle',
    };
    expect(translateDrawing(t, 500, 5)).toEqual({
      a: { realMs: 1_500, price: 105 },
      b: { realMs: 2_500, price: 205 },
    });
  });
});

describe('translateDrawing — pencil', () => {
  it('shifts every vertex by (dMs, dPrice)', () => {
    const p: Pencil = {
      id: 'p1',
      kind: 'pencil',
      points: [
        { realMs: 1_000, price: 100 },
        { realMs: 1_010, price: 105 },
        { realMs: 1_020, price: 110 },
      ],
      ...baseStyle,
      paneId: 'candle',
    };
    expect(translateDrawing(p, 50, 2)).toEqual({
      points: [
        { realMs: 1_050, price: 102 },
        { realMs: 1_060, price: 107 },
        { realMs: 1_070, price: 112 },
      ],
    });
  });

  it('subX 는 이동해도 그대로다 — 다만 원본과 배열을 공유하지 않는다', () => {
    // 가로 이동은 봉 서수 단위라(TimeShift/DragBarDomain) 각 점의 봉 **안**
    // 위치는 안 변한다. 배열을 그대로 넘기면 cloneWithOffset 이 만든 복제본이
    // 원본과 같은 배열을 가리켜, 한쪽을 고치면 다른 쪽이 따라 바뀐다.
    const p: Pencil = {
      id: 'p1',
      kind: 'pencil',
      points: [
        { realMs: 1_000, price: 100 },
        { realMs: 1_010, price: 105 },
      ],
      subX: [0.25, -0.4],
      ...baseStyle,
      paneId: 'candle',
    };
    const patch = translateDrawing(p, 50, 2) as Partial<Pencil>;
    expect(patch.subX).toEqual([0.25, -0.4]);
    expect(patch.subX).not.toBe(p.subX);
  });

  it('subX 가 없던 stroke 는 이동해도 생기지 않는다', () => {
    const p: Pencil = {
      id: 'p1',
      kind: 'pencil',
      points: [{ realMs: 1_000, price: 100 }],
      ...baseStyle,
      paneId: 'candle',
    };
    expect('subX' in (translateDrawing(p, 50, 2) as object)).toBe(false);
  });

  it('handles an empty point list cleanly (no crash; returns empty points)', () => {
    const p: Pencil = { id: 'p1', kind: 'pencil', points: [], ...baseStyle, paneId: 'candle' };
    const result = translateDrawing(p, 100, 10) as Partial<Pencil>;
    expect(result.points).toEqual([]);
  });
});

describe('pricesOf', () => {
  it('returns [price] for hline', () => {
    const h: Hline = { id: 'h', kind: 'hline', price: 50, ...baseStyle, paneId: 'candle' };
    expect(pricesOf(h)).toEqual([50]);
  });
  it('returns [a.price, b.price] for trendline', () => {
    const t: Trendline = {
      id: 't', kind: 'trendline',
      a: { realMs: 0, price: 10 }, b: { realMs: 0, price: 90 },
      ...baseStyle, paneId: 'candle',
    };
    expect(pricesOf(t)).toEqual([10, 90]);
  });
  it('returns every vertex price for pencil', () => {
    const p: Pencil = {
      id: 'p', kind: 'pencil',
      points: [{ realMs: 0, price: 5 }, { realMs: 1, price: 50 }, { realMs: 2, price: 7 }],
      ...baseStyle, paneId: 'candle',
    };
    expect(pricesOf(p)).toEqual([5, 50, 7]);
  });
});

describe('clampDPriceForDrawing', () => {
  const bounds = { top: 100, bottom: 0 }; // pane spans price ∈ [0, 100]

  it('passes a dPrice through unchanged when every vertex stays inside the pane', () => {
    const h: Hline = { id: 'h', kind: 'hline', price: 50, ...baseStyle, paneId: 'candle' };
    expect(clampDPriceForDrawing(h, 10, bounds)).toBe(10);
    expect(clampDPriceForDrawing(h, -10, bounds)).toBe(-10);
  });

  it('caps positive dPrice so no vertex exceeds pane top', () => {
    const t: Trendline = {
      id: 't', kind: 'trendline',
      a: { realMs: 0, price: 90 }, b: { realMs: 0, price: 50 },
      ...baseStyle, paneId: 'candle',
    };
    // a is 10 below top; b is 50 below top. cap = min(10, 50) = 10.
    expect(clampDPriceForDrawing(t, 50, bounds)).toBe(10);
  });

  it('caps negative dPrice so no vertex falls below pane bottom', () => {
    const t: Trendline = {
      id: 't', kind: 'trendline',
      a: { realMs: 0, price: 5 }, b: { realMs: 0, price: 90 },
      ...baseStyle, paneId: 'candle',
    };
    // Lowest vertex (a=5) can drop by 5 before hitting 0. cap = -5.
    expect(clampDPriceForDrawing(t, -50, bounds)).toBe(-5);
  });

  it('preserves trendline spread at the boundary (the shape-preservation invariant)', () => {
    // The whole point of this helper: a trendline whose lower endpoint
    // touches the floor still moves both endpoints together when the user
    // tries to drag down further (clamped to 0 dPrice), so the 80-unit
    // spread between the endpoints survives.
    const t: Trendline = {
      id: 't', kind: 'trendline',
      a: { realMs: 0, price: 10 }, b: { realMs: 0, price: 90 },
      ...baseStyle, paneId: 'candle',
    };
    const cappedDown = clampDPriceForDrawing(t, -100, bounds);
    const translated = translateDrawing(t, 0, cappedDown) as Partial<Trendline>;
    const newA = translated.a!.price;
    const newB = translated.b!.price;
    // Both endpoints shift by the same capped amount; spread of 80 preserved.
    expect(newB - newA).toBe(80);
    // Lower endpoint pinned to the floor.
    expect(newA).toBe(0);
  });

  it('tolerates inverted bounds', () => {
    const h: Hline = { id: 'h', kind: 'hline', price: 50, ...baseStyle, paneId: 'candle' };
    expect(clampDPriceForDrawing(h, 60, { top: 0, bottom: 100 })).toBe(50);
  });

  it('freezes the drag (returns 0) when a vertex is already outside the bounds', () => {
    // Autoscale shift moved the bounds while the user is mid-drag and a
    // vertex now sits above the new top. We don't yank the drawing.
    const h: Hline = { id: 'h', kind: 'hline', price: 200, ...baseStyle, paneId: 'candle' };
    expect(clampDPriceForDrawing(h, 5, bounds)).toBe(0);
  });
});

describe('translateDrawing — exhaustiveness', () => {
  it('returns Partial<Drawing> for every Drawing.kind', () => {
    // If a new kind is added to the Drawing union without extending
    // translateDrawing, this test still compiles but TypeScript flags the
    // missing case in the switch — see types.ts.
    const cases: Drawing[] = [
      { id: '1', kind: 'hline', price: 0, ...baseStyle, paneId: 'candle' },
      {
        id: '2',
        kind: 'trendline',
        a: { realMs: 0, price: 0 },
        b: { realMs: 0, price: 0 },
        ...baseStyle,
        paneId: 'candle',
      },
      { id: '3', kind: 'pencil', points: [], ...baseStyle, paneId: 'candle' },
    ];
    for (const d of cases) expect(translateDrawing(d, 1, 1)).toBeTypeOf('object');
  });
});

describe('translateDrawing — function-form time shift (gap-aware drag)', () => {
  it('maps every vertex realMs through the shift function', () => {
    const r: Rect = {
      id: 'r', kind: 'rect',
      a: { realMs: 1_000, price: 10 },
      b: { realMs: 2_000, price: 20 },
      fillOpacity: 0.1,
      ...baseStyle, paneId: 'candle',
    };
    // Nonlinear on purpose — a flat Δms can't express this (the whole point of
    // the function form: virtual-domain shifts skip inter-session gaps).
    const shift = (ms: number) => ms * 2 + 5;
    expect(translateDrawing(r, shift, 1)).toEqual({
      a: { realMs: 2_005, price: 11 },
      b: { realMs: 4_005, price: 21 },
    });
  });

  it('applies the shift to a vline and to every pencil point', () => {
    const v: Vline = { id: 'v', kind: 'vline', realMs: 100, ...baseStyle, paneId: 'candle' };
    expect(translateDrawing(v, (ms) => ms + 7, 0)).toEqual({ realMs: 107 });
    const p: Pencil = {
      id: 'p', kind: 'pencil',
      points: [{ realMs: 1, price: 1 }, { realMs: 2, price: 2 }],
      ...baseStyle, paneId: 'candle',
    };
    expect(translateDrawing(p, (ms) => ms + 10, 1)).toEqual({
      points: [{ realMs: 11, price: 2 }, { realMs: 12, price: 3 }],
    });
  });
});

describe('timesOf', () => {
  it('returns every time-bearing vertex per kind', () => {
    const h: Hline = { id: 'h', kind: 'hline', price: 5, ...baseStyle, paneId: 'candle' };
    const v: Vline = { id: 'v', kind: 'vline', realMs: 9, ...baseStyle, paneId: 'candle' };
    const m: Measure = {
      id: 'm', kind: 'measure',
      a: { realMs: 1, price: 1 }, b: { realMs: 2, price: 2 },
      ...baseStyle, paneId: 'candle',
    };
    const t: Text = {
      id: 't', kind: 'text', at: { realMs: 4, price: 4 }, text: 'x', fontSize: 13,
      ...baseStyle, paneId: 'candle',
    };
    expect(timesOf(h)).toEqual([]);
    expect(timesOf(v)).toEqual([9]);
    expect(timesOf(m)).toEqual([1, 2]);
    expect(timesOf(t)).toEqual([4]);
  });
});

describe('clampDBarForDrawing — left-edge shape-preserving cap', () => {
  const rect: Rect = {
    id: 'r', kind: 'rect',
    a: { realMs: 1_000, price: 10 },
    b: { realMs: 3_000, price: 20 },
    fillOpacity: 0.1,
    ...baseStyle, paneId: 'candle',
  };
  const identity = (ms: number) => ms;

  it('passes a rightward shift through untouched (future band is open-ended)', () => {
    expect(clampDBarForDrawing(rect, 500, 0, identity)).toBe(500);
  });

  it('caps a leftward shift so the earliest vertex stops at the origin', () => {
    // Earliest vertex at ordinal 1_000; origin 0 → at most -1_000. The same
    // capped delta applies to BOTH vertices, so the 2_000 span survives.
    expect(clampDBarForDrawing(rect, -5_000, 0, identity)).toBe(-1_000);
  });

  it('leaves an hline unclamped (no time vertices to protect)', () => {
    const h: Hline = { id: 'h', kind: 'hline', price: 5, ...baseStyle, paneId: 'candle' };
    expect(clampDBarForDrawing(h, -9_999, 0, identity)).toBe(-9_999);
  });
});

/** 다중 선택 이동의 계획 단계. 단건 translateDrawing 과 다른 점 둘을 고정한다:
 *  ① 세로 델타가 픽셀이라 팬마다 다른 가격으로 풀린다, ② 클램프가 집합 전체로
 *  계산돼 한 도형이 경계에 닿아도 대형이 무너지지 않는다. */
describe('planGroupTranslate', () => {
  const style = { color: '#14B8A6', width: 1.5, lineStyle: 'solid' as const };
  const hline = (id: string, price: number, paneId: 'candle' | 'ind0' = 'candle'): Hline =>
    ({ id, kind: 'hline', price, ...style, paneId }) as Hline;

  // 캔들 팬: y = 400 - price (1원 = 1px). 지표 팬: y = 800 - price*10 (1 = 10px).
  // 두 팬의 축척이 10배 다른 것이 이 테스트들의 요점이다.
  const Y0 = { candle: 400, ind0: 800 } as const;
  const SCALE = { candle: 1, ind0: 10 } as const;
  const coords = {
    priceToCanvasY: (price: number, paneId: string) =>
      Y0[paneId as 'candle' | 'ind0'] - price * SCALE[paneId as 'candle' | 'ind0'],
    canvasYToPrice: (py: number, paneId: string) =>
      (Y0[paneId as 'candle' | 'ind0'] - py) / SCALE[paneId as 'candle' | 'ind0'],
    priceBoundsForPane: () => ({ top: 1_000, bottom: 0 }),
    toBar: (ms: number) => ms,
    toReal: (b: number) => b,
    originBar: -Infinity,
  };

  it('같은 픽셀 이동이 팬마다 자기 축척의 가격 변화로 풀린다', () => {
    const members = [hline('c', 100, 'candle'), hline('i', 50, 'ind0')];
    // 위로 20px (화면 y 감소).
    const plan = planGroupTranslate(members, 0, -20, coords);
    // 캔들 팬은 1px = 1원 → +20, 지표 팬은 10px = 1 → +2.
    expect(plan).toEqual([
      { id: 'c', patch: { price: 120 } },
      { id: 'i', patch: { price: 52 } },
    ]);
  });

  it('가로 이동은 공유 도메인이라 전원이 같은 Δbar 로 움직인다', () => {
    const v = (id: string, realMs: number): Vline =>
      ({ id, kind: 'vline', realMs, ...style, paneId: 'candle' }) as Vline;
    const plan = planGroupTranslate([v('v1', 1_000), v('v2', 5_000)], 250, 0, coords);
    expect(plan).toEqual([
      { id: 'v1', patch: { realMs: 1_250 } },
      { id: 'v2', patch: { realMs: 5_250 } },
    ]);
  });

  // ⚠ 이것이 그룹 클램프의 존재 이유다. 도형마다 따로 캡을 걸면 천장에 닿은
  // 하나만 멈추고 나머지는 계속 올라가, 사용자가 골라 둔 배치가 드래그 도중
  // 뭉개진다. 집합의 최소 허용치를 전원에게 적용하면 간격이 보존된다.
  it('한 도형이 팬 경계에 닿으면 집합 전체가 거기서 멈춘다 — 간격 보존', () => {
    // 캔들 팬 상단(y=0)은 가격 400. 990 은 이미 위쪽에 붙어 있어 +10 까지만 갈 수 있다.
    const bounded = {
      ...coords,
      priceBoundsForPane: () => ({ top: 1_000, bottom: 0 }),
    };
    const members = [hline('top', 990), hline('bottom', 100)];
    const plan = planGroupTranslate(members, 0, -50, bounded);
    // 위로 50px = +50원을 요청했지만 'top' 이 +10 밖에 못 간다 → 둘 다 +10.
    expect(plan).toEqual([
      { id: 'top', patch: { price: 1_000 } },
      { id: 'bottom', patch: { price: 110 } },
    ]);
    // 간격이 그대로다.
    const prices = plan.map((p) => (p.patch as { price: number }).price);
    expect(prices[0] - prices[1]).toBe(990 - 100);
  });

  it('vline 은 세로 성분이 없어 픽셀 이동을 그냥 흘린다', () => {
    const v: Vline = { id: 'v', kind: 'vline', realMs: 1_000, ...style, paneId: 'candle' };
    expect(planGroupTranslate([v], 0, -80, coords)).toEqual([{ id: 'v', patch: { realMs: 1_000 } }]);
  });

  // 순서 무관성: 각 멤버의 허용치를 **원래 요청**에 대해 재기 때문이다. 진행
  // 중인 최소값에 대해 재면 목록 순서가 결과를 바꾼다.
  it('멤버 순서가 결과를 바꾸지 않는다', () => {
    const a = hline('top', 990);
    const b = hline('bottom', 100);
    const forward = planGroupTranslate([a, b], 0, -50, coords);
    const backward = planGroupTranslate([b, a], 0, -50, coords);
    expect(backward.map((p) => p.patch)).toEqual([forward[1].patch, forward[0].patch]);
  });
});

/** 정렬·분배. 그룹 이동과 달리 **멤버마다 델타가 다르므로** 집합 최소 클램프가 없고,
 *  축마다 자격이 갈린다(hline 은 x 범위가, vline 은 y 범위가 없다). */
describe('planAlign / planDistribute', () => {
  const style = { color: '#14B8A6', width: 1.5, lineStyle: 'solid' as const };

  // 1 000 ms = 1 px, 가격 1 = 1 px(candle) / 10 px(ind0). 축척이 다른 두 팬이
  // 있어야 "픽셀로 계산한다" 는 주장이 실제로 재어진다.
  const Y0 = { candle: 400, ind0: 800 } as const;
  const SCALE = { candle: 1, ind0: 10 } as const;
  const pane = (id: string) => id as 'candle' | 'ind0';
  const coords = {
    realMsToCanvasX: (ms: number) => ms / 1_000,
    canvasXToRealMs: (px: number) => px * 1_000,
    priceToCanvasY: (price: number, paneId: string) =>
      Y0[pane(paneId)] - price * SCALE[pane(paneId)],
    canvasYToPrice: (py: number, paneId: string) =>
      (Y0[pane(paneId)] - py) / SCALE[pane(paneId)],
    priceBoundsForPane: () => ({ top: 10_000, bottom: -10_000 }),
    toBar: (ms: number) => ms,
    toReal: (b: number) => b,
    originBar: -Infinity,
  };

  const rect = (id: string, a: [number, number], b: [number, number], over = {}): Rect =>
    ({
      id, kind: 'rect',
      a: { realMs: a[0], price: a[1] }, b: { realMs: b[0], price: b[1] },
      fillOpacity: 0.1, ...style, paneId: 'candle', ...over,
    }) as Rect;
  const hline = (id: string, price: number, over = {}): Hline =>
    ({ id, kind: 'hline', price, ...style, paneId: 'candle', ...over }) as Hline;
  const vline = (id: string, realMs: number): Vline =>
    ({ id, kind: 'vline', realMs, ...style, paneId: 'candle' }) as Vline;

  const patchOf = (plan: { id: string; patch: Partial<Drawing> }[], id: string) =>
    plan.find((p) => p.id === id)?.patch as Record<string, { realMs: number; price: number }> | undefined;

  it('좌측 정렬 — 왼쪽 끝이 가장 왼쪽 도형에 맞는다', () => {
    // A: x 10..30, B: x 50..60. 좌측 정렬이면 B 가 40 000ms(=40px) 왼쪽으로.
    const a = rect('a', [10_000, 100], [30_000, 200]);
    const b = rect('b', [50_000, 300], [60_000, 400]);
    const plan = planAlign([a, b], 'left', coords);
    expect(plan.map((p) => p.id)).toEqual(['b']);
    const pb = patchOf(plan, 'b')!;
    expect(pb.a.realMs).toBe(10_000);
    expect(pb.b.realMs).toBe(20_000); // 폭 10 000 보존
    expect(pb.a.price).toBe(300);     // 세로는 건드리지 않는다
  });

  it('우측 정렬 — 오른쪽 끝이 가장 오른쪽 도형에 맞는다', () => {
    const a = rect('a', [10_000, 100], [30_000, 200]);
    const b = rect('b', [50_000, 300], [60_000, 400]);
    const plan = planAlign([a, b], 'right', coords);
    const pa = patchOf(plan, 'a')!;
    expect(pa.b.realMs).toBe(60_000);
    expect(pa.a.realMs).toBe(40_000);
  });

  it('가운데 정렬 — 외곽의 중심에 각자의 중심을 맞춘다', () => {
    const a = rect('a', [0, 100], [20_000, 200]);       // center 10 000
    const b = rect('b', [80_000, 300], [100_000, 400]); // center 90 000
    const plan = planAlign([a, b], 'hcenter', coords);  // 외곽 중심 50 000
    expect(patchOf(plan, 'a')!.a.realMs).toBe(40_000);
    expect(patchOf(plan, 'b')!.a.realMs).toBe(40_000);
  });

  // ⚠ 이 기능을 두 번 미루게 했던 바로 그 문제. 축을 통째로 포기할 일이 아니라
  // 그 축에서 그 종류를 빼면 된다.
  it('hline 은 수평 정렬에서 빠진다 — x 범위가 없다', () => {
    const plan = planAlign([rect('a', [10_000, 100], [30_000, 200]), hline('h', 150)], 'left', coords);
    expect(plan.map((p) => p.id)).not.toContain('h');
  });

  it('hline 은 수직 정렬에는 들어간다 — 가격축 정렬은 뜻이 통한다', () => {
    // rect 의 위쪽(가격 200 → y 200)에 hline(가격 150 → y 250)을 맞춘다.
    const plan = planAlign([rect('a', [10_000, 100], [30_000, 200]), hline('h', 150)], 'top', coords);
    expect(patchOf(plan, 'h')).toEqual({ price: 200 });
  });

  it('vline 은 반대다 — 수직에서 빠지고 수평에 들어간다', () => {
    const shapes = [rect('a', [10_000, 100], [30_000, 200]), vline('v', 50_000)];
    expect(planAlign(shapes, 'top', coords).map((p) => p.id)).not.toContain('v');
    expect(planAlign(shapes, 'left', coords).map((p) => p.id)).toContain('v');
  });

  it('자격자가 하나뿐이면 아무것도 하지 않는다 — 자기 자신에게 맞출 수는 없다', () => {
    expect(planAlign([rect('a', [10_000, 100], [30_000, 200]), hline('h', 150)], 'left', coords)).toEqual([]);
  });

  it('잠긴 멤버는 기준에도 대상에도 들어가지 않는다', () => {
    const a = rect('a', [10_000, 100], [30_000, 200]);
    const b = rect('b', [50_000, 300], [60_000, 400]);
    const lockedFar = rect('lk', [0, 500], [5_000, 600], { locked: true });
    const plan = planAlign([a, b, lockedFar], 'left', coords);
    expect(plan.map((p) => p.id)).toEqual(['b']);
    // 기준이 잠긴 도형(x 0)이 아니라 a(x 10 000)였다는 증거.
    expect(patchOf(plan, 'b')!.a.realMs).toBe(10_000);
  });

  // 픽셀로 계산하는 이유. 두 팬의 축척이 10배 다르므로 가격 델타는 공유될 수 없다.
  it('팬이 달라도 화면상 같은 높이로 맞는다', () => {
    const onCandle = hline('c', 100);            // y = 300
    const onInd = hline('i', 50, { paneId: 'ind0' }); // y = 300
    const higher = hline('h', 150);              // y = 250  ← 기준
    const plan = planAlign([onCandle, onInd, higher], 'top', coords);
    // candle 은 +50 가격(=50px), ind0 은 +5(=50px).
    expect(patchOf(plan, 'c')).toEqual({ price: 150 });
    expect(patchOf(plan, 'i')).toEqual({ price: 55 });
  });

  it('분배 — 양 끝은 그대로, 사이가 고르게 벌어진다', () => {
    const a = vline('a', 0);
    const b = vline('b', 10_000);
    const c = vline('c', 90_000);
    const plan = planDistribute([a, b, c], 'horizontal', coords);
    // 0 / 45 000 / 90 000 이 되어야 한다 — b 만 움직인다.
    expect(plan.map((p) => p.id)).toEqual(['b']);
    expect((patchOf(plan, 'b') as unknown as { realMs: number }).realMs).toBe(45_000);
  });

  it('분배는 셋 미만이면 아무것도 하지 않는다 — 둘은 양 끝이다', () => {
    expect(planDistribute([vline('a', 0), vline('b', 10_000)], 'horizontal', coords)).toEqual([]);
  });

  it('전원이 한 점에 몰려 있으면 나눌 것이 없다', () => {
    const same = [vline('a', 5_000), vline('b', 5_000), vline('c', 5_000)];
    expect(planDistribute(same, 'horizontal', coords)).toEqual([]);
  });

  it('세로 분배는 종류가 섞여도 중심 기준으로 고르게 놓는다', () => {
    // y: hline 100 → 300, rect(200..220) → 180..200 center 190, hline 20 → 380
    const plan = planDistribute(
      [hline('lo', 20), rect('mid', [0, 200], [1_000, 220]), hline('hi', 100)],
      'vertical',
      coords,
    );
    // 화면 y 로 190 / 300 / 380 → 목표 190 / 285 / 380. 가운데만 움직인다.
    expect(plan.map((p) => p.id)).toEqual(['hi']);
    expect(patchOf(plan, 'hi')).toEqual({ price: 115 });
  });
});

/** 축 자격 술어 자체. 커널 안에서는 `pixelSpan` 의 null 판정과 겹쳐서 계획 결과로는
 *  재어지지 않는다 — 진짜 소비자는 투영이 없는 UI(버튼 비활성)라, 여기서 직접 잰다. */
describe('hasAxis / eligibleFor', () => {
  const style = { color: '#14B8A6', width: 1.5, lineStyle: 'solid' as const };
  const hline: Hline = { id: 'h', kind: 'hline', price: 100, ...style, paneId: 'candle' };
  const vline: Vline = { id: 'v', kind: 'vline', realMs: 1_000, ...style, paneId: 'candle' };
  const rect: Rect = {
    id: 'r', kind: 'rect',
    a: { realMs: 0, price: 0 }, b: { realMs: 1_000, price: 100 },
    fillOpacity: 0.1, ...style, paneId: 'candle',
  };

  it('hline 은 y 만, vline 은 x 만 갖는다', () => {
    expect(hasAxis(hline, 'y')).toBe(true);
    expect(hasAxis(hline, 'x')).toBe(false);
    expect(hasAxis(vline, 'x')).toBe(true);
    expect(hasAxis(vline, 'y')).toBe(false);
  });

  it('두 축을 다 가진 종류도 있다', () => {
    expect(hasAxis(rect, 'x')).toBe(true);
    expect(hasAxis(rect, 'y')).toBe(true);
  });

  it('eligibleFor 는 축 자격과 잠금을 함께 본다', () => {
    const lockedRect = { ...rect, id: 'lk', locked: true } as Rect;
    expect(eligibleFor([hline, vline, rect, lockedRect], 'x').map((d) => d.id)).toEqual(['v', 'r']);
    expect(eligibleFor([hline, vline, rect, lockedRect], 'y').map((d) => d.id)).toEqual(['h', 'r']);
  });
});

/** 텍스트는 앵커가 아니라 **그려지는 상자**로 정렬된다. 앵커로 재면 '세로 가운데'
 *  에서 글자의 위가 중심선에 놓여 반 글자 높이만큼 어긋나 보인다. */
describe('planAlign — 텍스트 상자', () => {
  const style = { color: '#14B8A6', width: 1.5, lineStyle: 'solid' as const };
  const coords = {
    realMsToCanvasX: (ms: number) => ms / 1_000,
    canvasXToRealMs: (px: number) => px * 1_000,
    priceToCanvasY: (price: number) => 400 - price,
    canvasYToPrice: (py: number) => 400 - py,
    priceBoundsForPane: () => ({ top: 10_000, bottom: -10_000 }),
    toBar: (ms: number) => ms,
    toReal: (b: number) => b,
    originBar: -Infinity,
    // render.ts 의 headless fallback 과 같은 식 — 'ab' @20px = 24px.
    measureTextWidth: (t: string, sizePx: number) => t.length * sizePx * 0.6,
  };

  const text = (id: string, realMs: number, price: number, over = {}): Text =>
    ({
      id, kind: 'text', at: { realMs, price }, text: 'ab', fontSize: 20,
      ...style, paneId: 'candle', ...over,
    }) as Text;
  const rect = (id: string, a: [number, number], b: [number, number]): Rect =>
    ({
      id, kind: 'rect',
      a: { realMs: a[0], price: a[1] }, b: { realMs: b[0], price: b[1] },
      fillOpacity: 0.1, ...style, paneId: 'candle',
    }) as Rect;
  const patchOf = (plan: { id: string; patch: Partial<Drawing> }[], id: string) =>
    plan.find((p) => p.id === id)?.patch as { at?: { realMs: number; price: number } } | undefined;

  // 산술을 그대로 적는다. rect 가격 100..200 → y 200..300(중심 250).
  // text 앵커 가격 300 → y 100, 상자 100..120(중심 110). 외곽 100..300 → 중심 200.
  // 그러니 text 중심이 90px 내려가야 하고, 앵커 가격은 300 − 90 = 210 이 된다.
  // **앵커로 쟀다면 200** 이 나온다 — 딱 fontSize/2 만큼 어긋난 값이다.
  it('세로 가운데 — 글상자의 중심이 맞는다(앵커가 아니라)', () => {
    const plan = planAlign([rect('r', [0, 100], [10_000, 200]), text('t', 0, 300)], 'vcenter', coords);
    expect(patchOf(plan, 't')!.at!.price).toBe(210);
  });

  it('아래 정렬 — 글상자의 아래변이 맞는다', () => {
    // rect 아래변 y 300(가격 100). text 상자 아래변은 앵커 y + 20.
    // 앵커 y 가 280 → 가격 120 이어야 한다.
    const plan = planAlign([rect('r', [0, 100], [10_000, 200]), text('t', 0, 300)], 'bottom', coords);
    expect(patchOf(plan, 't')!.at!.price).toBe(120);
  });

  it('우측 정렬 — 글상자의 오른쪽 끝이 맞는다', () => {
    // rect 오른쪽 x 50(=50 000ms)이 외곽. text 상자는 앵커 x + 24px 이므로 앵커가
    // 26 000ms(=26px)로 가야 오른쪽 끝이 50 에 닿는다.
    // **앵커로 쟀다면 50 000** — 딱 글자 폭만큼 오른쪽으로 밀려난 값이다.
    const plan = planAlign([rect('r', [0, 100], [50_000, 200]), text('t', 0, 300)], 'right', coords);
    expect(patchOf(plan, 't')!.at!.realMs).toBe(26_000);
  });

  // 측정기가 없으면 x 는 앵커 한 점으로 접힌다(스텁 호환 — HitCoord 와 같은 관례).
  it('폭 측정기가 없으면 x 는 앵커 기준으로 떨어진다', () => {
    const { measureTextWidth: _drop, ...noWidth } = coords;
    void _drop;
    const plan = planAlign([rect('r', [0, 100], [50_000, 200]), text('t', 0, 300)], 'right', noWidth);
    expect(patchOf(plan, 't')!.at!.realMs).toBe(50_000);
  });

  it('세로 분배도 글상자 중심을 쓴다', () => {
    // y: hi rect(가격 300..320) 중심 90, text(앵커 200 → 상자 200..220) 중심 210,
    // lo rect(가격 0..20) 중심 390. 목표 가운데 = (90+390)/2 = 240.
    const plan = planDistribute(
      [rect('hi', [0, 300], [1_000, 320]), text('t', 0, 200), rect('lo', [0, 0], [1_000, 20])],
      'vertical',
      coords,
    );
    expect(plan.map((p) => p.id)).toEqual(['t']);
    // 중심 210 → 240 이므로 30px 아래 = 앵커 가격 200 − 30 = 170.
    expect(patchOf(plan, 't')!.at!.price).toBe(170);
  });
});
