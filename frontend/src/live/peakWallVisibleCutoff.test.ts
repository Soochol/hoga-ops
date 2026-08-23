import { describe, expect, it } from 'vitest';
import type { AskPeak, BidPeak, Candle } from '../api/types';
import type { IRange, Time } from 'lightweight-charts';
import { createVirtualAxis } from '../util/virtualAxis';
import {
  applyPeakVisibleTimeCutoff,
  rightmostVisibleCandleCutoff,
  nextVisibleTimeCutoff,
  sameVisibleTimeCutoff,
  type VisibleTimeCutoff,
} from './peakWallVisibleCutoff';

const day1Open = Date.UTC(2026, 5, 10, 0, 0);
const day1Close = Date.UTC(2026, 5, 10, 6, 30);
const day2Open = Date.UTC(2026, 5, 11, 0, 0);
const day2Close = Date.UTC(2026, 5, 11, 6, 30);

const axis = createVirtualAxis([
  { date: '20260610', sessionOpenMs: day1Open, sessionCloseMs: day1Close },
  { date: '20260611', sessionOpenMs: day2Open, sessionCloseMs: day2Close },
], day1Open);

const candle = (ts_ms: number): Candle => ({
  ts_ms,
  open: 1,
  high: 2,
  low: 1,
  close: 2,
  vol_a: 1,
  vol_b: 0,
});

const askPeak = (date: string): AskPeak => ({
  date,
  price: 100,
  qty: 100,
  t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000,
  max_price: 100,
  max_qty: 100,
  max_t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000,
  traded_peaks: [
    { price: 100, qty: 100, t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000 },
    { price: 101, qty: 500, t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000 },
  ],
  traded_max_peaks: [
    { price: 100, qty: 110, t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000 },
    { price: 101, qty: 600, t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000 },
  ],
});

describe('rightmostVisibleCandleCutoff', () => {
  it('uses the rightmost visible candle, clamping right-offset whitespace to the latest candle', () => {
    const candles = [candle(day1Open), candle(day1Open + 60_000), candle(day1Open + 120_000)];
    const visibleRange: IRange<Time> = {
      from: (axis.toVirtual(day1Open) / 1000) as Time,
      to: (axis.toVirtual(day1Open + 10 * 60_000) / 1000) as Time,
    };

    expect(rightmostVisibleCandleCutoff(candles, visibleRange, axis)).toEqual({
      date: '20260610',
      tMs: day1Open + 120_000,
    });
  });

  it('uses the full rightmost visible candle bucket as the cutoff', () => {
    const candles = [candle(day1Open), candle(day1Open + 60_000), candle(day1Open + 120_000)];
    const visibleRange: IRange<Time> = {
      from: (axis.toVirtual(day1Open) / 1000) as Time,
      to: (axis.toVirtual(day1Open + 120_000) / 1000) as Time,
    };

    expect(rightmostVisibleCandleCutoff(candles, visibleRange, axis, 60_000)).toEqual({
      date: '20260610',
      tMs: day1Open + 180_000 - 1,
    });
  });

  it('returns null when the visible range ends before the first loaded candle', () => {
    const candles = [candle(day1Open + 60_000), candle(day1Open + 120_000)];
    const visibleRange: IRange<Time> = {
      from: (axis.toVirtual(day1Open) / 1000) as Time,
      to: (axis.toVirtual(day1Open) / 1000) as Time,
    };

    expect(rightmostVisibleCandleCutoff(candles, visibleRange, axis)).toBeNull();
  });
});

