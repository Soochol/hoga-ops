import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useChartPrefsStore } from './chartPrefs';
import { useAuctionMaskActive } from './useAuctionMaskActive';
import type { VirtualAxis } from '../util/virtualAxis';

describe('useAuctionMaskActive', () => {
  beforeEach(() => {
    // Reset the global toggle to its default (true) before each test so the
    // suite is order-independent.
    useChartPrefsStore.getState().setToggle('auctionWindowMask', true);
  });

  it('returns false when auctionWindowMask toggle is off (axis predicate not called)', () => {
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);

    const axisMock = { inClosingAuctionWindow: vi.fn(() => true) } as unknown as VirtualAxis;
    const cursorMs = 1_716_350_400_000;

    const { result } = renderHook(() => useAuctionMaskActive(axisMock, cursorMs));

    expect(result.current).toBe(false);
    expect(axisMock.inClosingAuctionWindow).not.toHaveBeenCalled();
  });

  it('returns false when toggle is on but cursorMs is null', () => {
    const axisMock = { inClosingAuctionWindow: vi.fn(() => true) } as unknown as VirtualAxis;

    const { result } = renderHook(() => useAuctionMaskActive(axisMock, null));

    expect(result.current).toBe(false);
    expect(axisMock.inClosingAuctionWindow).not.toHaveBeenCalled();
  });

  it('returns false when toggle is on but axis is null', () => {
    const cursorMs = 1_716_350_400_000;

    const { result } = renderHook(() => useAuctionMaskActive(null, cursorMs));

    expect(result.current).toBe(false);
  });

  it('returns false when toggle is on, cursor is valid, but axis predicate returns false', () => {
    const axisMock = { inClosingAuctionWindow: vi.fn(() => false) } as unknown as VirtualAxis;
    const cursorMs = 1_716_350_400_000;

    const { result } = renderHook(() => useAuctionMaskActive(axisMock, cursorMs));

    expect(result.current).toBe(false);
    expect(axisMock.inClosingAuctionWindow).toHaveBeenCalledWith(cursorMs);
  });

  it('returns true when toggle is on, cursor is valid, and axis predicate returns true', () => {
    const axisMock = { inClosingAuctionWindow: vi.fn(() => true) } as unknown as VirtualAxis;
    const cursorMs = 1_716_350_400_000;

    const { result } = renderHook(() => useAuctionMaskActive(axisMock, cursorMs));

    expect(result.current).toBe(true);
  });
});
