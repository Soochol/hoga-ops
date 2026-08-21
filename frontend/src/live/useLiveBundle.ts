import { useEffect, useMemo, useRef } from 'react';
import type { WireDataWarning } from '../api/dataWarnings';
import type { LiveSeriesData } from '../api/liveSeries';
import { useLiveSettings } from '../api/liveSettings';
import { useLivePastCandles } from '../api/livePastCandles';
import { useLivePastDailyCandles } from '../api/livePastDailyCandles';
import { useLivePastInvestorNet } from '../api/livePastInvestorNet';
import { useScreenerDailyCandles } from '../api/screenerDailyCandles';
import { useRange, useRangeHogaDelta, useRangeSidecarDelta } from '../api/range';
import { scaleRangeBundlePrices } from './scaleRangeBundlePrices';
import {
  type LiveTimeframe,
  isMinuteTimeframe,
  needsRegularSessionClip,
  fetchBucketMsFor,
} from '../state/livePage';
import { useWindowView, useWindowIndicators } from './workspace/windowView';
import type { LiveVenueOption } from '../state/liveVenue';
import {
  classifyRestWarning,
  useRestBypassModeStore,
} from '../state/restBypassMode';
import {
  TIMEFRAME_TO_MS,
  type Timeframe,
  type RangeBundle,
  type RangeMissingDate,
  type Candle,
  type InvestorNetPoint,
  type SourceName,
} from '../api/types';
import { buildChartBundle, createIncrementalHogaSeriesBuilder, filterProgramTradeForCandles, type HogaSeries } from './buildLiveBundle';
import { deriveCandleEmptyState, type CandleEmptyState } from './candleEmptyState';
import type { DepthDeltaPoint } from './depthDelta';
import {
  combineDepthDeltaBackendLive,
  depthDeltaFromWire,
  mergeDepthDeltaSession,
} from './depthDeltaSession';
import type { LiveDataWarning } from './liveDataWarnings';
import type { TradeSnapshot } from './bucketHogaSeries';
import {
  aggregateCandles,
  aggregateCalendar,
  calendarBucketKey,
  keepRegularSessionCandles,
  isRegularSessionMs,
} from './aggregateCandles';
import { collapseClosingAuction } from './collapseClosingAuction';
import {
  regularSessionOpenMs,
  regularSessionCloseMs,
  realMsToYyyymmdd,
  subtractDaysKst,
  initialHistoricalDaysFor,
  earliestAllowedMinuteDate,
  isKstWeekend,
} from './liveDateTime';
import {
  effectiveSessionBoundsByDate,
  liveVenueAcceptsFrame,
  liveVenueSessionBoundsMs,
  liveVenueUsesExtendedMinuteWindow,
} from './liveVenuePolicy';
import { buildLivePriceLevelHits, mergePriceLevelHits } from './priceLevelHits';
import { mergeDepthHeatmapToday } from './depthHeatmapWire';
import { mergeProgramTradeSeriesWithLiveTail } from './programTradeLiveTail';
import { useMinuteGapFill, type MinuteGapFillResult } from './useMinuteGapFill';

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

/** @param clipToRegularSession 정규장 밖 체결을 버린다. **기본값을 두지 않는다** —
 *  과거봉만 클립하고 실시간 tail 을 안 클립하면 그 비대칭이 **장중에만** 나타나고
 *  마감 후에는 사라져서 재현이 어렵다. 호출부가 매번 표시 tf 를 보고 정하게 한다. */
