import type { AskPeakPoint, RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { isAfterRegularOpen, tradingDayOf } from '../util/tradingDay';
import { isContinuousBook, type ObSnapshot } from './bucketHogaSeries';
import { regularSessionCloseMs, regularSessionOpenMs } from './liveDateTime';
import { resolveViewportRightEdge, type VisibleTimeRange } from './viewportRightEdge';

export type ViewportAskPeak = {
  t_ms: number;
  price: number;
  qty: number;
};

function bestAskLevel(ob: ObSnapshot): { price: number; qty: number } | null {
  if (!ob.asks) return null;
  let best: { price: number; qty: number } | null = null;
  for (const level of ob.asks) {
    if (level.qty <= 0) continue;
    if (best === null || level.qty > best.qty) {
      best = { price: level.price, qty: level.qty };
    }
  }
  return best;
}

export function buildLiveAskPeakPoints(
  obs: readonly ObSnapshot[],
  bucketMs: number,
  seed: AskPeakPoint | null = null,
  sessionCloseMs: number = Number.POSITIVE_INFINITY,
): AskPeakPoint[] {
  if (bucketMs <= 0) return [];
  const sorted = [...obs].sort((a, b) => a.t_ms - b.t_ms);
  const out: AskPeakPoint[] = [];
  let currentBucket: number | null = null;
  let bucketRepresentative: ObSnapshot | null = null;
  let runningBest: { price: number; qty: number } | null = seed
    ? { price: seed.price, qty: seed.qty }
    : null;

  const emit = (bucket: number, representative: ObSnapshot | null): void => {
    const candidate = representative ? bestAskLevel(representative) : null;
    if (candidate !== null && (runningBest === null || candidate.qty > runningBest.qty)) {
      runningBest = candidate;
    }
    if (runningBest === null) return;
    out.push({ t: bucket, price: runningBest.price, qty: runningBest.qty });
  };

  for (const ob of sorted) {
    if (ob.t_ms > sessionCloseMs || !isContinuousBook(ob) || !isAfterRegularOpen(ob.t_ms)) continue;
    const bucket = Math.floor(ob.t_ms / bucketMs) * bucketMs;
    if (currentBucket === null) {
      currentBucket = bucket;
    } else if (bucket !== currentBucket) {
      emit(currentBucket, bucketRepresentative);
      currentBucket = bucket;
      bucketRepresentative = null;
    }
    bucketRepresentative = ob;
  }

  if (currentBucket !== null) emit(currentBucket, bucketRepresentative);
  return out;
}

export function mergeAskPeakSeries(
  prefixPoints: readonly AskPeakPoint[],
  livePoints: readonly AskPeakPoint[],
): AskPeakPoint[] {
  const byTime = new Map<number, AskPeakPoint>();
  for (const p of prefixPoints) byTime.set(p.t, p);
  for (const p of livePoints) {
    const prev = byTime.get(p.t);
    if (!prev || p.qty > prev.qty) byTime.set(p.t, p);
  }
  const sorted = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
  const out: AskPeakPoint[] = [];
  let runningBest: AskPeakPoint | null = null;
  let runningDay: number | null = null;
  for (const p of sorted) {
    const day = tradingDayOf(p.t);
    if (runningDay === null || day !== runningDay) {
      runningDay = day;
      runningBest = null;
    }
    if (runningBest === null || p.qty > runningBest.qty) runningBest = p;
    out.push({ t: p.t, price: runningBest.price, qty: runningBest.qty });
  }
  return out;
}

export type ViewportAskPeakSeriesInput = {
  prefixPoints: readonly AskPeakPoint[];
  liveOrderbooks: readonly ObSnapshot[];
  bucketMs: number;
  todayKst: string;
  sessionCloseMs?: number;
};

export function buildViewportAskPeakSeries({
  prefixPoints,
  liveOrderbooks,
  bucketMs,
  todayKst,
  sessionCloseMs = regularSessionCloseMs(todayKst),
}: ViewportAskPeakSeriesInput): AskPeakPoint[] {
  const firstLiveMs = liveOrderbooks.reduce<number | null>(
    (min, ob) => (min === null || ob.t_ms < min ? ob.t_ms : min),
    null,
  );
  let seed: AskPeakPoint | null = null;
  if (firstLiveMs != null) {
    const openMs = regularSessionOpenMs(todayKst);
    const closeMs = regularSessionCloseMs(todayKst);
    for (const p of prefixPoints) {
      if (p.t >= openMs && p.t <= closeMs && p.t <= firstLiveMs) seed = p;
    }
  }
  return mergeAskPeakSeries(
    prefixPoints,
    buildLiveAskPeakPoints(liveOrderbooks, bucketMs, seed, sessionCloseMs),
  );
}

export function computeViewportAskPeak(
  points: readonly AskPeakPoint[],
  visibleRange: VisibleTimeRange | null,
  axis: VirtualAxis,
  segments: readonly RangeSegment[],
): ViewportAskPeak | null {
  if (!visibleRange || points.length === 0 || segments.length === 0) return null;
  const rightEdge = resolveViewportRightEdge(visibleRange, axis, segments);
  if (!rightEdge) return null;
  const { cutoffMs, segment } = rightEdge;

  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = points[mid].t;
    if (t <= cutoffMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  for (let i = ans; i >= 0; i -= 1) {
    const p = points[i];
    if (p.t < segment.session_open_ms) break;
    return { t_ms: p.t, price: p.price, qty: p.qty };
  }
  return null;
}
