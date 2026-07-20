import type {
  RangeBundle,
  RangeSegment,
  Candle,
  VolumeProfile,
  ProgramTradeSeries,
  QuoteRatio,
  FillStrength,
  InvestorNetPoint,
  QuoteRatioPoint,
  FillStrengthPoint,
  OrderbookLevel,
  SourceName,
} from '../api/types';
import {
  bucketHogaSeries,
  isContinuousBook,
  isIndicatorEligibleBook,
  type ObSnapshot,
  type TradeSnapshot,
} from './bucketHogaSeries';
import {
  realMsToYyyymmdd,
  regularSessionOpenMs,
  regularSessionCloseMs,
} from './liveDateTime';
import { quoteImbalance } from '../util/imbalance';
import type { DepthHeatmapPoint } from './depthHeatmapWire';
import {
  foldLevelDiff,
  ladderTick,
  makeDeltaPoint,
  sameDeltaChain,
  type DeltaAcc,
  type DepthDeltaPoint,
} from './depthDelta';

/** /live never mounts VolumeProfileOverlay; the bundle ships an empty profile
 * that satisfies the RangeBundle type without claiming any data. */
const EMPTY_VOLUME_PROFILE: VolumeProfile = {
  bin_count: 0,
  price_min: 0,
  price_max: 0,
  bin_width: 0,
  bins: [],
};

const AFTER_HOURS_EXTENSION_MS = 30 * 60 * 1000;

export interface BuildLiveBundleInput {
  code: string;
  todayDate: string;
  todaySession: { open_ms: number; close_ms: number };
  /** Past stock-dates fetched via /api/range. Used for hoga indicators
   * (quote_ratio, fill_strength) and segments only —
   * `pastBundle.candles` is intentionally ignored. */
  pastBundle: RangeBundle | null;
  sseOb: readonly ObSnapshot[];
  sseTrade: readonly TradeSnapshot[];
  /** Candles from /api/live/past-candles (KIS dailychartprice), already
   * client-side aggregated to the display timeframe and converted to wire
   * Candle shape. Single source of truth for the bundle's candle array
   * (ADR-0040 — Live Candle Backfill). */
  kisCandles: Candle[];
  candleSourceByDate?: ReadonlyMap<string, SourceName>;
  bucketMs: number;
}

/** ob/trade-derived hoga series — the ONLY part of the bundle that changes on
 * an SSE snapshot push. Split out so the candle/segment side (buildChartBundle)
 * can be memoised WITHOUT the ob/trade array deps, so a live tick doesn't churn
 * the candle path (2026-06-09 bundle-split design). */
export interface BuildHogaSeriesInput {
  todaySession: { open_ms: number; close_ms: number };
  pastBundle: RangeBundle | null;
  sseOb: readonly ObSnapshot[];
  sseTrade: readonly TradeSnapshot[];
  bucketMs: number;
}

export interface HogaSeries {
  quote_ratio: QuoteRatio;
  fill_strength: FillStrength;
  /** Today's live depth-heatmap buckets — per minute the CLOSE (last continuous
   * tick) 10-level book plus the MAX (peak total-qty tick) 10-level book. Only
   * populated when SSE ob snapshots carry `asks`/`bids`; totals-only ticks
   * contribute nothing. Past-date depth lives on `RangeBundle.depth_heatmap`;
   * the bundle merge (Task 6) stitches the two. */
  depth_heatmap_today: DepthHeatmapPoint[];
  /** 오늘의 단별 잔량 증감 버킷 — 연속된 두 호가 스냅샷을 가격 교집합으로 diff 해
   * 분봉 버킷마다 가격별 유입/유출을 합산한 것. 히트맵이 "얼마나 쌓여 있나"(상태)라면
   * 이쪽은 "언제 얼마나 들어오고 빠졌나"(흐름)다.
   *
   * v1 은 **오늘 전용**이다: 과거일 `RangeBundle.depth_heatmap` 은 분봉당 close/max
   * 스냅샷만 있어 분 내부 증감이 이미 소실됐고, close-to-close 근사는 오늘과 정밀도가
   * 달라 같은 지표로 보이면 오독을 부른다. 과거일은 백엔드가 캡처 원본에서 집계해
   * 서빙하는 후속 작업(설계 §5a)으로 미룬다 — 그래서 wire 왕복도 없다. */
  depth_delta_today: DepthDeltaPoint[];
}

interface PastHogaSeries {
  validPastQR: QuoteRatioPoint[];
  validPastFS: FillStrengthPoint[];
  pastMaxQrT: number;
  pastMaxFsT: number;
}

export function filterProgramTradeForCandles(
  series: ProgramTradeSeries | undefined,
  candles: readonly Candle[],
): ProgramTradeSeries {
  if (!series || series.points.length === 0 || candles.length === 0) return { points: [] };
  const candleDates = new Set(candles.map((c) => realMsToYyyymmdd(c.ts_ms)));
  return {
    ...series,
    points: series.points.filter((p) => candleDates.has(realMsToYyyymmdd(p.t))),
  };
}

