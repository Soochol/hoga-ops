import { useEffect, useReducer } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import { isMinuteTimeframe, type LiveMAConfig, type LiveTimeframe } from '../state/livePage';
import { displayIndicatorSettings, instanceSettings } from '../state/indicatorInstances';
import { useThemePrefsStore } from '../state/themePrefs';
import { resolveMaColor } from '../util/maColor';
import { priceDirClass } from '../ui/priceDir';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';
import { isNonDomesticStockCode } from './liveInstrument';
import { formatInstrumentPrice } from './instrumentPriceFormat';
import { readSeriesValueAtTime } from './legendRows';
import { useWindowIndicators, useWindowScopeId } from './workspace/windowView';
import { useMaSeriesRegistry } from './indicators/maSeriesRegistry';
import { useDailyMaSeriesRegistry } from './indicators/dailyMaSeriesRegistry';
import { scopeEntries } from './indicators/windowScopedRegistry';

type Props = {
  chart: IChartApi;
  timeSec: number;
  close: number;
  code: string;
  timeframe: LiveTimeframe;
};
type Group = {
  scope: string | null;
  daily: boolean;
  configs: readonly LiveMAConfig[];
};

function MovingAverageRows({ chart, timeSec, close, code, scope, daily, configs }: Omit<Props, 'timeframe'> & Group) {
  const ma = useMaSeriesRegistry(s => scopeEntries(s.byScope, scope));
  const dailyMa = useDailyMaSeriesRegistry(s => scopeEntries(s.byScope, scope));
  const series = daily ? dailyMa : ma;
  const theme = useThemePrefsStore(s => s.themePreference);
  const [, refresh] = useReducer(n => n + 1, 0);

  // Mounted only while the tooltip is open. Read back the plotted values after
  // setData/update, including daily data arriving under a stationary pointer.
  useEffect(() => {
    for (const line of series.values()) line.subscribeDataChanged(refresh);
    refresh();
    return () => {
      for (const line of series.values()) safeUnsubscribe(() => line.unsubscribeDataChanged(refresh));
    };
  }, [series]);

  const logicalIndex = chart.timeScale().timeToIndex?.(timeSec as Time) ?? null;
  return configs.map(cfg => {
    const raw = readSeriesValueAtTime(series.get(cfg.id), timeSec, logicalIndex);
    const price = raw !== null && Number.isFinite(raw) && raw > 0 ? raw : null;
    const gap = price !== null && Number.isFinite(close) ? (close / price - 1) * 100 : null;
    const rounded = gap !== null ? Number(gap.toFixed(2)) : null;
    const pct = rounded === null ? '—' : `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`;
    return <div key={cfg.id} data-testid="candle-ma-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ color: 'var(--fg-dim)' }}>
        <span aria-hidden="true" style={{ color: resolveMaColor(cfg, theme) }}>●</span>
        {` ${daily ? '일봉 MA' : 'MA'} ${cfg.period}`}
      </span>
      <span style={{ color: 'var(--fg)' }}>
        {price === null ? '—' : formatInstrumentPrice(price, code)}
        {price !== null && <> <span className={rounded !== null ? priceDirClass(rounded) : undefined}>({pct})</span></>}
      </span>
    </div>;
  });
}

/** Share the overlays' window/instance scopes and exact candle time. Never
 * substitute a latest/previous MA for a missing point or recompute its source. */
export default function CandleMovingAverageDetails(props: Props) {
  const base = useWindowIndicators();
  const scope = useWindowScopeId();
  const displayed = displayIndicatorSettings(base);
  const dailyApplicable = isMinuteTimeframe(props.timeframe) && !!props.code && !isNonDomesticStockCode(props.code);
  const groups: Group[] = [];
  const add = (scope: Group['scope'], daily: boolean, configs: readonly LiveMAConfig[]) => {
    const visible = configs.filter(cfg => cfg.enabled && !cfg.hidden);
    if (visible.length && (!daily || dailyApplicable)) groups.push({ scope, daily, configs: visible });
  };
  add(scope, false, displayed.movingAverages);
  add(scope, true, displayed.dailyMovingAverages);
  for (const instance of base.indicatorInstances ?? []) {
    if (instance.hidden || !['moving-average', 'daily-moving-average'].includes(instance.category)) continue;
    const settings = instanceSettings(base, instance);
    const daily = instance.category === 'daily-moving-average';
    add(`${scope ?? 'ambient'}:indicator:${instance.id}`, daily, daily ? settings.dailyMovingAverages : settings.movingAverages);
  }
  if (!groups.length) return null;
  return <div data-testid="candle-ma-details" style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, color: 'var(--fg-dim)' }}>
      <span>이동평균</span><span>가격 (이격도)</span>
    </div>
    {groups.map(group => <MovingAverageRows key={`${group.scope}:${group.daily}`} {...props} {...group} />)}
  </div>;
}
