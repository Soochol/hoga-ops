import type { StudyViewReference } from '../api/studyViews';
import { TIMEFRAME_TO_MS, type Candle, type RangeBundle, type Timeframe, type VolumeProfile } from '../api/types';
import { aggregateCalendar, aggregateCandles } from '../live/aggregateCandles';
import { buildChartBundle } from '../live/buildLiveBundle';
import {
  initialHistoricalDaysFor,
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
  subtractDaysKst,
} from '../live/liveDateTime';
import { liveVenueSessionBoundsMs, liveVenueUsesExtendedMinuteWindow } from '../live/liveVenuePolicy';
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
  range: {
    code: string | null;
    from: string | null;
    to: string | null;
    timeframe: Timeframe | null;
  };
  minuteCandles: {
    code: string | null;
    from: string | null;
    to: string | null;
  };
  dailyCandles: {
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
    broker_late_entries: [],
  };
}

export function studyReferenceQueryInputs(save: StudyViewReference | null): StudyReferenceQueryInputs {
  const timeframe = save?.timeframe ?? null;
  const isMinute = timeframe ? isMinuteTimeframe(timeframe) : false;
  const bucketMs = timeframe && isMinute ? TIMEFRAME_TO_MS[timeframe as Timeframe] : 60_000;
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
    minuteCandles: {
      code: save && isMinute ? save.code : null,
      from: save && isMinute ? save.range.from_date : null,
      to: save && isMinute ? save.range.to_date : null,
    },
    dailyCandles: {
      code: save && !isMinute ? save.code : null,
      from: dailyFrom,
      to: save && !isMinute ? save.range.to_date : null,
    },
  };
}

function aggregateReferenceCandles({
  save,
  isMinute,
  minuteCandles,
  dailyCandles,
}: {
  save: StudyViewReference;
  isMinute: boolean;
  minuteCandles: readonly StudyReferenceKisBar[];
  dailyCandles: readonly StudyReferenceKisBar[];
}): Candle[] {
  if (isMinute) {
    const raw = [...minuteCandles].sort((a, b) => a.t_ms - b.t_ms);
    return aggregateCandles(raw, TIMEFRAME_TO_MS[save.timeframe as Timeframe] / 1000).map(kisBarToCandle);
  }

  const raw = [...dailyCandles].sort((a, b) => a.t_ms - b.t_ms);
  const bars = save.timeframe === 'D' ? raw : aggregateCalendar(raw, save.timeframe as CalendarTimeframe);
  return bars.map(kisBarToCandle);
}

export function buildStudyReferenceBundleModel({
  save,
  venue,
  pastBundle,
  minuteCandles,
  dailyCandles,
}: {
  save: StudyViewReference | null;
  venue: LiveVenueOption;
  pastBundle: RangeBundle | null;
  minuteCandles: readonly StudyReferenceKisBar[];
  dailyCandles: readonly StudyReferenceKisBar[];
}): StudyReferenceBundleModel {
  if (!save) return { bundle: null, chartBundle: null };

  const inputs = studyReferenceQueryInputs(save);
  const kisCandles = aggregateReferenceCandles({
    save,
    isMinute: inputs.isMinute,
    minuteCandles,
    dailyCandles,
  });
  const clippedKisCandles = inputs.isMinute
    ? kisCandles.filter((c) => c.ts_ms >= save.range.from_ms && c.ts_ms <= save.range.to_ms)
    : kisCandles.filter((c) => {
      const date = realMsToYyyymmdd(c.ts_ms);
      return date >= save.range.from_date && date <= save.range.to_date;
    });
  const sessionForDate = liveVenueUsesExtendedMinuteWindow(venue)
    ? (yyyymmdd: string) => liveVenueSessionBoundsMs(yyyymmdd, venue)
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
      broker_late_entries: pastBundle.broker_late_entries ?? [],
    },
  };
}