function preparePastHogaSeries(pastBundle: RangeBundle | null, todaySessionCloseMs: number): PastHogaSeries {
  const afterHoursEndMs = todaySessionCloseMs + AFTER_HOURS_EXTENSION_MS;
  const validPastQR = pastBundle?.quote_ratio.points.filter((p) => p.t <= afterHoursEndMs) ?? [];
  const validPastFS = pastBundle?.fill_strength.points.filter((p) => p.t <= afterHoursEndMs) ?? [];
  return {
    validPastQR,
    validPastFS,
    pastMaxQrT: validPastQR.length > 0 ? validPastQR[validPastQR.length - 1].t : 0,
    pastMaxFsT: validPastFS.length > 0 ? validPastFS[validPastFS.length - 1].t : 0,
  };
}

export function buildHogaSeries(input: BuildHogaSeriesInput): HogaSeries {
  const { todaySession, pastBundle, sseOb, sseTrade, bucketMs } = input;

  // ADR-0049 / spec §3 — filter (not clip) past points whose t escapes
  // the Live Session end so a backend encoding regression cannot block SSE
  // merge. Why filter not Math.min: clipping leaves pastMaxQrT at
  // close+30min, strictly greater than every SSE timestamp during the
  // session, so `incrementalQR.filter(p => p.t > pastMaxQrT)` would reject
  // ALL SSE points. Filter drops corrupt past entries from pastMax calc
  // AND from the wire output, so SSE merges naturally and renders stay
  // consistent with VirtualAxis (which filters out-of-segment points
  // anyway). Ceiling = close_ms + 30min (Live Session end incl. After-Hours
  // Trading, ADR-0044 / CONTEXT.md "Live Session"). Healthy past always
  // passes — no-op for normal bundles.
  const { validPastQR, validPastFS, pastMaxQrT, pastMaxFsT } = preparePastHogaSeries(
    pastBundle,
    todaySession.close_ms,
  );

  // Today's straddle/auction buckets must not pull the closing-auction (3-level)
  // book into 호가비·총잔량. bucketHogaSeries detects the auction structurally
  // (book collapse) per ob snapshot's asks/bids and excludes everything after the
  // last continuous-book snapshot at/before close. today's close is the upper
  // bound for that search (load-bearing — 2026-06-03 structural-boundary spec).
  // Known limitation: close_ms falls back to 15:30 on half-days, so the today-live
  // half-day tail stays uncleaned; backend (past dates) uses the exact per-date close.
  const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs, todaySession.close_ms);
  const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > pastMaxQrT);
  const incrementalFS = sseBuckets.fillStrengthPoints.filter((p) => p.t > pastMaxFsT);

  return {
    quote_ratio: { bucket_ms: bucketMs, points: [...validPastQR, ...incrementalQR] },
    fill_strength: { bucket_ms: bucketMs, points: [...validPastFS, ...incrementalFS] },
    depth_heatmap_today: bucketDepthHeatmap(sseOb, bucketMs, todaySession.close_ms),
    depth_delta_today: bucketDepthDelta(sseOb, bucketMs, todaySession.close_ms),
  };
}

/** One-shot depth-heatmap bucketing — the stateless oracle mirrored by
 * `IncrementalHogaBucketer`'s per-tick ratchet. Per minute bucket it keeps two
 * 10-level books: CLOSE (the last continuous-book tick) and MAX (the tick whose
 * total bid+ask qty peaked). Gated identically to the quote ratchet: only ticks
 * at/before the structural closing-auction boundary (`s.t_ms <= lastContinuousMs`)
 * count, and only ticks carrying `asks`/`bids` (totals-only ticks are skipped so
 * the minute-chart totals path never fabricates an empty book). Strict `>` on the
 * max means the FIRST tick at the peak total wins ties (mirrors `imb_max`). */
export function bucketDepthHeatmap(
  ob: readonly ObSnapshot[],
  bucketMs: number,
  sessionCloseMs: number = Number.POSITIVE_INFINITY,
): DepthHeatmapPoint[] {
  const obSorted = [...ob].sort((a, b) => a.t_ms - b.t_ms);
  let lastContinuousMs = Number.NEGATIVE_INFINITY;
  for (const s of obSorted) {
    if (s.t_ms <= sessionCloseMs && isContinuousBook(s)) lastContinuousMs = s.t_ms;
  }
  if (lastContinuousMs === Number.NEGATIVE_INFINITY) lastContinuousMs = Number.POSITIVE_INFINITY;

  const byBucket = new Map<
    number,
    { close: { asks: OrderbookLevel[]; bids: OrderbookLevel[] }; max: { asks: OrderbookLevel[]; bids: OrderbookLevel[]; total: number } }
  >();
  const order: number[] = [];
  for (const s of obSorted) {
    // ADR-0062 v2/v3 (동시호가 배제 통일): 시간 상한 + 공용 술어 isIndicatorEligibleBook
    // (구조 + 개장 09:00 하한) — 장중 VI 붕괴책과 개장 동시호가를 depth 대표에서도 배제
    // (quote 경로·incremental builder·매도벽과 동일 규칙, parity 유지). 완전-동시호가
    // 버킷은 통째로 드롭 = 빈 컬럼(백엔드 WHERE 사전 필터 드롭과 파리티).
    if (s.t_ms > lastContinuousMs || !isIndicatorEligibleBook(s)) continue;
    if (!s.asks || !s.bids) continue;
    const t = bucketStartMs(s.t_ms, bucketMs);
    const curTotal = s.total_bid_qty + s.total_ask_qty;
    const prev = byBucket.get(t);
    if (!prev) order.push(t);
    const close = { asks: s.asks, bids: s.bids };
    const max =
      !prev || curTotal > prev.max.total ? { asks: s.asks, bids: s.bids, total: curTotal } : prev.max;
    byBucket.set(t, { close, max });
  }
  return order.map((t) => {
    const d = byBucket.get(t)!;
    return { tMs: t, asks: d.close.asks, bids: d.close.bids, asksMax: d.max.asks, bidsMax: d.max.bids };
  });
}

