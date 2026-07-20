import { describe, it, expect } from 'vitest';
import {
  deltaAccToLevels,
  foldLevelDiff,
  ladderTick,
  makeDeltaPoint,
  netDeltaQty,
  sameDeltaChain,
  type DeltaAcc,
} from './depthDelta';

const lv = (price: number, qty: number) => ({ price, qty });

describe('foldLevelDiff', () => {
  it('folds a per-price increase as inflow and a decrease as outflow', () => {
    const acc: DeltaAcc = new Map();
    const folded = foldLevelDiff(
      [lv(100, 500), lv(101, 300)],
      [lv(100, 800), lv(101, 120)],
      acc,
    );
    expect(folded).toBe(true);
    expect(deltaAccToLevels(acc)).toEqual([
      { price: 100, inQty: 300, outQty: 0 },
      { price: 101, inQty: 0, outQty: 180 },
    ]);
  });

  it('ignores prices present on only one side of the pair (관측창 이동 아티팩트)', () => {
    // 현재가가 한 틱 올라 사다리가 미끄러진 상황: 101~103 만 두 스냅샷에 공통이다.
    // 사라진 100 과 새로 등장한 104 의 잔량은 주문 변화가 아니라 창 이동이므로
    // 증감으로 세면 안 된다 — 이 규칙이 없으면 틱마다 거대한 가짜 유입/유출이 찍힌다.
    const acc: DeltaAcc = new Map();
    foldLevelDiff(
      [lv(100, 9999), lv(101, 100), lv(102, 100), lv(103, 100)],
      [lv(101, 150), lv(102, 100), lv(103, 100), lv(104, 8888)],
      acc,
    );
    expect(deltaAccToLevels(acc)).toEqual([{ price: 101, inQty: 50, outQty: 0 }]);
  });

  it('skips unchanged levels and reports folded=false when nothing moved', () => {
    const acc: DeltaAcc = new Map();
    expect(foldLevelDiff([lv(100, 500)], [lv(100, 500)], acc)).toBe(false);
    expect(deltaAccToLevels(acc)).toEqual([]);
  });

  it('skips ladder filler slots (price <= 0) on either side', () => {
    // 애프터마켓 단일가는 4~10단계를 "-0"(=0)으로 보낸다 — 백엔드가 price 0 으로 정규화.
    const acc: DeltaAcc = new Map();
    foldLevelDiff([lv(0, 0), lv(100, 100)], [lv(0, 0), lv(100, 140)], acc);
    expect(deltaAccToLevels(acc)).toEqual([{ price: 100, inQty: 40, outQty: 0 }]);
  });

  it('counts 0 → N as genuine inflow (빈 호가에 신규 진입)', () => {
    const acc: DeltaAcc = new Map();
    foldLevelDiff([lv(100, 0)], [lv(100, 700)], acc);
    expect(deltaAccToLevels(acc)).toEqual([{ price: 100, inQty: 700, outQty: 0 }]);
  });

  it('accumulates inflow and outflow separately across successive folds', () => {
    // 같은 가격에서 들어왔다 빠진 공방: net 은 0 이지만 gross 는 살아 있어야 한다.
    const acc: DeltaAcc = new Map();
    foldLevelDiff([lv(100, 100)], [lv(100, 400)], acc); // +300
    foldLevelDiff([lv(100, 400)], [lv(100, 100)], acc); // -300
    const levels = deltaAccToLevels(acc);
    expect(levels).toEqual([{ price: 100, inQty: 300, outQty: 300 }]);
    expect(netDeltaQty(levels[0])).toBe(0);
  });

  it('emits levels in ascending price order regardless of book order', () => {
    // 매수호가는 내림차순으로 들어온다 — 방출은 항상 가격 오름차순으로 정규화된다.
    const acc: DeltaAcc = new Map();
    foldLevelDiff(
      [lv(103, 10), lv(102, 10), lv(101, 10)],
      [lv(103, 20), lv(102, 20), lv(101, 20)],
      acc,
    );
    expect(deltaAccToLevels(acc).map((l) => l.price)).toEqual([101, 102, 103]);
  });
});

