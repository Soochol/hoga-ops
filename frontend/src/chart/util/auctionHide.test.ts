import { describe, it, expect, vi } from 'vitest';
import {
  isAuctionHidden,
  isExcludedQuoteBucket,
  TRANSPARENT,
  LINE_HIDDEN_COLOR,
  BASELINE_HIDDEN_COLORS,
} from './auctionHide';

type AxisLike = { inClosingAuctionWindow: (t: number) => boolean };

describe('isAuctionHidden', () => {
  it('returns false when mask is off, and does not call the axis predicate', () => {
    const spy = vi.fn(() => true);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionHidden(axis, false, 1_700_000_000_000)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns false when mask is on but axis predicate is false', () => {
    const axis: AxisLike = { inClosingAuctionWindow: () => false };
    expect(isAuctionHidden(axis, true, 1_700_000_000_000)).toBe(false);
  });

  it('returns true when mask is on and axis predicate is true', () => {
    const axis: AxisLike = { inClosingAuctionWindow: () => true };
    expect(isAuctionHidden(axis, true, 1_700_000_000_000)).toBe(true);
  });
});

describe('isExcludedQuoteBucket (ADR-0062 v2 — 구조 마스크)', () => {
  it('마스크 ON + (0,0) 센티넬 → true (장중 VI/마감 동시호가 배제 버킷)', () => {
    expect(isExcludedQuoteBucket(true, 0, 0)).toBe(true);
  });

  it('마스크 ON이라도 한쪽만 0(정상 일방 호가)이면 false', () => {
    expect(isExcludedQuoteBucket(true, 0, 100)).toBe(false);
    expect(isExcludedQuoteBucket(true, 100, 0)).toBe(false);
    expect(isExcludedQuoteBucket(true, 50, 60)).toBe(false);
  });

  it('마스크 OFF면 (0,0)이라도 false (토글 OFF는 (0,0) 그대로 노출)', () => {
    expect(isExcludedQuoteBucket(false, 0, 0)).toBe(false);
  });
});

describe('hidden-color sentinels', () => {
  it('TRANSPARENT is the canonical rgba zero-alpha string', () => {
    expect(TRANSPARENT).toBe('rgba(0,0,0,0)');
  });

  it('LINE_HIDDEN_COLOR carries the line-series color field', () => {
    expect(LINE_HIDDEN_COLOR).toEqual({ color: TRANSPARENT });
  });

  it('BASELINE_HIDDEN_COLORS covers both line + fill, top + bottom (6 fields)', () => {
    // BaselineSeries renders line AND gradient fill; missing any of the six
    // leaves the auction-window plateau visible as that variant. This test
    // pins the full set so a future refactor can't accidentally drop one.
    expect(BASELINE_HIDDEN_COLORS).toEqual({
      topLineColor: TRANSPARENT,
      topFillColor1: TRANSPARENT,
      topFillColor2: TRANSPARENT,
      bottomLineColor: TRANSPARENT,
      bottomFillColor1: TRANSPARENT,
      bottomFillColor2: TRANSPARENT,
    });
  });
});
