import { describe, expect, it } from 'vitest';
import type { RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { realMsFromVisibleRightEdge, resolveViewportRightEdge } from './viewportRightEdge';

const axis = {
  toReal: (virtualMs: number) => virtualMs,
} as VirtualAxis;

const segment = (date: string, open: number, close: number): RangeSegment => ({
  date,
  session_open_ms: open,
  session_close_ms: close,
  source: 'hogaplay',
});

describe('resolveViewportRightEdge', () => {
  it('converts the visible range right edge from virtual seconds to real ms', () => {
    expect(realMsFromVisibleRightEdge({ from: 0, to: 2.5 }, axis)).toBe(2500);
    expect(realMsFromVisibleRightEdge(null, axis)).toBeNull();
  });

  it('returns real cursor ms and the segment containing the visible right edge', () => {
    expect(resolveViewportRightEdge({ from: 0, to: 2.5 }, axis, [
      segment('20260613', 0, 10_000),
    ])).toEqual({
      rightEdgeMs: 2500,
      segment: segment('20260613', 0, 10_000),
      cutoffMs: 2500,
    });
  });

  it('falls back to the last prior segment after a session close', () => {
    expect(resolveViewportRightEdge({ from: 0, to: 10.5 }, axis, [
      segment('20260612', 0, 5000),
      segment('20260613', 10_000, 20_000),
    ])).toEqual({
      rightEdgeMs: 10_500,
      segment: segment('20260613', 10_000, 20_000),
      cutoffMs: 10_500,
    });

    expect(resolveViewportRightEdge({ from: 0, to: 21 }, axis, [
      segment('20260612', 0, 5000),
      segment('20260613', 10_000, 20_000),
    ])).toEqual({
      rightEdgeMs: 21_000,
      segment: segment('20260613', 10_000, 20_000),
      cutoffMs: 20_000,
    });
  });

  it('returns null for missing visible range, missing segments, or non-finite conversion', () => {
    const badAxis = { toReal: () => Number.NaN } as unknown as VirtualAxis;

    expect(resolveViewportRightEdge(null, axis, [segment('20260613', 0, 10_000)])).toBeNull();
    expect(resolveViewportRightEdge({ from: 0, to: 1 }, axis, [])).toBeNull();
    expect(resolveViewportRightEdge({ from: 0, to: 1 }, badAxis, [
      segment('20260613', 0, 10_000),
    ])).toBeNull();
  });
});
