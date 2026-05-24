import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActivePrefs, CHART_TOGGLES, categoryOf } from './chartPrefs';
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

describe('CHART_TOGGLES — category metadata', () => {
  it('fillStrengthCumulative entry resolves to category="indicators"', () => {
    const entry = CHART_TOGGLES.find((t) => t.key === 'fillStrengthCumulative');
    expect(entry).toBeDefined();
    expect(categoryOf(entry!)).toBe('indicators');
  });

  it('pre-existing toggles default to category="chart" (category field absent)', () => {
    const auction = CHART_TOGGLES.find((t) => t.key === 'auctionWindowMask');
    expect(auction).toBeDefined();
    expect(categoryOf(auction!)).toBe('chart');
    // Verify the field is genuinely absent at runtime (not silently undefined
    // because of some shape drift) — the helper's default branch is what
    // produces the 'chart' result above.
    expect('category' in auction!).toBe(false);
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
