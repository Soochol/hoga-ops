import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_PREFS, type ChartViewPrefs } from '../state/tabs';

/**
 * Read-only `ChartViewPrefs` for the chart subtree.
 *
 * Why this exists: `ChartStage` subscribes to the active tab's prefs once
 * via `useTabsStore` and exposes the resolved snapshot to every pane below
 * through this context. Pane code reads prefs uniformly via
 * `useChartPrefs()` — no second subscription, no per-pane `useTabsStore`
 * import, no `mode={volumeProfileMode}` prop drill.
 *
 * Write path stays on the store directly (`useTabsStore(s => s.setToggle)`
 * etc.) — components outside the chart subtree (e.g. SettingsModal mounted
 * in Toolbar) still mutate prefs through the store, not this context.
 *
 * The fallback value is `DEFAULT_PREFS`, so panes rendered standalone in
 * tests don't need to wrap in a provider when they're happy with defaults.
 * Tests exercising non-default prefs render with `<ChartPrefsContext.Provider value={...}>`.
 */
export const ChartPrefsContext = createContext<ChartViewPrefs>(DEFAULT_PREFS);

export function useChartPrefs(): ChartViewPrefs {
  return useContext(ChartPrefsContext);
}

export function ChartPrefsProvider({
  value,
  children,
}: {
  value: ChartViewPrefs;
  children: ReactNode;
}) {
  return <ChartPrefsContext.Provider value={value}>{children}</ChartPrefsContext.Provider>;
}
