import type { RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

export type VisibleTimeRange = {
  from: number;
  to: number;
};

export type ViewportRightEdge = {
  rightEdgeMs: number;
  segment: RangeSegment;
  cutoffMs: number;
};

export function realMsFromVisibleRightEdge(
  visibleRange: { from?: unknown; to: unknown } | null,
  axis: VirtualAxis,
): number | null {
  if (!visibleRange) return null;
  const rightEdgeMs = axis.toReal(Number(visibleRange.to) * 1000);
  return Number.isFinite(rightEdgeMs) ? rightEdgeMs : null;
}

function segmentForRightEdge(
  segments: readonly RangeSegment[],
  rightEdgeMs: number,
): RangeSegment | null {
  let lastBefore: RangeSegment | null = null;
  for (const segment of segments) {
    if (rightEdgeMs >= segment.session_open_ms && rightEdgeMs <= segment.session_close_ms) {
      return segment;
    }
    if (rightEdgeMs >= segment.session_open_ms) {
      lastBefore = segment;
    }
  }
  return lastBefore;
}

export function resolveViewportRightEdge(
  visibleRange: VisibleTimeRange | null,
  axis: VirtualAxis,
  segments: readonly RangeSegment[],
): ViewportRightEdge | null {
  if (!visibleRange || segments.length === 0) return null;
  const rightEdgeMs = realMsFromVisibleRightEdge(visibleRange, axis);
  if (rightEdgeMs === null) return null;

  const segment = segmentForRightEdge(segments, rightEdgeMs);
  if (!segment) return null;
  return {
    rightEdgeMs,
    segment,
    cutoffMs: Math.min(rightEdgeMs, segment.session_close_ms),
  };
}
