import { beforeEach, describe, expect, it } from 'vitest';

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
