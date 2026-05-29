// frontend/src/live/useLiveCursorStore.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { useLiveCursorStore } from './useLiveCursorStore';

describe('useLiveCursorStore', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().clearCursor();
  });

  it('starts with cursorMs null', () => {
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
  });

  it('setCursor stores the value', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000000);
  });

  it('clearCursor resets to null', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    useLiveCursorStore.getState().clearCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
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
});