export function overlayLiveTradesOnCandles(
  candles: readonly Candle[],
  trades: readonly TradeSnapshot[],
  bucketMs: number,
  venue: LiveVenueOption = 'KRX',
  clipToRegularSession: boolean = false,
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
        // 비거래일 틱은 캔들이 될 수 없다 — 주말 시각 틱이 여기로 새면 차트 끝에
        // 주말 캔들이 붙고, 저장뷰 to_date 가 토/일로 박제된다. 백엔드 파서가 1차로
        // 거르지만(kiwoom_frames), 버퍼에 남은 틱까지 덮도록 여기서도 막는다.
        isKstWeekend(realMsToYyyymmdd(tMs)) ||
        // 120·240 전용 — 과거봉 클립(`keepRegularSessionCandles`)과 **같은 술어**를
        // 본다. 다르게 재계산하면 정규장 마지막 봉만 tail 이 어긋난다.
        (clipToRegularSession && !isRegularSessionMs(tMs)) ||
        !liveVenueAcceptsFrame(venue, snapshot.venue)
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
 *  - **vol_a는 건드리지 않는다.** 벤더/스크리너 일봉의 오늘 volume은 이미 당일
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
        // 비거래일 틱은 캔들이 될 수 없다 — 주말 시각 틱이 여기로 새면 차트 끝에
        // 주말 캔들이 붙고, 저장뷰 to_date 가 토/일로 박제된다. 백엔드 파서가 1차로
        // 거르지만(kiwoom_frames), 버퍼에 남은 틱까지 덮도록 여기서도 막는다.
        isKstWeekend(realMsToYyyymmdd(tMs)) ||
        !liveVenueAcceptsFrame(venue, snapshot.venue)
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
      // best-effort 하한(당일 누적치 아님). 벤더 모드는 다음 refetch 가 정본으로
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
  /** 호가 결손 사유 — `hogaBundle` 이 null 이어도 살아 있어야 해서 별도 필드다(#1133).
   *  근거는 반환부 주석. */
  hogaMissingDates: readonly RangeMissingDate[];
  /** 캔들이 없을 때 왜 없는지 + 사용자가 할 수 있는 일. 캔들이 있으면 `null`(#1133 후속). */
  candleEmpty: CandleEmptyState | null;
  /** 활성 캔들 쿼리 재조회 — 빈 상태의 "다시 시도" 가 쓴다. */
  refetchCandles: () => void;
  /** 오늘의 단별 잔량 증감 버킷(분봉). 과거일 소스가 없는 **오늘 전용** 지표라
   * RangeBundle 이 아니라 별도 필드로 나간다 — 자세한 근거는 `HogaSeries.depth_delta_today`. */
  depthDeltaToday: readonly DepthDeltaPoint[];
  /** 이 번들의 지표에 적용된 날짜별 수정계수(`YYYYMMDD` → 계수). `/api/range` 를 따로
   *  호출하는 소비자가 **같은 척도**를 쓰게 하는 통로다 — `scaleRangeBundlePrices` 참조.
   *  우회 ON 이면 `undefined`(그 모드는 캔들도 디스크라 환산 자체가 없다). */
  adjustFactors: Readonly<Record<string, number>> | undefined;
  /** 얼린 저장뷰에서 **디스크에 없는 거래일을 키움으로 보충한** 결과. 얼림이 아니면
   *  전 필드가 비어 있다. 저장뷰 안내(`savedRangeNotice`)가 이 값으로 "몇 일 보충됐고
   *  몇 일은 왜 못 채웠는지" 를 말한다. */
  gapFill: MinuteGapFillResult;
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
   * 매매가 캔들과 한 번의 reveal로 등장하게 한다. 단 **캔들·호가 settle 후
   * `SIDECAR_REVEAL_CAP_MS`(700ms)까지만** 대기한다 — 사이드카가 늦어져도 캔들을
   * 인질로 잡지 않는다. (이 캡은 #579 가 제거했다가 2026-08-19 복원됐다. 근거·실측은
   * `LiveChartRoot.tsx` 의 그 상수 주석이 유일 출처이므로 여기 숫자를 늘려 적지 말 것.)
   * - sidecarEnabled=false(지표 전부 off)면 항상 false → 홀드 없음.
   * - `data == null`: 캐시된 뷰 재방문 시 즉시 서빙되는 동안 리프레시가 isLoading이어도
   *   불필요 홀드를 방지. 에러 settle도 isLoading=false라 영구 홀드 없음. */
  isSidecarLoading: boolean;
  /** 활성 타임프레임 경로(분봉=past-candles, D/W/M=past-daily-candles)의 fetch 경고.
   * 백엔드가 키움 유량 초과 등으로 일부/전체 날짜를 못 받으면 채운다. LiveChartRoot가
   * 빈칸 문구 전환 + 부분 로딩 칩에 쓴다(2026-06-09). 무경고면 빈 배열. */
  pastDataWarnings: LiveDataWarning[];
  /** Coverage-gap 백필(A안): 활성 range 지표(hoga + 활성 sidecar)가 도달한 가장 최근
   * from_date(YYYYMMDD). 캔들이 병합 캐시로 더 과거까지 복원돼도 지표가 이 날짜까지만
   * 있으면, useViewportBackfill이 viewport 좌단이 이보다 과거일 때 range 창을 확장한다.
   * 분봉 전용(D/W/M은 range 지표 없음 → null), 미로드 시 null. */
  indicatorCoverageFromDate: string | null;
  /** 지금 range가 요청 중인 창의 from(YYYYMMDD). coverage 스텝 base의 null-fallback.
   * 분봉 외/미요청이면 null. */
  rangeWindowFromDate: string | null;
  /**
   * 지금 **서빙 중인** 과거 캔들 창의 from(YYYYMMDD) — 벤더/디스크 응답이 되싣는 echo.
   *
   * `useViewportBackfill` 3a의 두 번째 스텝-완료 신호다(#1328). 좌측 팬 스텝이 웜 캐시로
   * 채워지면 fetch가 없어 `isExtending`이 뜨지 않고, 그 하강 엣지에만 기대던 진행 루프가
   * 잠긴다 — 종목을 떠났다 돌아온 뒤의 첫 스텝은 쿼리 키가 직전 방문과 같아 **반드시**
   * 그 경우다.
   *
   * **D/W/M 전용(분봉은 null).** 두 가지 이유다: ① 분봉은 캔들 병합 캐시가 깊이를 통째로
   * 복원하므로 같은 창을 다시 걸어 들어가는 일 자체가 없고, ② 분봉의 한 스텝은 캔들과
   * range 지표가 **함께** 착지해야 완료라(위 `extending` 원자화) 캔들 응답의 from만으로는
   * 스텝 완료를 뜻하지 않는다. 그쪽은 하강 엣지가 계속 유일 신호다.
   *
   * 응답 `code`가 현재 종목과 다르면 null — placeholder 술어(`livePastDailyCandles`)와
   * 같은 규율로, 종목 전환 직후 이전 종목의 echo가 스텝 완료로 위장하지 못하게 한다.
   */
  pastSettledFromDate: string | null;
}

/** 같은 그룹의 데이터 창(매물대·프로그램)이 요구하는 sidecar 강제 fetch
 *  (ADR-0119 PR-D). 창의 지표 토글과 OR — pane 표시는 지표 토글만 따르고
 *  (LiveChartRoot 는 useWindowIndicator 직독) fetch 범위만 확장된다. 그룹의
 *  링크 발행 차트 창(groupTargetChartWindow)만 이 옵션을 켠다. */
export type SidecarDemands = { programTrade?: boolean; volumeDistribution?: boolean };

