import { createStore } from 'zustand/vanilla';
import { DEFAULT_PREFS, INDICATOR_MODAL_PREF_KEYS, type ChartViewPrefs, type IndicatorModalPrefKey } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS, INDICATOR_SETTING_KEYS, type IndicatorSettings } from '../../state/indicatorSettingsV2';
import { bindIndicatorOps } from '../../state/indicatorOps';
import { INDICATOR_LINE_KEYS } from '../../state/indicatorLineVisibility';
import type { SettingsSnapshot } from '../settings/useSettingsUndo';
import type { CategoryId } from './IndicatorPanelHelpers';
import type { PanePrefKey } from './indicatorPaneProfiles';

export const PANE_CATEGORY_TO_KEY: Partial<Record<CategoryId, PanePrefKey>> = {
  volume: 'volumeEnabled', 'trade-value': 'tradeValueEnabled', 'quote-totals': 'quoteTotalsEnabled',
  ratio: 'ratioEnabled', 'fill-strength': 'fillStrengthEnabled', 'program-trade': 'programTradeEnabled',
  'program-daily': 'dailyProgramEnabled', 'foreign-net': 'foreignNetEnabled', 'institution-net': 'institutionNetEnabled',
};

export function indicatorIsPresent(id: CategoryId, settings: IndicatorSettings): boolean {
  const paneKey = PANE_CATEGORY_TO_KEY[id];
  if (paneKey) return settings[paneKey] === true;
  switch (id) {
    case 'moving-average': return settings.movingAverages.some(m => m.enabled);
    case 'daily-moving-average': return settings.dailyMovingAverages.some(m => m.enabled);
    case 'supertrend': return settings.supertrendEnabled;
    case 'bollinger': return settings.bollingerEnabled;
    case 'envelope': return settings.envelopeEnabled;
    case 'peak-walls': return settings.askPeakEnabled || settings.bidPeakEnabled;
    case 'trade-volume-poc': return settings.tradeVolumePocEnabled;
    case 'volume-distribution': return settings.volumeDistributionEnabled;
    case 'depth-heatmap': return settings.depthHeatmapEnabled;
    case 'broker-late-entry': return settings.brokerLateEntries.some(e => e.enabled);
    default: return false;
  }
}

/** One ephemeral store per category, owned by the open dialog, never persisted. */
export function createCatalogDraft(id: CategoryId, base: IndicatorSettings, basePrefs: ChartViewPrefs) {
  const store = createStore(() => ({ settings: base, prefs: basePrefs }));
  const patch = (changes: Partial<IndicatorSettings>) => store.setState(s => ({ settings: { ...s.settings, ...changes } }));
  const actions = bindIndicatorOps(() => store.getState().settings, patch);
  const paneKey = PANE_CATEGORY_TO_KEY[id];
  if (paneKey) patch({ [paneKey]: true });
  else switch (id) {
    case 'moving-average':
      if (!base.movingAverages.length) patch({ movingAverages: FACTORY_INDICATOR_SETTINGS.movingAverages });
      actions.setAllMovingAveragesEnabled(true); break;
    case 'daily-moving-average':
      if (!base.dailyMovingAverages.length) patch({ dailyMovingAverages: FACTORY_INDICATOR_SETTINGS.dailyMovingAverages });
      actions.setAllDailyMovingAveragesEnabled(true); break;
    case 'supertrend': actions.setSupertrendEnabled(true); break;
    case 'bollinger': actions.setBollingerEnabled(true); break;
    case 'envelope': actions.setEnvelopeEnabled(true); break;
    case 'peak-walls': actions.setAskPeakEnabled(true); actions.setBidPeakEnabled(true); break;
    case 'trade-volume-poc': actions.setTradeVolumePocEnabled(true); break;
    case 'volume-distribution': actions.setVolumeDistributionEnabled(true); break;
    case 'depth-heatmap': actions.setDepthHeatmapEnabled(true); break;
    case 'broker-late-entry':
      if (!base.brokerLateEntries.length) patch({ brokerLateEntries: FACTORY_INDICATOR_SETTINGS.brokerLateEntries });
      actions.setAllBrokerLateEntriesEnabled(true); break;
  }
  const setPref = (key: IndicatorModalPrefKey, value: boolean | number) => {
    if (!INDICATOR_MODAL_PREF_KEYS.includes(key)) return;
    store.setState(s => ({ prefs: { ...s.prefs, [key]: value } }));
  };
  const resetPrefs = () => store.setState(s => ({ prefs: { ...s.prefs,
    ...Object.fromEntries(INDICATOR_MODAL_PREF_KEYS.map(key => [key, DEFAULT_PREFS[key]])),
  } }));
  return { base, basePrefs, store, actions, setPref, resetPrefs };
}
export type CatalogDraft = ReturnType<typeof createCatalogDraft>;


const same = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
/** Apply only this draft's edits, preserving unrelated changes made while it was open. */
export function catalogDraftPatch(draft: CatalogDraft, current: SettingsSnapshot): SettingsSnapshot {
  const { settings, prefs } = draft.store.getState();
  const patch: SettingsSnapshot = {};
  for (const key of INDICATOR_SETTING_KEYS) {
    if (same(draft.base[key], settings[key])) continue;
    if (key === 'indicatorLineVisibility') {
      const visibility = { ...(current[`indicator:${key}`] as IndicatorSettings['indicatorLineVisibility']) };
      for (const line of INDICATOR_LINE_KEYS) {
        if (draft.base.indicatorLineVisibility[line] === settings.indicatorLineVisibility[line]) continue;
        if (settings.indicatorLineVisibility[line] === false) visibility[line] = false;
        else delete visibility[line];
      }
      patch[`indicator:${key}`] = visibility;
    } else patch[`indicator:${key}`] = settings[key];
  }
  for (const key of INDICATOR_MODAL_PREF_KEYS) if (!same(draft.basePrefs[key], prefs[key])) patch[`pref:${key}`] = prefs[key];
  return patch;
}