/** One-shot depth-DELTA bucketing — the stateless oracle mirrored by
 * `IncrementalHogaBucketer`'s per-tick fold. Walks the snapshots in time order
 * keeping a single `prev` baseline and folds each consecutive pair's per-price
 * change into the bucket of the LATER tick (변화가 관측된 시각).
 *
 * The eligibility gate is byte-identical to `bucketDepthHeatmap`'s, but the
 * treatment of a rejected tick differs in a load-bearing way: instead of merely
 * skipping it, a rejected tick **drops the baseline** (`prev = null`). Diffing
 * across an excluded stretch (개장/종가 동시호가, 장중 VI 붕괴, book 없는
 * totals-only 틱) would attribute an unbounded, unobserved interval of change to
 * a single bucket — and the 10단 관측창이 그 사이 크게 미끄러졌을 가능성이 높아
 * 교집합 규칙만으로는 아티팩트를 막지 못한다. Venue 전환(KRX↔NXT)도 같은 이유로
 * 체인을 끊는다(별개 호가장).
 *
 * 빈 버킷(폴드는 했지만 증감이 전부 0)은 방출하지 않는다 — depth 경로의 "배제 버킷 =
 * 빈 컬럼" 정책과 같고, 증분 미러도 `makeDeltaPoint` 의 null 로 같은 결정을 내린다. */
export function bucketDepthDelta(
  ob: readonly ObSnapshot[],
  bucketMs: number,
  sessionCloseMs: number = Number.POSITIVE_INFINITY,
): DepthDeltaPoint[] {
  const obSorted = [...ob].sort((a, b) => a.t_ms - b.t_ms);
  let lastContinuousMs = Number.NEGATIVE_INFINITY;
  for (const s of obSorted) {
    if (s.t_ms <= sessionCloseMs && isContinuousBook(s)) lastContinuousMs = s.t_ms;
  }
  // 경계를 못 찾았으면 히트맵처럼 +Infinity 로 **열지 않는다**. 버퍼가 통째로 세션 마감
  // 뒤인 상황(KRX 차트로 NXT 애프터마켓을 보는 경우 — 15분 창이 전부 15:30 이후)이 정확히
  // 그 경우인데, 열어 주면 19:00 같은 세션 밖 시각에 버킷이 생긴다. 그런 버킷은 차트
  // 가상축에 자리가 없어 **그려지지 않으면서 레전드에는 값이 찍히는** 유령 상태를 만든다
  // (증감은 과거일 소스가 없어 이 버퍼가 유일한 입력이라 출력 전체가 유령이 된다).
  // 세션 상한으로 닫으면 KRX 차트에서는 조용히 비고(레전드 행도 hasDepthDelta 로 사라짐),
  // 통합(UN) 차트에서는 세션이 20:00 까지라 NXT 시간대가 그대로 살아난다.
  if (lastContinuousMs === Number.NEGATIVE_INFINITY) lastContinuousMs = sessionCloseMs;

  const byBucket = new Map<number, { ask: DeltaAcc; bid: DeltaAcc; askTick: number; bidTick: number }>();
  const order: number[] = [];
  let prev: ObSnapshot | null = null;
  for (const s of obSorted) {
    if (s.t_ms > lastContinuousMs || !isIndicatorEligibleBook(s) || !s.asks || !s.bids) {
      prev = null;
      continue;
    }
    if (prev?.asks && prev.bids && sameDeltaChain(prev, s)) {
      const t = bucketStartMs(s.t_ms, bucketMs);
      let accs = byBucket.get(t);
      if (!accs) {
        accs = {
          ask: new Map(),
          bid: new Map(),
          askTick: Number.POSITIVE_INFINITY,
          bidTick: Number.POSITIVE_INFINITY,
        };
        byBucket.set(t, accs);
        order.push(t);
      }
      foldLevelDiff(prev.asks, s.asks, accs.ask);
      foldLevelDiff(prev.bids, s.bids, accs.bid);
      // 마지막으로 **관측된** 틱을 쓴다(최솟값 고착 금지). 사다리가 잠시 퇴화해
      // 틱을 못 구한 틱(Infinity)은 앞서 구한 값을 지운다는 뜻이 아니므로 건너뛴다.
      const at = ladderTick(s.asks);
      if (Number.isFinite(at)) accs.askTick = at;
      const bt = ladderTick(s.bids);
      if (Number.isFinite(bt)) accs.bidTick = bt;
    }
    prev = s;
  }

  const out: DepthDeltaPoint[] = [];
  for (const t of order) {
    const accs = byBucket.get(t)!;
    const point = makeDeltaPoint(t, accs.ask, accs.bid, accs.askTick, accs.bidTick);
    if (point) out.push(point);
  }
  return out;
}

