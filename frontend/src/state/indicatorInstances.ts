import type { IndicatorSettings } from './indicatorSettingsV2';
import type { ChartViewPrefs } from './chartPrefs';
import type { CategoryId } from '../live/indicators/IndicatorPanelHelpers';

/** The original flat configuration remains the first instance (and preserves saved drawings). */
export const PRIMARY_INDICATOR_ID = 'main';
export const MAX_INDICATOR_INSTANCES = 128;
export const EMPTY_INDICATOR_INSTANCES: readonly IndicatorInstance[] = [];
export interface IndicatorInstance {
  id: string;
  category: CategoryId;
  hidden?: boolean;
  settings: Partial<IndicatorSettings>;
  prefs: Partial<ChartViewPrefs>;
}

const PREFIXES: Record<CategoryId, readonly string[]> = {
  'moving-average': ['movingAverages'], 'daily-moving-average': ['dailyMovingAverages'],
  bollinger: ['bollinger'], supertrend: ['supertrend'], volume: ['volume'],
  'trade-value': ['tradeValue'], 'quote-totals': ['quoteTotals', 'surge'], ratio: ['ratio'],
  'fill-strength': ['fillStrength'], 'program-trade': ['programTrade'],
  'program-daily': ['dailyProgram'], 'foreign-net': ['foreignNet', 'foreignTradeSide'],
  'institution-net': ['institutionNet', 'institutionTradeSide'], 'peak-walls': ['askPeak', 'bidPeak', 'peakWall'],
  'trade-volume-poc': ['tradeVolumePoc'], 'depth-heatmap': ['depthHeatmap'],
  'volume-distribution': ['volumeDistribution'], 'broker-late-entry': ['brokerLateEntries'],
};
const LINE_PREFIX: Partial<Record<CategoryId, string>> = {
  bollinger: 'bollinger', supertrend: 'supertrend', 'quote-totals': 'quoteTotals', 'fill-strength': 'fillStrength',
};
export const INDICATOR_CATEGORIES = Object.keys(PREFIXES) as CategoryId[];
export function ownsIndicatorKey(category: CategoryId, key: string): boolean {
  // volume does not own volumeDistribution, nor does its cumulative option belong to fill strength.
  if (category === 'volume' && key.startsWith('volumeDistribution')) return false;
  return PREFIXES[category].some(prefix => key.startsWith(prefix));
}
export function captureIndicatorSettings(category: CategoryId, settings: IndicatorSettings): Partial<IndicatorSettings> {
  const out = Object.fromEntries(Object.entries(settings).filter(([key]) => ownsIndicatorKey(category, key))) as Partial<IndicatorSettings>;
  const prefix = LINE_PREFIX[category];
  if (prefix) out.indicatorLineVisibility = Object.fromEntries(Object.entries(settings.indicatorLineVisibility).filter(([key]) => key.startsWith(prefix)));
  return out;
}
export function captureIndicatorPrefs(category: CategoryId, prefs: Partial<ChartViewPrefs>): Partial<ChartViewPrefs> {
  return Object.fromEntries(Object.entries(prefs).filter(([key]) => ownsIndicatorKey(category, key)));
}
export function instanceSettings(base: IndicatorSettings, instance: IndicatorInstance): IndicatorSettings {
  return { ...base, ...instance.settings, indicatorInstances: [], indicatorPrimaryHidden: [],
    indicatorLineVisibility: { ...Object.fromEntries(Object.entries(base.indicatorLineVisibility).filter(([key]) => !key.startsWith(LINE_PREFIX[instance.category] ?? '__none__'))), ...instance.settings.indicatorLineVisibility } };
}
export function makeIndicatorInstance(category: CategoryId, settings: IndicatorSettings, prefs: ChartViewPrefs): IndicatorInstance {
  return { id: crypto.randomUUID(), category, settings: captureIndicatorSettings(category, settings), prefs: captureIndicatorPrefs(category, prefs) };
}
export function normalizeIndicatorInstances(raw: unknown, normalize: (raw: unknown) => IndicatorSettings): IndicatorInstance[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.slice(0, MAX_INDICATOR_INSTANCES).flatMap((item: unknown): IndicatorInstance[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as IndicatorInstance;
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || row.id === PRIMARY_INDICATOR_ID || seen.has(row.id)
      || !INDICATOR_CATEGORIES.includes(row.category)) return [];
    seen.add(row.id);
    const settings = normalize({ ...(row.settings && typeof row.settings === 'object' ? row.settings : {}), indicatorInstances: [] });
    // Persist only finite primitives; the category registry prevents sibling/global preference leakage.
    const prefs = Object.fromEntries(Object.entries(row.prefs && typeof row.prefs === 'object' ? row.prefs : {}).filter(([key, value]) =>
      ownsIndicatorKey(row.category, key) && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))));
    return [{ id: row.id, category: row.category, ...(row.hidden === true ? { hidden: true } : {}), settings: captureIndicatorSettings(row.category, settings), prefs }];
  });
}
export function indicatorInstanceSummary(category: CategoryId, settings: IndicatorSettings): string {
  switch (category) {
    case 'bollinger': return `${settings.bollingerPeriod}봉 · ${settings.bollingerMultiplier}배`;
    case 'supertrend': return `ATR ${settings.supertrendPeriod} · ${settings.supertrendMultiplier}배`;
    case 'moving-average': return settings.movingAverages.filter(m => m.enabled).map(m => `${m.period}`).join(' · ') || '이동평균선';
    case 'daily-moving-average': return settings.dailyMovingAverages.filter(m => m.enabled).map(m => `${m.period}일`).join(' · ') || '일봉 이동평균선';
    case 'broker-late-entry': return settings.brokerLateEntries.filter(m => m.enabled).map(m => `${String(m.startHHMM).padStart(4, '0').replace(/(..)(..)/, '$1:$2')}`).join(' · ');
    case 'quote-totals': return [['quoteTotalsBid', '매수'], ['quoteTotalsAsk', '매도']].filter(([key]) => settings.indicatorLineVisibility[key as keyof typeof settings.indicatorLineVisibility] !== false).map(([, label]) => label).join(' · ') || '선 숨김';
    case 'fill-strength': return [['fillStrengthBuy', '매수'], ['fillStrengthSell', '매도']].filter(([key]) => settings.indicatorLineVisibility[key as keyof typeof settings.indicatorLineVisibility] !== false).map(([, label]) => label).join(' · ') || '선 숨김';
    case 'peak-walls': return [settings.askPeakEnabled ? '매도' : '', settings.bidPeakEnabled ? '매수' : ''].filter(Boolean).join(' · ');
    case 'trade-volume-poc': return `투명도 ${Math.round(settings.tradeVolumePocOpacity * 100)}%`;
    case 'depth-heatmap': return `최대 ${Math.round(settings.depthHeatmapMaxOpacity * 100)}%`;
    case 'program-trade': return '누적 순매수';
    case 'volume-distribution': return `${settings.volumeDistributionRangeCount}구간`;
    case 'foreign-net': return { net: '순매수', buy: '총매수', sell: '총매도' }[settings.foreignTradeSide];
    case 'institution-net': return { net: '순매수', buy: '총매수', sell: '총매도' }[settings.institutionTradeSide];
    case 'program-daily': return { net: '순매수', buy: '총매수', sell: '총매도' }[settings.dailyProgramTradeSide];
    default: return '기본 설정';
  }
}

