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

export function studyReferenceQueryInputs(save: StudyViewReference | null): StudyReferenceQueryInputs {
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
      from: save && !isMinute ? save.range.from_date : null,
      to: save && !isMinute ? save.range.to_date : null,
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
}: {
  save: StudyViewReference | null;
  venue: LiveVenueOption;
  pastBundle: RangeBundle | null;
  rangeCandles: readonly Candle[];
  screenerDailyCandles: readonly StudyReferenceKisBar[];
  sessions?: readonly LiveEffectiveSession[];
}): StudyReferenceBundleModel {
  if (!save) return { bundle: null, chartBundle: null };

  const inputs = studyReferenceQueryInputs(save);
  const kisCandles = aggregateReferenceCandles({
    save,
    isMinute: inputs.isMinute,
    rangeCandles,
    screenerDailyCandles,
  });
  const clippedKisCandles = inputs.isMinute
    ? kisCandles.filter((c) => c.ts_ms >= save.range.from_ms && c.ts_ms <= save.range.to_ms)
    : kisCandles.filter((c) => {
      const date = realMsToYyyymmdd(c.ts_ms);
      return date >= save.range.from_date && date <= save.range.to_date;
    });
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
      todayDate: save.range.to_date,
      todaySession: {
        open_ms: regularSessionOpenMs(save.range.to_date),
        close_ms: regularSessionCloseMs(save.range.to_date),
      },
      pastBundle: inputs.isMinute ? pastBundle : null,
      kisCandles: clippedKisCandles,
      bucketMs: inputs.bucketMs,
      hasTodayObSignal: false,
      investorPoints: [],
      sessionBoundsForDate: sessionForDate,
    }),
    from_date: save.range.from_date,
    to_date: save.range.to_date,
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
