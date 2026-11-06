import { AppIcon } from '../../ui/AppIcon';
import type { MouseEventParams, Time } from 'lightweight-charts';
import { lineVisible } from '../../state/indicatorLineVisibility';
import { resolveMaColor } from '../../util/maColor';
import { useThemePrefsStore } from '../../state/themePrefs';
import { useLivePageStore } from '../../state/livePage';
import { bucketsForScope, resolveIndicatorSettings } from '../../state/indicatorSettingsV2';
import { indicatorInstanceSummary, instanceSettings, indicatorGroupHidden, clearIndicatorGroupHidden } from '../../state/indicatorInstances';
import { useWindowIndicators, useWindowIndicatorScope, useWindowIndicatorTimeframe, useWindowScopeId } from '../workspace/windowView';
import { CATEGORIES } from './IndicatorPanelHelpers';
import { readFlagLegendValues } from './flagLegendValueRegistry';
import { usePaneLegendRegistry } from './paneLegendRegistry';
import { useMaSeriesRegistry } from './maSeriesRegistry';
import { useDailyMaSeriesRegistry } from './dailyMaSeriesRegistry';
import { scopeEntries } from './windowScopedRegistry';
import { readSeriesValue, readSeriesValueAtTime } from '../legendRows';
import EyeGlyph from '../EyeGlyph';
import type { LegendFlagId } from '../legendRows';