describe('makeDeltaPoint', () => {
  it('returns null when neither side moved (빈 버킷은 방출하지 않는다)', () => {
    expect(makeDeltaPoint(1000, new Map(), new Map(), 10, 10)).toBeNull();
  });

  it('returns a point when only one side moved', () => {
    const ask: DeltaAcc = new Map([[100, { in: 50, out: 0 }]]);
    expect(makeDeltaPoint(1000, ask, new Map(), 10, 5)).toEqual({
      tMs: 1000,
      askDelta: [{ price: 100, inQty: 50, outQty: 0 }],
      bidDelta: [],
      askTick: 10,
      bidTick: 5,
    });
  });

  it('normalizes an unobservable tick to 0 (호출부 폴백 신호)', () => {
    const ask: DeltaAcc = new Map([[100, { in: 50, out: 0 }]]);
    const p = makeDeltaPoint(1000, ask, new Map(), Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)!;
    expect(p.askTick).toBe(0);
    expect(p.bidTick).toBe(0);
  });

  it('builds fresh arrays so a stored point is never mutated by later folds', () => {
    const ask: DeltaAcc = new Map([[100, { in: 50, out: 0 }]]);
    const first = makeDeltaPoint(1000, ask, new Map(), 10, 10)!;
    foldLevelDiff([lv(100, 50)], [lv(100, 90)], ask);
    expect(first.askDelta).toEqual([{ price: 100, inQty: 50, outQty: 0 }]);
  });
});

describe('ladderTick', () => {
  it('returns the tick of a dense ladder', () => {
    // 250,000원대 종목(호가단위 500원) 매도 10단.
    const ladder = Array.from({ length: 10 }, (_, i) => lv(250000 + i * 500, 10));
    expect(ladderTick(ladder)).toBe(500);
  });

  it('picks the majority gap when the ladder straddles a 호가단위 경계', () => {
    // 50,000원 경계: 아래는 50원, 위는 100원 단위. 최솟값(50)을 쓰면 100원 단위 구간의
    // 셀이 절반 높이로 그려져 칠해지지 않는 띠가 생긴다 — 다수인 100 을 골라야 한다.
    const ladder = [
      lv(49900, 1), lv(49950, 1), lv(50000, 1), lv(50100, 1), lv(50200, 1),
      lv(50300, 1), lv(50400, 1), lv(50500, 1), lv(50600, 1), lv(50700, 1),
    ];
    expect(ladderTick(ladder)).toBe(100);
  });

  it('ignores filler slots (price 0) instead of reading them as a huge gap', () => {
    // 애프터마켓 단일가: 3호가만 차고 나머지는 price 0.
    const ladder = [lv(425000, 10), lv(425500, 10), lv(426000, 10), lv(0, 0), lv(0, 0)];
    expect(ladderTick(ladder)).toBe(500);
  });

  it('returns Infinity when fewer than two valid prices exist', () => {
    expect(ladderTick([lv(100, 5)])).toBe(Number.POSITIVE_INFINITY);
    expect(ladderTick([])).toBe(Number.POSITIVE_INFINITY);
  });

  it('is order-insensitive (매수 사다리는 내림차순으로 들어온다)', () => {
    expect(ladderTick([lv(1030, 1), lv(1020, 1), lv(1010, 1)])).toBe(10);
  });
});

describe('sameDeltaChain', () => {
  it('allows same-venue pairs and blocks cross-venue pairs', () => {
    expect(sameDeltaChain({ venue: 'KRX' }, { venue: 'KRX' })).toBe(true);
    expect(sameDeltaChain({}, {})).toBe(true); // 구백엔드(무태그) = 같은 장으로 해석
    expect(sameDeltaChain({ venue: 'KRX' }, { venue: 'NXT' })).toBe(false);
  });
});
