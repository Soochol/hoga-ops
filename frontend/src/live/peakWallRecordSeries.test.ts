import { describe, expect, it } from 'vitest';
import {
  buildPeakRecordSeries,
  todaySeedRow,
  offerPeakRecord,
  withSessionRecords,
  PeakRecordAccumulator,
  PEAK_RECORD_CAP,
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

// 백엔드 `_TodaySidePeakState._offer_record` 의 미러다 — 규약이 같아야 하므로
// `tests/unit/live/test_ask_peak_state.py` 의 같은 이름 절과 짝을 맞춘다.
describe('offerPeakRecord', () => {
  it('시간순 prefix maxima 를 유지한다 — 제시 순서에 무관하다', () => {
    const records: AskPeakCandidate[] = [];
    // 뒤(t=30, 300)를 먼저, 앞(t=10, 100)을 나중에 — 도착 순서로 접으면 앞이 사라진다.
    offerPeakRecord(records, c(110, 300, 30));
    offerPeakRecord(records, c(100, 100, 10));
    expect(records).toEqual([c(100, 100, 10), c(110, 300, 30)]);
  });

  it('뒤늦게 제시된 앞선 큰 벽은 뒤 항목을 소급 무효화한다', () => {
    const records: AskPeakCandidate[] = [];
    offerPeakRecord(records, c(110, 100, 30));
    offerPeakRecord(records, c(100, 300, 10));
    expect(records).toEqual([c(100, 300, 10)]);
  });

  it('동률은 기록이 아니다 — 먼저 도달한 것을 유지한다', () => {
    const records: AskPeakCandidate[] = [];
    expect(offerPeakRecord(records, c(100, 400, 10))).toBe(true);
    expect(offerPeakRecord(records, c(105, 400, 20))).toBe(false);
    expect(records).toEqual([c(100, 400, 10)]);
  });

  it('같은 벽을 두 번 제시해도 고정점이다(누적기가 이에 기댄다)', () => {
    const records: AskPeakCandidate[] = [];
    offerPeakRecord(records, c(100, 100, 10));
    offerPeakRecord(records, c(110, 300, 30));
    const snapshot = records.slice();
    offerPeakRecord(records, c(100, 100, 10));
    offerPeakRecord(records, c(110, 300, 30));
    expect(records).toEqual(snapshot);
  });

  it('상한에서 **뒤를** 자른다 — 앞을 자르면 오전이 다시 빈다', () => {
    const records: AskPeakCandidate[] = [];
    for (let i = 0; i < PEAK_RECORD_CAP + 5; i += 1) offerPeakRecord(records, c(100 + i, 10 + i, i));
    expect(records).toHaveLength(PEAK_RECORD_CAP);
    expect(records[0]).toEqual(c(100, 10, 0));
  });
});

describe('PeakRecordAccumulator · withSessionRecords', () => {
  const row = (date: string, tradedPeaks: AskPeakCandidate[]) => ({
    date, traded_peaks: tradedPeaks, traded_record_peaks: [], traded_record_max_peaks: [],
  });

  it('순위 밖으로 밀린 기록을 붙들어 둔다 — 잔여를 닫는 절', () => {
    const accumulator = new PeakRecordAccumulator();
    const early = c(100, 1_000, 10);

    withSessionRecords([row('D', [early])], accumulator, 'D', 'k');
    // 이후 프레임에서 early 는 top-3 밖으로 밀려났다.
    const after = withSessionRecords(
      [row('D', [c(110, 50_000, 30), c(111, 40_000, 31), c(112, 30_000, 32)])],
      accumulator, 'D', 'k',
    );
    expect(after[0].traded_record_peaks).toContainEqual(early);
    expect(after[0].traded_record_max_peaks).toContainEqual(early);
  });

  it('스코프가 바뀌면 누적을 버린다', () => {
    const accumulator = new PeakRecordAccumulator();
    withSessionRecords([row('D', [c(100, 1_000, 10)])], accumulator, 'D', 'code-a');
    const after = withSessionRecords([row('D', [])], accumulator, 'D', 'code-b');
    expect(after[0].traded_record_peaks).toEqual([]);
  });

  it('오늘 행이 없어도 스코프 갱신은 한다 — 옛 종목 기록이 새 종목에 새지 않는다', () => {
    const accumulator = new PeakRecordAccumulator();
    withSessionRecords([row('D', [c(100, 1_000, 10)])], accumulator, 'D', 'code-a');
    withSessionRecords([], accumulator, 'D', 'code-b');           // 전환 직후, 오늘 행 없음
    const after = withSessionRecords([row('D', [])], accumulator, 'D', 'code-b');
    expect(after[0].traded_record_peaks).toEqual([]);
  });

  it('얹을 것이 없으면 원 배열 참조를 그대로 돌려준다(소비처 memo 안정)', () => {
    const accumulator = new PeakRecordAccumulator();
    const rows = [row('D', [])];
    expect(withSessionRecords(rows, accumulator, 'D', 'k')).toBe(rows);
  });
});
