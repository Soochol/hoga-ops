import {
  DEFAULT_PREFS, INDICATOR_MODAL_PREF_KEYS, isIndicatorModalPrefKey, prefsForScope,
  useChartPrefsStore, type ChartViewPrefs, type ChartToggleKey, type NumericPrefKey,
} from '../../state/chartPrefs';
import { useThemePrefsStore, type ThemePreference } from '../../state/themePrefs';
import { useLiveVenueStore, type LiveVenueOption } from '../../state/liveVenue';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import { INDICATOR_SETTING_KEYS, bucketsForScope, resolveIndicatorSettings, type IndicatorScope, type IndicatorSettings } from '../../state/indicatorSettingsV2';
import type { SettingsSnapshot } from './useSettingsUndo';
import { normalizeChartDisplayPrefs, VOLUME_OVERLAY_PREF_KEYS, type ChartDisplayPrefs } from '../../state/chartDisplayPrefs';
import { useWindowSettingsStore } from '../../state/windowSettings';

const GLOBAL_KEYS = (Object.keys(DEFAULT_PREFS) as (keyof ChartViewPrefs)[]).filter(key => !isIndicatorModalPrefKey(key));
export function readAppSettings(): SettingsSnapshot {
  const chart = useChartPrefsStore.getState();
  return { ...Object.fromEntries(GLOBAL_KEYS.map(key => [key, chart[key]])),
    theme: useThemePrefsStore.getState().themePreference, venue: useLiveVenueStore.getState().venue };
}
export function restoreAppSettings(patch: SettingsSnapshot) {
  const { theme, venue, ...chart } = patch;
  if (Object.keys(chart).length) useChartPrefsStore.setState(chart as Partial<ChartViewPrefs>);
  if (theme !== undefined) useThemePrefsStore.getState().setThemePreference(theme as ThemePreference);
  if (venue !== undefined) useLiveVenueStore.getState().setVenue(venue as LiveVenueOption);
}
export function subscribeAppSettings(changed: () => void) {
  const stops = [useChartPrefsStore.subscribe(changed), useThemePrefsStore.subscribe(changed), useLiveVenueStore.subscribe(changed)];
  return () => stops.forEach(stop => stop());
}
export function readIndicatorEditor(scope: IndicatorScope, timeframe: LiveTimeframe, ambient: boolean, windowId?: string | null): SettingsSnapshot {
  const page = useLivePageStore.getState(), chart = useChartPrefsStore.getState();
  const settings = ambient ? page : resolveIndicatorSettings(bucketsForScope(page.indicatorsByTimeframe, page.indicatorsByWindow, scope), timeframe);
  const prefs = ambient ? chart : prefsForScope(chart, scope, timeframe);
  const display = windowId ? normalizeChartDisplayPrefs(useWindowSettingsStore.getState().byWindow[windowId]?.chart ?? chart) : null;
  return { ...Object.fromEntries(INDICATOR_SETTING_KEYS.map(key => [`indicator:${key}`, settings[key]])),
    ...(display ? Object.fromEntries(VOLUME_OVERLAY_PREF_KEYS.map(key => [`display:${key}`, display[key]])) : {}),
    ...Object.fromEntries(INDICATOR_MODAL_PREF_KEYS.map(key => [`pref:${key}`, prefs[key]])) };
}
export function restoreIndicatorEditor(scope: IndicatorScope, timeframe: LiveTimeframe, patch: SettingsSnapshot, windowId?: string | null) {
  const indicators: Partial<IndicatorSettings> = {};
  const display: Partial<ChartDisplayPrefs> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('indicator:')) (indicators as Record<string, unknown>)[key.slice(10)] = value;
    else if (key.startsWith('pref:')) useChartPrefsStore.getState().setPrefScoped(scope, timeframe, key.slice(5) as ChartToggleKey | NumericPrefKey, value as boolean | number);
    else if (VOLUME_OVERLAY_PREF_KEYS.some(pref => key === `display:${pref}`)) (display as Record<string, unknown>)[key.slice(8)] = value;
  }
  if (Object.keys(indicators).length) useLivePageStore.getState().patchIndicatorsScoped(scope, timeframe, indicators);
  if (windowId && Object.keys(display).length) useWindowSettingsStore.getState().patch(windowId, 'chart', display);
}
export function subscribeIndicatorEditor(changed: () => void) {
  const stops = [useLivePageStore.subscribe(changed), useChartPrefsStore.subscribe(changed), useWindowSettingsStore.subscribe(changed)];
  return () => stops.forEach(stop => stop());
}
