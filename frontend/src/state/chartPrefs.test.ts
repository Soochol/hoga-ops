import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActivePrefs } from './chartPrefs';
import { useTabsStore } from './tabs';

describe('useActivePrefs — scaffold', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('returns the default for the active tab when no override exists', () => {
    const { result } = renderHook(() => useActivePrefs((p) => p.volumeProfileMode));
    expect(result.current).toBe('range');
  });

  it('reflects setVolumeProfileMode on the active tab', () => {
    const { result } = renderHook(() => useActivePrefs((p) => p.volumeProfileMode));
    expect(result.current).toBe('range');
    act(() => {
      const id = useTabsStore.getState().activeTabId;
      useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    });
    expect(result.current).toBe('per-day');
  });
});

describe('useActivePrefs — fine-grained subscription', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('does not re-render when an unselected slice changes', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useActivePrefs((p) => p.volumeProfileMode);
    });
    expect(renders).toBe(1);
    expect(result.current).toBe('range');

    // Mutate a DIFFERENT slice (auctionWindowMask) — should not re-render
    // this hook because the selected value (volumeProfileMode) didn't change.
    act(() => {
      const id = useTabsStore.getState().activeTabId;
      useTabsStore.getState().setToggle(id, 'auctionWindowMask', false);
    });
    expect(renders).toBe(1);
    expect(result.current).toBe('range');

    // Mutate the selected slice — should re-render.
    act(() => {
      const id = useTabsStore.getState().activeTabId;
      useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    });
    expect(renders).toBe(2);
    expect(result.current).toBe('per-day');
  });
});