function isOrderedByTime<T extends { t_ms: number }>(items: readonly T[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1].t_ms > items[i].t_ms) return false;
  }
  return true;
}

function bucketStartMs(tMs: number, bucketMs: number): number {
  return Math.floor(tMs / bucketMs) * bucketMs;
}

class IncrementalHogaBucketer {
  private bucketMs = 0;
  private sessionCloseMs = Number.POSITIVE_INFINITY;
  private obLength = 0;
  private tradeLength = 0;
  private lastObRef: ObSnapshot | null = null;
  private lastTradeRef: TradeSnapshot | null = null;
  private continuousBoundaryMs: number | null = null;
  private maxProcessedObT: number | null = null;
  private maxProcessedTradeT: number | null = null;
  private quoteByBucket = new Map<number, QuoteRatioPoint>();
  private quoteOrder: number[] = [];
  private seenPre = new Set<number>();
  private fillByBucket = new Map<number, FillStrengthPoint>();
  private fillOrder: number[] = [];
  // 버킷별로 완성된 DepthHeatmapPoint 를 보관한다 — 틱이 그 버킷을 실제로 바꿀 때만
  // 새 point 객체로 교체하므로, 갱신되지 않은 과거 버킷의 참조가 틱 간 안정적이다.
  // 하류 depthPointToWire / depthHeatmapFromWire 의 WeakMap 캐시가 이 불변식에
  // 의존한다(내용 변경 = 객체 교체 → 미변경 버킷은 캐시 히트). ⚠️ point 내부
  // 배열을 in-place mutate 하면 이 불변식이 깨진다 — 항상 새 point 로 교체할 것.
  private depthByBucket = new Map<number, { point: DepthHeatmapPoint; maxTotal: number }>();
  private depthOrder: number[] = [];
  // 증감(delta) 상태. 누적기(ask/bid)는 point 의 **형제**로 둔다 — point 안에 넣고
  // in-place 로 더하면 위의 참조 안정 불변식이 깨진다. `point: null` 은 "아직 0 이 아닌
  // 증감이 없는 버킷"이며 방출에서 제외된다(오라클의 빈 버킷 드롭과 대응).
  private deltaByBucket = new Map<number, { ask: DeltaAcc; bid: DeltaAcc; askTick: number; bidTick: number; point: DepthDeltaPoint | null }>();
  private deltaOrder: number[] = [];
  // 틱 간 baseline. ⚠️ reset() 에서 반드시 null 로 되돌려야 한다 — 안 그러면 슬라이딩
  // 윈도우가 앞을 잘라낸 뒤 rebuild 할 때, **현재 배열에 없는** 스냅샷과 diff 해서
  // 오라클이 결코 만들지 않는 유령 증감이 첫 버킷에 찍힌다(패리티 계약 위반).
  private prevDeltaBook: ObSnapshot | null = null;

  update(
    ob: readonly ObSnapshot[],
    trade: readonly TradeSnapshot[],
    bucketMs: number,
    sessionCloseMs: number,
  ): {
    quoteRatioPoints: QuoteRatioPoint[];
    fillStrengthPoints: FillStrengthPoint[];
    depthHeatmapToday: DepthHeatmapPoint[];
    depthDeltaToday: DepthDeltaPoint[];
  } {
    if (
      this.bucketMs !== bucketMs ||
      this.sessionCloseMs !== sessionCloseMs ||
      !this.canAppendOb(ob) ||
      !this.canAppendTrade(trade)
    ) {
      this.reset(bucketMs, sessionCloseMs);
      const obSorted = isOrderedByTime(ob) ? ob : [...ob].sort((a, b) => a.t_ms - b.t_ms);
      const tradeSorted = isOrderedByTime(trade) ? trade : [...trade].sort((a, b) => a.t_ms - b.t_ms);
      this.appendOb(obSorted);
      this.appendTrade(tradeSorted);
      this.rememberInputs(ob, trade);
      return this.snapshot();
    }

    const obDelta = ob.slice(this.obLength);
    const tradeDelta = trade.slice(this.tradeLength);
    if (!this.isMonotonicObDelta(obDelta) || !this.isMonotonicTradeDelta(tradeDelta)) {
      this.reset(bucketMs, sessionCloseMs);
      const obSorted = isOrderedByTime(ob) ? ob : [...ob].sort((a, b) => a.t_ms - b.t_ms);
      const tradeSorted = isOrderedByTime(trade) ? trade : [...trade].sort((a, b) => a.t_ms - b.t_ms);
      this.appendOb(obSorted);
      this.appendTrade(tradeSorted);
      this.rememberInputs(ob, trade);
      return this.snapshot();
    }
    if (!this.appendOb(obDelta)) {
      this.reset(bucketMs, sessionCloseMs);
      const obSorted = isOrderedByTime(ob) ? ob : [...ob].sort((a, b) => a.t_ms - b.t_ms);
      const tradeSorted = isOrderedByTime(trade) ? trade : [...trade].sort((a, b) => a.t_ms - b.t_ms);
      this.appendOb(obSorted);
      this.appendTrade(tradeSorted);
      this.rememberInputs(ob, trade);
      return this.snapshot();
    }
    this.appendTrade(tradeDelta);
    this.rememberInputs(ob, trade);
    return this.snapshot();
  }

