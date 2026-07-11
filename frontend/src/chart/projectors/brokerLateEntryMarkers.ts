import type { Time, UTCTimestamp } from 'lightweight-charts';

import type { BrokerLateEntryEvent, QuoteRatioPoint, RangeBundle } from '../../api/types';
import type { BrokerLateEntrySideMode } from '../../state/liveIndicatorsPersistence';
import { brokerDisplayShort } from '../../sidebar/brokerDisplayNames';
import { quoteImbalance } from '../../util/imbalance';
import type { VirtualAxis } from '../../util/virtualAxis';
import { isAuctionHidden } from '../util/auctionHide';
import { isSyntheticHogaGapPoint } from '../util/hogaGapHide';
import { quoteRatioPointsForBundle, quoteRatioPointsForSlice } from './quoteRatioPoints';
import type { RatioPaneContext } from './ratio';

export type BrokerLateEntryMarkerPoint = {
  time: Time;
  anchorTime: Time;
  price: number;
  broker: string;
  label: string;
  side: 'buy' | 'sell';
  color: string;
};

type BrokerLateEntryRatioInputs = Pick<
  RatioPaneContext,
  'auctionWindowMask' | 'outlierFilterEnabled' | 'outlierThreshold' | 'intraMax'
>;

export type BrokerLateEntryProjectionContext = BrokerLateEntryRatioInputs & {
  sideMode: BrokerLateEntrySideMode;
  buyColor: string;
  sellColor: string;
};

export type BrokerLateEntryMarkerContext = BrokerLateEntryProjectionContext;

export type BrokerLateEntryLabelGroup = {
  markers: readonly BrokerLateEntryMarkerPoint[];
  label: string;
  side: 'buy' | 'sell' | 'mixed';
  color: string;
};

export const MIXED_BROKER_LATE_ENTRY_LABEL_COLOR = 'var(--fg-dim)';

function sideAllowed(side: 'buy' | 'sell', mode: BrokerLateEntrySideMode): boolean {
  return mode === 'both' || mode === side;
}