type UseLiveBundleOptions = {
  investorNetEnabled?: boolean;
  venue?: LiveVenueOption;
  sidecarDemands?: SidecarDemands;
  /**
   * 저장뷰 구간에 **얼린** 창의 시작일(YYYYMMDD KST). `null`/미지정 = 평소의 라이브 창.
   *
   * 끝일은 따로 받지 않는다 — `todayKstYyyymmdd` 가 **이미 그것**이다. 호출부
   * (`useLiveChartData`)가 저장 끝일을 "오늘" 로 넘기는 것이 이 모드의 정의이고,
   * 그래서 `minutePastTo`·세션 경계·라이브 엣지 판정이 전부 저절로 따라온다. 끝일을
   * 여기서 한 번 더 받으면 두 값이 어긋날 수 있는 **불변식이 하나 생긴다** — 안 받는
   * 쪽이 어긋날 자리가 없다.
   *
   * 이 값이 서면 세 가지가 같이 바뀐다(셋은 한 덩어리다):
   *  1. **디스크 소스 강제** — 벤더(`ka10080`)는 자격증명·보존에 달렸고, 저장뷰가
   *     가리키는 과거 구간의 신뢰 가능한 소스는 캡처 디스크(hogaplay)다. 전역
   *     `rest_bypass_enabled` 를 켜는 것이 **아니라** 이 창만 그렇게 읽는다.
   *  2. **시작일 고정** — 백필이 걸어온 `historicalFromDate` 대신 저장 시작일.
   *  3. **250일 벽 해제** — 그 벽은 `/api/live/past-candles` 의 span 캡에서 온 것이라
   *     (`hoga/live/api.py` `_PAST_MAX_DAYS`) 디스크 경로(`/api/range`)에는 없다.
   *     실측(2026-08-21): `mode=candles` 가 20251212(벽 밖 252일)를 381봉·경고 0으로 서빙.
   *
   * **분봉 전용이다.** 캘린더 봉은 애초에 벽이 없고, 얼리면 `/study` 처럼 맥락 창을
   * 따로 넓혀 줘야 해서(`studyDailyContextWindow`) 화면이 오히려 좁아진다.
   */
  frozenRangeFrom?: string | null;
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
    depthDeltaEnabled: boolean;
    wallSurgeEnabled: boolean;
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
  depthDeltaEnabled: boolean;
  wallSurgeEnabled: boolean;
  brokerLateEntryEnabled: boolean;
  brokerLateEntryStartHHMM: number;
  programTradeEnabled: boolean;
  volumeDistributionEnabled: boolean;
  volumeDistributionRangeCount: number;
  volumeDistributionPriceRange: { min: number; max: number } | null;
  /** 저장뷰 얼림 시작일 — `UseLiveBundleOptions.frozenRangeFrom` 과 같은 값·같은 의미. */
  frozenRangeFrom?: string | null;
}): LiveRangeRequestPlan {
  const isMinute = isMinuteTimeframe(args.timeframe);
  const frozenFrom = args.frozenRangeFrom ?? null;
  const seedFrom = frozenFrom
    ?? args.historicalFromDate
    ?? subtractDaysKst(args.todayKstYyyymmdd, initialHistoricalDaysFor(args.timeframe));
  // 얼린 창은 벽을 타지 않는다 — 250일은 벤더 span 캡이고 이 모드는 디스크를 읽는다.
  const minutePastFrom = frozenFrom
    ? seedFrom
    : laterDate(seedFrom, earliestAllowedMinuteDate(args.todayKstYyyymmdd));
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
      depthDeltaEnabled: enableMinute && args.depthDeltaEnabled,
      wallSurgeEnabled: enableMinute && args.wallSurgeEnabled,
      volumeDistributionBins: args.volumeDistributionEnabled ? args.volumeDistributionRangeCount : null,
      tradeVolumePocBins: args.tradeVolumePocEnabled ? args.volumeDistributionRangeCount : null,
      volumeDistributionPriceRange: args.volumeDistributionEnabled ? args.volumeDistributionPriceRange : null,
    },
  };
}