  private reset(bucketMs: number, sessionCloseMs: number) {
    this.bucketMs = bucketMs;
    this.sessionCloseMs = sessionCloseMs;
    this.obLength = 0;
    this.tradeLength = 0;
    this.lastObRef = null;
    this.lastTradeRef = null;
    this.continuousBoundaryMs = null;
    this.maxProcessedObT = null;
    this.maxProcessedTradeT = null;
    this.quoteByBucket = new Map();
    this.quoteOrder = [];
    this.seenPre = new Set();
    this.fillByBucket = new Map();
    this.fillOrder = [];
    this.depthByBucket = new Map();
    this.depthOrder = [];
    this.deltaByBucket = new Map();
    this.deltaOrder = [];
    // load-bearing: rebuild 은 "현재 배열만" 보고 오라클과 같은 답을 내야 한다.
    this.prevDeltaBook = null;
  }

  private canAppendOb(ob: readonly ObSnapshot[]): boolean {
    if (ob.length < this.obLength) return false;
    if (this.obLength === 0) return true;
    return ob[this.obLength - 1] === this.lastObRef;
  }

  private canAppendTrade(trade: readonly TradeSnapshot[]): boolean {
    if (trade.length < this.tradeLength) return false;
    if (this.tradeLength === 0) return true;
    return trade[this.tradeLength - 1] === this.lastTradeRef;
  }

  private rememberInputs(ob: readonly ObSnapshot[], trade: readonly TradeSnapshot[]) {
    this.obLength = ob.length;
    this.tradeLength = trade.length;
    this.lastObRef = ob.length > 0 ? ob[ob.length - 1] : null;
    this.lastTradeRef = trade.length > 0 ? trade[trade.length - 1] : null;
  }

  private isMonotonicObDelta(obs: readonly ObSnapshot[]): boolean {
    let last = this.maxProcessedObT;
    for (const s of obs) {
      if (last !== null && s.t_ms < last) return false;
      last = s.t_ms;
    }
    return true;
  }

  private isMonotonicTradeDelta(trades: readonly TradeSnapshot[]): boolean {
    let last = this.maxProcessedTradeT;
    for (const s of trades) {
      if (last !== null && s.t_ms < last) return false;
      last = s.t_ms;
    }
    return true;
  }

  private appendOb(obs: readonly ObSnapshot[]): boolean {
    if (obs.length === 0) return true;
    const oldBoundary = this.continuousBoundaryMs;
    let nextBoundary = oldBoundary;
    for (const s of obs) {
      if (s.t_ms <= this.sessionCloseMs && isContinuousBook(s)) {
        nextBoundary = nextBoundary === null ? s.t_ms : Math.max(nextBoundary, s.t_ms);
      }
    }

    if (
      oldBoundary !== null &&
      nextBoundary !== null &&
      nextBoundary > oldBoundary &&
      this.maxProcessedObT !== null &&
      this.maxProcessedObT > oldBoundary
    ) {
      return false;
    }

    this.continuousBoundaryMs = nextBoundary;
    const threshold = this.continuousBoundaryMs ?? Number.POSITIVE_INFINITY;
    // 증감 전용 상한 — 히트맵(threshold)과 갈라지는 유일한 지점. 경계를 못 찾았을 때
    // 히트맵은 +Infinity 로 열지만 증감은 세션 마감으로 닫는다(bucketDepthDelta 의 같은
    // 분기 주석 참조: 버퍼가 통째로 마감 뒤면 세션 밖 유령 버킷만 나온다).
    const deltaThreshold = this.continuousBoundaryMs ?? this.sessionCloseMs;
    for (const s of obs) {
      const t = bucketStartMs(s.t_ms, this.bucketMs);
      // ADR-0062 v2/v3 (동시호가 배제 통일): bucketHogaSeries와 동일하게 시간 상한 +
      // 공용 술어 isIndicatorEligibleBook(구조 + 개장 09:00 하한)을 요구해 장중 VI
      // 붕괴책과 개장 동시호가를 대표선정에서 배제한다(parity 계약 유지). 배제 버킷은
      // 아래 else의 0-센티넬로 방출. depth 래칫은 이 게이트 안쪽이라 개장전 자동 드롭.
      const deltaEligible = s.t_ms <= deltaThreshold && isIndicatorEligibleBook(s) && !!s.asks && !!s.bids;
      // 증감 체인 차단 — bucketDepthDelta 의 `prev = null; continue;` 와 **같은 조건**을
      // 한 곳에 모은다. 배제 구간(동시호가·VI·개장전)이나 book 없는 totals-only 틱을
      // 가로지르는 diff 는 관측되지 않은 구간의 변화를 한 버킷에 몰아넣기 때문이다.
      if (!deltaEligible) this.prevDeltaBook = null;
      if (s.t_ms <= threshold && isIndicatorEligibleBook(s)) {
        const prev = this.quoteByBucket.get(t);
        const bid_max = Math.max(prev?.bid_max ?? 0, s.total_bid_qty);
        const ask_max = Math.max(prev?.ask_max ?? 0, s.total_ask_qty);
        let imb_max_bid = prev?.imb_max_bid ?? 0;
        let imb_max_ask = prev?.imb_max_ask ?? 0;
        const curMag = Math.abs(quoteImbalance(s.total_bid_qty, s.total_ask_qty));
        const prevMag = prev ? Math.abs(quoteImbalance(imb_max_bid, imb_max_ask)) : -1;
        if (curMag > prevMag) {
          imb_max_bid = s.total_bid_qty;
          imb_max_ask = s.total_ask_qty;
        }
        if (!prev) this.quoteOrder.push(t);
        this.quoteByBucket.set(t, {
          t,
          ask_total: s.total_ask_qty,
          bid_total: s.total_bid_qty,
          bid_max,
          ask_max,
          imb_max_bid,
          imb_max_ask,
        });
        this.seenPre.add(t);
        // Depth ratchet — mirrors bucketDepthHeatmap. Only continuous ticks that
        // carry the 10-level book contribute; totals-only ticks (asks/bids absent)
        // update quote totals but never fabricate a depth book. CLOSE = latest
        // tick; MAX = the tick whose total bid+ask qty peaked (strict `>` keeps the
        // earliest at a tie, same single-snapshot argmax as imb_max).
        if (s.asks && s.bids) {
          const curTotal = s.total_bid_qty + s.total_ask_qty;
          const prevD = this.depthByBucket.get(t);
          if (!prevD) this.depthOrder.push(t);
          // CLOSE = 최신 틱(활성 버킷은 매 틱 새 point 로 정당히 교체). MAX = 총잔량
          // 피크 틱 — strict `>` 로 동률 시 앞선 것 유지(imb_max 와 동일 argmax).
          const keepMax = prevD !== undefined && curTotal <= prevD.maxTotal;
          this.depthByBucket.set(t, {
            maxTotal: keepMax ? prevD.maxTotal : curTotal,
            point: {
              tMs: t,
              asks: s.asks,
              bids: s.bids,
              asksMax: keepMax ? prevD.point.asksMax : s.asks,
              bidsMax: keepMax ? prevD.point.bidsMax : s.bids,
            },
          });
          // 증감 폴드 — bucketDepthDelta 를 미러한다. 직전 eligible book 과의 가격
          // 교집합 diff 를 이 틱의 버킷에 누적한다.
          this.foldDelta(t, s);
        }
      } else if (!this.seenPre.has(t) && !this.quoteByBucket.has(t)) {
        this.quoteOrder.push(t);
        this.quoteByBucket.set(t, {
          t,
          ask_total: 0,
          bid_total: 0,
          bid_max: 0,
          ask_max: 0,
          imb_max_bid: 0,
          imb_max_ask: 0,
        });
      }
      this.maxProcessedObT = this.maxProcessedObT === null ? s.t_ms : Math.max(this.maxProcessedObT, s.t_ms);
    }
    return true;
  }

