import type { LiveTimeframe } from '../../state/livePage';
import type { PersistedIndicators } from '../../state/liveIndicatorsPersistence';
import type { PaneToggles } from '../paneSpecsForTimeframe';

export type IndicatorPaneProfileKey = 'minute' | 'D' | 'W' | 'M';

export type IndicatorPanePrefs = {
  volumeEnabled: boolean;
  quoteTotalsEnabled: boolean;
  ratioEnabled: boolean;
  fillStrengthEnabled: boolean;
  programTradeEnabled: boolean;
  foreignNetEnabled: boolean;
  institutionNetEnabled: boolean;
};

export type PanePrefKey = keyof IndicatorPanePrefs;

export type IndicatorPanePrefsByTimeframe =
  Record<IndicatorPaneProfileKey, IndicatorPanePrefs>;

export type PersistedPanePrefsByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorPanePrefs>>>;

export const INDICATOR_PANE_PROFILE_KEYS: readonly IndicatorPaneProfileKey[] =
  ['minute', 'D', 'W', 'M'] as const;

export const INDICATOR_PANE_PREF_KEYS: readonly PanePrefKey[] = [
  'volumeEnabled',
  'quoteTotalsEnabled',
  'ratioEnabled',
  'fillStrengthEnabled',
  'programTradeEnabled',
  'foreignNetEnabled',
  'institutionNetEnabled',
] as const;

const PROFILE_KEY_SET = new Set<string>(INDICATOR_PANE_PROFILE_KEYS);
const PANE_PREF_KEY_SET = new Set<string>(INDICATOR_PANE_PREF_KEYS);

function isProfileKey(value: string): value is IndicatorPaneProfileKey {
  return PROFILE_KEY_SET.has(value);
}

function isPanePrefKey(value: string): value is PanePrefKey {
  return PANE_PREF_KEY_SET.has(value);
}

export function profileKeyForTimeframe(tf: LiveTimeframe): IndicatorPaneProfileKey {
  return tf === 'D' || tf === 'W' || tf === 'M' ? tf : 'minute';
}

export function normalizePanePrefsByTimeframe(raw: unknown): PersistedPanePrefsByTimeframe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const normalized: PersistedPanePrefsByTimeframe = {};
  for (const [profileKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProfileKey(profileKey)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const profile: Partial<IndicatorPanePrefs> = {};
    for (const [paneKey, paneValue] of Object.entries(value as Record<string, unknown>)) {
      if (!isPanePrefKey(paneKey)) continue;
      if (typeof paneValue !== 'boolean') continue;
      profile[paneKey] = paneValue;
    }
    if (Object.keys(profile).length > 0) normalized[profileKey] = profile;
  }
  return normalized;
}

export function legacyPanePrefsFromIndicators(indicators: PersistedIndicators): IndicatorPanePrefs {
  return {
    volumeEnabled: indicators.volumeEnabled,
    quoteTotalsEnabled: indicators.quoteTotalsEnabled,
    ratioEnabled: indicators.ratioEnabled,
    fillStrengthEnabled: indicators.fillStrengthEnabled,
    programTradeEnabled: indicators.programTradeEnabled,
    foreignNetEnabled: indicators.foreignNetEnabled,
    institutionNetEnabled: indicators.institutionNetEnabled,
  };
}

function panePrefsByTimeframeFromIndicators(indicators: PersistedIndicators): PersistedPanePrefsByTimeframe {
  return normalizePanePrefsByTimeframe(
    (indicators as { panePrefsByTimeframe?: unknown }).panePrefsByTimeframe,
  );
}

export function panePrefsForTimeframe(
  indicators: PersistedIndicators,
  timeframe: LiveTimeframe,
): IndicatorPanePrefs {
  const legacy = legacyPanePrefsFromIndicators(indicators);
  const profileKey = profileKeyForTimeframe(timeframe);
  const byTimeframe = panePrefsByTimeframeFromIndicators(indicators);
  return {
    ...legacy,
    ...(byTimeframe[profileKey] ?? {}),
  };
}

export function resolvePaneTogglesForTimeframe(input: {
  indicators: PersistedIndicators;
  timeframe: LiveTimeframe;
  forceHogaPanes?: boolean;
  hogaPanes?: boolean;
  override?: Partial<PaneToggles>;
}): PaneToggles {
  const prefs = panePrefsForTimeframe(input.indicators, input.timeframe);
  return {
    foreignNet: prefs.foreignNetEnabled,
    institutionNet: prefs.institutionNetEnabled,
    volumeEnabled: prefs.volumeEnabled,
    quoteTotalsEnabled: prefs.quoteTotalsEnabled,
    ratioEnabled: prefs.ratioEnabled,
    fillStrengthEnabled: prefs.fillStrengthEnabled,
    programTradeEnabled: prefs.programTradeEnabled,
    hogaPanes: input.hogaPanes,
    forceHogaPanes: input.forceHogaPanes,
    ...input.override,
  };
}
