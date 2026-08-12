import { describe, expect, it } from 'vitest';

import { scaleRangeBundlePrices, unscalePriceForRequest } from './scaleRangeBundlePrices';
import type { RangeBundle } from '../api/types';

/** 2026-06-12 09:00 KST — 계수 0.9432 를 실은 날짜(한화솔루션 실측 케이스). */
const T_0612 = Date.UTC(2026, 5, 12, 0, 0) as number;
/** 2026-06-15 09:00 KST — 수정 이벤트 효력일, 계수 1.0. */
const T_0615 = Date.UTC(2026, 5, 15, 0, 0) as number;

const FACTORS = { 20260612: 0.5, 20260615: 1.0 } as const;

function bundle(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '009830', from_date: '20260612', to_date: '20260615', bucket_ms: 60_000,
    segments: [
      { date: '20260612', session_open_ms: T_0612, session_close_ms: T_0612, source: 'hogaplay' },
      { date: '20260615', session_open_ms: T_0615, session_close_ms: T_0615, source: 'hogaplay' },
    ],
    candles: [],
    quote_ratio: { bucket_ms: 60_000, points: [] },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
    ...overrides,
  };
}

describe('scaleRangeBundlePrices', () => {
  it('계수가 없거나 전부 1.0 이면 원본 **참조**를 그대로 돌려준다', () => {
    // 값이 같은 새 객체를 만들면 하위 wire→domain WeakMap 캐시가 전량 미스가 나고
    // 병합마다 전 구간이 재변환된다 — 참조 동일성이 그 캐시의 계약이다.
    const b = bundle();
    expect(scaleRangeBundlePrices(b, undefined)).toBe(b);
    expect(scaleRangeBundlePrices(b, { 20260612: 1.0 })).toBe(b);
  });

  it('히트맵의 **위치 가격**(튜플 첫 원소)만 곱하고 잔량은 건드리지 않는다', () => {
    const b = bundle({
      depth_heatmap: [
        { t_ms: T_0612, asks: [[38550, 610]], bids: [[38400, 218]], asks_max: [[38600, 900]], bids_max: [[38350, 42]] },
      ],
    });

    const out = scaleRangeBundlePrices(b, FACTORS);

    expect(out.depth_heatmap![0].asks).toEqual([[19275, 610]]);
    expect(out.depth_heatmap![0].bids).toEqual([[19200, 218]]);
    expect(out.depth_heatmap![0].asks_max).toEqual([[19300, 900]]);
    expect(out.depth_heatmap![0].bids_max).toEqual([[19175, 42]]);
  });

  it('잔량 증감은 in/out 수량을 보존하고 **ask_tick/bid_tick 도** 곱한다', () => {
    // tick 은 이름에 price 가 없는 가격공간 값이라 눈으로 훑으면 빠뜨리는 자리다.
    // 안 곱하면 증감 셀 높이만 옛 척도로 남아 가격축과 어긋난다.
    const b = bundle({
      depth_delta: [
        { t_ms: T_0612, asks: [[37950, 65, -212]], bids: [[37900, 30, -10]], ask_tick: 50, bid_tick: 50 },
      ],
    });

    const out = scaleRangeBundlePrices(b, FACTORS);

    expect(out.depth_delta![0].asks).toEqual([[18975, 65, -212]]);
    expect(out.depth_delta![0].bids).toEqual([[18950, 30, -10]]);
    expect(out.depth_delta![0].ask_tick).toBe(25);
    expect(out.depth_delta![0].bid_tick).toBe(25);
  });

  it('최대벽의 **모든** 가격 변형과 순위 배열을 곱한다', () => {
    const b = bundle({
      ask_peaks: [{
        date: '20260612',
        price: 38700, qty: 6269, t_ms: T_0612,
        max_price: 38700, max_qty: 6269, max_t_ms: T_0612,
        all_price: 38500, all_qty: 8461, all_t_ms: T_0612,
        all_max_price: 38500, all_max_qty: 8558, all_max_t_ms: T_0612,
        untraded_price: 38500, untraded_qty: 100, untraded_t_ms: T_0612,
        untraded_max_price: 38500, untraded_max_qty: 100, untraded_max_t_ms: T_0612,
        traded_peaks: [{ price: 38700, qty: 6269, t_ms: T_0612 }],
      }],
    });

    const peak = scaleRangeBundlePrices(b, FACTORS).ask_peaks[0];

    expect(peak.price).toBe(19350);
    expect(peak.max_price).toBe(19350);
    expect(peak.all_price).toBe(19250);
    expect(peak.all_max_price).toBe(19250);
    expect(peak.untraded_price).toBe(19250);
    expect(peak.untraded_max_price).toBe(19250);
    expect(peak.traded_peaks).toEqual([{ price: 19350, qty: 6269, t_ms: T_0612 }]);
    // 수량·시각은 가격이 아니다.
    expect(peak.qty).toBe(6269);
    expect(peak.t_ms).toBe(T_0612);
  });

  it('매물대 격자는 경계와 **bin_width** 를 함께 옮긴다', () => {
    const b = bundle({
      volume_distributions: [{
        date: '20260612', range_count: 5, price_min: 36750, price_max: 38800,
        session_open_ms: T_0612, session_close_ms: T_0612,
        bins: [{ price_low: 36750, price_high: 37160, qty: 100 }],
      }],
      volume_profile_by_day: [
        { bin_count: 1, price_min: 36750, price_max: 38800, bin_width: 2050, bins: [{ price_low: 36750, qty: 100 }] },
        { bin_count: 1, price_min: 36700, price_max: 40450, bin_width: 3750, bins: [{ price_low: 36700, qty: 200 }] },
      ],
    });

    const out = scaleRangeBundlePrices(b, FACTORS);

    expect(out.volume_distributions[0].price_min).toBe(18375);
    expect(out.volume_distributions[0].bins[0]).toEqual({ price_low: 18375, price_high: 18580, qty: 100 });
    // by_day 는 `date` 가 없어 **segments 와 같은 순서**로 짝지어진다 — 두 번째 날은
    // 계수 1.0 이라 값이 그대로여야 인덱스 짝짓기가 맞다는 뜻이다.
    expect(out.volume_profile_by_day[0].bin_width).toBe(1025);
    expect(out.volume_profile_by_day[1].bin_width).toBe(3750);
  });

  it('계수를 **모르는 날짜**는 손대지 않는다 (모름 ≠ 1.0)', () => {
    const b = bundle({
      trade_volume_pocs: [
        { date: '20260612', center_price: 37877, low_price: 37775, high_price: 37980, qty: 1, t_ms: T_0612, band_pct: 0.005 },
        { date: '20260611', center_price: 36000, low_price: 35900, high_price: 36100, qty: 1, t_ms: T_0612, band_pct: 0.005 },
      ],
    });

    const out = scaleRangeBundlePrices(b, FACTORS);

    expect(out.trade_volume_pocs![0].center_price).toBe(18939);
    // 값만 재면 "모름" 과 "1.0" 이 구별되지 않는다(둘 다 원값). **참조**로 재야
    // 두 규약이 갈린다 — 모르는 날짜는 새 객체조차 만들지 않는다.
    expect(out.trade_volume_pocs![1]).toBe(b.trade_volume_pocs![1]);
  });

  it('같은 포인트를 다시 환산하면 **같은 객체**가 나온다 (델타 병합 참조 불변식)', () => {
    // range 델타 병합은 미변경 버킷의 wire point 참조를 보존하고, 하위 domain 캐시가
    // 그 참조를 WeakMap 키로 쓴다. 환산이 매번 새 객체를 만들면 계수 ≠ 1 종목에서만
    // 그 불변식이 조용히 깨진다.
    const point = { t_ms: T_0612, asks: [[38550, 610]] as [number, number][], bids: [] };
    const first = scaleRangeBundlePrices(bundle({ depth_heatmap: [point] }), FACTORS);
    const second = scaleRangeBundlePrices(bundle({ depth_heatmap: [point] }), FACTORS);

    expect(second.depth_heatmap![0]).toBe(first.depth_heatmap![0]);
  });
});

describe('unscalePriceForRequest', () => {
  it('화면 가격을 서버(원주가) 공간으로 되돌린다', () => {
    expect(unscalePriceForRequest(19275, FACTORS, '20260612')).toBe(38550);
  });

  it('계수를 모르면 그대로 둔다 — 요청이 조용히 어긋나지 않게', () => {
    expect(unscalePriceForRequest(38550, FACTORS, '20260611')).toBe(38550);
    expect(unscalePriceForRequest(38550, undefined, '20260612')).toBe(38550);
  });
});
