import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle } from '../api/types';
import {
  MAX_LEGIBLE_DAILY_SPAN,
  STUDY_DAILY_FULL_HISTORY_FROM,
  studyDailyContextWindow,
  studyDailyViewport,
  studySavedRangeCoverage,
  studySavedRangeMarks,
} from './studyDailyContext';
import { todayKstYyyymmdd } from '../live/liveDateTime';

const DAY_MS = 86_400_000;

function save(overrides: Partial<StudyViewReference> = {}): StudyViewReference {
  return {
    schema_version: 2,
    id: 'view-1',
    name: '복기',
    code: '005930',
    label: '삼성전자',
    timeframe: '10m',
    range: {
      from_date: '20260601',
      to_date: '20260630',
      from_ms: 1_780_000_000_000,
      to_ms: 1_782_000_000_000,
    },
    viewport: { right_edge_ms: 1_782_000_000_000, left_edge_ms: 1_780_000_000_000, bar_span: 120, at_live_edge: false },
    memo: '',
    tags: [],
    created_at_ms: 1,
    updated_at_ms: 2,
    ...overrides,
  } as StudyViewReference;
}

/** ts 가 `base + i일` 인 캔들 n개. */
function candles(n: number, base = 1_779_000_000_000): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts_ms: base + i * DAY_MS,
    open: 100, high: 110, low: 90, close: 105, vol_a: 10, vol_b: 0,
  }));
}

describe('studyDailyContextWindow', () => {
  it('분봉 저장·표시에서는 null 이다 — 창을 넓히지 않는다', () => {
    expect(studyDailyContextWindow(save({ timeframe: '10m' }))).toBeNull();
    expect(studyDailyContextWindow(save({ timeframe: '1m' }))).toBeNull();
    expect(studyDailyContextWindow(null)).toBeNull();
  });

  it('캘린더 봉이면 전체 히스토리를 열고 오른쪽은 오늘까지 연다', () => {
    const window = studyDailyContextWindow(save({ timeframe: 'D' }));
    expect(window).not.toBeNull();
    // 앞: 전체 히스토리 센티널 — 저장 구간과 무관한 상수라 캐시 키가 종목당 한 벌이다.
    expect(window!.from).toBe(STUDY_DAILY_FULL_HISTORY_FROM);
    // 뒤: 이후 구간 노출은 항상 켬(2026-08-09 사용자 결정) → 저장 끝이 아니라 오늘.
    expect(window!.to).toBe(todayKstYyyymmdd());
    expect(window!.to > '20260630').toBe(true);
  });

  it('W·M 도 같은 창을 쓴다 — 소스가 일봉 하나라 창도 하나다', () => {
    const daily = studyDailyContextWindow(save({ timeframe: 'D' }))!;
    expect(studyDailyContextWindow(save({ timeframe: 'W' }))).toEqual(daily);
    expect(studyDailyContextWindow(save({ timeframe: 'M' }))).toEqual(daily);
  });
});

describe('studySavedRangeMarks', () => {
  it('저장 구간 안에 실재하는 캔들의 ts 로 경계를 잡는다', () => {
    const bars = candles(10);
    const fromMs = bars[3].ts_ms;
    const toMs = bars[6].ts_ms;
    const marks = studySavedRangeMarks(
      save({ timeframe: 'D', range: { from_date: '20260601', to_date: '20260630', from_ms: fromMs, to_ms: toMs } }).range,
      bars,
    );
    // 저장 range 의 ms 가 아니라 **캔들 ts** 여야 캘린더 축에서 좌표가 맞는다.
    expect(marks).toMatchObject({ fromMs: bars[3].ts_ms, toMs: bars[6].ts_ms, barCount: 4 });
  });

  it('구간 안에 캔들이 하나도 없으면 null — 밴드를 그리지 않는다', () => {
    const bars = candles(5);
    const marks = studySavedRangeMarks(
      save({ range: { from_date: '20200101', to_date: '20200102', from_ms: 1, to_ms: 2 } }).range,
      bars,
    );
    expect(marks).toBeNull();
  });
});

describe('studyDailyViewport', () => {
  const bars = candles(300);
  const fromMs = bars[100].ts_ms;
  const toMs = bars[139].ts_ms; // 저장 구간 40봉

  it('저장 구간 끝보다 오른쪽에 앵커를 둔다 — 이후 구간이 화면에 들어오게', () => {
    const vp = studyDailyViewport(bars, fromMs, toMs)!;
    expect(vp.rightEdgeMs).toBeGreaterThan(toMs);
    // 40봉 × 0.35 = 14봉 뒤
    expect(vp.rightEdgeMs).toBe(bars[139 + 14].ts_ms);
  });

  it('span 은 저장 구간의 2.2배 — 저장 구간이 화면 우측 절반 남짓을 차지한다', () => {
    expect(studyDailyViewport(bars, fromMs, toMs)!.barSpan).toBe(88);
  });

  it('atLiveEdge 는 false — true 면 최신 봉을 따라가 저장 구간이 화면 밖으로 밀린다', () => {
    expect(studyDailyViewport(bars, fromMs, toMs)!.atLiveEdge).toBe(false);
  });

  it('넓은 저장 구간이라도 가독 상한을 넘지 않는다 (#141 몸통 붕괴 방지)', () => {
    const wide = studyDailyViewport(bars, bars[0].ts_ms, bars[250].ts_ms)!;
    expect(wide.barSpan).toBe(MAX_LEGIBLE_DAILY_SPAN);
  });

  it('앵커를 밀어도 마지막 캔들을 넘지 않는다', () => {
    const vp = studyDailyViewport(bars, bars[290].ts_ms, bars[299].ts_ms)!;
    expect(vp.rightEdgeMs).toBe(bars[299].ts_ms);
  });

  it('캔들이 없으면 null', () => {
    expect(studyDailyViewport([], fromMs, toMs)).toBeNull();
  });
});