  /** 직전 eligible book 대비 증감을 버킷 `t` 에 누적하고 baseline 을 `s` 로 옮긴다.
   *  호출 전에 `s.asks`/`s.bids` 존재와 eligibility 가 보장돼야 한다(호출부 게이트). */
  private foldDelta(t: number, s: ObSnapshot) {
    const prev = this.prevDeltaBook;
    this.prevDeltaBook = s;
    // baseline 이 없거나(체인 시작) 거래소가 바뀌었으면 이 틱은 기준만 세우고 끝.
    if (!prev?.asks || !prev.bids || !sameDeltaChain(prev, s)) return;
    let entry = this.deltaByBucket.get(t);
    if (!entry) {
      entry = {
        ask: new Map(),
        bid: new Map(),
        askTick: Number.POSITIVE_INFINITY,
        bidTick: Number.POSITIVE_INFINITY,
        point: null,
      };
      this.deltaByBucket.set(t, entry);
      this.deltaOrder.push(t);
    }
    // 두 fold 는 **둘 다** 실행해야 한다 — `||` 로 단축평가하면 매도만 변한 틱에서
    // 매수 누적이 통째로 유실된다.
    const askFolded = foldLevelDiff(prev.asks, s.asks!, entry.ask);
    const bidFolded = foldLevelDiff(prev.bids, s.bids!, entry.bid);
    const prevAskTick = entry.askTick;
    const prevBidTick = entry.bidTick;
    const at = ladderTick(s.asks!);
    if (Number.isFinite(at)) entry.askTick = at;
    const bt = ladderTick(s.bids!);
    if (Number.isFinite(bt)) entry.bidTick = bt;
    // 내용이 안 바뀌었으면 point 를 재생성하지 않는다 — 참조 안정 불변식.
    // (틱이 바뀌면 셀 높이가 달라지므로 그때도 재생성해야 오라클과 일치한다.)
    const tickChanged = entry.askTick !== prevAskTick || entry.bidTick !== prevBidTick;
    if (!askFolded && !bidFolded && !tickChanged) return;
    entry.point = makeDeltaPoint(t, entry.ask, entry.bid, entry.askTick, entry.bidTick);
  }

  private appendTrade(trades: readonly TradeSnapshot[]) {
    for (const s of trades) {
      const t = bucketStartMs(s.t_ms, this.bucketMs);
      let bucket = this.fillByBucket.get(t);
      if (!bucket) {
        bucket = { t, buy_qty: 0, sell_qty: 0 };
        this.fillByBucket.set(t, bucket);
        this.fillOrder.push(t);
      }
      for (const ev of s.trades) {
        if (ev.side === 1) bucket.buy_qty += ev.qty;
        else if (ev.side === -1) bucket.sell_qty += ev.qty;
      }
      this.maxProcessedTradeT = this.maxProcessedTradeT === null ? s.t_ms : Math.max(this.maxProcessedTradeT, s.t_ms);
    }
  }

