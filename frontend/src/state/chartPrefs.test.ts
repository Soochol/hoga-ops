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
