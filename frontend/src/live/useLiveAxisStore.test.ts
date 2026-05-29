// frontend/src/live/useLiveAxisStore.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { createVirtualAxis } from '../util/virtualAxis';
import { useLiveAxisStore } from './useLiveAxisStore';

describe('useLiveAxisStore', () => {
  beforeEach(() => {
    useLiveAxisStore.getState().setAxis(null);
  });

  it('starts with axis null', () => {
    expect(useLiveAxisStore.getState().axis).toBeNull();
  });

  it('setAxis stores the axis ref', () => {
    const axis = createVirtualAxis([]);
    useLiveAxisStore.getState().setAxis(axis);
    expect(useLiveAxisStore.getState().axis).toBe(axis);
  });

  it('inClosingAuctionWindow query routes through the stored axis', () => {
    const axis = createVirtualAxis([]);
    useLiveAxisStore.getState().setAxis(axis);
    // Empty segments → false for any t. Just exercise the wiring.
    expect(useLiveAxisStore.getState().axis?.inClosingAuctionWindow(0)).toBe(false);
  });
});
