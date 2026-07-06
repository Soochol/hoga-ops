// frontend/src/live/useLiveCursorStore.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { useLiveCursorStore } from './useLiveCursorStore';

describe('useLiveCursorStore', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
  });

  it('starts with cursorMs null', () => {
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
    expect(useLiveCursorStore.getState().lastCursorMs).toBeNull();
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  });

  it('setCursor stores the value', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000000);
    expect(useLiveCursorStore.getState().lastCursorMs).toBe(1748400000000);
  });

  it('clearCursor resets to null', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    useLiveCursorStore.getState().clearCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
    expect(useLiveCursorStore.getState().lastCursorMs).toBe(1748400000000);
  });

  it('restoreCursor rehydrates cursorMs from lastCursorMs', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    useLiveCursorStore.getState().clearCursor();
    useLiveCursorStore.getState().restoreCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000000);
    expect(useLiveCursorStore.getState().lastCursorMs).toBe(1748400000000);
  });

  it('resetCursor clears cursorMs and lastCursorMs', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    useLiveCursorStore.getState().setSidebarCursor(1748400000000);
    useLiveCursorStore.getState().resetCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
    expect(useLiveCursorStore.getState().lastCursorMs).toBeNull();
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  });

  it('setCursor with same value is a no-op for subscribers', () => {
    // Implementation should not trigger needless rerenders.
    useLiveCursorStore.getState().setCursor(123);
    let calls = 0;
    const unsub = useLiveCursorStore.subscribe(() => { calls += 1; });
    useLiveCursorStore.getState().setCursor(123);
    unsub();
    expect(calls).toBe(0);
  });

  it('setSidebarCursor stores a sidebar-specific value without changing cursorMs', () => {
    useLiveCursorStore.getState().setCursor(1748400000123);
    useLiveCursorStore.getState().setSidebarCursor(1748400000000);

    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000123);
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(1748400000000);
  });

  it('setSidebarCursor with same value is a no-op for subscribers', () => {
    useLiveCursorStore.getState().setSidebarCursor(123);
    let calls = 0;
    const unsub = useLiveCursorStore.subscribe((state) => {
      if (state.sidebarCursorMs === 123) calls += 1;
    });
    useLiveCursorStore.getState().setSidebarCursor(123);
    unsub();
    expect(calls).toBe(0);
  });

  it('clearSidebarCursor clears only sidebarCursorMs', () => {
    useLiveCursorStore.getState().setCursor(1748400000123);
    useLiveCursorStore.getState().setSidebarCursor(1748400000000);
    useLiveCursorStore.getState().clearSidebarCursor();

    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000123);
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  });
});
