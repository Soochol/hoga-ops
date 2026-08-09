import type { StudyViewReference } from '../api/studyViews';
import type { LiveEffectiveSession } from '../api/livePastCandles';
import { TIMEFRAME_TO_MS, type Candle, type RangeBundle, type Timeframe, type VolumeProfile } from '../api/types';
import { aggregateCalendar, aggregateCandles, keepRegularSessionCandles } from '../live/aggregateCandles';
import { mergeCalendarCandlesByPriority } from '../live/candleSourceMerge';
import { buildChartBundle } from '../live/buildLiveBundle';
import {
  initialHistoricalDaysFor,
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
  subtractDaysKst,
} from '../live/liveDateTime';
import {
  effectiveSessionBoundsByDate,
  liveVenueSessionBoundsMs,
  liveVenueUsesExtendedMinuteWindow,
} from '../live/liveVenuePolicy';
import type { LiveVenueOption } from '../state/liveVenue';
import { isMinuteTimeframe, type CalendarTimeframe } from '../state/livePage';
import type { StudyDailyContextWindow } from './studyDailyContext';

type StudyReferenceKisBar = {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StudyReferenceQueryInputs = {
  isMinute: boolean;
  bucketMs: number;
  // 호가·사이드카(mode=hoga/sidecar)용 — 분봉 저장에서만 활성(D/W/M은 null).
  range: {
    code: string | null;
    from: string | null;
    to: string | null;
    timeframe: Timeframe | null;
  };
  // 디스크 캔들(/api/range mode=candles) — 항상 활성. 분봉이면 저장 타임프레임,
  // D/W/M이면 '1m'을 받아 프론트에서 캘린더 집계.
  candles: {
    code: string | null;
    from: string | null;
    to: string | null;
    timeframe: Timeframe | null;
  };
  // 스크리너 일봉(디스크 parquet) — D/W/M 갭 채움 전용.
  screenerDaily: {
    code: string | null;
    from: string | null;
    to: string | null;
  };
};

export type StudyReferenceBundleModel = {
  bundle: RangeBundle | null;
  chartBundle: RangeBundle | null;
};

const EMPTY_VOLUME_PROFILE: VolumeProfile = {
  bin_count: 0,
  price_min: 0,
  price_max: 0,
  bin_width: 0,
  bins: [],
};

function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function kisBarToCandle(c: StudyReferenceKisBar): Candle {
  return { ts_ms: c.t_ms, open: c.open, high: c.high, low: c.low, close: c.close, vol_a: c.volume, vol_b: 0 };
}

function emptyRangeBundle(code: string, fromDate: string, toDate: string, bucketMs: number): RangeBundle {
  return {
    code,
    from_date: fromDate,
    to_date: toDate,
    bucket_ms: bucketMs,
    segments: [],
    candles: [],
    quote_ratio: { bucket_ms: bucketMs, points: [] },
    fill_strength: { bucket_ms: bucketMs, points: [] },
    program_trade: { points: [], source: 'kis_program_trade' },
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    price_level_hits: [],
    trade_volume_pocs: [],
    depth_heatmap: [],
    broker_late_entries: [],
  };
}

/**
 * 캘린더 봉 맥락 창(`studyDailyContext`). null = 저장 구간으로 클립(분봉 경로).
 *
 * 값이 있으면 **screenerDaily 창만** 넓히고 클립도 같은 창으로 푼다. 1분봉
 * (hogaplay) 창은 손대지 않는다 — 그쪽 캡은 의도된 방어고, 캡 밖은 screenerDaily 가
 * 덮는다는 계약이 아래 `dailyFrom` 주석에 이미 적혀 있다.
 */
export function studyReferenceQueryInputs(
  save: StudyViewReference | null,
  dailyContext: StudyDailyContextWindow = null,
): StudyReferenceQueryInputs {
  const timeframe = save?.timeframe ?? null;
  const isMinute = timeframe ? isMinuteTimeframe(timeframe) : false;
  const bucketMs = timeframe && isMinute ? TIMEFRAME_TO_MS[timeframe as Timeframe] : 60_000;
  // D/W/M: hogaplay 1m 요청 창은 저장 구간, 단 to 기준 타임프레임별 캡(월봉 ~10년
  // 1m 전량 요청 방지). 캡 밖·캡처 공백은 screenerDaily가 저장 구간 전체를 커버해 채운다.
  const dailyFrom = save && !isMinute
    ? laterDate(save.range.from_date, subtractDaysKst(save.range.to_date, initialHistoricalDaysFor(save.timeframe)))
    : null;

  return {
    isMinute,
    bucketMs,
    range: {
      code: save && isMinute ? save.code : null,
      from: save && isMinute ? save.range.from_date : null,
      to: save && isMinute ? save.range.to_date : null,
      timeframe: save && isMinute ? (save.timeframe as Timeframe) : null,
    },
    candles: {
      code: save ? save.code : null,
      from: save ? (isMinute ? save.range.from_date : dailyFrom) : null,
      to: save ? save.range.to_date : null,
      timeframe: save ? (isMinute ? (save.timeframe as Timeframe) : '1m') : null,
    },
    screenerDaily: {
      code: save && !isMinute ? save.code : null,
      from: save && !isMinute ? (dailyContext?.from ?? save.range.from_date) : null,
      to: save && !isMinute ? (dailyContext?.to ?? save.range.to_date) : null,
    },
  };
}

function candleToBar(c: Candle): StudyReferenceKisBar {
  return { t_ms: c.ts_ms, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.vol_a + c.vol_b };
}

function aggregateReferenceCandles({
  save,
  isMinute,
  rangeCandles,
  screenerDailyCandles,
}: {
  save: StudyViewReference;
  isMinute: boolean;
  rangeCandles: readonly Candle[];
  screenerDailyCandles: readonly StudyReferenceKisBar[];
}): Candle[] {
  if (isMinute) {
    // 서버가 이미 저장 타임프레임 버킷으로 내려주므로 aggregateCandles는 멱등(재정렬만).
    const raw = rangeCandles.map(candleToBar).sort((a, b) => a.t_ms - b.t_ms);
    return aggregateCandles(raw, TIMEFRAME_TO_MS[save.timeframe as Timeframe] / 1000).map(kisBarToCandle);
  }

  // D/W/M: hogaplay 1m을 정규장 필터 후 일봉 집계 → 스크리너 일봉으로 갭 채움(hogaplay 우선).
  // 일(D) granularity에서 병합해 캡 경계·캡처 공백의 부분 버킷을 스크리너가 날짜 단위로 메꾼 뒤,
  // W/M이면 병합 결과를 다시 캘린더 집계한다.
  const oneMinBars = rangeCandles.map(candleToBar).sort((a, b) => a.t_ms - b.t_ms);
  const hogaDaily = aggregateCalendar(keepRegularSessionCandles(oneMinBars), 'D').map(kisBarToCandle);
  const screenerDaily = [...screenerDailyCandles].sort((a, b) => a.t_ms - b.t_ms).map(kisBarToCandle);
  const mergedDaily = mergeCalendarCandlesByPriority(hogaDaily, screenerDaily, 'D');
  if (save.timeframe === 'D') return mergedDaily;
  const mergedBars = mergedDaily.map(candleToBar);
  return aggregateCalendar(mergedBars, save.timeframe as CalendarTimeframe).map(kisBarToCandle);
}

export function buildStudyReferenceBundleModel({
  save,
  venue,
  pastBundle,
  rangeCandles,
  screenerDailyCandles,
  sessions = [],
  dailyContext = null,
}: {
  save: StudyViewReference | null;
  venue: LiveVenueOption;
  pastBundle: RangeBundle | null;
  rangeCandles: readonly Candle[];
  screenerDailyCandles: readonly StudyReferenceKisBar[];
  sessions?: readonly LiveEffectiveSession[];
  /** 캘린더 봉 맥락 창(`studyReferenceQueryInputs` 주석 참조). */
  dailyContext?: StudyDailyContextWindow;
}): StudyReferenceBundleModel {
  if (!save) return { bundle: null, chartBundle: null };

  const inputs = studyReferenceQueryInputs(save, dailyContext);
  // 맥락 창은 **캘린더 봉에서만** 의미가 있다. 호출부가 실수로 분봉에 창을 넘겨도
  // 여기서 무력화해, 분봉 경로의 "저장 구간 = 화면" 계약이 한 곳에서 지켜지게 한다.
  const window = inputs.isMinute ? null : dailyContext;
  const kisCandles = aggregateReferenceCandles({
    save,
    isMinute: inputs.isMinute,
    rangeCandles,
    screenerDailyCandles,
  });
  const clippedKisCandles = inputs.isMinute
    ? kisCandles.filter((c) => c.ts_ms >= save.range.from_ms && c.ts_ms <= save.range.to_ms)
    : kisCandles.filter((c) => {
      // 이 필터가 캘린더 봉의 가시 범위를 정한다. `dailyContext` 없이 저장 구간으로
      // 자르면 일봉이 저장 구간만 보여 "큰 그림에서의 위치" 를 답할 수 없다.
      const date = realMsToYyyymmdd(c.ts_ms);
      const from = window?.from ?? save.range.from_date;
      const to = window?.to ?? save.range.to_date;
      return date >= from && date <= to;
    });
  // 축 기준일은 **실제 마지막 캔들의 날짜**여야 한다. 저장 구간 끝을 쓰면 맥락 창이
  // 그보다 뒤까지 뻗을 때 "오늘 세션" 세그먼트가 더 이른 날짜로 뒤에 붙어 세그먼트
  // 정렬이 깨진다(`[virtualAxis] buildSegments … axis conversions will be wrong`).
  const lastCandle = clippedKisCandles[clippedKisCandles.length - 1];
  const axisTodayDate = window && lastCandle
    ? realMsToYyyymmdd(lastCandle.ts_ms)
    : save.range.to_date;
  const effectiveSessionByDate = effectiveSessionBoundsByDate(sessions);
  const sessionForDate = inputs.isMinute
    ? (yyyymmdd: string) =>
        effectiveSessionByDate.get(yyyymmdd) ??
        (liveVenueUsesExtendedMinuteWindow(venue)
          ? liveVenueSessionBoundsMs(yyyymmdd, venue)
          : {
              open_ms: regularSessionOpenMs(yyyymmdd),
              close_ms: regularSessionCloseMs(yyyymmdd),
            })
    : undefined;
  const chartBundle = {
    ...buildChartBundle({
      code: save.code,
      todayDate: axisTodayDate,
      todaySession: {
        open_ms: regularSessionOpenMs(axisTodayDate),
        close_ms: regularSessionCloseMs(axisTodayDate),
      },
      pastBundle: inputs.isMinute ? pastBundle : null,
      kisCandles: clippedKisCandles,
      bucketMs: inputs.bucketMs,
      hasTodayObSignal: false,
      investorPoints: [],
      sessionBoundsForDate: sessionForDate,
    }),
    // 번들 메타는 **실제로 들고 있는 범위**를 말한다 — 맥락 창을 열었으면 그 창이고,
    // 우측은 요청 상한(오늘)이 아니라 마지막 캔들 날짜다(디스크에 없는 날은 없는 것).
    from_date: window?.from ?? save.range.from_date,
    to_date: window && lastCandle ? axisTodayDate : save.range.to_date,
  };

  if (!inputs.isMinute || !pastBundle) {
    return {
      chartBundle,
      bundle: {
        ...emptyRangeBundle(save.code, save.range.from_date, save.range.to_date, inputs.bucketMs),
        ...chartBundle,
      },
    };
  }

  return {
    chartBundle,
    bundle: {
      ...chartBundle,
      quote_ratio: pastBundle.quote_ratio,
      fill_strength: pastBundle.fill_strength,
      program_trade: pastBundle.program_trade,
      volume_profile_range: pastBundle.volume_profile_range,
      volume_profile_by_day: pastBundle.volume_profile_by_day,
      volume_distributions: pastBundle.volume_distributions,
      ask_peaks: pastBundle.ask_peaks,
      bid_peaks: pastBundle.bid_peaks ?? [],
      price_level_hits: pastBundle.price_level_hits ?? [],
      trade_volume_pocs: pastBundle.trade_volume_pocs ?? [],
      depth_heatmap: pastBundle.depth_heatmap ?? [],
      broker_late_entries: pastBundle.broker_late_entries ?? [],
    },
  };
}
