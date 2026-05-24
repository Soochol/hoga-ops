import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useReplayLayoutStore, SIDEBAR_PX_MIN, SIDEBAR_PX_MAX } from './replayLayout';

beforeEach(() => {
  // Reset to fresh defaults between tests. We expose a private __reset for tests only.
  useReplayLayoutStore.getState().__resetForTests();
});

describe('useReplayLayoutStore — defaults and clamp', () => {
  it('starts with a positive sidebarPx and not collapsed', () => {
    const s = useReplayLayoutStore.getState();
    expect(s.sidebarPx).toBeGreaterThanOrEqual(SIDEBAR_PX_MIN);
    expect(s.sidebarPx).toBeLessThanOrEqual(SIDEBAR_PX_MAX);
    expect(s.sidebarCollapsed).toBe(false);
  });

  it('setSidebarPx clamps below MIN', () => {
    useReplayLayoutStore.getState().setSidebarPx(50);
    expect(useReplayLayoutStore.getState().sidebarPx).toBe(SIDEBAR_PX_MIN);
  });

  it('setSidebarPx clamps above MAX', () => {
    useReplayLayoutStore.getState().setSidebarPx(9999);
    expect(useReplayLayoutStore.getState().sidebarPx).toBe(SIDEBAR_PX_MAX);
  });

  it('setSidebarPx accepts in-range values verbatim', () => {
    useReplayLayoutStore.getState().setSidebarPx(380);
    expect(useReplayLayoutStore.getState().sidebarPx).toBe(380);
  });

  it('setSidebarCollapsed toggles', () => {
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(true);
    useReplayLayoutStore.getState().setSidebarCollapsed(false);
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggleSidebar flips the boolean', () => {
    const before = useReplayLayoutStore.getState().sidebarCollapsed;
    useReplayLayoutStore.getState().toggleSidebar();
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(!before);
  });

  it('resetSidebar restores in-range default and uncollapses', () => {
    useReplayLayoutStore.getState().setSidebarPx(480);
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    useReplayLayoutStore.getState().resetSidebar();
    const s = useReplayLayoutStore.getState();
    expect(s.sidebarPx).toBeGreaterThanOrEqual(SIDEBAR_PX_MIN);
    expect(s.sidebarPx).toBeLessThanOrEqual(SIDEBAR_PX_MAX);
    expect(s.sidebarCollapsed).toBe(false);
  });
});

describe('useReplayLayoutStore — localStorage persistence', () => {
  const KEY = 'replay.layout';

  beforeEach(() => {
    localStorage.clear();
    useReplayLayoutStore.getState().__resetForTests();
  });

  it('writes changes to localStorage under "replay.layout"', () => {
    // attachPersistence debounces writes by 250 ms; advance fake timers to flush.
    vi.useFakeTimers();
    try {
      useReplayLayoutStore.getState().setSidebarPx(360);
      useReplayLayoutStore.getState().setSidebarCollapsed(true);
      vi.advanceTimersByTime(250);
      const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      expect(stored).toEqual({ sidebarPx: 360, sidebarCollapsed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rehydrates from localStorage when present', async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarPx: 400, sidebarCollapsed: true }));
    // Reset the module cache so the store re-imports and re-reads localStorage.
    vi.resetModules();
    const { useReplayLayoutStore: freshStore } = await import('./replayLayout');
    const s = freshStore.getState();
    expect(s.sidebarPx).toBe(400);
    expect(s.sidebarCollapsed).toBe(true);
  });

  it('falls back to defaults on corrupt JSON', async () => {
    localStorage.setItem(KEY, '{not json');
    vi.resetModules();
    const { useReplayLayoutStore: freshStore, SIDEBAR_PX_MIN, SIDEBAR_PX_MAX } =
      await import('./replayLayout');
    const s = freshStore.getState();
    expect(s.sidebarPx).toBeGreaterThanOrEqual(SIDEBAR_PX_MIN);
    expect(s.sidebarPx).toBeLessThanOrEqual(SIDEBAR_PX_MAX);
    expect(s.sidebarCollapsed).toBe(false);
  });

  it('falls back to defaults when stored sidebarPx is out of range', async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarPx: 50, sidebarCollapsed: false }));
    vi.resetModules();
    const { useReplayLayoutStore: freshStore, SIDEBAR_PX_MIN } = await import('./replayLayout');
    const s = freshStore.getState();
    expect(s.sidebarPx).toBe(SIDEBAR_PX_MIN); // clamped
  });

  it('falls back to defaults when stored sidebarCollapsed is wrong type', async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarPx: 360, sidebarCollapsed: 'yes' }));
    vi.resetModules();
    const { useReplayLayoutStore: freshStore } = await import('./replayLayout');
    expect(freshStore.getState().sidebarCollapsed).toBe(false);
  });
});