/**
 * 저장 구간이 캘린더 봉 코퍼스 밖일 때의 안내.
 *
 * 이 가드가 **닫는 방향**은 하나다: 코퍼스의 첫/끝 봉이 저장 구간을 못 덮는 경우.
 * 구간 **안쪽 구멍**은 보지 않고(그 전제는 함수 주석), 분봉 경로는 호출부가 막는다
 * (캔들이 저장 구간으로 클립돼 있어 여기 넣으면 전 구간이 "앞이 잘렸다" 가 된다).
 */
describe('studySavedRangeCoverage', () => {
  // `Date.UTC` 로 잡으면 그대로 KST 09:00 이라 캔들 ts(`_daily_t_ms`)와 같은 격자다.
  // 날짜 문구를 눈으로 확인할 수 있게 실제 달력 값을 쓴다.
  const FROM = Date.UTC(2026, 5, 1); // 2026-06-01
  const TO = Date.UTC(2026, 6, 1); // 2026-07-01
  const daily = (overrides: Partial<StudyViewReference> = {}) => save({
    timeframe: 'D',
    range: { from_date: '20260601', to_date: '20260701', from_ms: FROM, to_ms: TO },
    ...overrides,
  });
  /** `startUtc` 부터 하루 간격 `n` 개. */
  const bars = (startUtc: number, n: number, stepDays = 1): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      ts_ms: startUtc + i * stepDays * DAY_MS,
      open: 100, high: 110, low: 90, close: 105, vol_a: 10, vol_b: 0,
    }));

  it('전 구간을 덮으면 침묵한다 — 정상 화면에 칩이 남으면 안 된다', () => {
    expect(studySavedRangeCoverage(daily(), bars(FROM - 10 * DAY_MS, 60), 'D')).toBeNull();
  });

  it('캔들이 하나도 없으면 침묵한다 — 그 화면은 빈 상태가 소유한다', () => {
    expect(studySavedRangeCoverage(daily(), [], 'D')).toBeNull();
  });

  it('저장 시작일에 봉이 없어도(휴장) 코퍼스가 그 전부터면 침묵한다', () => {
    // 이틀 간격이라 FROM 당일 봉이 없다. 그래도 코퍼스는 구간을 덮고 있다 —
    // 판정 기준이 "그 날의 봉" 이 아니라 "코퍼스의 첫/끝 봉" 이라는 성질을 고정한다.
    const twoDayGrid = bars(FROM - 3 * DAY_MS, 30, 2);
    expect(twoDayGrid.some((c) => c.ts_ms === FROM)).toBe(false);
    expect(studySavedRangeCoverage(daily(), twoDayGrid, 'D')).toBeNull();
  });

  describe('구간 안에 봉이 하나도 없다 — 밴드·동기화가 통째로 사라지는 경우', () => {
    it('무엇이 사라지는지와 어디부터 있는지를 함께 말한다', () => {
      // 코퍼스가 저장 끝보다 뒤에서 시작한다(실측 010140: 저장 2024-08 · 코퍼스 2025-04).
      const notice = studySavedRangeCoverage(daily(), bars(Date.UTC(2026, 6, 6), 20), 'D');
      expect(notice?.text).toBe('저장 구간 데이터 없음');
      // 저장 구간과 코퍼스 시작이 **다른 값**으로 둘 다 문구에 있어야 원인이 보인다.
      expect(notice?.detail).toContain('2026.06.01~2026.07.01');
      expect(notice?.detail).toContain('2026.07.06');
      expect(notice?.detail).toContain('크로스헤어 동기화');
    });

    it('W 에서는 동기화를 잃었다고 말하지 않는다 — 애초에 없는 기능이다', () => {
      const notice = studySavedRangeCoverage(daily(), bars(Date.UTC(2026, 6, 6), 20), 'W');
      expect(notice?.text).toBe('저장 구간 데이터 없음');
      expect(notice?.detail).toContain('기간 밴드');
      expect(notice?.detail).not.toContain('크로스헤어');
    });
  });

  describe('부분 커버리지 — 밴드가 그려지되 구간을 거짓말한다', () => {
    it('앞이 잘리면 코퍼스 시작을 지목한다', () => {
      const notice = studySavedRangeCoverage(daily(), bars(Date.UTC(2026, 5, 10), 40), 'D');
      expect(notice?.text).toBe('저장 구간 일부만 표시');
      expect(notice?.detail).toContain('2026.06.10 부터');
    });

    it('뒤가 잘리면 코퍼스 끝을 지목한다', () => {
      // 6/1 이전에 시작해 6/5 에 끝난다 → 앞은 멀쩡, 뒤가 모자란다.
      const notice = studySavedRangeCoverage(daily(), bars(Date.UTC(2026, 4, 28), 9), 'D');
      expect(notice?.text).toBe('저장 구간 일부만 표시');
      expect(notice?.detail).toContain('2026.06.05 까지만');
    });

    it('앞뒤가 다 잘리면 남은 구간을 통째로 말한다', () => {
      const notice = studySavedRangeCoverage(daily(), bars(Date.UTC(2026, 5, 10), 5), 'D');
      expect(notice?.detail).toContain('2026.06.10~2026.06.14 만');
    });
  });
});
