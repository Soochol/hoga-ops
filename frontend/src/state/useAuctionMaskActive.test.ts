import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTabsStore } from './tabs';
import { useAuctionMaskActive } from './useAuctionMaskActive';
import type { VirtualAxis } from '../util/virtualAxis';

describe('useAuctionMaskActive', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('returns false when auctionWindowMask toggle is off (axis predicate not called)', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', false);
    useTabsStore.getState().setCursor(id, 1_700_000_000_000);

    const axisMock = { inClosingAuctionWindow: vi.fn(() => true) } as unknown as VirtualAxis;

    const { result } = renderHook(() => useAuctionMaskActive(axisMock));

    expect(result.current).toBe(false);
    expect(axisMock.inClosingAuctionWindow).not.toHaveBeenCalled();
  });

  it('returns false when auctionWindowMask is true but cursorMs is null', () => {
    const id = useTabsStore.getState().tabs[0].id;
    // auctionWindowMask defaults to true, but be explicit
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', true);
    // Do NOT call setCursor — cursorMs stays null

    const axisMock = { inClosingAuctionWindow: vi.fn(() => true) } as unknown as VirtualAxis;

    const { result } = renderHook(() => useAuctionMaskActive(axisMock));

    expect(result.current).toBe(false);
  });

  it('returns false when auctionWindowMask is true, cursor is valid, but axis predicate returns false', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', true);
    const cursorMs = 1_716_350_400_000; // some valid timestamp
    useTabsStore.getState().setCursor(id, cursorMs);

    const axisMock = { inClosingAuctionWindow: vi.fn(() => false) } as unknown as VirtualAxis;

    const { result } = renderHook(() => useAuctionMaskActive(axisMock));

    expect(result.current).toBe(false);
    expect(axisMock.inClosingAuctionWindow).toHaveBeenCalledWith(cursorMs);
  });

  it('returns true when auctionWindowMask is true, cursor is valid, and axis predicate returns true', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', true);
    const cursorMs = 1_716_350_400_000; // some valid timestamp
    useTabsStore.getState().setCursor(id, cursorMs);

    const axisMock = { inClosingAuctionWindow: vi.fn(() => true) } as unknown as VirtualAxis;

    const { result } = renderHook(() => useAuctionMaskActive(axisMock));

    expect(result.current).toBe(true);
  });
});
