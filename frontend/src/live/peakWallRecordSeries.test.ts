import { describe, expect, it } from 'vitest';
import {
  buildPeakRecordSeries,
  todaySeedRow,
  EMPTY_PEAK_RECORD_SERIES,
} from './peakWallRecordSeries';
import type { AskPeakCandidate } from '../api/types';

const c = (price: number, qty: number, t_ms: number): AskPeakCandidate => ({ price, qty, t_ms });

describe('buildPeakRecordSeries', () => {
  it('seed(오전)와 라이브 스냅샷(당일 전체)의 합집합을 시각순으로 낸다', () => {
    const series = buildPeakRecordSeries(
      { traded_record_peaks: [c(100, 50, 3)], traded_record_max_peaks: [c(100, 60, 3)] },
      { traded_record_peaks: [c(110, 900, 9), c(105, 300, 5)] },
    );
    expect(series.close).toEqual([c(100, 50, 3), c(105, 300, 5), c(110, 900, 9)]);
    // 라이브는 축 구분이 없어 cont 쪽에도 같은 배열이 실린다(seed 만 두 축이 다르다).
    expect(series.max).toEqual([c(100, 60, 3), c(105, 300, 5), c(110, 900, 9)]);
  });

  it('상한을 걸지 않는다 — 랭커를 태우면 top-3 으로 잘려 계열의 존재 이유가 사라진다', () => {
    const many = Array.from({ length: 12 }, (_, i) => c(100 + i, 10 * (i + 1), i));
    expect(buildPeakRecordSeries({ traded_record_peaks: many }, null).close).toHaveLength(12);
  });

  it('같은 벽이 두 출처에 다 있으면 한 번만 남는다', () => {
    const shared = c(100, 50, 3);
    const series = buildPeakRecordSeries(
      { traded_record_peaks: [shared] },
      { traded_record_peaks: [shared, c(110, 900, 9)] },
    );
    expect(series.close).toEqual([shared, c(110, 900, 9)]);
  });

  it('두 출처가 다 비면 빈 계열 — 하류(expandBaselinePeaks)가 top-3 으로 폴백한다', () => {
    expect(buildPeakRecordSeries(null, null)).toEqual(EMPTY_PEAK_RECORD_SERIES);
    expect(buildPeakRecordSeries({}, {})).toEqual(EMPTY_PEAK_RECORD_SERIES);
  });
});

describe('todaySeedRow', () => {
  it('오늘 날짜의 seed 행을 고른다', () => {
    const rows = [{ date: '20260612' }, { date: '20260613' }];
    expect(todaySeedRow(rows, '20260613')).toBe(rows[1]);
    expect(todaySeedRow(rows, '20260614')).toBeNull();
  });
});
