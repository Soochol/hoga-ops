import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle } from '../api/types';
import {
  MAX_LEGIBLE_DAILY_SPAN,
  STUDY_DAILY_FULL_HISTORY_FROM,
  studyDailyContextWindow,
  studyDailyViewport,
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
      save({ timeframe: 'D', range: { from_date: '20260601', to_date: '20260630', from_ms: fromMs, to_ms: toMs } }),
      bars,
    );
    // 저장 range 의 ms 가 아니라 **캔들 ts** 여야 캘린더 축에서 좌표가 맞는다.
    expect(marks).toMatchObject({ fromMs: bars[3].ts_ms, toMs: bars[6].ts_ms, barCount: 4 });
  });

  it('구간 안에 캔들이 하나도 없으면 null — 밴드를 그리지 않는다', () => {
    const bars = candles(5);
    const marks = studySavedRangeMarks(
      save({ range: { from_date: '20200101', to_date: '20200102', from_ms: 1, to_ms: 2 } }),
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