describe('applyPeakVisibleTimeCutoff', () => {
  it('keeps earlier dates full-day, filters the cutoff date, and omits later dates', () => {
    const cutoff: VisibleTimeCutoff = { date: '20260611', tMs: day2Open + 120_000 };

    const out = applyPeakVisibleTimeCutoff([askPeak('20260610'), askPeak('20260611')], cutoff, {
      intraMax: false,
    });

    expect(out).toHaveLength(2);
    expect(out[0].date).toBe('20260610');
    expect(out[0].qty).toBe(100);
    expect(out[1]).toMatchObject({
      date: '20260611',
      price: 100,
      qty: 100,
      t_ms: day2Open + 60_000,
    });
  });

  it('omits the cutoff date when every candidate is after the cutoff', () => {
    const cutoff: VisibleTimeCutoff = { date: '20260611', tMs: day2Open + 30_000 };

    expect(applyPeakVisibleTimeCutoff([askPeak('20260611')], cutoff, {
      intraMax: false,
    })).toEqual([]);
  });

  it('uses bid ranked candidates the same way as ask ranked candidates', () => {
    const bid: BidPeak = {
      ...askPeak('20260611'),
      price: 99,
      max_price: 99,
      traded_peaks: [
        { price: 99, qty: 90, t_ms: day2Open + 60_000 },
        { price: 98, qty: 900, t_ms: day2Open + 180_000 },
      ],
      traded_max_peaks: [
        { price: 99, qty: 95, t_ms: day2Open + 60_000 },
        { price: 98, qty: 950, t_ms: day2Open + 180_000 },
      ],
    };

    const out = applyPeakVisibleTimeCutoff([bid], { date: '20260611', tMs: day2Open + 120_000 }, {
      intraMax: false,
    });

    expect(out).toEqual([expect.objectContaining({ price: 99, qty: 90, t_ms: day2Open + 60_000 })]);
  });

  it('omits bid peaks with explicit empty ranked candidates instead of falling back to full-day fields', () => {
    const bid: BidPeak = {
      ...askPeak('20260611'),
      price: 99,
      qty: 900,
      t_ms: day2Open + 180_000,
      max_price: 99,
      max_qty: 900,
      max_t_ms: day2Open + 180_000,
      traded_peaks: [],
      traded_max_peaks: [],
    };

    expect(applyPeakVisibleTimeCutoff([bid], { date: '20260611', tMs: day2Open + 120_000 }, {
      intraMax: false,
    })).toEqual([]);
  });

  it('filters bid all-price fields independently of traded candidates', () => {
    const bid: BidPeak = {
      ...askPeak('20260611'),
      price: 99,
      max_price: 99,
      traded_peaks: [{ price: 99, qty: 90, t_ms: day2Open + 60_000 }],
      traded_max_peaks: [{ price: 99, qty: 95, t_ms: day2Open + 60_000 }],
      all_price: 97,
      all_qty: 900,
      all_t_ms: day2Open + 180_000,
      all_max_price: 96,
      all_max_qty: 950,
      all_max_t_ms: day2Open + 180_000,
    };

    const out = applyPeakVisibleTimeCutoff([bid], { date: '20260611', tMs: day2Open + 120_000 }, {
      intraMax: false,
    });

    expect(out).toEqual([
      expect.objectContaining({
        price: 99,
        all_price: null,
        all_qty: null,
        all_t_ms: null,
        all_max_price: null,
        all_max_qty: null,
        all_max_t_ms: null,
      }),
    ]);
  });

});

/**
 * **`sameVisibleTimeCutoff` — 재렌더 억제의 판별식**(2026-08-23).
 *
 * `rightmostVisibleCandleCutoff` 는 호출마다 새 객체를 낸다. 팬 한 번은 프레임을 수십 개
 * 내는데 그 대부분은 **오른쪽 끝 봉이 그대로**다(왼쪽으로 밀거나 봉 하나 안에서 줌할 때).
 * 호출부가 이걸로 걸러 이전 참조를 유지하면 React 가 그 프레임의 재렌더를 건너뛴다.
 *
 * **막는 방향**: 값이 같은데 다르다고 해서 재렌더가 되살아나는 것, 그리고 그 반대로
 * 값이 **달라졌는데 같다고** 해서 컷오프가 갱신되지 않는 것(그러면 지표가 옛 봉에 멈춘다).
 */