  private snapshot() {
    return {
      quoteRatioPoints: this.quoteOrder.map((t) => ({ ...this.quoteByBucket.get(t)! })),
      fillStrengthPoints: this.fillOrder.map((t) => ({ ...this.fillByBucket.get(t)! })),
      // 갱신 안 된 버킷은 저장된 point 를 그대로 반환 → 참조 안정(틱당 재할당 = 변경 버킷뿐).
      depthHeatmapToday: this.depthOrder.map((t) => this.depthByBucket.get(t)!.point),
      // point===null = 폴드는 했지만 증감이 전부 0 인 버킷 → 오라클과 같이 방출 제외.
      depthDeltaToday: this.deltaOrder
        .map((t) => this.deltaByBucket.get(t)!.point)
        .filter((p): p is DepthDeltaPoint => p !== null),
    };
  }
}

export function createIncrementalHogaSeriesBuilder(): (input: BuildHogaSeriesInput) => HogaSeries {
  const bucketer = new IncrementalHogaBucketer();
  let pastBundleRef: RangeBundle | null | undefined;
  let pastSessionCloseMs = 0;
  let cachedPastQR: QuoteRatioPoint[] = [];
  let cachedPastFS: FillStrengthPoint[] = [];
  let cachedPastMaxQrT = 0;
  let cachedPastMaxFsT = 0;

  return (input: BuildHogaSeriesInput): HogaSeries => {
    const { todaySession, pastBundle, sseOb, sseTrade, bucketMs } = input;
    if (pastBundleRef !== pastBundle || pastSessionCloseMs !== todaySession.close_ms) {
      pastBundleRef = pastBundle;
      pastSessionCloseMs = todaySession.close_ms;
      const past = preparePastHogaSeries(pastBundle, todaySession.close_ms);
      cachedPastQR = past.validPastQR;
      cachedPastFS = past.validPastFS;
      cachedPastMaxQrT = past.pastMaxQrT;
      cachedPastMaxFsT = past.pastMaxFsT;
    }

    const sseBuckets = bucketer.update(sseOb, sseTrade, bucketMs, todaySession.close_ms);
    const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > cachedPastMaxQrT);
    const incrementalFS = sseBuckets.fillStrengthPoints.filter((p) => p.t > cachedPastMaxFsT);

    return {
      quote_ratio: { bucket_ms: bucketMs, points: [...cachedPastQR, ...incrementalQR] },
      fill_strength: { bucket_ms: bucketMs, points: [...cachedPastFS, ...incrementalFS] },
      depth_heatmap_today: sseBuckets.depthHeatmapToday,
      // depth 와 같이 pastMax 필터를 걸지 않는다 — 증감은 과거일 소스가 없어(오늘 전용)
      // 겹칠 상대가 아예 없다.
      depth_delta_today: sseBuckets.depthDeltaToday,
    };
  };
}

/** Candle/segment side of the bundle — independent of SSE ob/trade. `quote_ratio`
 * /`fill_strength` are stubbed empty here; the caller overlays the live
 * `buildHogaSeries` output (see buildLiveBundle). */
export interface BuildChartBundleInput {
  code: string;
  todayDate: string;
  todaySession: { open_ms: number; close_ms: number };
  pastBundle: RangeBundle | null;
  kisCandles: Candle[];
  bucketMs: number;
  /** True if today has ANY SSE orderbook signal. Passed as a boolean (not the
   * ob array) so this builder's memo stays stable across ob/trade pushes —
   * the value only flips false→true once on the first push. Subsumes the old
   * `incrementalQR.length > 0` check (incrementalQR derives from sseOb, so
   * `sseOb.length > 0` already covers it). */
  hasTodayObSignal: boolean;
  /** Merged by useLiveBundle; candle-path data (investor pane). */
  investorPoints?: InvestorNetPoint[];
  sessionBoundsForDate?: (yyyymmdd: string) => { open_ms: number; close_ms: number };
  /** Dates whose candle rows came from a fallback source instead of the primary
   * KIS candle endpoint. Used only to keep the source chip honest. */
  candleSourceByDate?: ReadonlyMap<string, SourceName>;
}