/** Orchestrate live SSE + past-candles + /api/range hoga indicators into a
 * single RangeBundle for LiveChartRoot. ADR-0040 — vendor candles are the single
 * candle source via the dedicated `/api/live/past-candles` endpoint (Kiwoom
 * `ka10080` since ADR-0136; KIS until then).
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
    depthDeltaEnabled,
    wallSurgeEnabled,
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
  /**
   * 저장뷰 얼림 시작일 — 서 있으면 이 창이 저장 구간에 얼려 있다는 뜻이다
   * (`UseLiveBundleOptions.frozenRangeFrom` 이 세 가지 효과를 전부 적는다).
   * 분봉에서만 의미가 있으므로 여기서 한 번 걸러 아래 세 소비처가 각자 안 걸러도 되게 한다.
   */
  const frozenRangeFrom =
    isMinuteTimeframe(timeframe) ? (options.frozenRangeFrom ?? null) : null;
  // 캔들 소스의 유일한 분기 축(4옵션 우선순위-병합 모델 폐기). 우회 OFF=벤더 REST만,
  // 우회 ON=디스크만(분봉 hogaplay / D·W·M 스크리너). 모드당 소스 1개라 병합 없음.
  //
  // 얼린 창은 **전역 설정과 무관하게** 디스크다. 전역 토글을 뒤집는 것이 아니라 이 창의
  // 지역 상수만 뒤집는다 — `SAVED_RANGE_VENUE` 가 전역 `live.venue.v1` 을 안 건드리는
  // 것과 같은 규율이고, 안 그러면 저장뷰 클릭 하나가 다른 창·다른 탭까지 바꾼다.
  const restBypassEnabled = frozenRangeFrom !== null || (liveSettings?.rest_bypass_enabled ?? false);
  const notifyRestFailure = useRestBypassModeStore((s) => s.notifyFailure);
  const resolveRestFailure = useRestBypassModeStore((s) => s.resolveFailure);
  const venue = options.venue ?? 'KRX';

  const isMinute = isMinuteTimeframe(timeframe);
  const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;

  // 250-day clamp at the bundle layer so /api/range's 90-day cap and
  // /api/live/past-candles' 250-day cap can stay independent. Applies to
  // the minute path only — the daily endpoint has no equivalent cap.
  //
  // ⚠ **얼린 창(`frozenRangeFrom`)은 이 클램프를 타지 않는다.** 250일은 벤더 엔드포인트의
  // span 캡에서 온 숫자이고(`hoga/live/api.py` `_PAST_MAX_DAYS`), 얼린 창은 그 엔드포인트를
  // 아예 안 부른다(위 `restBypassEnabled` 가 디스크로 보낸다). 여기서 같이 자르면 저장뷰가
  // 가리키는 구간이 **디스크에는 있는데 화면에는 없는** 상태가 된다 — 이 기능이 고치려던
  // 바로 그 증상이다.
  const seedFrom = frozenRangeFrom
    ?? historicalFromDate
    ?? subtractDaysKst(todayKstYyyymmdd, initialHistoricalDaysFor(timeframe));
  const earliestAllowedMinute = earliestAllowedMinuteDate(todayKstYyyymmdd);
  const minutePastFrom = frozenRangeFrom ? seedFrom : laterDate(seedFrom, earliestAllowedMinute);
  // Includes today so post-promote disk data (hogaplay/snapshots.parquet,
  // ADR-0037 v2 layout) feeds today's hoga indicators. Before this, today's
  // quote_ratio/fill_strength came only from the in-memory SSE buffer, which
  // is volatile across backend restarts. buildLiveBundle's pastHasTodaySegment
  // check + the t > pastMaxQrT incremental filter already handle the dedup
  // with the SSE tail (buildLiveBundle.ts:67, 72).
  const minutePastTo = todayKstYyyymmdd;

  // 벤더 분봉 캔들(키움 `ka10080`) — 우회 OFF에서만 fetch. 우회 ON이면 code=null로
  // 비활성(요청 절약). 과거분은 아래 bucketMs 인자대로 표시 tf 주기로 받고, 오늘분만
  // 1분이다(실시간 tail 병합 격자 — collect_minute docstring).
  // (hoga 지표 쿼리 pastHoga는 이 게이트와 무관하게 rangePlan에서 별도로 발사된다.)
  const enableMinute = !!(code && isMinute && minutePastFrom <= minutePastTo && !restBypassEnabled);
  const pastCandlesQuery = useLivePastCandles(
    enableMinute ? code : null,
    enableMinute ? minutePastFrom : null,
    enableMinute ? minutePastTo : null,
    venue,
    todayKstYyyymmdd,
    // 표시 tf 를 그대로 벤더 주기로 요청한다 — 콜당 커버리지가 tf 배수만큼 는다
    // (10분 = 900행에 약 23 거래일). 캘린더 tf(D/W/M)는 이 훅을 안 타므로
    // `isMinute` 가 아니면 값이 쓰이지 않는다.
    // 120·240 만 예외로 30m 를 받는다 — 15:30 경계를 입력에 남겨야 클립이 성립한다
    // (`fetchBucketMsFor` 주석). 표시 버킷은 아래 `bucketMs` 가 따로 들고 있다.
    isMinute ? fetchBucketMsFor(timeframe) : 60_000,
  );

  // 벤더 일봉 past-candles(키움 `ka10081`) — D/W/M, 우회 OFF에서만 (ADR-0048).
  const enableDaily = !!(code && !isMinute && !restBypassEnabled);
  const dailyPastFrom = seedFrom;
  const dailyPastTo = todayKstYyyymmdd;
  const pastDailyCandlesQuery = useLivePastDailyCandles(
    enableDaily ? code : null,
    enableDaily ? dailyPastFrom : null,
    enableDaily ? dailyPastTo : null,
    venue,
  );
  // 스크리너 일봉 — D/W/M, 우회 ON 전용(디스크 소스).
  const enableScreenerDaily = !!(code && !isMinute && restBypassEnabled);
  const screenerDailyCandlesQuery = useScreenerDailyCandles(
    enableScreenerDaily ? code : null,
    enableScreenerDaily ? dailyPastFrom : null,
    enableScreenerDaily ? dailyPastTo : null,
  );

  // Investor net-buy (foreign/institution) — 'D' (일봉) ONLY. Kiwoom 종목별
  // 투자자 일별 (`ka10059`, PR-E/#1041 컷오버; KIS `FHPTJ04160001` 대체) walks back
  // the requested [from, to] range by date cursor. ADR-0055.
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
    if (restBypassEnabled) return;
    const response = isMinute ? pastCandlesQuery.data : pastDailyCandlesQuery.data;
    // **응답이 아직 없는 것과 경고 없는 응답은 다르다.** 이전 판은 둘 다 빈 배열로
    // 뭉갰는데, 그때는 실패만 읽었으므로 무해했다. 회복까지 읽는 지금은 로딩·비활성
    // 상태를 "다시 성공했다" 로 오독해 토스트를 조기에 지운다.
    if (!response) return;
    const warnings: readonly WireDataWarning[] = response.data_warnings;
    // 여러 사유가 섞여 오면 **transport 를 우선**한다 — 서버에 닿지도 못한 사실이
    // 혼잡보다 무겁고, 사용자 처방(저장 데이터 우회)도 그쪽에 붙어 있다.
    const kinds = warnings.map(classifyRestWarning).filter((k) => k !== null);
    const kind = kinds.includes('transport') ? 'transport' : kinds[0];
    if (kind) {
      notifyRestFailure(kind);
    } else {
      // 알릴 사유가 하나도 없는 응답 = 수집이 다시 됐다. 이 팔이 없으면 회복 뒤에도
      // "재시도 중" 이 화면에 남는다 — 실패 사건에서만 상태가 움직였기 때문이다.
      resolveRestFailure();
    }
  }, [
    isMinute,
    restBypassEnabled,
    notifyRestFailure,
    resolveRestFailure,
    pastCandlesQuery.data,
    pastDailyCandlesQuery.data,
  ]);

  // 우회 ON 분봉의 유일한 디스크 캔들 쿼리(/api/range mode=candles). 서버가 bucket_ms로
  // 3/5/15/30분 버킷팅해 내려주므로 클라이언트 재집계 불요.
  // (D/W/M 우회는 스크리너 일봉만 쓰므로 이 쿼리는 분봉 전용.)
  //
  // **sourcePref 고정을 뗐다(2026-08-20).** 예전엔 `'hogaplay_first'` 를 박아
  // "candles.parquet 없는 kis 소스가 선택돼 빈 캔들이 되는 함정" 을 막았는데, 그 함정의
  // 주체인 `kis_live`/`kis_api` 는 소스에서 제거됐다(2026-08-06·08-07). 남은 두 소스는
  // **둘 다 캔들을 보유**하므로(`CANDLE_BEARING_SOURCES`) 고정할 이유가 사라졌다.
  //
  // 더 나쁜 것은 그 고정이 **동작하지도 않았다**는 점이다: 백엔드 `ordered_sources` 는
  // `'hogaplay'` 만 인식하고 나머지는 기본 사다리(kiwoom_live 우선)로 수렴시키므로,
  // `'hogaplay_first'` 는 이름과 **정반대**로 동작했다. 인자를 빼면 `useRange` 의
  // `sourcePrefOverride ?? storedSourcePref` 가 설정(`krx_prefer_hogaplay`)을 따른다 —
  // 로딩 중 `undefined` 게이트도 그 경로가 이미 처리한다.
  const minuteDiskNeeded = !!(code && isMinute && restBypassEnabled);
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
  );

  /**
   * 디스크에 **없는 거래일을 키움 분봉으로 보충**한다 (`useMinuteGapFill`).
   *
   * 게이트가 `frozenRangeFrom !== null` 인 것이 요점이다 — 전역 `rest_bypass_enabled`
   * 에서는 켜지 않는다. 그 모드는 벤더가 실패하고 있을 때 사용자에게 권하는 처방이라
   * (`notifyRestFailure` → 우회 유도), 그 상태에서 자동으로 벤더를 두드리면 모드가
   * 존재하는 이유를 정면으로 무효화한다. 저장뷰 얼림은 반대다 — **사용자가 특정 과거
   * 구간을 보겠다고 명시한** 창이라 그 구간을 채우는 것이 곧 요청받은 일이다.
   *
   * 구멍 목록은 백엔드가 준 `missing_dates` 하나만 쓴다. 프론트가 직접 계산하면
   * 거래일 달력이 없어 주말·공휴일을 구멍으로 오인한다.
   */
  const minuteGapFill = useMinuteGapFill({
    enabled: frozenRangeFrom !== null,
    code,
    venue,
    timeframe,
    todayKstYyyymmdd,
    missingDates: minuteDiskCandles.data?.missing_dates,
  });
  /** 디스크가 실제로 실어 온 거래일. 보충분과의 **서로소 확인**과 소스 표기가 함께 쓴다. */
  const diskCandleDates = useMemo(
    () => (minuteDiskNeeded ? candleDateSet(minuteDiskCandles.data?.candles ?? []) : null),
    [minuteDiskNeeded, minuteDiskCandles.data?.candles],
  );

  // 캔들 소스 이분법 — 모드당 소스 1개라 병합 없음.
  const minuteKisCandles = useMemo<Candle[]>(() => {
    if (!isMinute) return EMPTY_CANDLES;
    // 우회 ON: 디스크 캔들 그대로(서버 버킷팅 완료). OFF: 벤더 응답을 tf 버킷으로 집계.
    // 벤더 응답은 **혼합 해상도**다 — 과거분은 `tic_scope=표시 tf`(#1008, 콜당 커버리지
    // tf 배수), 오늘분은 1분(실시간 tail 병합 격자). aggregateCandles 는 이미 버킷된
    // 과거분에 멱등이라 한 번의 호출이 두 해상도를 같은 격자로 수렴시킨다. 이 멱등성은
    // 매핑된 6종 tf 가 전부 KST 오프셋을 정수로 나누는 데 기댄다 — 45분처럼 나누지
    // 못하는 tf 를 추가하려면 kiwoom_minute_candles.BUCKET_MS_TO_TIC_SCOPE 주석 참고.
    if (restBypassEnabled) {
      const disk = minuteDiskCandles.data?.candles ?? EMPTY_CANDLES;
      if (minuteGapFill.candles.length === 0) return disk;
      // **서로소 날짜 union 이지 우선순위 병합이 아니다.** `missing_dates` 는 정의상
      // 디스크에 없는 거래일이므로 두 집합은 겹치지 않는다 — 그래서 이 자리는 "모드당
      // 소스 1개" 규율(위 주석)과 충돌하지 않는다. 같은 날짜를 두 소스가 다투기 시작하면
      // 그때는 이 코드가 아니라 그 전제가 깨진 것이므로, 겹침을 **버려서** 디스크를
      // 진실로 남긴다(캡처본이 호가 지표와 격자가 맞는 유일한 쪽이다).
      const extra = diskCandleDates === null
        ? minuteGapFill.candles
        : minuteGapFill.candles.filter((c) => !diskCandleDates.has(realMsToYyyymmdd(c.ts_ms)));
      if (extra.length === 0) return disk;
      return [...disk, ...extra].sort((a, b) => a.ts_ms - b.ts_ms);
    }
    const raw = pastCandlesQuery.data?.candles ?? [];
    if (raw.length === 0) return EMPTY_CANDLES;
    // 120·240 만 정규장으로 클립한 뒤 접는다. 입력은 30m 라 15:30 이 봉 경계로 남아
    // 있어 봉 단위 클립이 성립한다 — 표시 tf 로 받았다면 이미 혼합된 봉이라 불가능.
    const src = needsRegularSessionClip(timeframe) ? keepRegularSessionCandles(raw) : raw;
    if (src.length === 0) return EMPTY_CANDLES;
    return aggregateCandles(src, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000).map(kisBarToCandle);
  }, [isMinute, timeframe, restBypassEnabled, minuteDiskCandles.data?.candles, pastCandlesQuery.data?.candles, minuteGapFill.candles, diskCandleDates]);
  const calendarKisCandles = useMemo<Candle[]>(() => {
    if (isMinute) return EMPTY_CANDLES;
    // 우회 ON: 스크리너 일봉. OFF: 벤더 일봉. D는 그대로, W/M은 aggregateCalendar.
    const raw = restBypassEnabled
      ? screenerDailyCandlesQuery.data?.candles ?? []
      : pastDailyCandlesQuery.data?.candles ?? [];
    const bars = raw.length === 0 ? [] : timeframe === 'D' ? raw : aggregateCalendar(raw, timeframe as 'W' | 'M');
    return bars.map(kisBarToCandle);
  }, [isMinute, timeframe, restBypassEnabled, pastDailyCandlesQuery.data?.candles, screenerDailyCandlesQuery.data?.candles]);
  const kisCandles = isMinute ? minuteKisCandles : calendarKisCandles;
  // 소스 칩용 날짜→소스 맵. 우회 OFF는 undefined → buildChartBundle 기본값(kiwoom_live)이
  // 순수-KIS 표기를 담당(현행 동일). 우회 ON에서만 디스크 소스를 명시한다.
  const candleSourceByDate = useMemo(() => {
    if (!restBypassEnabled) return undefined;
    const sourceByDate = new Map<string, SourceName>();
    if (isMinute) {
      for (const date of diskCandleDates ?? candleDateSet(minuteDiskCandles.data?.candles ?? [])) {
        sourceByDate.set(date, segmentSourceByDate(minuteDiskCandles.data, date) ?? 'hogaplay');
      }
      // 보충일은 **디스크가 말하지 않은 날짜만** 차지한다. 소스를 따로 두는 이유는
      // 그날엔 캔들만 있고 호가 파생 지표가 없기 때문이다 — 배지가 말해 주지 않으면
      // 빈 지표 pane 이 고장으로 읽힌다(`SourceName` 주석).
      for (const date of minuteGapFill.filledDates) {
        if (!sourceByDate.has(date)) sourceByDate.set(date, 'kiwoom_gapfill');
      }
    } else {
      for (const c of screenerDailyCandlesQuery.data?.candles ?? []) {
        sourceByDate.set(realMsToYyyymmdd(c.t_ms), 'screener_daily');
      }
    }
    return sourceByDate.size > 0 ? sourceByDate : undefined;
  }, [restBypassEnabled, isMinute, minuteDiskCandles.data, diskCandleDates, minuteGapFill.filledDates, screenerDailyCandlesQuery.data]);
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
    (restBypassEnabled
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
    depthDeltaEnabled,
    wallSurgeEnabled,
    brokerLateEntryEnabled,
    brokerLateEntryStartHHMM,
    programTradeEnabled: effProgramTradeEnabled,
    volumeDistributionEnabled: effVolumeDistributionEnabled,
    volumeDistributionRangeCount,
    volumeDistributionPriceRange,
    frozenRangeFrom,
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
      // Vendor candles arrive on a separate fast path, but today's promoted
      // trades can exist before a matching candles.parquet. The sidecar needs
      // the vendor candle low/high grid to build the dense 10-bin distribution
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
      rangePlan.options.depthDeltaEnabled ||
      rangePlan.options.wallSurgeEnabled ||
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
  // 호가 유래 지표를 **캔들과 같은 척도**로 옮긴다. `/api/range` 는 디스크 캡처라
  // 원주가이고 위 벤더 봉은 수정주가인데, 둘이 같은 price scale 에 그려지므로 계수 ≠ 1
  // 인 구간이 통째로 어긋난다(009830 2026-06-12: 캔들 34,662~36,596 vs 히트맵
  // 36,300~39,250). 근거·규약 전문은 `scaleRangeBundlePrices`.
  //
  // **환산은 여기 한 곳에서만 한다.** 렌더 지점(히트맵·최대벽·매물대…)마다 흩뿌리면
  // 빠뜨릴 자리가 그만큼 늘고, 하위 wire→domain 캐시가 객체 **참조**를 키로 쓰므로
  // (`depthHeatmapWire`) 캐시 앞단에서 한 번 바꾸는 것이 참조 안정성 면에서도 맞다.
  // 계수는 봉 응답에서만 온다 — 따로 조회하면 두 곳이 다른 기준일을 쥘 수 있다.
  //
  // **우회 ON 이면 계수를 쓰지 않는다.** 그 모드의 캔들은 벤더 봉이 아니라 디스크
  // (`minuteDiskCandles`, mode='candles')라 지표와 **똑같이 원주가**다 — 이미 정합인
  // 것을 환산하면 새로 어긋난다. `pastCandlesQuery` 는 그때 비활성이지만 React Query 는
  // 비활성 쿼리의 **옛 데이터를 그대로 돌려주므로**(우회를 켜기 전에 받아 둔 응답이
  // 남는다) `enabled` 에 기대면 안 되고 여기서 명시적으로 끊어야 한다.
  const adjustFactors = restBypassEnabled ? undefined : pastCandlesQuery.data?.adjust_factors;
  const scaledHogaData = useMemo(
    () => (pastHoga.data ? scaleRangeBundlePrices(pastHoga.data, adjustFactors) : null),
    [pastHoga.data, adjustFactors],
  );
  const scaledSidecarData = useMemo(
    () => (pastSidecars.data ? scaleRangeBundlePrices(pastSidecars.data, adjustFactors) : null),
    [pastSidecars.data, adjustFactors],
  );
  const effectiveSessionByDate = useMemo(
    () => effectiveSessionBoundsByDate(pastCandlesQuery.data?.effective_sessions),
    [pastCandlesQuery.data?.effective_sessions],
  );
  const liveCandles = useMemo<Candle[]>(() => {
    const overlaid = isMinute
      ? overlayLiveTradesOnCandles(
          kisCandles, live.trade, bucketMs, venue, needsRegularSessionClip(timeframe),
        )
      : overlayLiveTradesOnCalendarCandles(kisCandles, live.trade, timeframe as 'D' | 'W' | 'M', venue);
    // 마감 동시호가 봉 접기 — REST 원본과 실시간 오버레이를 **둘 다 지난 뒤** 건다.
    // kisCandles 단계에서 접으면 그 뒤 오버레이가 평탄화되지 않은 봉을 다시 세울 수
    // 있다. 여기가 bundle.candles 로 넘어가는 최종 배열이라(아래 buildChartBundle),
    // 차트·거래량·MA·툴팁·레전드가 전부 같은 봉을 본다.
    // KRX 분봉 한정 — 근거는 collapseClosingAuction 의 호출 계약 절 참조.
    return isMinute && venue === 'KRX'
      ? collapseClosingAuction(overlaid, effectiveSessionByDate)
      : overlaid;
  }, [isMinute, timeframe, kisCandles, live.trade, bucketMs, venue, effectiveSessionByDate]);

  const defaultKrxSession = useMemo(
    () =>
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) },
    [live.initial, todayKstYyyymmdd],
  );
  // Chart session follows the selected venue for minute candles — **호가 지표도
  // 같은 세션을 쓴다**(아래 hogaSeries).
  //
  // 종전 주석은 "HOGA/WS side remains KRX-only, so buildHogaSeries keeps the default
  // KRX bounds" 였다. 그 전제는 venue 축이 호가·WS 로 확장되면서 죽었는데 결정만 남아,
  // NXT/통합에서 총잔량·호가비·히트맵·증감이 정규장 밖(프리 08:00–08:50 · 애프터
  // 15:40–20:00)에서 통째로 0-센티넬이 됐다. 캔들 축은 확장창이라 **캔들만 있고 라인은
  // 없는** 화면이 나왔고, 10호가 창과 pane 레전드에는 값이 찍혀서 데이터 결손으로
  // 오진하기 쉬웠다.
  //
  // 예외: 우회 ON(kis_rest_bypass) 분봉은 디스크(hogaplay/range) 소스라 KRX 전용
  // (ADR-0003 "Hogaplay is a KRX-only product" · ADR-0078 venue=KIS 실시간 전용).
  // 그래서 venue=UN 이어도 확장창(08:00~20:00)이 아니라 KRX 정규창을 써야 한다 —
  // 안 그러면 KRX 캔들에 데이터 없는 확장 구간이 붙어 축이 비대칭해진다.
  const useExtendedWindow = liveVenueUsesExtendedMinuteWindow(venue) && !restBypassEnabled;
  const todayChartSession = useMemo(
    () => {
      if (!isMinute) return defaultKrxSession;
      const effective = effectiveSessionByDate.get(todayKstYyyymmdd);
      if (effective) return effective;
      return useExtendedWindow
        ? liveVenueSessionBoundsMs(todayKstYyyymmdd, venue)
        : defaultKrxSession;
    },
    [defaultKrxSession, effectiveSessionByDate, isMinute, todayKstYyyymmdd, venue, useExtendedWindow],
  );
  const sessionBoundsForDate = useMemo(
    () =>
      isMinute
        ? (yyyymmdd: string) =>
            effectiveSessionByDate.get(yyyymmdd) ??
            (useExtendedWindow
              ? liveVenueSessionBoundsMs(yyyymmdd, venue)
              : {
                  open_ms: regularSessionOpenMs(yyyymmdd),
                  close_ms: regularSessionCloseMs(yyyymmdd),
                })
        : undefined,
    [effectiveSessionByDate, isMinute, venue, useExtendedWindow],
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
      pastBundle: scaledHogaData,
      kisCandles: liveCandles,
      candleSourceByDate,
      bucketMs,
      hasTodayObSignal,
      investorPoints,
      sessionBoundsForDate,
    });
    const sidecarSource = scaledSidecarData;
    if (sidecarSource) {
      built.ask_peaks = sidecarSource.ask_peaks ?? [];
      built.bid_peaks = sidecarSource.bid_peaks ?? [];
      built.broker_late_entries = sidecarSource.broker_late_entries ?? [];
      built.trade_volume_pocs = sidecarSource.trade_volume_pocs ?? [];
      built.depth_heatmap = sidecarSource.depth_heatmap ?? [];
      built.depth_delta = sidecarSource.depth_delta ?? [];
      built.wall_surge = sidecarSource.wall_surge ?? [];
      built.volume_distributions = sidecarSource.volume_distributions ?? [];
      built.program_trade = filterProgramTradeForCandles(sidecarSource.program_trade, liveCandles);
    }
    if (effProgramTradeEnabled) {
      built.program_trade = mergeProgramTradeSeriesWithLiveTail(
        built.program_trade,
        live.program,
      );
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
  }, [
    code,
    todayKstYyyymmdd,
    todayChartSession,
    scaledHogaData,
    scaledSidecarData,
    liveCandles,
    live.program,
    candleSourceByDate,
    bucketMs,
    hasTodayObSignal,
    investorPoints,
    sessionBoundsForDate,
    effProgramTradeEnabled,
  ]);

  // HOGA side (quote_ratio / fill_strength). Deps INCLUDE ob/trade — this is the
  // ONLY half that rebuilds on an SSE tick.
  const hogaSeriesBuilderRef = useRef<ReturnType<typeof createIncrementalHogaSeriesBuilder> | null>(null);
  if (hogaSeriesBuilderRef.current === null) {
    hogaSeriesBuilderRef.current = createIncrementalHogaSeriesBuilder();
  }
  const hogaSeries = useMemo<HogaSeries>(
    () =>
      hogaSeriesBuilderRef.current!({
        // 캔들과 **같은** 세션을 쓴다 — 경계를 여기서 다시 조립하지 않는다(진실 소스 하나).
        // `todayChartSession` 이 venue 분기(확장창 08:00–20:00)와 우회 ON 예외(KRX 정규창)를
        // 이미 삼켰으므로, 여기서 갈라지면 축과 지표가 다시 어긋난다.
        todaySession: todayChartSession,
        pastBundle: scaledHogaData,
        sseOb: isMinute ? live.ob : [],
        sseTrade: isMinute ? live.trade : [],
        bucketMs,
        // 꺼진 지표는 계산하지 않는다. 이 둘은 15분 버퍼 전체를 훑는 O(n) 이고 기본
        // OFF 인데 종전엔 토글과 무관하게 매 flush 돌았다 — 실측상 전체 재빌드 비용의
        // 73~94%(자세한 근거는 BuildHogaSeriesInput 주석). 소비처는 전부 이 창의
        // 차트 오버레이라 같은 토글로 게이트돼 있어, 끄면 애초에 그릴 대상이 없다.
        depthHeatmapEnabled,
        depthDeltaEnabled,
      }),
    [
      todayChartSession, scaledHogaData, isMinute, live.ob, live.trade, bucketMs,
      depthHeatmapEnabled, depthDeltaEnabled,
    ],
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
      // 우회 ON에선 차트 캔들이 벤더 REST가 아니라 디스크(minuteDiskCandles, plain useRange)
      // 에서 온다. 이 쿼리도 좌측 팬 re-key 시 이전 데이터를 placeholder로 보이며 더 오래된 창을
      // fetch하므로 벤더 경로와 동일하게 isPlaceholderData && isFetching로 홀드해야 프리펜드가
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
      depth_delta_today: [],
    }),
    [bucketMs],
  );
  const committedHogaSeries = holdHogaSeriesForColdCandles ? emptyHogaSeries : hogaSeries;

  // 증감 세션 누적 — live.ob 가 15분 시간창이라 버킷터 출력만 쓰면 커버리지가 "오늘"이
  // 아니라 "최근 15분"이 된다(depthDeltaSession 주석 참조). 종목·거래일·버킷 크기가
  // 바뀌면 누적을 버린다. merge 는 멱등하고 무변화 시 같은 참조를 돌려주므로 렌더 중
  // 호출이 안전하다.
  const deltaSessionRef = useRef<{ key: string; points: readonly DepthDeltaPoint[] }>({
    key: '',
    points: [],
  });
  const deltaSessionKey = `${code ?? ''}|${todayKstYyyymmdd}|${bucketMs}`;
  if (deltaSessionRef.current.key !== deltaSessionKey) {
    deltaSessionRef.current = { key: deltaSessionKey, points: [] };
  }
  deltaSessionRef.current.points = mergeDepthDeltaSession(
    deltaSessionRef.current.points,
    committedHogaSeries.depth_delta_today,
  );
  const liveDeltaPoints = deltaSessionRef.current.points;
  // 백엔드 슬라이스(캡처 스냅샷 ~10s 표본의 diff — 과거일 + 오늘의 페이지 열기 이전
  // 구간)와 라이브 세션 누적을 결합한다. 이게 "켜자마자 빈 화면" 문제의 해소 지점:
  // 종전에는 라이브 누적(페이지 로드 이후)만 있어 커버리지가 세션 시작부터였다.
  const backendDeltaPoints = useMemo(
    () => depthDeltaFromWire(chartBundle?.depth_delta),
    [chartBundle?.depth_delta],
  );
  const depthDeltaToday = useMemo(
    () => combineDepthDeltaBackendLive(backendDeltaPoints, liveDeltaPoints),
    [backendDeltaPoints, liveDeltaPoints],
  );

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
            // 결손 사유는 **호가 응답에만** 있다(#1133) — 스프레드 원본인 chartBundle 은
            // 캔들 경로(벤더 REST)라 이 필드가 없다. 그래서 명시적으로 실어 올린다.
            // 안 하면 호가 pane 이 비는 바로 그 상황에서 이유가 사라진다.
            missing_dates: pastHoga.data?.missing_dates ?? [],
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
      pastHoga.data?.missing_dates,
    ],
  );

  // Clamp is a minute-path concern only; the daily endpoint has no 250d cap.
  // 지금 캔들을 담당하는 쿼리 하나 — 빈 상태 판별의 입력(#1133 후속).
  // 축이 둘이다: 타임프레임(분봉/캘린더) × REST 우회(벤더/디스크). 넷 중 하나만 산다.
  const activeCandlesQuery = restBypassEnabled
    ? (isMinute ? minuteDiskCandles : screenerDailyCandlesQuery)
    : (isMinute ? pastCandlesQuery : pastDailyCandlesQuery);
  const activeCandlesError = activeCandlesQuery.error;
  const activeCandlesLoading = activeCandlesQuery.isLoading;
  // 빈 상태의 "다시 시도" — 활성 쿼리 하나만 다시 쏜다(전부 refetch 하면 벤더 유량을
  // 무관한 쿼리까지 태운다). 캔들 소스가 바뀌면 이 참조도 따라 바뀐다.
  const refetchCandles = activeCandlesQuery.refetch;

  const clampEngaged = isMinute
    && historicalFromDate != null
    && historicalFromDate <= earliestAllowedMinute;

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

  // 캘린더(D/W/M) 캔들 응답이 되싣는 from — 웜 캐시 스텝의 진행 신호(위 필드 주석).
  // 활성 소스 배타 선택은 `pastDataWarnings`·`activeCandlesQuery`와 같은 규율이다.
  const settledDailyResponse = restBypassEnabled
    ? screenerDailyCandlesQuery.data
    : pastDailyCandlesQuery.data;
  const pastSettledFromDate =
    !isMinute && settledDailyResponse && settledDailyResponse.code === code
      ? settledDailyResponse.from
      : null;

  // 활성 소스의 fetch 경고만 노출 — 배타 이분화. 우회 ON 분봉은 디스크라 경고 없음([]),
  // D/W/M은 스크리너. 우회 OFF는 KIS 경로. (다른 경로 쿼리는 disabled라 스테일 경고가
  // 새어 나오지 않도록 배타로 고른다.)
  const pastDataWarnings: LiveDataWarning[] = isMinute
    ? (restBypassEnabled ? [] : pastCandlesQuery.data?.data_warnings ?? [])
    : restBypassEnabled
      ? screenerDailyCandlesQuery.data?.data_warnings ?? []
      : pastDailyCandlesQuery.data?.data_warnings ?? [];

  return {
    bundle,
    chartBundle,
    hogaBundle,
    /**
     * 호가 결손 사유 — **번들과 따로 내보낸다**(#1133).
     *
     * `hogaBundle` 은 `chartBundle ? {...} : null` 이라 **캔들이 없으면 통째로 null**
     * 이고, 그러면 안에 실린 사유도 함께 사라진다. 그런데 사유는 데이터가 없을 때
     * 존재하는 값이라 정작 필요한 순간에 그릇이 없는 셈이다 — 자격증명 미설정·벤더
     * 장애로 캔들이 안 오면 "왜 비었는지" 를 말할 수단이 함께 증발했다.
     *
     * 메타데이터를 데이터와 같은 경로로 흘린 대가라, 경로를 가른 것이 수정이다.
     */
    hogaMissingDates: pastHoga.data?.missing_dates ?? [],
    /**
     * 캔들이 **왜** 없나 — 원인 4종 판별(#1133 후속). 로직은 `candleEmptyState.ts`.
     *
     * ⚠ **활성 캔들 소스의 에러만** 본다. 타임프레임(분봉/캘린더)과 REST 우회 설정에
     * 따라 캔들이 오는 쿼리가 넷으로 갈리는데, 아래 `error` 필드처럼 전부 합치면 지금
     * 캔들을 담당하지 않는 쿼리의 실패가 엉뚱한 빈 상태를 띄운다.
     */
    candleEmpty: deriveCandleEmptyState({
      error: activeCandlesError,
      // 같은 "활성 경로" 규율을 경고에도 적용한다 — `pastDataWarnings` 가 이미 우회
      // 여부·타임프레임으로 배타 선택된 값이라 그대로 넘기면 된다. 벤더 실패가 500 이
      // 아니라 경고로 오는 경로(#1226 이후)에서는 이게 유일한 단서다.
      warnings: pastDataWarnings,
      hasCandles: (chartBundle?.candles.length ?? 0) > 0,
      isLoading: activeCandlesLoading,
      restBypassEnabled,
      savedRangeFrozen: frozenRangeFrom !== null,
      // "지금 요청 중" 과 "아직 남은 run 이 있다" 의 합집합 — run 사이 커서가 넘어가는
      // 프레임에서 `isFetching` 만 보면 빈 상태가 한 번 깜빡인다.
      savedRangeGapFillPending: minuteGapFill.isFetching || minuteGapFill.remainingRuns > 0,
      hasInstrument: !!code,
    }),
    refetchCandles,
    /** 오늘의 단별 잔량 증감 버킷(세션 누적). 과거일 소스가 없어(설계 §5) RangeBundle 에
     *  싣지 않고 도메인 그대로 내보낸다 — wire 왕복도, 백엔드 플래그도 필요 없다. */
    depthDeltaToday,
    /** 이 번들의 지표에 적용된 날짜별 수정계수. `/api/range` 를 **따로 호출하는**
     *  소비자(예: `useVolumeDistributionCutoffProfile`)가 같은 척도를 쓰게 하려고
     *  내보낸다 — 여기서 안 주면 그 경로만 원주가로 남아 옆문으로 어긋난다.
     *  우회 ON 이면 `undefined`(그 모드는 캔들도 디스크라 환산 대상이 아니다). */
    adjustFactors,
    gapFill: minuteGapFill,
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
    indicatorCoverageFromDate,
    rangeWindowFromDate,
    pastSettledFromDate,
  };
}
