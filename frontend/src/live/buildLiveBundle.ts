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
    if (s.t_ms > lastContinuousMs) continue;
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
  private depthByBucket = new Map<
    number,
    { close: { asks: OrderbookLevel[]; bids: OrderbookLevel[] }; max: { asks: OrderbookLevel[]; bids: OrderbookLevel[]; total: number } }
  >();
  private depthOrder: number[] = [];

  update(
    ob: readonly ObSnapshot[],
    trade: readonly TradeSnapshot[],
    bucketMs: number,
    sessionCloseMs: number,
  ): {
    quoteRatioPoints: QuoteRatioPoint[];
    fillStrengthPoints: FillStrengthPoint[];
    depthHeatmapToday: DepthHeatmapPoint[];
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
    for (const s of obs) {
      const t = bucketStartMs(s.t_ms, this.bucketMs);
      if (s.t_ms <= threshold) {
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
          const close = { asks: s.asks, bids: s.bids };
          const max =
            !prevD || curTotal > prevD.max.total
              ? { asks: s.asks, bids: s.bids, total: curTotal }
              : prevD.max;
          this.depthByBucket.set(t, { close, max });
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
      depthHeatmapToday: this.depthOrder.map((t) => {
        const d = this.depthByBucket.get(t)!;
        return {
          tMs: t,
          asks: d.close.asks,
          bids: d.close.bids,
          asksMax: d.max.asks,
          bidsMax: d.max.bids,
        };
      }),
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
