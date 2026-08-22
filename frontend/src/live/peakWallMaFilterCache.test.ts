/**
 * SMA 메모의 **배선** 가드.
 *
 * ⚠ 결과를 재는 테스트로는 이 최적화를 검증할 수 없다 — 캐시가 있든 없든 답이 같은 것이
 * 계약이라, `filterPeaksAgainstMa` 의 반환값만 보면 **메모가 통째로 없어도 초록**이다.
 * 그래서 여기서는 `computeSMA` 의 **호출 횟수**를 센다(#1445·#1447 이 같은 함정을 두 번
 * 밟았다).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeSMA } from '../chart/projectors/movingAverage';
import { filterPeaksAgainstMa } from './peakWallMaFilter';
import type { AskPeak, Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

vi.mock('../chart/projectors/movingAverage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chart/projectors/movingAverage')>();
  return { ...actual, computeSMA: vi.fn(actual.computeSMA) };
});

const MIN = 60_000;
const BASE = Date.UTC(2026, 5, 23, 0, 0, 0);
const axis = { toVirtual: (ms: number) => ms, contains: () => true } as unknown as VirtualAxis;
const otherAxis = { toVirtual: (ms: number) => ms, contains: () => true } as unknown as VirtualAxis;

/** ⚠ 테스트마다 **새 배열**을 만든다. 캐시 키가 배열 참조이고 WeakMap 은 모듈 레벨이라,
 *  같은 배열을 공유하면 앞 테스트가 채운 캐시를 뒤 테스트가 물려받아 호출 수가 어긋난다
 *  (실측: "새 배열이면 다시 계산" 이 1회로 나와 실패했다). */
function freshCandles(): Candle[] {
  return Array.from({ length: 40 }, (_u, i) => ({
    ts_ms: BASE + i * MIN, open: 100, high: 100, low: 100, close: 100, vol_a: 0, vol_b: 0,
  }));
}

const peaks: AskPeak[] = [{
  date: '20260623', price: 110, qty: 1, t_ms: BASE + 30 * MIN,
  max_price: 110, max_qty: 1, max_t_ms: BASE + 30 * MIN,
}];

const ASK = { side: 'ask' as const, period: 20 };

beforeEach(() => {
  vi.mocked(computeSMA).mockClear();
});

describe('SMA 메모', () => {
  it('같은 캔들·기간으로 반복 호출하면 SMA 를 한 번만 계산한다', () => {
    const cs = freshCandles();
    for (let i = 0; i < 6; i += 1) filterPeaksAgainstMa(peaks, cs, axis, false, ASK);
    expect(vi.mocked(computeSMA)).toHaveBeenCalledTimes(1);
  });

  it('기간이 다르면 각각 계산한다(캔들 필터는 공유)', () => {
    const cs = freshCandles();
    filterPeaksAgainstMa(peaks, cs, axis, false, { side: 'ask', period: 5 });
    filterPeaksAgainstMa(peaks, cs, axis, false, { side: 'ask', period: 10 });
    filterPeaksAgainstMa(peaks, cs, axis, false, { side: 'ask', period: 5 });
    expect(vi.mocked(computeSMA)).toHaveBeenCalledTimes(2);
  });

  it('캔들 배열이 새로 오면 다시 계산한다(스테일 금지)', () => {
    filterPeaksAgainstMa(peaks, freshCandles(), axis, false, ASK);
    filterPeaksAgainstMa(peaks, freshCandles(), axis, false, ASK);
    expect(vi.mocked(computeSMA)).toHaveBeenCalledTimes(2);
  });

  it('축이 바뀌면 다시 계산한다 — 세션 판정이 달라지므로', () => {
    const shared = freshCandles();
    filterPeaksAgainstMa(peaks, shared, axis, false, ASK);
    filterPeaksAgainstMa(peaks, shared, otherAxis, false, ASK);
    expect(vi.mocked(computeSMA)).toHaveBeenCalledTimes(2);
  });
});
