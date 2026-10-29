import { DEFAULT_PREFS, INDICATOR_MODAL_PREF_KEYS } from '../../state/chartPrefs';
import { DEFAULT_CHART_DISPLAY_PREFS, VOLUME_OVERLAY_PREF_KEYS } from '../../state/chartDisplayPrefs';
import { FACTORY_INDICATOR_SETTINGS, INDICATOR_SETTING_KEYS, type IndicatorSettings } from '../../state/indicatorSettingsV2';
import { captureIndicatorPrefs, captureIndicatorSettings, instanceSettings, PRIMARY_INDICATOR_ID } from '../../state/indicatorInstances';
import type { SettingsSnapshot } from '../settings/useSettingsUndo';
import { createCatalogDraft } from './indicatorCatalogDraft';
import type { CategoryId } from './IndicatorPanelHelpers';

/** Restore one category's active factory configuration without changing membership or group visibility. */
export function indicatorResetPatch(category: CategoryId, id: string, snapshot: SettingsSnapshot): SettingsSnapshot {
  const base = { ...FACTORY_INDICATOR_SETTINGS, ...Object.fromEntries(INDICATOR_SETTING_KEYS
    .filter(key => `indicator:${key}` in snapshot).map(key => [key, snapshot[`indicator:${key}`]])) } as IndicatorSettings;
  const instance = base.indicatorInstances?.find(row => row.id === id && row.category === category);
  if (id !== PRIMARY_INDICATOR_ID && !instance) return {};
  const current = instance ? instanceSettings(base, instance) : base;
  // Catalog activation already handles the different presence contracts: flags,
  // pane toggles, MA arrays and broker sets. Never reset an existing item to OFF.
  const activeFactory = createCatalogDraft(category, FACTORY_INDICATOR_SETTINGS, DEFAULT_PREFS).store.getState().settings;
  const settings = captureIndicatorSettings(category, activeFactory);
  for (const key of Object.keys(settings) as (keyof IndicatorSettings)[]) {
    if (key.endsWith('Hidden')) (settings as Record<string, unknown>)[key] = current[key];
  }
  const prefs = captureIndicatorPrefs(category, DEFAULT_PREFS);
  if (instance) return { 'indicator:indicatorInstances': base.indicatorInstances!.map(row => row.id === id
    ? { ...row, settings, prefs } : row) };

  if (settings.indicatorLineVisibility !== undefined) {
    const visibility = { ...base.indicatorLineVisibility };
    const owned = captureIndicatorSettings(category, base).indicatorLineVisibility ?? {};
    for (const key of Object.keys(owned) as (keyof typeof visibility)[]) delete visibility[key];
    settings.indicatorLineVisibility = { ...visibility, ...settings.indicatorLineVisibility };
  }
  const patch: SettingsSnapshot = Object.fromEntries(Object.entries(settings).map(([key, value]) => [`indicator:${key}`, value]));
  for (const key of INDICATOR_MODAL_PREF_KEYS) if (key in prefs) patch[`pref:${key}`] = prefs[key];
  if (category === 'volume') {
    for (const key of VOLUME_OVERLAY_PREF_KEYS) {
      if (`display:${key}` in snapshot) patch[`display:${key}`] = DEFAULT_CHART_DISPLAY_PREFS[key];
    }
  }
  return patch;
}
