import type { StudyViewReference } from '../api/studyViews';
import type { LiveEffectiveSession } from '../api/livePastCandles';
import { TIMEFRAME_TO_MS, type Candle, type RangeBundle, type Timeframe, type VolumeProfile } from '../api/types';
import { aggregateCalendar, aggregateCandles } from '../live/aggregateCandles';
import { buildChartBundle } from '../live/buildLiveBundle';
import {
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
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
  // 디스크 캔들(/api/range mode=candles) — **분봉 저장에서만 활성**(D/W/M은 null).
  // 캘린더 봉은 스크리너 일봉만 쓴다(`aggregateReferenceCandles` 주석).
  candles: {
    code: string | null;
    from: string | null;
    to: string | null;
    timeframe: Timeframe | null;
  };
  // 스크리너 일봉(디스크 parquet) — **D/W/M 화면의 유일한 소스**(예전엔 갭 채움용).
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
 * 값이 있으면 screenerDaily 창을 넓히고 클립도 같은 창으로 푼다. 캘린더 봉의
 * 소스가 screenerDaily 하나뿐이므로, 이 창이 곧 화면 범위다.
 */
export function studyReferenceQueryInputs(
  save: StudyViewReference | null,
  dailyContext: StudyDailyContextWindow = null,
): StudyReferenceQueryInputs {
  const timeframe = save?.timeframe ?? null;
  const isMinute = timeframe ? isMinuteTimeframe(timeframe) : false;
  const bucketMs = timeframe && isMinute ? TIMEFRAME_TO_MS[timeframe as Timeframe] : 60_000;

  return {
    isMinute,
    bucketMs,
    range: {
      code: save && isMinute ? save.code : null,
      from: save && isMinute ? save.range.from_date : null,
      to: save && isMinute ? save.range.to_date : null,
      timeframe: save && isMinute ? (save.timeframe as Timeframe) : null,
    },
    // ⚠ **분봉 저장에서만 켠다.** D/W/M 은 예전에 여기서 1분봉을 저장 구간만큼
    // 받아 프론트에서 일봉으로 접고 screenerDaily 로 갭을 채웠다(hogaplay 우선).
    // 그 병합을 걷어낸 이유는 `aggregateReferenceCandles` 주석에 있다 — 요약하면
    // **두 소스의 주가 기준이 달라 섞으면 안 되고**(액면분할 종목에서 봉 하나가
    // 1/5로 튀었다), 섞어서 얻던 것도 사실상 없었다(5종목 실측: hogaplay 에만
    // 있는 날짜 0, OHLC 불일치 1~3%).
    candles: {
      code: save && isMinute ? save.code : null,
      from: save && isMinute ? save.range.from_date : null,
      to: save && isMinute ? save.range.to_date : null,
      timeframe: save && isMinute ? (save.timeframe as Timeframe) : null,
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

  // D/W/M: **스크리너 일봉만** 쓴다. W/M 이면 그 일봉을 캘린더 집계한다.
  //
  // 예전에는 hogaplay 1분봉을 정규장 필터 후 일봉으로 접고 스크리너로 갭을 채웠다
  // (hogaplay 우선). 그 병합을 걷어냈다 — 실측이 두 가지를 보여줬기 때문이다.
  //
  // **① 두 소스는 주가 기준이 다르다. 섞으면 봉이 튄다.** 스크리너는 수정주가,
  // hogaplay 1분봉은 그날의 원주가다. 5:1 액면분할 종목(010120)에서 hogaplay 캡처가
  // 없는 하루가 스크리너 값으로 채워지며 close 가 293,000 → **57,300** → 278,500 으로
  // 꽂혔다. 다른 종목에서 안 보였던 건 분할이 없어서지 병합이 안전해서가 아니다
  // — 그 종목들도 스크리너로 채우는 날이 13~24일씩 있었다.
  //
  // **② 섞어서 얻던 것이 사실상 없었다.** 5종목·5개월 실측에서 hogaplay 에만 있는
  // 날짜는 **한 종목도 없었고**(스크리너가 항상 덮는다), OHLC 불일치는 1~3% 였다
  // (high/low/close 는 완전 일치, open 만 하루). 유일하게 일관되게 달랐던 거래량은
  // hogaplay 쪽이 **항상 적었다**(3.5~28%) — 캡처가 불완전하다는 뜻이라, 우선할
  // 이유가 아니라 우선하지 말아야 할 이유다.
  //
  // 대가: 캘린더 봉은 수정주가, 분봉은 원주가로 갈린다. 다만 **그 분기는 이 변경이
  // 만든 것이 아니다** — 이전에는 같은 갈림이 한 차트 **안에서** 일어났다.
  const screenerDaily = [...screenerDailyCandles].sort((a, b) => a.t_ms - b.t_ms).map(kisBarToCandle);
  if (save.timeframe === 'D') return screenerDaily;
  const dailyBars = screenerDaily.map(candleToBar);
  return aggregateCalendar(dailyBars, save.timeframe as CalendarTimeframe).map(kisBarToCandle);
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