describe('sameVisibleTimeCutoff', () => {
  it('같은 값이면 참조가 달라도 같다고 본다', () => {
    expect(sameVisibleTimeCutoff({ date: '20260822', tMs: 5 }, { date: '20260822', tMs: 5 }))
      .toBe(true);
  });

  it('tMs 가 다르면 다르다', () => {
    expect(sameVisibleTimeCutoff({ date: '20260822', tMs: 5 }, { date: '20260822', tMs: 6 }))
      .toBe(false);
  });

  it('날짜가 다르면 다르다(같은 tMs 라도)', () => {
    expect(sameVisibleTimeCutoff({ date: '20260822', tMs: 5 }, { date: '20260821', tMs: 5 }))
      .toBe(false);
  });

  it('null 끼리는 같고, 한쪽만 null 이면 다르다', () => {
    expect(sameVisibleTimeCutoff(null, null)).toBe(true);
    expect(sameVisibleTimeCutoff(null, { date: '20260822', tMs: 5 })).toBe(false);
    expect(sameVisibleTimeCutoff({ date: '20260822', tMs: 5 }, null)).toBe(false);
  });
});

/**
 * **`nextVisibleTimeCutoff` — 참조 보존이 재렌더 억제의 실체다.**
 *
 * `rightmostVisibleCandleCutoff` 는 호출마다 **새 객체**를 낸다. 그 결과를 곧장 setState 하면
 * 값이 그대로여도 재렌더가 나고, 팬 한 번의 프레임 대부분이 그 경우다. React 는 `Object.is`
 * 로 같으면 갱신을 버리므로 **이전 참조를 그대로 돌려주는 것**만으로 재렌더가 사라진다.
 *
 * **막는 방향**: 그 비교를 지워 매 프레임 새 객체가 나가는 것(= `LiveChartRoot` 전체 재렌더
 * 부활). 이 단언이 `toEqual` 이 아니라 **`toBe`** 인 이유가 그것이다 — 값이 같은지가 아니라
 * **참조가 같은지**를 재야 의미가 있다.
 * **못 보는 것**: 실제로 몇 번 덜 렌더되는지 — 그건 프로파일의 몫이다.
 */
describe('nextVisibleTimeCutoff', () => {
  const candles = [candle(day1Open), candle(day1Open + 60_000), candle(day1Open + 120_000)];
  const range = (toMs: number): IRange<Time> => ({
    from: (axis.toVirtual(day1Open) / 1000) as Time,
    to: (axis.toVirtual(toMs) / 1000) as Time,
  });

  it('같은 봉이면 **이전 참조 그대로** 돌려준다', () => {
    const first = nextVisibleTimeCutoff(null, candles, range(day1Open + 130_000), axis);
    expect(first).not.toBeNull();
    // 오른쪽 끝 봉이 그대로인 다음 프레임(범위만 조금 달라짐).
    const second = nextVisibleTimeCutoff(first, candles, range(day1Open + 150_000), axis);
    expect(second).toBe(first);
  });

  it('오른쪽 끝 봉이 바뀌면 새 값을 낸다', () => {
    const first = nextVisibleTimeCutoff(null, candles, range(day1Open + 130_000), axis);
    const second = nextVisibleTimeCutoff(first, candles, range(day1Open + 60_000), axis);
    expect(second).not.toBe(first);
    expect(second?.tMs).toBe(day1Open + 60_000);
  });

  it('범위가 없으면 null 이고, 이미 null 이면 그대로 null 이다', () => {
    expect(nextVisibleTimeCutoff(null, candles, null, axis)).toBeNull();
    const some = nextVisibleTimeCutoff(null, candles, range(day1Open + 130_000), axis);
    expect(nextVisibleTimeCutoff(some, candles, null, axis)).toBeNull();
  });
});