const hiddenCache = new WeakMap<IndicatorSettings, IndicatorSettings>();
/** Visibility is a presentation gate; membership/data demand remain unchanged. */
export function displayIndicatorSettings(settings: IndicatorSettings): IndicatorSettings {
  const hidden = settings.indicatorPrimaryHidden;
  if (!hidden?.length) return settings;
  const cached = hiddenCache.get(settings); if (cached) return cached;
  const out = { ...settings };
  for (const category of hidden) {
    for (const key of Object.keys(out) as (keyof IndicatorSettings)[]) {
      if (key.endsWith('Hidden') && ownsIndicatorKey(category, key)) (out as Record<string, unknown>)[key] = true;
    }
    if (category === 'moving-average') out.movingAverages = out.movingAverages.map(row => ({ ...row, hidden: true }));
    if (category === 'daily-moving-average') out.dailyMovingAverages = out.dailyMovingAverages.map(row => ({ ...row, hidden: true }));
    if (category === 'broker-late-entry') out.brokerLateEntries = out.brokerLateEntries.map(row => ({ ...row, enabled: false }));
  }
  hiddenCache.set(settings, out);
  return out;
}
/** Source demand is the union of active instances, independent of visual hiding. */
const demandCache = new WeakMap<IndicatorSettings, IndicatorSettings>();
export function indicatorDemandSettings(base: IndicatorSettings): IndicatorSettings {
  if (!base.indicatorInstances?.length) return base;
  const cached = demandCache.get(base); if (cached) return cached;
  const out = { ...base };
  for (const instance of base.indicatorInstances) {
    // These instances own parameter-keyed queries in their pane/card; no unused primary query is needed.
    if (['foreign-net', 'institution-net', 'program-daily', 'volume-distribution'].includes(instance.category)) continue;
    for (const [key, value] of Object.entries(instance.settings)) {
      if (key.endsWith('Enabled') && value === true) (out as Record<string, unknown>)[key] = true;
    }
    if (instance.category === 'peak-walls' && instance.settings.peakWallPaneMode === 'bar') out.peakWallPaneMode = 'bar';
    if (instance.category === 'broker-late-entry') out.brokerLateEntries = [...out.brokerLateEntries, ...(instance.settings.brokerLateEntries ?? [])];
  }
  demandCache.set(base, out);
  return out;
}

/** Legacy group-eye fields are still editable from the existing chart legends. */
export function indicatorGroupHidden(category: CategoryId, settings: IndicatorSettings): boolean {
  if (settings.indicatorPrimaryHidden?.includes(category)) return true;
  const fields = Object.keys(settings).filter(key => key.endsWith('Hidden') && ownsIndicatorKey(category, key));
  return fields.length > 0 && fields.every(key => settings[key as keyof IndicatorSettings] === true);
}
export function clearIndicatorGroupHidden(category: CategoryId, settings: Partial<IndicatorSettings>): Partial<IndicatorSettings> {
  const patch = { ...settings };
  for (const key of Object.keys(patch)) if (key.endsWith('Hidden') && ownsIndicatorKey(category, key)) (patch as Record<string, unknown>)[key] = false;
  return patch;
}
