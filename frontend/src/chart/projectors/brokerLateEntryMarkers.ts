import type { Time, UTCTimestamp } from 'lightweight-charts';

import type { BrokerLateEntryEvent, QuoteRatioPoint, RangeBundle } from '../../api/types';
import type { BrokerLateEntrySideMode } from '../../state/liveIndicatorsPersistence';
import { brokerDisplayShort } from '../../sidebar/brokerDisplayNames';
import { quoteImbalance } from '../../util/imbalance';
import type { VirtualAxis } from '../../util/virtualAxis';
import { isAuctionHidden } from '../util/auctionHide';
import { isSyntheticHogaGapPoint } from '../util/hogaGapHide';
import { quoteRatioPointsForBundle } from './quoteRatioPoints';
import type { RatioPaneContext } from './ratio';

export type BrokerLateEntryMarkerPoint = {
  time: Time;
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

export function projectBrokerLateEntryMarkers(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: BrokerLateEntryProjectionContext,
): BrokerLateEntryMarkerPoint[] {
  const ratioPoints = quoteRatioPointsForBundle(bundle);
  const markers: BrokerLateEntryMarkerPoint[] = [];

  for (const event of bundle.broker_late_entries) {
    if (!sideAllowed(event.side, ctx.sideMode)) continue;
    const anchor = findMarkerAnchorPoint(ratioPoints, event, axis, ctx);
    if (!anchor) continue;
    markers.push({
      time: (axis.toVirtual(event.t_ms) / 1000) as UTCTimestamp,
      price: displayedRatioValue(anchor, ctx),
      broker: event.broker,
      label: brokerDisplayShort(event.broker),
      side: event.side,
      color: event.side === 'buy' ? ctx.buyColor : ctx.sellColor,
    });
  }

  return markers;
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
