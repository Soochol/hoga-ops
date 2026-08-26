import { describe, it, expect } from 'vitest';
import {
  depthHeatmapFromWire,
  depthHeatmapSourceOf,
  depthLevelsOf,
  depthPointToWire,
} from './depthHeatmapWire';
import type { DepthHeatmapPoint } from './depthHeatmapWire';
import type { DepthHeatmapPointWire } from '../api/types';

describe('depthHeatmapFromWire', () => {
  it('wire 튜플을 도메인 객체로 변환한다', () => {
    const out = depthHeatmapFromWire([
      { t_ms: 100, asks: [[1000, 500], [1010, 300]], bids: [[990, 400]] },
    ]);
    expect(out).toEqual([
      {
        tMs: 100,
        asks: [{ price: 1000, qty: 500 }, { price: 1010, qty: 300 }],
        bids: [{ price: 990, qty: 400 }],
        asksMax: [],
        bidsMax: [],
        asksPriceMax: [],
        bidsPriceMax: [],
      },
    ]);
  });
  it('null/undefined는 빈 배열', () => {
    expect(depthHeatmapFromWire(null)).toEqual([]);
    expect(depthHeatmapFromWire(undefined)).toEqual([]);
  });
  it('asks_max/bids_max를 asksMax/bidsMax로 변환한다', () => {
    const out = depthHeatmapFromWire([
      { t_ms: 100, asks: [[1000, 500]], bids: [[990, 400]],
        asks_max: [[1000, 900], [1010, 300]], bids_max: [[990, 800]] },
    ]);
    expect(out[0].asksMax).toEqual([{ price: 1000, qty: 900 }, { price: 1010, qty: 300 }]);
    expect(out[0].bidsMax).toEqual([{ price: 990, qty: 800 }]);
  });
  it('asks_max/bids_max 없으면 빈 배열', () => {
    const out = depthHeatmapFromWire([{ t_ms: 1, asks: [], bids: [] }]);
    expect(out[0].asksMax).toEqual([]);
    expect(out[0].bidsMax).toEqual([]);
  });
  it('asks_price_max/bids_price_max를 asksPriceMax/bidsPriceMax로 변환한다', () => {
    const out = depthHeatmapFromWire([
      { t_ms: 100, asks: [[1000, 500]], bids: [[990, 400]],
        asks_price_max: [[1000, 900], [1010, 300], [1020, 120]], bids_price_max: [[990, 800]] },
    ]);
    // 길이가 10 고정이 아니고 `asks` 와도 다를 수 있다 — 그 버킷에 등장한 distinct 가격.
    expect(out[0].asksPriceMax).toEqual([
      { price: 1000, qty: 900 }, { price: 1010, qty: 300 }, { price: 1020, qty: 120 },
    ]);
    expect(out[0].bidsPriceMax).toEqual([{ price: 990, qty: 800 }]);
  });

  it('동일 wire 참조는 동일 domain 객체를 반환한다(WeakMap 캐시)', () => {
    // 틱마다 새 배열이 와도 원소(wire point) 참조가 같으면 domain 을 재할당하지 않는다.
    const wire: DepthHeatmapPointWire = { t_ms: 100, asks: [[1000, 5]], bids: [[990, 4]] };
    const a = depthHeatmapFromWire([wire])[0];
    const b = depthHeatmapFromWire([wire, { t_ms: 200, asks: [], bids: [] }])[0];
    expect(b).toBe(a);
  });
});

describe('depthPointToWire', () => {
  it('동일 point 참조는 동일 wire 객체를 반환한다(WeakMap 캐시)', () => {
    const p: DepthHeatmapPoint = {
      tMs: 100,
      asks: [{ price: 1000, qty: 5 }],
      bids: [{ price: 990, qty: 4 }],
      asksMax: [{ price: 1000, qty: 9 }],
      bidsMax: [{ price: 990, qty: 8 }],
    };
    expect(depthPointToWire(p)).toBe(depthPointToWire(p));
  });

  it('값을 wire 튜플로 변환한다', () => {
    const p: DepthHeatmapPoint = {
      tMs: 100,
      asks: [{ price: 1000, qty: 5 }],
      bids: [{ price: 990, qty: 4 }],
      asksMax: [],
      bidsMax: [],
    };
    expect(depthPointToWire(p)).toEqual({
      t_ms: 100,
      asks: [[1000, 5]],
      bids: [[990, 4]],
      asks_max: [],
      bids_max: [],
      // 도메인 쪽이 optional 이라 없으면 빈 배열로 나간다(구 캐시·구 백엔드 호환).
      asks_price_max: [],
      bids_price_max: [],
    });
  });
});

describe('depthHeatmapSourceOf', () => {
  it('부모 OFF 면 자식 값과 무관하게 close', () => {
    // UI 는 `enabledBy` 로 이 조합을 못 만들지만, 저장된 pref 는 부모를 껐어도 자식
    // 값을 **보존한다**(게이트는 값을 지우지 않는다). 그래서 부모 OFF + 자식 ON 이
    // 실제로 존재하는 상태이고, 여기서 close 로 접히는 것이 그 상태의 정의다.
    expect(depthHeatmapSourceOf(false, false)).toBe('close');
    expect(depthHeatmapSourceOf(false, true)).toBe('close');
  });
  it('부모만 ON 이면 총잔량 최대 순간, 자식까지 ON 이면 가격대별', () => {
    expect(depthHeatmapSourceOf(true, false)).toBe('peakSnapshot');
    expect(depthHeatmapSourceOf(true, true)).toBe('perPriceMax');
  });
});

describe('depthLevelsOf', () => {
  // 세 소스가 **서로 다른 값**을 갖는 point — 같은 값이면 선택이 옳은지 알 수 없다.
  // 실측 형태를 축소한 것이다(005930 20260825 14:35: 자기 최고 93,543 vs 총잔량
  // 최고 순간 61,057 vs 종가 61,057).
  const point: DepthHeatmapPoint = {
    tMs: 1,
    asks: [{ price: 100, qty: 61 }],
    bids: [{ price: 99, qty: 11 }],
    asksMax: [{ price: 100, qty: 61 }],
    bidsMax: [{ price: 99, qty: 11 }],
    asksPriceMax: [{ price: 100, qty: 93 }],
    bidsPriceMax: [{ price: 99, qty: 22 }],
  };
  it('소스마다 다른 배열을 고른다', () => {
    expect(depthLevelsOf(point, 'ask', 'close')).toBe(point.asks);
    expect(depthLevelsOf(point, 'ask', 'peakSnapshot')).toBe(point.asksMax);
    expect(depthLevelsOf(point, 'ask', 'perPriceMax')).toBe(point.asksPriceMax);
    expect(depthLevelsOf(point, 'bid', 'close')).toBe(point.bids);
    expect(depthLevelsOf(point, 'bid', 'peakSnapshot')).toBe(point.bidsMax);
    expect(depthLevelsOf(point, 'bid', 'perPriceMax')).toBe(point.bidsPriceMax);
  });
  it('가격대별 계열이 없는 point 는 빈 배열(구 캐시)', () => {
    const legacy: DepthHeatmapPoint = { tMs: 1, asks: [], bids: [], asksMax: [], bidsMax: [] };
    expect(depthLevelsOf(legacy, 'ask', 'perPriceMax')).toEqual([]);
    expect(depthLevelsOf(legacy, 'bid', 'perPriceMax')).toEqual([]);
  });
});