export function buildChartBundle(input: BuildChartBundleInput): RangeBundle {
  const {
    code,
    todayDate,
    todaySession,
    pastBundle,
    kisCandles,
    bucketMs,
    hasTodayObSignal,
    investorPoints = [],
    sessionBoundsForDate,
    candleSourceByDate,
  } = input;

  // Segment derivation follows the DISPLAYED CANDLE SOURCE, not hoga (10호가)
  // capture coverage. One segment per distinct KST trading date present in the
  // active candle set (`kisCandles`), so a day's Day-Boundary divider (and the
  // VirtualAxis window that lets its candles render at all) appears exactly when
  // that day's candles do — independent of whether/when hoga snapshots were
  // captured. A day whose hoga capture backfills late (e.g. Orion 20260707,
  // backfilled the next morning) no longer lags its divider behind its candles.
  //
  // This is the "표시 소스 = 캔들 데이터 기준" policy: in KIS mode the KIS candle
  // history is complete so every in-range trading day gets a divider; in
  // 우회(hogaplay) mode only captured days have candles and thus dividers, which
  // is the intended "저장된 날짜만 표시, 없는 날짜는 비움" behavior. Hoga coverage
  // still feeds the overlays (호가비·매도벽 etc.) independently via the
  // pastBundle fields returned below — those render only where hoga data exists,
  // gated by the segment the candle already established.
  //
  // Historical note: segments used to come from `pastBundle.segments` (hoga)
  // unioned with a `kisOnlyDates` backfill (ADR-0040, /investigate 2026-05-28).
  // Since hoga-captured dates are a subset of candle dates in practice, the
  // union collapsed to "candle dates" anyway; deriving straight from candles
  // makes the invariant explicit ("divider ⟺ candle for that day") and drops
  // the empty-hoga-only-divider edge.
  const boundsForDate = (d: string): { open_ms: number; close_ms: number } =>
    sessionBoundsForDate?.(d) ?? {
      open_ms: regularSessionOpenMs(d),
      close_ms: regularSessionCloseMs(d),
    };

  const candleDates = new Set<string>();
  for (const c of kisCandles) candleDates.add(realMsToYyyymmdd(c.ts_ms));

  const pastSegments: RangeSegment[] = Array.from(candleDates)
    .filter((d) => d !== todayDate)
    .sort()
    .map((d) => {
      const bounds = boundsForDate(d);
      return {
        date: d,
        session_open_ms: bounds.open_ms,
        session_close_ms: bounds.close_ms,
        source: candleSourceByDate?.get(d) ?? 'kis_live',
      };
    });

  // Today segment — present if today has ANY live signal: a today candle, an
  // orderbook push, or a hoga QR point. Kept even with no past candles so the
  // live WS view always shows today, per policy ("오늘 실시간(WS)은 계속 표시").
  const pastQRPoints = pastBundle?.quote_ratio.points ?? [];
  const todaySegments: RangeSegment[] = [];
  const hasTodaySignal =
    candleDates.has(todayDate) ||
    hasTodayObSignal ||
    pastQRPoints.some((p) => realMsToYyyymmdd(p.t) === todayDate);
  if (hasTodaySignal) {
    todaySegments.push({
      date: todayDate,
      session_open_ms: todaySession.open_ms,
      session_close_ms: todaySession.close_ms,
      source: candleSourceByDate?.get(todayDate) ?? 'kis_live',
    });
  }

  const pastFromDate = pastBundle?.from_date ?? pastSegments[0]?.date ?? todayDate;
  // pastSegments are already date-ascending; todaySegments is the single today
  // entry which is strictly the latest.
  const segments = [...pastSegments, ...todaySegments];

  return {
    code,
    from_date: pastFromDate,
    to_date: todayDate,
    bucket_ms: bucketMs,
    segments,
    candles: kisCandles,
    // Hoga series stubbed empty — buildLiveBundle / useLiveBundle overlays the
    // live buildHogaSeries output. Candle/volume/investor projectors never read
    // these, so the empty stub is invisible to the candle path.
    quote_ratio: { bucket_ms: bucketMs, points: [] },
    fill_strength: { bucket_ms: bucketMs, points: [] },
    program_trade: filterProgramTradeForCandles(pastBundle?.program_trade, kisCandles),
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    volume_distributions: pastBundle?.volume_distributions ?? [],
    investorPoints,
    // 거래일별 매도 최대벽은 /api/range(pastBundle)에서 거래일당 1개씩 온다 — 그대로 통과시킨다.
    // (hoga 시리즈와 달리 candle-path 데이터라 라이브 오버레이가 덮어쓰지 않는다. 오늘 항목은
    // useDayAskPeaks가 live.ob ratchet으로 추가; segments엔 todaySegment가 있어 매핑된다.)
    ask_peaks: pastBundle?.ask_peaks ?? [],
    bid_peaks: pastBundle?.bid_peaks ?? [],
    broker_late_entries: pastBundle?.broker_late_entries ?? [],
    price_level_hits: pastBundle?.price_level_hits ?? [],
    trade_volume_pocs: pastBundle?.trade_volume_pocs ?? [],
    depth_heatmap: pastBundle?.depth_heatmap ?? [],
    depth_delta: pastBundle?.depth_delta ?? [],
  };
}

/** Compose the chart side (candles + segments) with the live hoga series into a
 * single RangeBundle. Retained as the one-shot builder for tests and any caller
 * that wants the full bundle in one call; useLiveBundle instead memoises the two
 * halves separately so an SSE tick only rebuilds the hoga half. */
export function buildLiveBundle(input: BuildLiveBundleInput): RangeBundle {
  const { code, todayDate, todaySession, pastBundle, sseOb, sseTrade, kisCandles, candleSourceByDate, bucketMs } = input;
  const hoga = buildHogaSeries({ todaySession, pastBundle, sseOb, sseTrade, bucketMs });
  const chart = buildChartBundle({
    code,
    todayDate,
    todaySession,
    pastBundle,
    kisCandles,
    candleSourceByDate,
    bucketMs,
    hasTodayObSignal: sseOb.length > 0,
  });
  return { ...chart, quote_ratio: hoga.quote_ratio, fill_strength: hoga.fill_strength };
}