function lowerBoundT(points: readonly QuoteRatioPoint[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function displayedRatioValue(point: QuoteRatioPoint, ctx: BrokerLateEntryRatioInputs): number {
  const raw = ctx.intraMax
    ? quoteImbalance(point.imb_max_bid, point.imb_max_ask)
    : quoteImbalance(point.bid_total, point.ask_total);
  return ctx.outlierFilterEnabled && 1 + Math.abs(raw) >= ctx.outlierThreshold ? 0 : raw;
}

function isVisibleRatioPoint(
  point: QuoteRatioPoint,
  axis: VirtualAxis,
  ctx: BrokerLateEntryRatioInputs,
): boolean {
  return axis.contains(point.t)
    && !isSyntheticHogaGapPoint(point)
    && !isAuctionHidden(axis, ctx.auctionWindowMask, point.t);
}

// Hidden/whitespace buckets should not inherit labels from an earlier point.
// We only fall back when the exact bucket is absent from the ratio series.
function findMarkerAnchorPoint(
  points: readonly QuoteRatioPoint[],
  event: BrokerLateEntryEvent,
  axis: VirtualAxis,
  ctx: BrokerLateEntryRatioInputs,
): QuoteRatioPoint | null {
  if (!axis.contains(event.t_ms)) return null;
  if (isAuctionHidden(axis, ctx.auctionWindowMask, event.t_ms)) return null;

  const eventSession = axis.findByReal(event.t_ms);
  if (eventSession < 0) return null;

  const exactIdx = lowerBoundT(points, event.t_ms);
  const exact = points[exactIdx];
  if (exact?.t === event.t_ms) {
    return isVisibleRatioPoint(exact, axis, ctx) ? exact : null;
  }

  for (let i = exactIdx - 1; i >= 0; i -= 1) {
    const point = points[i];
    const pointSession = axis.findByReal(point.t);
    if (pointSession < eventSession) break;
    if (pointSession !== eventSession) continue;
    if (!isVisibleRatioPoint(point, axis, ctx)) continue;
    return point;
  }
  return null;
}

/** 이벤트 목록을 주어진 ratio points(앵커 소스)에 대해 마커로 투영하는 코어. 캐시
 *  경로(과거/당일 슬라이스)와 풀 경로가 공유하는 유일 구현 — 여기가 갈라지면 동등성이
 *  깨지므로 반드시 한 곳만 둔다. */
function projectMarkersFromRatioPoints(
  events: readonly BrokerLateEntryEvent[],
  ratioPoints: readonly QuoteRatioPoint[],
  axis: VirtualAxis,
  ctx: BrokerLateEntryProjectionContext,
): BrokerLateEntryMarkerPoint[] {
  const markers: BrokerLateEntryMarkerPoint[] = [];
  for (const event of events) {
    if (!sideAllowed(event.side, ctx.sideMode)) continue;
    const anchor = findMarkerAnchorPoint(ratioPoints, event, axis, ctx);
    if (!anchor) continue;
    markers.push({
      time: (axis.toVirtual(event.t_ms) / 1000) as UTCTimestamp,
      anchorTime: (axis.toVirtual(anchor.t) / 1000) as UTCTimestamp,
      price: displayedRatioValue(anchor, ctx),
      broker: event.broker,
      label: brokerDisplayShort(event.broker),
      side: event.side,
      color: event.side === 'buy' ? ctx.buyColor : ctx.sellColor,
    });
  }
  return markers;
}

export function projectBrokerLateEntryMarkers(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: BrokerLateEntryProjectionContext,
): BrokerLateEntryMarkerPoint[] {
  return projectMarkersFromRatioPoints(
    bundle.broker_late_entries,
    quoteRatioPointsForBundle(bundle),
    axis,
    ctx,
  );
}

/** projectBrokerLateEntryMarkers 의 과거/당일 분리 캐시판(makePastCachedProjector 관용구).
 *
 *  labelMarkers 는 SSE 틱(150ms)마다 실행되고, 매번 quoteRatioPointsForBundle 이 전체
 *  ratio points 에 withHogaGapSentinels(정렬 2회 + Set, O(n log n))를 재지불했다.
 *  broker_late_entries·과거 ratio points·axis·ctx 는 장중 불변(당일 세그먼트만 매 틱
 *  변함)이므로, 과거 이벤트의 마커를 캐시하고 당일 이벤트만 재투영하면 틱당 비용이
 *  히스토리 깊이와 무관해진다.
 *
 *  정확성 불변식: cached(past) ++ project(today) 는 풀 투영과 바이트 동일해야 한다.
 *  - 과거 이벤트(t_ms < todayOpen)의 앵커는 반드시 todayOpen 이전(같은 세션)에 있으므로
 *    과거 slice ratio points 만으로 찾아도 풀 배열과 같은 앵커를 얻는다.
 *  - slice 의 sentinel 은 quoteRatioPointsForSlice(allPoints 로 firstHogaT/lastHogaT 전달)
 *    로 풀 배열의 과거 구간과 동일하게 생성된다(과거 candle 버킷 t < todayOpen 은 당일
 *    ratio 점과 겹치지 않아 hogaTimes 판정도 동일).
 *  - broker_late_entries 는 과거→당일 오름차순(백엔드 date 순 + range 병합 previous++next)
 *    이라 filter 로 분할해도 원배열 순서가 보존된다(오라클 테스트로 잠금). */
export function makeCachedBrokerLateEntryProjector(): (
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: BrokerLateEntryProjectionContext,
) => BrokerLateEntryMarkerPoint[] {
  const cache = new WeakMap<VirtualAxis, {
    ctx: BrokerLateEntryProjectionContext;
    events: readonly BrokerLateEntryEvent[];
    todayOpen: number;
    pastQuoteLen: number;
    pastQuoteLastT: number;
    pastMarkers: BrokerLateEntryMarkerPoint[];
  }>();
  return (bundle, axis, ctx) => {
    const segs = bundle.segments;
    // 세그먼트가 1개 이하면 "과거"가 없어 분리 이득이 없다 — 풀 투영.
    if (!segs || segs.length < 2) return projectBrokerLateEntryMarkers(bundle, axis, ctx);

    const events = bundle.broker_late_entries;
    const todayOpen = segs[segs.length - 1].session_open_ms;
    const quotePoints = bundle.quote_ratio.points;
    const splitIdx = lowerBoundT(quotePoints, todayOpen);
    const pastQuote = quotePoints.slice(0, splitIdx);
    const todayQuote = quotePoints.slice(splitIdx);
    const pastQuoteLen = pastQuote.length;
    const pastQuoteLastT = pastQuoteLen > 0 ? pastQuote[pastQuoteLen - 1].t : 0;

    let entry = cache.get(axis);
    if (
      !entry
      || entry.ctx !== ctx
      || entry.events !== events
      || entry.todayOpen !== todayOpen
      || entry.pastQuoteLen !== pastQuoteLen
      || entry.pastQuoteLastT !== pastQuoteLastT
    ) {
      const pastEvents = events.filter((e) => e.t_ms < todayOpen);
      const pastRatio = quoteRatioPointsForSlice({
        bundle, points: pastQuote, allPoints: quotePoints, toT: todayOpen,
      });
      entry = {
        ctx, events, todayOpen, pastQuoteLen, pastQuoteLastT,
        pastMarkers: projectMarkersFromRatioPoints(pastEvents, pastRatio, axis, ctx),
      };
      cache.set(axis, entry);
    }
    const todayEvents = events.filter((e) => e.t_ms >= todayOpen);
    const todayRatio = quoteRatioPointsForSlice({
      bundle, points: todayQuote, allPoints: quotePoints, fromT: todayOpen,
    });
    const todayMarkers = projectMarkersFromRatioPoints(todayEvents, todayRatio, axis, ctx);
    return entry.pastMarkers.concat(todayMarkers);
  };
}

type MarkerLayoutBox = {
  index: number;
  marker: BrokerLateEntryMarkerPoint;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function boxesOverlap(
  a: MarkerLayoutBox,
  b: MarkerLayoutBox,
  minHorizontalGapPx: number,
  minVerticalGapPx: number,
): boolean {
  return a.left <= b.right + minHorizontalGapPx
    && b.left <= a.right + minHorizontalGapPx
    && a.top <= b.bottom + minVerticalGapPx
    && b.top <= a.bottom + minVerticalGapPx;
}

function compactGroup(cluster: readonly BrokerLateEntryMarkerPoint[]): BrokerLateEntryLabelGroup {
  let representative = cluster[0];
  for (const marker of cluster.slice(1)) {
    if (marker.label.length < representative.label.length) representative = marker;
  }
  const sides = new Set(cluster.map((marker) => marker.side));
  return {
    markers: cluster,
    label: `${representative.label} +${cluster.length - 1}`,
    side: sides.size === 1 ? representative.side : 'mixed',
    color: sides.size === 1 ? representative.color : MIXED_BROKER_LATE_ENTRY_LABEL_COLOR,
  };
}

export function layoutBrokerLateEntryLabels(
  markers: readonly BrokerLateEntryMarkerPoint[],
  opts: {
    minHorizontalGapPx: number;
    estimateLabelWidthPx: (label: string) => number;
    forceFull?: boolean;
    getX?: (marker: BrokerLateEntryMarkerPoint) => number;
    getY?: (marker: BrokerLateEntryMarkerPoint) => number;
    labelHeightPx?: number;
    minVerticalGapPx?: number;
  },
): { groups: BrokerLateEntryLabelGroup[] } {
  if (opts.forceFull) {
    return {
      groups: markers.map((marker) => ({
        markers: [marker],
        label: marker.label,
        side: marker.side,
        color: marker.color,
      })),
    };
  }

  const getX = opts.getX ?? ((marker: BrokerLateEntryMarkerPoint) => Number(marker.time));
  const getY = opts.getY ?? ((marker: BrokerLateEntryMarkerPoint) => marker.price);
  const labelHeightPx = opts.labelHeightPx ?? 11;
  const minVerticalGapPx = opts.minVerticalGapPx ?? 0;

  const boxes = markers.map<MarkerLayoutBox>((marker, index) => {
    const x = getX(marker);
    const y = getY(marker);
    const width = opts.estimateLabelWidthPx(marker.label);
    return {
      index,
      marker,
      left: x,
      right: x + width,
      top: y - labelHeightPx,
      bottom: y,
    };
  });

  const clusters: MarkerLayoutBox[][] = [];
  for (const box of boxes) {
    const overlaps = clusters.filter((cluster) =>
      cluster.some((other) =>
        boxesOverlap(other, box, opts.minHorizontalGapPx, minVerticalGapPx)));

    if (overlaps.length === 0) {
      clusters.push([box]);
      continue;
    }

    const merged = overlaps.flat();
    merged.push(box);
    merged.sort((a, b) => a.index - b.index);
    for (let i = clusters.length - 1; i >= 0; i -= 1) {
      if (overlaps.includes(clusters[i])) clusters.splice(i, 1);
    }
    clusters.push(merged);
  }

  return {
    groups: clusters
      .slice()
      .sort((a, b) => a[0].index - b[0].index)
      .flatMap((cluster) => {
      const clusterMarkers = cluster.map((box) => box.marker);
      if (clusterMarkers.length === 1) {
        const marker = clusterMarkers[0];
        return [{
          markers: [marker],
          label: marker.label,
          side: marker.side,
          color: marker.color,
        }];
      }
      return [compactGroup(clusterMarkers)];
      }),
  };
}
