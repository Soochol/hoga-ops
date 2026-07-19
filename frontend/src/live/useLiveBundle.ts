import { useEffect, useMemo, useRef } from 'react';
import type { LiveSeriesData } from '../api/liveSeries';
import { useLiveSettings } from '../api/liveSettings';
import { useLivePastCandles } from '../api/livePastCandles';
import { useLivePastDailyCandles } from '../api/livePastDailyCandles';
import { useLivePastInvestorNet } from '../api/livePastInvestorNet';
import { useScreenerDailyCandles } from '../api/screenerDailyCandles';
import { useRange, useRangeHogaDelta, useRangeSidecarDelta } from '../api/range';
import { type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';
import { useWindowView, useWindowIndicators } from './workspace/windowView';
import type { LiveVenueOption } from '../state/liveVenue';
import {
  kisRestWarningIndicatesUnavailable,
  useKisRestModeStore,
} from '../state/kisRestMode';
import {
  TIMEFRAME_TO_MS,
  type Timeframe,
  type RangeBundle,
  type Candle,
  type InvestorNetPoint,
  type SourceName,
} from '../api/types';
import { buildChartBundle, createIncrementalHogaSeriesBuilder, filterProgramTradeForCandles, type HogaSeries } from './buildLiveBundle';
import type { LiveDataWarning } from './liveDataWarnings';
import type { TradeSnapshot } from './bucketHogaSeries';
import { aggregateCandles, aggregateCalendar, calendarBucketKey } from './aggregateCandles';
import {
  regularSessionOpenMs,
  regularSessionCloseMs,
  realMsToYyyymmdd,
  subtractDaysKst,
  initialHistoricalDaysFor,
  earliestAllowedMinuteDate,
} from './liveDateTime';
import {
  effectiveSessionBoundsByDate,
  liveVenueAllowsTradeOverlay,
  liveVenueSessionBoundsMs,
  liveVenueUsesExtendedMinuteWindow,
} from './liveVenuePolicy';
import { buildLivePriceLevelHits, mergePriceLevelHits } from './priceLevelHits';
import { mergeDepthHeatmapToday } from './depthHeatmapWire';
import { hogaCoverageGapDates as computeHogaCoverageGapDates } from './hogaCoverageGap';

const EMPTY_INVESTOR_POINTS: InvestorNetPoint[] = [];
const EMPTY_CANDLES: Candle[] = [];

function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function kisBarToCandle(b: { t_ms: number; open: number; high: number; low: number; close: number; volume: number }): Candle {
  return {
    ts_ms: b.t_ms,
    open: b.open,
    close: b.close,
    high: b.high,
    low: b.low,
    vol_a: b.volume,
    vol_b: 0,
  };
}

function candleDateSet(candles: readonly Candle[]): Set<string> {
  return new Set(candles.map((c) => realMsToYyyymmdd(c.ts_ms)));
}

function segmentSourceByDate(bundle: RangeBundle | null | undefined, date: string): SourceName | undefined {
  return bundle?.segments.find((s) => s.date === date)?.source;
}

function bucketStartMs(tMs: number, bucketMs: number): number {
  return Math.floor(tMs / bucketMs) * bucketMs;
}

function candlePriceRange(candles: readonly Candle[], startMs: number, endMs: number): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (candle.ts_ms < startMs || candle.ts_ms > endMs) continue;
    if (Number.isFinite(candle.low)) min = Math.min(min, candle.low);
    if (Number.isFinite(candle.high)) max = Math.max(max, candle.high);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export function overlayLiveTradesOnCandles(
  candles: readonly Candle[],
  trades: readonly TradeSnapshot[],
  bucketMs: number,
  venue: LiveVenueOption = 'KRX',
): Candle[] {
  if (candles.length === 0 || bucketMs <= 0) return candles as Candle[];
  const lastBase = candles[candles.length - 1];
  const lastBaseBucket = bucketStartMs(lastBase.ts_ms, bucketMs);
  const byBucket = new Map<number, Array<{ price: number; qty: number; tMs: number }>>();

  for (const snapshot of trades) {
    for (const ev of snapshot.trades) {
      const tMs = ev.t_ms ?? snapshot.t_ms;
      if (
        typeof ev.side !== 'number' ||
        typeof ev.price !== 'number' ||
        typeof ev.qty !== 'number' ||
        !Number.isFinite(tMs) ||
        !Number.isFinite(ev.price) ||
        !Number.isFinite(ev.qty) ||
        ev.qty <= 0 ||
        !liveVenueAllowsTradeOverlay(venue, snapshot.venue, tMs)
      ) {
        continue;
      }
      const bucket = bucketStartMs(tMs, bucketMs);
      if (bucket < lastBaseBucket) continue;
      const bucketTrades = byBucket.get(bucket) ?? [];
      bucketTrades.push({ price: ev.price, qty: ev.qty, tMs });
      byBucket.set(bucket, bucketTrades);
    }
  }
  if (byBucket.size === 0) return candles as Candle[];

  let out: Candle[] | null = null;
  for (const [bucket, bucketTrades] of Array.from(byBucket.entries()).sort((a, b) => a[0] - b[0])) {
    bucketTrades.sort((a, b) => a.tMs - b.tMs);
    const lastTrade = bucketTrades[bucketTrades.length - 1];
    const tradeHigh = Math.max(...bucketTrades.map((t) => t.price));
    const tradeLow = Math.min(...bucketTrades.map((t) => t.price));
    const tradeQty = bucketTrades.reduce((sum, t) => sum + t.qty, 0);
    const currentCandles: readonly Candle[] = out ?? candles;
    const last: Candle = currentCandles[currentCandles.length - 1];
    if (bucket === last.ts_ms) {
      if (out === null) out = [...candles.slice(0, -1), { ...last }];
      const mutableLast = out[out.length - 1];
      mutableLast.high = Math.max(mutableLast.high, tradeHigh);
      mutableLast.low = Math.min(mutableLast.low, tradeLow);
      mutableLast.close = lastTrade.price;
      mutableLast.vol_a += tradeQty;
    } else if (bucket > last.ts_ms) {
      if (out === null) out = [...candles];
      const prev = out[out.length - 1];
      out.push({
        ts_ms: bucket,
        open: prev.close,
        high: tradeHigh,
        low: tradeLow,
        close: lastTrade.price,
        vol_a: tradeQty,
        vol_b: 0,
      });
    }
  }

  return out ?? (candles as Candle[]);
}

/**
 * D/W/M 캔들의 마지막(=오늘이 속한) 캘린더 버킷에 live 체결을 접어 넣는다.
 * `overlayLiveTradesOnCandles`(분봉)의 캘린더 판(版) — 차이점:
 *  - 버킷 판정을 epoch-floor(`bucketStartMs`)가 아니라 `calendarBucketKey`(KST
 *    날짜/주/월)로 한다. W/M은 기간이 가변이라 floor로는 깨진다.
 *  - **vol_a는 건드리지 않는다.** KIS/스크리너 일봉의 오늘 volume은 이미 당일
 *    누적치라 버퍼 qty를 더하면 이중계산 — 60초 refetch가 volume 정본을 공급한다.
 *    (새로 만드는 캔들만 best-effort로 버퍼 qty 합을 넣는다.)
 *  - 오늘 버킷이 아직 없으면(우회 모드 디스크는 어제까지, 콜드 로드) 새 캔들을
 *    만든다. ts_ms=09:00 KST(백엔드 anchor 일치 → refetch가 같은 ts로 자연 대체),
 *    open=첫 유효 체결가(prev.close는 일봉 갭 시가를 오도).
 * 유효성 술어는 `freshLiveTradePrice`(deriveCurrentPriceLine.ts)와 동일 —
 * 현재가 라인과 캔들 close가 같은 체결 집합을 보게 해 "라인 = 마지막 close" 정합.
 * 유효 체결이 없거나 OHLC가 안 변하면 입력 배열 참조를 그대로 반환해 downstream
 * churn(setData/크로스헤어/축)을 억제한다.
 */
export function overlayLiveTradesOnCalendarCandles(
  candles: readonly Candle[],
  trades: readonly TradeSnapshot[],
  granularity: 'D' | 'W' | 'M',
  venue: LiveVenueOption = 'KRX',
): Candle[] {
  if (candles.length === 0) return candles as Candle[];
  const last = candles[candles.length - 1];
  const lastKey = calendarBucketKey(last.ts_ms, granularity);

  const sameBucket: Array<{ price: number; qty: number; tMs: number }> = [];
  const newBuckets = new Map<string, Array<{ price: number; qty: number; tMs: number }>>();

  for (const snapshot of trades) {
    for (const ev of snapshot.trades) {
      const tMs = ev.t_ms ?? snapshot.t_ms;
      if (
        typeof ev.side !== 'number' ||
        typeof ev.price !== 'number' ||
        typeof ev.qty !== 'number' ||
        !Number.isFinite(tMs) ||
        !Number.isFinite(ev.price) ||
        ev.price <= 0 ||
        !Number.isFinite(ev.qty) ||
        ev.qty <= 0 ||
        !liveVenueAllowsTradeOverlay(venue, snapshot.venue, tMs)
      ) {
        continue;
      }
      const key = calendarBucketKey(tMs, granularity);
      if (key === lastKey) {
        sameBucket.push({ price: ev.price, qty: ev.qty, tMs });
      } else if (tMs > last.ts_ms) {
        const group = newBuckets.get(key) ?? [];
        group.push({ price: ev.price, qty: ev.qty, tMs });
        newBuckets.set(key, group);
      }
      // else: 마지막 캔들보다 과거 버킷의 체결 → skip.
    }
  }
  if (sameBucket.length === 0 && newBuckets.size === 0) return candles as Candle[];

  let out: Candle[] | null = null;

  if (sameBucket.length > 0) {
    sameBucket.sort((a, b) => a.tMs - b.tMs);
    const high = Math.max(last.high, ...sameBucket.map((t) => t.price));
    const low = Math.min(last.low, ...sameBucket.map((t) => t.price));
    const close = sameBucket[sameBucket.length - 1].price;
    // OHLC 무변화 → 참조 유지(churn 억제). vol_a는 의도적으로 불변.
    if (high !== last.high || low !== last.low || close !== last.close) {
      out = [...candles.slice(0, -1), { ...last, high, low, close }];
    }
  }

  // 그룹 내부는 tMs 정렬, 그룹 간에도 앵커(첫 체결 tMs) 오름차순으로 append 한다.
  // live.trade 버퍼는 시간순이라 삽입 순서가 대개 오름차순이지만, 버퍼 시간 역전·
  // 자정 초과로 미래 버킷이 2개 이상 생기면 ts_ms 비오름차순이 될 수 있다. lwc
  // setData 는 오름차순을 가정하므로 방어적으로 정렬(분봉 경로 byBucket sort 와 대칭).
  const sortedNewBuckets = Array.from(newBuckets.values());
  for (const group of sortedNewBuckets) group.sort((a, b) => a.tMs - b.tMs);
  sortedNewBuckets.sort((a, b) => a[0].tMs - b[0].tMs);
  for (const group of sortedNewBuckets) {
    out = out ?? [...candles];
    out.push({
      ts_ms: regularSessionOpenMs(realMsToYyyymmdd(group[0].tMs)),
      open: group[0].price,
      high: Math.max(...group.map((t) => t.price)),
      low: Math.min(...group.map((t) => t.price)),
      close: group[group.length - 1].price,
      // best-effort 하한(당일 누적치 아님). KIS 모드는 다음 refetch 가 정본으로
      // 교정하지만, bypass(D) 모드의 useScreenerDailyCandles 는 refetchInterval 이
      // 없어(staleTime 60s 만) 교정이 오지 않는다 → today 캔들 volume 은 버퍼 tail
      // 합계로 근사 유지된다(close/high/low 는 매 틱 정상 갱신). 의도된 한계.
      vol_a: group.reduce((sum, t) => sum + t.qty, 0),
      vol_b: 0,
    });
  }

  return out ?? (candles as Candle[]);
}

export interface UseLiveBundleResult {
  /** Full bundle = stable chart side + live hoga overlay. Consumed by hoga
   * panes (ratio/quoteTotals/fillStrength), LiveStatusBar, LiveSidebar. New ref
   * on every SSE tick. */
  bundle: RangeBundle | null;
  /** Chart side only (candles + segments + investor), STABLE across SSE ticks.
   * Consumed by the candle/volume panes + axis + candle overlays so a tick
   * doesn't churn the candle path (2026-06-09 bundle-split, Phase A). Shares
   * `bundle`'s segments/candles refs (bundle spreads it). */
  chartBundle: RangeBundle | null;
  /** Hoga indicator panes only (quote totals / ratio / fill strength). Stable
   * across the slower full sidecar range so those panes can paint from
   * `mode=hoga` without being re-keyed when volume-distribution sidecars land. */
  hogaBundle: RangeBundle | null;
  isLoading: boolean;
  error: unknown;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** 호가 지표 경로(/api/range mode=hoga)의 CURRENT (code, timeframe) 뷰 초기 fetch가
   * 아직 pending인가. LiveChartRoot의 reveal 커버가 isPastCandlesLoading과 함께 써서
   * 초기 로드/종목 전환/타임프레임 전환 시 캔들+호가 pane이 한 번의 reveal로 등장하게 한다.
   * - `isLoading` 단독으로 re-key 안전: rangePlaceholderData가 code(rangeRequest.ts)·
   *   bucketMs 변경 시 placeholder를 드롭하므로 stale 호가가 settled로 위장 불가.
   *   placeholder 생존은 같은 뷰의 from/to 변경(좌측 팬)뿐 — reveal 게이트는 그 경로를
   *   일부러 홀드하지 않는다(isExtending이 별도 원자화).
   * - `&& data == null`: 캐시된 뷰로 되돌아올 때 병합 이전 번들이 즉시 서빙되는 동안
   *   오늘-델타(from=to=today) 리프레시가 isLoading일 수 있어 불필요 홀드를 방지.
   * - 에러 settle(status 'error' → isLoading false)·disabled(D/W/M: planLiveRangeRequest가
   *   code를 null) 모두 false라 영구 홀드 없음. */
  isHogaLoading: boolean;
  /** 좌측 팬 한 스텝이 진행 중(placeholderData+isFetching). false-edge = 스텝 settle.
   * LiveChartRoot 진행 루프가 이 falling edge에 반응해 다음 스텝을 dispatch한다. */
  isExtending: boolean;
  /** 사이드카 지표 경로(/api/range mode=sidecar)의 초기 fetch가 아직 pending인가.
   * LiveChartRoot의 reveal 커버가 캔들·호가와 함께 써서 최대벽·POC·거래량분포·프로그램
   * 매매가 캔들과 한 번의 reveal로 등장하게 한다(개선안 1-A). 캔들 settle 후 상한(캡)까지만
   * 대기하고, 사이드카가 rate-limit로 늦어지면 캔들을 인질로 잡지 않는다.
   * - sidecarEnabled=false(지표 전부 off)면 항상 false → 홀드 없음.
   * - `data == null`: 캐시된 뷰 재방문 시 즉시 서빙되는 동안 리프레시가 isLoading이어도
   *   불필요 홀드를 방지. 에러 settle도 isLoading=false라 영구 홀드 없음. */
  isSidecarLoading: boolean;
  /** 활성 타임프레임 경로(분봉=past-candles, D/W/M=past-daily-candles)의 fetch 경고.
   * 백엔드가 KIS rate-limit 등으로 일부/전체 날짜를 못 받으면 채운다. LiveChartRoot가
   * 빈칸 문구 전환 + 부분 로딩 칩에 쓴다(2026-06-09). 무경고면 빈 배열. */
  pastDataWarnings: LiveDataWarning[];
  /** 캔들은 있는데 10호가 캡처가 없는 과거 거래일(YYYYMMDD 오름차순). 이 날짜들은
   * 최대벽·매물대·호가비 등 캡처 기반 지표가 빠지므로 LiveStatusBar가 warn 칩으로
   * 드러낸다. 분봉 전용(D/W/M은 호가 pane이 없어 빈 배열), hoga 번들 미로드 시에도
   * 빈 배열(판정 유보 — 로딩 중 거짓 경고 방지). */
  hogaCoverageGapDates: string[];
  /** Coverage-gap 백필(A안): 활성 range 지표(hoga + 활성 sidecar)가 도달한 가장 최근
   * from_date(YYYYMMDD). 캔들이 병합 캐시로 더 과거까지 복원돼도 지표가 이 날짜까지만
   * 있으면, useViewportBackfill이 viewport 좌단이 이보다 과거일 때 range 창을 확장한다.
   * 분봉 전용(D/W/M은 range 지표 없음 → null), 미로드 시 null. */
  indicatorCoverageFromDate: string | null;
  /** 지금 range가 요청 중인 창의 from(YYYYMMDD). coverage 스텝 base의 null-fallback.
   * 분봉 외/미요청이면 null. */
  rangeWindowFromDate: string | null;
}

type UseLiveBundleOptions = {
  investorNetEnabled?: boolean;
  venue?: LiveVenueOption;
  /** 같은 그룹의 데이터 창(매물대·프로그램)이 요구하는 sidecar 강제 fetch
   *  (ADR-0119 PR-D). 창의 지표 토글과 OR — pane 표시는 지표 토글만 따르고
   *  (LiveChartRoot 는 useWindowIndicator 직독) fetch 범위만 확장된다. 그룹의
   *  링크 발행 차트 창(groupTargetChartWindow)만 이 옵션을 켠다. */
  sidecarDemands?: { programTrade?: boolean; volumeDistribution?: boolean };
};

export type LiveRangeRequestPlan = {
  code: string | null;
  from: string | null;
  to: string | null;
  timeframe: Timeframe | null;
  todayKst: string | null;
  options: {
    askPeaksEnabled: boolean;
    bidPeaksEnabled: boolean;
    brokerLateEntriesEnabled: boolean;
    brokerLateEntryStartHHMM: number | null;
    programTradeEnabled: boolean;
    tradeVolumePocEnabled: boolean;
    depthHeatmapEnabled: boolean;
    volumeDistributionBins: number | null;
    tradeVolumePocBins: number | null;
    volumeDistributionPriceRange: { min: number; max: number } | null;
  };
};

export function planLiveRangeRequest(args: {
  code: string | null;
  timeframe: LiveTimeframe;
  todayKstYyyymmdd: string;
  historicalFromDate: string | null;
  askPeakEnabled: boolean;
  bidPeakEnabled: boolean;
  tradeVolumePocEnabled: boolean;
  depthHeatmapEnabled: boolean;
  brokerLateEntryEnabled: boolean;
  brokerLateEntryStartHHMM: number;
  programTradeEnabled: boolean;
  volumeDistributionEnabled: boolean;
  volumeDistributionRangeCount: number;
  volumeDistributionPriceRange: { min: number; max: number } | null;
}): LiveRangeRequestPlan {
  const isMinute = isMinuteTimeframe(args.timeframe);
  const seedFrom = args.historicalFromDate
    ?? subtractDaysKst(args.todayKstYyyymmdd, initialHistoricalDaysFor(args.timeframe));
  const minutePastFrom = laterDate(seedFrom, earliestAllowedMinuteDate(args.todayKstYyyymmdd));
  const enableMinute = !!(args.code && isMinute && minutePastFrom <= args.todayKstYyyymmdd);
  return {
    code: enableMinute ? args.code : null,
    from: enableMinute ? minutePastFrom : null,
    to: enableMinute ? args.todayKstYyyymmdd : null,
    timeframe: enableMinute ? (args.timeframe as Timeframe) : null,
    todayKst: enableMinute ? args.todayKstYyyymmdd : null,
    options: {
      askPeaksEnabled: enableMinute && args.askPeakEnabled,
      bidPeaksEnabled: enableMinute && args.bidPeakEnabled,
      brokerLateEntriesEnabled: args.brokerLateEntryEnabled,
      brokerLateEntryStartHHMM: args.brokerLateEntryEnabled ? args.brokerLateEntryStartHHMM : null,
      programTradeEnabled: enableMinute && args.programTradeEnabled,
      tradeVolumePocEnabled: enableMinute && args.tradeVolumePocEnabled,
      depthHeatmapEnabled: enableMinute && args.depthHeatmapEnabled,
      volumeDistributionBins: args.volumeDistributionEnabled ? args.volumeDistributionRangeCount : null,
      tradeVolumePocBins: args.tradeVolumePocEnabled ? args.volumeDistributionRangeCount : null,
      volumeDistributionPriceRange: args.volumeDistributionEnabled ? args.volumeDistributionPriceRange : null,
    },
  };
}

/** Orchestrate live SSE + KIS past-candles + /api/range hoga indicators into a
 * single RangeBundle for LiveChartRoot. ADR-0040 — KIS candles are the single
 * candle source via the dedicated `/api/live/past-candles` endpoint.
 *
 * ADR-0048: D/W/M timeframes route through `/api/live/past-daily-candles`
 * (direct daily backfill) instead of aggregating from 1m bars. Only the minute
 * branch is subject to the 250-day clamp; the daily branch has no clamp.
 */
export function useLiveBundle(
  code: string | null,
  timeframe: LiveTimeframe,
  todayKstYyyymmdd: string,
  live: LiveSeriesData,
  options: UseLiveBundleOptions = {},
): UseLiveBundleResult {
  // 창-스코프 뷰(ADR-0119 PR-B) — Provider 밖에서는 전역 스토어로 폴백(기능 무변경).
  const { historicalFromDate } = useWindowView();
  const {
    askPeakEnabled,
    bidPeakEnabled,
    tradeVolumePocEnabled,
    depthHeatmapEnabled,
    brokerLateEntryEnabled,
    brokerLateEntryStartHHMM,
    programTradeEnabled,
    volumeDistributionEnabled,
    volumeDistributionRangeCount,
  } = useWindowIndicators();
  // 데이터 창 수요와 OR 한 유효 fetch 게이트(ADR-0119 PR-D). 아래 fetch 경로는
  // 전부 eff* 를 쓰고, pane 표시 게이트는 이 훅 밖(useWindowIndicator)이라 불변.
  const effProgramTradeEnabled = programTradeEnabled || !!options.sidecarDemands?.programTrade;
  const effVolumeDistributionEnabled =
    volumeDistributionEnabled || !!options.sidecarDemands?.volumeDistribution;
  const { data: liveSettings } = useLiveSettings();
  // 캔들 소스의 유일한 분기 축(4옵션 우선순위-병합 모델 폐기). 우회 OFF=KIS만,
  // 우회 ON=디스크만(분봉 hogaplay / D·W·M 스크리너). 모드당 소스 1개라 병합 없음.
  const kisRestBypassEnabled = liveSettings?.kis_rest_bypass_enabled ?? false;
  const notifyKisRestFailure = useKisRestModeStore((s) => s.notifyFailure);
  const venue = options.venue ?? 'KRX';

  const isMinute = isMinuteTimeframe(timeframe);
  const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;

  // 250-day clamp at the bundle layer so /api/range's 90-day cap and
  // /api/live/past-candles' 250-day cap can stay independent. Applies to
  // the minute path only — the daily endpoint has no equivalent cap.
  const seedFrom = historicalFromDate ?? subtractDaysKst(todayKstYyyymmdd, initialHistoricalDaysFor(timeframe));
  const earliestAllowedMinute = earliestAllowedMinuteDate(todayKstYyyymmdd);
  const minutePastFrom = laterDate(seedFrom, earliestAllowedMinute);
  // Includes today so post-promote disk data (hogaplay/snapshots.parquet,
  // ADR-0037 v2 layout) feeds today's hoga indicators. Before this, today's
  // quote_ratio/fill_strength came only from the in-memory SSE buffer, which
  // is volatile across backend restarts. buildLiveBundle's pastHasTodaySegment
  // check + the t > pastMaxQrT incremental filter already handle the dedup
  // with the SSE tail (buildLiveBundle.ts:67, 72).
  const minutePastTo = todayKstYyyymmdd;

  // KIS 분봉 캔들 — 우회 OFF에서만 fetch. 우회 ON이면 code=null로 비활성(요청 절약).
  // (hoga 지표 쿼리 pastHoga는 이 게이트와 무관하게 rangePlan에서 별도로 발사된다.)
  const enableMinute = !!(code && isMinute && minutePastFrom <= minutePastTo && !kisRestBypassEnabled);
  const pastCandlesQuery = useLivePastCandles(
    enableMinute ? code : null,
    enableMinute ? minutePastFrom : null,
    enableMinute ? minutePastTo : null,
    venue,
    todayKstYyyymmdd,
  );

  // KIS daily past-candles — D/W/M, 우회 OFF에서만 (ADR-0048).
  const enableDaily = !!(code && !isMinute && !kisRestBypassEnabled);
  const dailyPastFrom = seedFrom;
  const dailyPastTo = todayKstYyyymmdd;
  const pastDailyCandlesQuery = useLivePastDailyCandles(
    enableDaily ? code : null,
    enableDaily ? dailyPastFrom : null,
    enableDaily ? dailyPastTo : null,
    venue,
  );
  // 스크리너 일봉 — D/W/M, 우회 ON 전용(디스크 소스).
  const enableScreenerDaily = !!(code && !isMinute && kisRestBypassEnabled);
  const screenerDailyCandlesQuery = useScreenerDailyCandles(
    enableScreenerDaily ? code : null,
    enableScreenerDaily ? dailyPastFrom : null,
    enableScreenerDaily ? dailyPastTo : null,
  );

  // Investor net-buy (foreign/institution) — 'D' (일봉) ONLY. KIS
  // investor-trade-by-stock-daily (FHPTJ04160001) walks back the requested
  // [from, to] range by date cursor. ADR-0055.
  // Why daily-only, not all calendar frames: investor points are daily-anchored
  // (09:00 KST), but W/M aggregate candles into week/month segments, so most
  // daily points would fall outside axis.contains and render a near-empty pane.
  // Optional pane data: if no investor pane is visible, do not fetch it or let
  // its later response churn the D chart bundle after the candles are revealed.
  const enableInvestor = !!(code && timeframe === 'D' && options.investorNetEnabled === true);
  const investorQuery = useLivePastInvestorNet(
    enableInvestor ? code : null,
    enableInvestor ? dailyPastFrom : null,
    enableInvestor ? dailyPastTo : null,
  );
  const investorPoints = useMemo<InvestorNetPoint[]>(
    () => (enableInvestor ? investorQuery.data?.points ?? EMPTY_INVESTOR_POINTS : EMPTY_INVESTOR_POINTS),
    [enableInvestor, investorQuery.data],
  );

  useEffect(() => {
    if (kisRestBypassEnabled) return;
    const warnings = isMinute
      ? pastCandlesQuery.data?.data_warnings ?? []
      : pastDailyCandlesQuery.data?.data_warnings ?? [];
    if (warnings.some(kisRestWarningIndicatesUnavailable)) {
      notifyKisRestFailure();
    }
  }, [
    isMinute,
    kisRestBypassEnabled,
    notifyKisRestFailure,
    pastCandlesQuery.data?.data_warnings,
    pastDailyCandlesQuery.data?.data_warnings,
  ]);

  // 우회 ON 분봉의 유일한 디스크 캔들 쿼리(/api/range mode=candles). 서버가 bucket_ms로
  // 3/5/15/30분 버킷팅해 내려주므로 클라이언트 재집계 불요. sourcePref는 'hogaplay_first'
  // 고정 — store 값을 따라가면 candles.parquet 없는 kis 소스가 선택돼 빈 캔들이 되는 함정.
  // (D/W/M 우회는 스크리너 일봉만 쓰므로 이 쿼리는 분봉 전용.)
  const minuteDiskNeeded = !!(code && isMinute && kisRestBypassEnabled);
  const minuteDiskOptions = useMemo(
    () => ({
      mode: 'candles' as const,
      brokerLateEntriesEnabled: false,
      brokerLateEntryStartHHMM: null,
      volumeDistributionBins: null,
      tradeVolumePocBins: null,
      volumeDistributionPriceRange: null,
    }),
    [],
  );
  const minuteDiskCandles = useRange(
    minuteDiskNeeded ? code : null,
    minuteDiskNeeded ? minutePastFrom : null,
    minuteDiskNeeded ? minutePastTo : null,
    minuteDiskNeeded ? (timeframe as Timeframe) : null,
    undefined,
    minuteDiskNeeded ? todayKstYyyymmdd : null,
    minuteDiskOptions,
    'hogaplay_first',
  );

  // 캔들 소스 이분법 — 모드당 소스 1개라 병합 없음.
  const minuteKisCandles = useMemo<Candle[]>(() => {
    if (!isMinute) return EMPTY_CANDLES;
    // 우회 ON: 디스크 캔들 그대로(서버 버킷팅 완료). OFF: KIS 분봉을 tf 버킷으로 집계.
    if (kisRestBypassEnabled) return minuteDiskCandles.data?.candles ?? EMPTY_CANDLES;
    const raw = pastCandlesQuery.data?.candles ?? [];
    if (raw.length === 0) return EMPTY_CANDLES;
    return aggregateCandles(raw, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000).map(kisBarToCandle);
  }, [isMinute, timeframe, kisRestBypassEnabled, minuteDiskCandles.data?.candles, pastCandlesQuery.data?.candles]);
  const calendarKisCandles = useMemo<Candle[]>(() => {
    if (isMinute) return EMPTY_CANDLES;
    // 우회 ON: 스크리너 일봉. OFF: KIS 일봉. D는 그대로, W/M은 aggregateCalendar.
    const raw = kisRestBypassEnabled
      ? screenerDailyCandlesQuery.data?.candles ?? []
      : pastDailyCandlesQuery.data?.candles ?? [];
    const bars = raw.length === 0 ? [] : timeframe === 'D' ? raw : aggregateCalendar(raw, timeframe as 'W' | 'M');
    return bars.map(kisBarToCandle);
  }, [isMinute, timeframe, kisRestBypassEnabled, pastDailyCandlesQuery.data?.candles, screenerDailyCandlesQuery.data?.candles]);
  const kisCandles = isMinute ? minuteKisCandles : calendarKisCandles;
  // 소스 칩용 날짜→소스 맵. 우회 OFF는 undefined → buildChartBundle 기본값(kis_live)이
  // 순수-KIS 표기를 담당(현행 동일). 우회 ON에서만 디스크 소스를 명시한다.
  const candleSourceByDate = useMemo(() => {
    if (!kisRestBypassEnabled) return undefined;
    const sourceByDate = new Map<string, SourceName>();
    if (isMinute) {
      for (const date of candleDateSet(minuteDiskCandles.data?.candles ?? [])) {
        sourceByDate.set(date, segmentSourceByDate(minuteDiskCandles.data, date) ?? 'hogaplay');
      }
    } else {
      for (const c of screenerDailyCandlesQuery.data?.candles ?? []) {
        sourceByDate.set(realMsToYyyymmdd(c.t_ms), 'screener_daily');
      }
    }
    return sourceByDate.size > 0 ? sourceByDate : undefined;
  }, [kisRestBypassEnabled, isMinute, minuteDiskCandles.data, screenerDailyCandlesQuery.data]);
  const volumeDistributionPriceRange = useMemo(
    () =>
      isMinute && effVolumeDistributionEnabled
        ? candlePriceRange(kisCandles, regularSessionOpenMs(todayKstYyyymmdd), regularSessionCloseMs(todayKstYyyymmdd))
        : null,
    [isMinute, effVolumeDistributionEnabled, kisCandles, todayKstYyyymmdd],
  );
  const sidecarWaitingForCandlePriceRange = !!(
    isMinute &&
    effVolumeDistributionEnabled &&
    volumeDistributionPriceRange == null &&
    (kisRestBypassEnabled
      ? (minuteDiskCandles.isLoading || minuteDiskCandles.isFetching)
      : (pastCandlesQuery.isLoading || pastCandlesQuery.isFetching))
  );
  const rangePlan = planLiveRangeRequest({
    code,
    timeframe,
    todayKstYyyymmdd,
    historicalFromDate,
    askPeakEnabled,
    bidPeakEnabled,
    tradeVolumePocEnabled,
    depthHeatmapEnabled,
    brokerLateEntryEnabled,
    brokerLateEntryStartHHMM,
    programTradeEnabled: effProgramTradeEnabled,
    volumeDistributionEnabled: effVolumeDistributionEnabled,
    volumeDistributionRangeCount,
    volumeDistributionPriceRange,
  });
  const hogaRangeOptions = useMemo(
    () => ({ mode: 'hoga' as const }),
    [],
  );
  const pastHoga = useRangeHogaDelta(
    rangePlan.code,
    rangePlan.from,
    rangePlan.to,
    rangePlan.timeframe,
    undefined,
    rangePlan.todayKst,
    hogaRangeOptions,
  );
  const sidecarRangeOptions = useMemo(
    () => ({
      mode: 'sidecar' as const,
      ...rangePlan.options,
      // KIS candles arrive on a separate fast path, but today's promoted
      // trades can exist before a matching candles.parquet. The sidecar needs
      // the KIS candle low/high grid to build the dense 10-bin distribution
      // instead of making the sidebar fall back to the short live trade tail.
      volumeDistributionPriceRange: rangePlan.options.volumeDistributionPriceRange,
    }),
    [rangePlan.options],
  );
  const sidecarEnabled = !!(
    !sidecarWaitingForCandlePriceRange &&
    rangePlan.code &&
    (
      rangePlan.options.askPeaksEnabled ||
      rangePlan.options.bidPeaksEnabled ||
      rangePlan.options.brokerLateEntriesEnabled ||
      rangePlan.options.programTradeEnabled ||
      rangePlan.options.tradeVolumePocEnabled ||
      rangePlan.options.depthHeatmapEnabled ||
      rangePlan.options.volumeDistributionBins != null
    )
  );
  const pastSidecars = useRangeSidecarDelta(
    sidecarEnabled ? rangePlan.code : null,
    sidecarEnabled ? rangePlan.from : null,
    sidecarEnabled ? rangePlan.to : null,
    sidecarEnabled ? rangePlan.timeframe : null,
    undefined,
    // /live's minutePastTo is always today (line 83), so this enables the
    // 5-min refetch that advances pastMaxQrT (review C1 — seam hole). The gate
    // lives in rangeFreshnessOptions: past-only callers (no todayKst) stay
    // frozen. A periodic refetch keeps the same query key → no placeholderData
    // swap → does not set isExtending, so today's right edge is untouched.
    sidecarEnabled ? rangePlan.todayKst : null,
    sidecarRangeOptions,
  );
  const liveCandles = useMemo<Candle[]>(
    () =>
      isMinute
        ? overlayLiveTradesOnCandles(kisCandles, live.trade, bucketMs, venue)
        : overlayLiveTradesOnCalendarCandles(kisCandles, live.trade, timeframe as 'D' | 'W' | 'M', venue),
    [isMinute, timeframe, kisCandles, live.trade, bucketMs, venue],
  );

  const defaultKrxSession = useMemo(
    () =>
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) },
    [live.initial, todayKstYyyymmdd],
  );
  const effectiveSessionByDate = useMemo(
    () => effectiveSessionBoundsByDate(pastCandlesQuery.data?.effective_sessions),
    [pastCandlesQuery.data?.effective_sessions],
  );
  // Chart session follows the selected KIS Venue for minute candles. HOGA/WS
  // side remains KRX-only, so buildHogaSeries keeps the default KRX bounds.
  const todayChartSession = useMemo(
    () => {
      if (!isMinute) return defaultKrxSession;
      const effective = effectiveSessionByDate.get(todayKstYyyymmdd);
      if (effective) return effective;
      return liveVenueUsesExtendedMinuteWindow(venue)
        ? liveVenueSessionBoundsMs(todayKstYyyymmdd, venue)
        : defaultKrxSession;
    },
    [defaultKrxSession, effectiveSessionByDate, isMinute, todayKstYyyymmdd, venue],
  );
  const sessionBoundsForDate = useMemo(
    () =>
      isMinute
        ? (yyyymmdd: string) =>
            effectiveSessionByDate.get(yyyymmdd) ??
            (liveVenueUsesExtendedMinuteWindow(venue)
              ? liveVenueSessionBoundsMs(yyyymmdd, venue)
              : {
                  open_ms: regularSessionOpenMs(yyyymmdd),
                  close_ms: regularSessionCloseMs(yyyymmdd),
                })
        : undefined,
    [effectiveSessionByDate, isMinute, venue],
  );

  // CHART side (candles + segments + investor). The ob path only contributes the
  // `hasTodayObSignal` boolean, so quote-only SSE ticks do not rebuild this memo.
  // Trade ticks rebuild it only when they actually change or append the live
  // forming candle; stale/venue-filtered ticks keep the candle ref stable.
  const hasTodayObSignal = isMinute && live.ob.length > 0;
  // Last content-distinct segments array — see the stabilization block below.
  const prevSegmentsRef = useRef<RangeBundle['segments'] | null>(null);
  const computedChartBundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;
    const built = buildChartBundle({
      code,
      todayDate: todayKstYyyymmdd,
      todaySession: todayChartSession,
      pastBundle: pastHoga.data ?? null,
      kisCandles: liveCandles,
      candleSourceByDate,
      bucketMs,
      hasTodayObSignal,
      investorPoints,
      sessionBoundsForDate,
    });
    const sidecarSource = pastSidecars.data ?? null;
    if (sidecarSource) {
      built.ask_peaks = sidecarSource.ask_peaks ?? [];
      built.bid_peaks = sidecarSource.bid_peaks ?? [];
      built.broker_late_entries = sidecarSource.broker_late_entries ?? [];
      built.trade_volume_pocs = sidecarSource.trade_volume_pocs ?? [];
      built.depth_heatmap = sidecarSource.depth_heatmap ?? [];
      built.volume_distributions = sidecarSource.volume_distributions ?? [];
      built.program_trade = filterProgramTradeForCandles(sidecarSource.program_trade, liveCandles);
    }

    // Segments-identity stabilization (eng review C1): buildChartBundle allocates
    // a fresh `segments` array each call even when no trading date changed.
    // LiveChartRoot memoises the VirtualAxis on this array's REFERENCE and the
    // KST behavior's `cacheKey` bumps its label-cache generation on axis
    // identity — so reuse the previous array when content-equal; it only changes
    // identity on a genuine mapping change (new date appended / leftward-pan
    // prepend).
    const prev = prevSegmentsRef.current;
    const sameSegments =
      prev !== null &&
      prev.length === built.segments.length &&
      built.segments.every(
        (s, i) =>
          s.date === prev[i].date &&
          s.session_open_ms === prev[i].session_open_ms &&
          s.session_close_ms === prev[i].session_close_ms &&
          s.source === prev[i].source,
      );
    if (sameSegments) {
      built.segments = prev;
    } else {
      prevSegmentsRef.current = built.segments;
    }

    return built;
  }, [code, todayKstYyyymmdd, todayChartSession, pastHoga.data, pastSidecars.data, liveCandles, candleSourceByDate, bucketMs, hasTodayObSignal, investorPoints, sessionBoundsForDate]);

  // HOGA side (quote_ratio / fill_strength). Deps INCLUDE ob/trade — this is the
  // ONLY half that rebuilds on an SSE tick.
  const hogaSeriesBuilderRef = useRef<ReturnType<typeof createIncrementalHogaSeriesBuilder> | null>(null);
  if (hogaSeriesBuilderRef.current === null) {
    hogaSeriesBuilderRef.current = createIncrementalHogaSeriesBuilder();
  }
  const hogaSeries = useMemo<HogaSeries>(
    () =>
      hogaSeriesBuilderRef.current!({
        todaySession: defaultKrxSession,
        pastBundle: pastHoga.data ?? null,
        sseOb: isMinute ? live.ob : [],
        sseTrade: isMinute ? live.trade : [],
        bucketMs,
      }),
    [defaultKrxSession, pastHoga.data, isMinute, live.ob, live.trade, bucketMs],
  );
  const livePriceLevelHits = useMemo(
    () => (isMinute ? buildLivePriceLevelHits(liveCandles, todayKstYyyymmdd) : []),
    [isMinute, liveCandles, todayKstYyyymmdd],
  );

  // Atomize the historical-prepend across the two independent past sources.
  // A leftward pan changes `historicalFromDate`, which re-keys BOTH past
  // queries (candles via /api/live/past-candles, hoga via /api/range). They
  // resolve in SEPARATE commits, so without gating the bundle would rebuild
  // twice — once with new candles + stale hoga, then with both — landing the
  // prepend in two paints. That splits LiveChartRoot's viewport shift across two
  // commits (a visible ~60ms jump-then-correct flicker) and makes the first
  // shift see a candles-only union (wrong inserted-index count). All three
  // queries keep the previous response as `placeholderData` during a same-code
  // re-key, so `isPlaceholderData` is true for exactly the window where one
  // source has the new range and the other does not. Hold the last fully-settled
  // bundle until BOTH are fresh, so the prepend swaps in ONE commit. SSE-only
  // and periodic-refetch updates do NOT set isPlaceholderData, so today's live
  // ticks are not gated.
  // Atomize ONLY a genuine historical extension (a leftward pan), keyed on
  // historicalFromDate != null. A pan re-keys BOTH past queries (candles via
  // /api/live/past-candles, hoga via /api/range), which resolve in SEPARATE
  // commits; without gating, the bundle rebuilds twice (new candles + stale
  // hoga, then both), splitting LiveChartRoot's viewport shift across two paints
  // and feeding the first shift a candles-only union (wrong inserted-index
  // count). Hold the last fully-settled bundle until BOTH sources are fresh so
  // the prepend swaps in ONE commit.
  //
  // The historicalFromDate gate is what scopes this to extensions: setActiveCode
  // and setCandleTimeframe reset it to null, so a code OR timeframe switch — both
  // of which ALSO re-key the past queries (useRange embeds bucketMs;
  // useLivePastCandles' from embeds initialHistoricalDaysFor(timeframe)) — is NOT
  // gated and falls straight through to computedBundle, instead of stalling on
  // the previous code/timeframe's bundle. SSE / periodic refetches never set
  // isPlaceholderData, so today's live ticks are not gated either.
  //
  // `&& isFetching` releases the hold if a re-keyed query goes
  // pending-but-NOT-fetching (paused/offline, or `enabled` flipped mid-flight),
  // which would otherwise freeze the bundle with no fetch in flight; a settled
  // error drops isPlaceholderData on its own (status leaves 'pending'). The hold
  // lasts as long as the slower past-fetch (bounded by the global retry:1),
  // pausing today's right edge — acceptable because the user is panned into
  // history, not watching the live edge.
  const extending = historicalFromDate != null && (isMinute
    ? pastHoga.isHistoricalDeltaFetching ||
      (sidecarEnabled && pastSidecars.isHistoricalDeltaFetching) ||
      (pastCandlesQuery.isPlaceholderData && pastCandlesQuery.isFetching) ||
      // 우회 ON에선 차트 캔들이 KIS가 아니라 디스크(minuteDiskCandles, plain useRange)에서
      // 온다. 이 쿼리도 좌측 팬 re-key 시 이전 데이터를 placeholder로 보이며 더 오래된 창을
      // fetch하므로 KIS 경로와 동일하게 isPlaceholderData && isFetching로 홀드해야 프리펜드가
      // 원자적이다. 우회 OFF면 disabled → 둘 다 false라 무해(이분 조건 불필요).
      (minuteDiskCandles.isPlaceholderData && minuteDiskCandles.isFetching)
    : (pastDailyCandlesQuery.isPlaceholderData && pastDailyCandlesQuery.isFetching) ||
      (screenerDailyCandlesQuery.isPlaceholderData && screenerDailyCandlesQuery.isFetching));
  // The gate holds the CHART side (candle/segment prepend atomicity is what it
  // protects — the viewport shift is candle-index-based). The hoga overlay
  // follows via the spread below; its points don't drive the viewport, so
  // letting them settle a beat later than the held chart is harmless.
  const lastSettledChartRef = useRef<RangeBundle | null>(null);
  const chartBundle = extending && lastSettledChartRef.current
    ? lastSettledChartRef.current
    : computedChartBundle;
  useEffect(() => {
    if (!extending) lastSettledChartRef.current = computedChartBundle;
  }, [extending, computedChartBundle]);

  // 콜드 분봉 로드 원자화(2026-07-08 venue=UN 간헐 크래시): 콜드 로드에선 mode=hoga가
  // past-candles보다 먼저 settle해 호가 pane 시리즈(2천+점)가 먼저 커밋되는데, 그 뒤
  // UN 캔들(08:00~20:00)이 landing하면 공유 timeScale에 호가 축에 없던 시간점이 수천 개
  // 삽입되며 lightweight-charts 내부(hitTest/baseline make-valid)가 스테일 인덱스를 밟아
  // throw → React 트리 전체 언마운트(검은 화면)가 간헐 재현됐다(KRX는 캔들 시간점이 호가
  // 버킷 grid와 일치해 삽입이 거의 0이라 미발현). 캔들 쿼리가 settle될 때까지 호가 시리즈를
  // 빈 배열로 홀드해 "캔들 먼저, 호가는 그 부분집합 삽입" 순서를 강제한다. reveal 커버가
  // 이미 캔들+호가 settle까지 차트를 가리므로 사용자 체감 변화는 없다.
  const holdHogaSeriesForColdCandles =
    isMinute && !!code && pastCandlesQuery.isLoading && pastCandlesQuery.data == null;
  const emptyHogaSeries = useMemo<HogaSeries>(
    () => ({
      quote_ratio: { bucket_ms: bucketMs, points: [] },
      fill_strength: { bucket_ms: bucketMs, points: [] },
      depth_heatmap_today: [],
    }),
    [bucketMs],
  );
  const committedHogaSeries = holdHogaSeriesForColdCandles ? emptyHogaSeries : hogaSeries;

  // Full bundle = stable chart side + live hoga overlay. Spreading chartBundle
  // shares its segments/candles refs, so the VirtualAxis stays single-build and
  // hoga panes (which read bundle.segments / bundle.bucket_ms in fillStrength)
  // see the same coordinate system as the candle path.
  const bundle = useMemo<RangeBundle | null>(
    () =>
      chartBundle
        ? {
            ...chartBundle,
            quote_ratio: committedHogaSeries.quote_ratio,
            fill_strength: committedHogaSeries.fill_strength,
            price_level_hits: mergePriceLevelHits(chartBundle.price_level_hits, livePriceLevelHits),
            depth_heatmap: mergeDepthHeatmapToday(chartBundle.depth_heatmap, committedHogaSeries.depth_heatmap_today),
          }
        : null,
    [chartBundle, committedHogaSeries, livePriceLevelHits],
  );
  const hogaBundle = useMemo<RangeBundle | null>(
    () =>
      chartBundle
        ? {
            ...chartBundle,
            quote_ratio: committedHogaSeries.quote_ratio,
            fill_strength: committedHogaSeries.fill_strength,
            broker_late_entries: brokerLateEntryEnabled ? chartBundle.broker_late_entries : [],
            program_trade: { points: [] },
          }
        : null,
    [
      chartBundle?.code,
      chartBundle?.from_date,
      chartBundle?.to_date,
      chartBundle?.bucket_ms,
      chartBundle?.segments,
      committedHogaSeries,
      brokerLateEntryEnabled,
      brokerLateEntryEnabled ? chartBundle?.broker_late_entries : null,
    ],
  );

  // Clamp is a minute-path concern only; the daily endpoint has no 250d cap.
  const clampEngaged = isMinute
    && historicalFromDate != null
    && historicalFromDate <= earliestAllowedMinute;

  // 캔들 대비 10호가 캡처 공백일 — 화면에 실제로 보이는 chartBundle(hold 반영)과
  // mode=hoga 응답의 세그먼트를 비교한다. 분봉 외 타임프레임은 hoga 쿼리가
  // disabled(data undefined)라 자연히 빈 배열이지만 isMinute 게이트로 의도를 명시.
  const hogaCoverageGapDates = useMemo(
    () =>
      isMinute
        ? computeHogaCoverageGapDates(
            chartBundle?.segments,
            pastHoga.data?.segments ?? null,
            todayKstYyyymmdd,
          )
        : [],
    [isMinute, chartBundle?.segments, pastHoga.data?.segments, todayKstYyyymmdd],
  );

  // Coverage-gap 백필(A안) 신호. 캔들은 병합 캐시로 수개월 복원되는데 range 지표는
  // 요청 창(기본 5거래일)만 커버해, viewport가 지표 커버리지 밖 구간을 보면
  // useViewportBackfill이 whitespace 없이도 range 창을 확장하도록 돕는다.
  // - indicatorCoverageFromDate: 활성 지표(hoga + 활성 sidecar)가 도달한 가장 최근
  //   from_date. 둘은 같은 historicalFromDate로 re-key되어 정상 settle 후 일치하지만,
  //   비활성/미settle 편차를 대비해 max(가장 덜 확장된 쪽=구속 조건)를 취한다.
  //   ⚠️ 전제: hoga와 sidecar는 같은 rangePlan.from(=historicalFromDate 파생)으로
  //   항상 동반 확장된다 — max가 "둘 다 채울 때까지 확장"으로 안전한 이유다. 만약
  //   향후 hoga/sidecar의 요청 창이 분기되면(예: sidecar만 좁게 요청), max는 화면 밖
  //   sidecar pane까지 채우려 과확장할 수 있으니 그때는 이 max 정책을 재검토할 것.
  // - rangeWindowFromDate: 지금 range가 요청 중인 창의 from(=nextCoverageFrom base의
  //   null-fallback). 분봉 외/미요청이면 null이라 coverage 경로가 자연 비활성.
  const indicatorCoverageFromDate = useMemo<string | null>(() => {
    if (!isMinute) return null;
    let coverage: string | null = null;
    if (pastHoga.data?.from_date) coverage = pastHoga.data.from_date;
    if (sidecarEnabled && pastSidecars.data?.from_date) {
      coverage = coverage === null || pastSidecars.data.from_date > coverage
        ? pastSidecars.data.from_date
        : coverage;
    }
    return coverage;
  }, [isMinute, pastHoga.data?.from_date, sidecarEnabled, pastSidecars.data?.from_date]);
  const rangeWindowFromDate = isMinute ? rangePlan.from : null;

  // 활성 소스의 fetch 경고만 노출 — 배타 이분화. 우회 ON 분봉은 디스크라 경고 없음([]),
  // D/W/M은 스크리너. 우회 OFF는 KIS 경로. (다른 경로 쿼리는 disabled라 스테일 경고가
  // 새어 나오지 않도록 배타로 고른다.)
  const pastDataWarnings: LiveDataWarning[] = isMinute
    ? (kisRestBypassEnabled ? [] : pastCandlesQuery.data?.data_warnings ?? [])
    : kisRestBypassEnabled
      ? screenerDailyCandlesQuery.data?.data_warnings ?? []
      : pastDailyCandlesQuery.data?.data_warnings ?? [];

  return {
    bundle,
    chartBundle,
    hogaBundle,
    isLoading: live.isLoading || pastHoga.isLoading || pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading || screenerDailyCandlesQuery.isLoading || (minuteDiskNeeded && minuteDiskCandles.isLoading),
    error: live.error ?? pastHoga.error ?? pastCandlesQuery.error ?? pastDailyCandlesQuery.error ?? screenerDailyCandlesQuery.error ?? pastSidecars.error ?? minuteDiskCandles.error ?? null,
    clampEngaged,
    isPastCandlesLoading: pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading || screenerDailyCandlesQuery.isLoading || (minuteDiskNeeded && minuteDiskCandles.isLoading) || (enableInvestor && investorQuery.isLoading),
    isHogaLoading: pastHoga.isLoading && pastHoga.data == null,
    isExtending: extending,
    // 콜드 로드 동시 등장(장면1): 거래량분포는 캔들 priceRange 가 나와야 fetch 가
    // 시작되는 구조적 체인(오늘 promoted trades 가 candles.parquet 보다 먼저 존재 가능)
    // 이라, 그 "캔들 대기" 상태(sidecarWaitingForCandlePriceRange)도 loading 으로 셈해
    // reveal 게이트가 지표 없이 캔들만 먼저 공개하지 않게 한다. isLoading(=isPending &&
    // isFetching) 대신 isPending 을 쓰는 이유: sidecarEnabled 가 켜지는 커밋에서 아직
    // fetch 미발화(isFetching=false)라 isLoading 이 1프레임 false 로 새는 레이스에 reveal
    // rAF 가 선스케줄되는 것을 막기 위함. 캔들·사이드카 settle(성공·에러 모두 isPending
    // false, sidecarEnabled 가 disabled 영구-pending 차단)로 반드시 해제된다.
    isSidecarLoading: sidecarWaitingForCandlePriceRange
      || (sidecarEnabled && pastSidecars.isPending && pastSidecars.data == null),
    pastDataWarnings,
    hogaCoverageGapDates,
    indicatorCoverageFromDate,
    rangeWindowFromDate,
  };
}