/** Instance controls always target the captured window/timeframe and stable id. */
export function IndicatorInstanceLegend({ id, cursorTimeSec = null, seriesData, latestTimeSec = null, strictVolume = false }: {
  id: string; cursorTimeSec?: number | null; latestTimeSec?: number | null; strictVolume?: boolean; seriesData?: MouseEventParams<Time>['seriesData'];
}) {
  const base = useWindowIndicators();
  const theme = useThemePrefsStore(s => s.themePreference);
  const scope = useWindowIndicatorScope();
  const tf = useWindowIndicatorTimeframe();
  const windowId = useWindowScopeId();
  // This component is also used inside the distribution's instance provider.
  const liveBase = useLivePageStore(s => tf ? resolveIndicatorSettings(bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scope), tf) : s.indicatorInstances);
  const rows = Array.isArray(liveBase) ? liveBase : liveBase?.indicatorInstances;
  const row = rows?.find(item => item.id === id);
  const registryScope = `${windowId?.split(':indicator:')[0] ?? 'ambient'}:indicator:${id}`;
  const ma = useMaSeriesRegistry(s => scopeEntries(s.byScope, registryScope));
  const dailyMa = useDailyMaSeriesRegistry(s => scopeEntries(s.byScope, registryScope));
  const panes = usePaneLegendRegistry(s => scopeEntries(s.byScope, windowId?.split(':indicator:')[0] ?? null));
  if (!row) return null;
  const settings = instanceSettings(base, row);
  const maSlots = row.category === 'moving-average' ? settings.movingAverages
    : row.category === 'daily-moving-average' ? settings.dailyMovingAverages : [];
  const category = CATEGORIES.find(c => c.id === row.category)!;
  const hidden = row.hidden || indicatorGroupHidden(row.category, settings);
  const title = `${category.label} · ${indicatorInstanceSummary(row.category, settings)}`;
  const flagType = ({ 'new-high-bearish': 'new-high-bearish', envelope: 'envelope', bollinger: 'bollinger', supertrend: 'supertrend', 'depth-heatmap': 'depth-heatmap', 'trade-volume-poc': 'trade-volume-poc', 'peak-walls': 'ask-peak' } as Partial<Record<string, LegendFlagId>>)[row.category];
  const cells = row.category === 'broker-late-entry' ? settings.brokerLateEntries.flatMap(slot => readFlagLegendValues(registryScope, 'broker-late-entry', slot.id, cursorTimeSec))
    : row.category === 'peak-walls' ? (['ask-peak', 'bid-peak'] as const).flatMap(type => readFlagLegendValues(registryScope, type, 'main', cursorTimeSec))
    : flagType ? readFlagLegendValues(registryScope, flagType, 'main', cursorTimeSec) : [];
  const paneValues = [...panes.entries()].filter(([name]) => name.startsWith(`indicator:${id}:`)).flatMap(([, entries]) => entries.flatMap(entry => {
    if (row.category === 'investor-net-line') {
      if (!entry.series.options().visible) return [];
      const value = readSeriesValueAtTime(entry.series, cursorTimeSec ?? latestTimeSec);
      return [`${entry.meta.label} ${value === null ? '—' : entry.meta.format?.(value) ?? entry.series.priceFormatter().format(value)}`];
    }
    const value = row.category === 'volume' && strictVolume ? readSeriesValueAtTime(entry.series, cursorTimeSec ?? latestTimeSec) : readSeriesValue(entry.series, seriesData ?? null, cursorTimeSec);
    return value === null ? [] : [`${entry.meta.label} ${entry.meta.format?.(value) ?? entry.series.priceFormatter().format(value)}`];
  }));
  const values = maSlots.length ? maSlots.filter(m => m.enabled && !m.hidden).flatMap(m => {
    const series = (row.category === 'daily-moving-average' ? dailyMa : ma).get(m.id); const value = series ? readSeriesValue(series, seriesData ?? null, cursorTimeSec) : null;
    return value === null ? [] : [`${m.period}: ${series?.priceFormatter().format(value)}`];
  }) : [...cells.map(cell => `${cell.label ?? ''} ${cell.value}`.trim()), ...paneValues];
  const update = (remove: boolean) => {
    const s = useLivePageStore.getState();
    const timeframe = tf ?? s.indicatorTimeframe;
    const cur = tf ? resolveIndicatorSettings(bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, scope), tf) : s;
    const current = cur.indicatorInstances ?? [];
    if (!current.some(item => item.id === id)) return;
    s.patchIndicatorsScoped(scope, timeframe, { indicatorInstances: remove ? current.filter(item => item.id !== id) : current.map(item => item.id === id ? { ...item, hidden: !(item.hidden || indicatorGroupHidden(item.category, instanceSettings(cur, item))), settings: clearIndicatorGroupHidden(item.category, item.settings) } : item) });
    if (remove) s.setIndicatorUndoToast({ label: `${category.label} 삭제됨`, scope, timeframe, patch: {}, removedInstance: { row: current.find(item => item.id === id)!, index: current.findIndex(item => item.id === id) } });
  };
  return <div className="indicator-instance-legend" data-testid={`indicator-instance-legend-${id}`}>
    {!hidden && row.category === 'investor-net-line' && [settings.investorNetLineForeignColor, settings.investorNetLineInstitutionColor].filter((_, i) => lineVisible(settings.indicatorLineVisibility, i === 0 ? 'investorNetLineForeign' : 'investorNetLineInstitution')).map((color, i) => <span key={i} aria-hidden="true" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color }} />)}
    {!hidden && maSlots.filter(m => m.enabled && !m.hidden).map(m => <span key={m.id}
      aria-label={`${m.period} ${row.category === 'daily-moving-average' ? '일봉' : '현재봉'} 이평선 색상`}
      style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: resolveMaColor(m, theme) }} />)}
    <span className={hidden ? 'text-fg-dimmer' : undefined} data-tooltip={title}>{title}</span>
    {!hidden && values.length > 0 && <span className="font-data">{values.join(' · ')}</span>}
    <button type="button" aria-label={`${title} ${hidden ? '표시' : '숨기기'}`} onClick={() => update(false)}><EyeGlyph hidden={hidden === true} /></button>
    <button type="button" aria-label={`${title} 삭제`} onClick={() => update(true)}><AppIcon name="close" /></button>
  </div>;
}
