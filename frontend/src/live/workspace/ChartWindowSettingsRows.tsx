import { useId, useState } from 'react';
import { CHART_DISPLAY_LINE_STYLES, CHART_DISPLAY_TOGGLES, type ChartDisplayPrefKey } from '../../state/chartDisplayPrefs';
import { useChartLineStyleActions, useChartPrefActions, useScopedChartPrefs, type ChartLineWidth } from '../../state/chartPrefs';
import { resolvePriceDirectionColor } from '../../chart/priceDirectionTokens';
import { useThemePrefsStore } from '../../state/themePrefs';
import { AppIcon } from '../../ui/AppIcon';
import ToggleRow from '../settings/ToggleRow';
import { WindowSettingsGroup } from './WindowSettingsEditor';

const groups = [
  { label: '가격축', keys: ['candleLogScale', 'candleInvertScale', 'candlePaneCandleOnlyScale'] },
  { label: '차트 표시', keys: ['accountExecutionsEnabled', 'candleAlwaysOnTop', 'depthHeatmapAboveCandles', 'auctionWindowMask', 'candleTooltipEnabled'] },
  { label: '가격 표시', keys: ['highLowLabelsEnabled'] },
  { label: '격자', keys: ['horizontalGridLinesEnabled', 'verticalGridLinesEnabled'] },
] as const satisfies readonly { label: string; keys: readonly ChartDisplayPrefKey[] }[];

type ToggleDefinition = (typeof CHART_DISPLAY_TOGGLES)[number];

function PriceLineRow({ def }: { def: (typeof CHART_DISPLAY_LINE_STYLES)[number] }) {
  const prefs = useScopedChartPrefs();
  const { setToggle } = useChartPrefActions();
  const setStyle = useChartLineStyleActions();
  // Resolving an automatic swatch follows the same theme changes as the chart.
  useThemePrefsStore(state => state.themePreference);
  const enabled = prefs[def.enabledBy];
  const color = prefs[`${def.key}Color`];
  const fallback = resolvePriceDirectionColor(def.direction);
  return <div className="window-settings-line-row">
    <label className="window-settings-line-label" data-tooltip={CHART_DISPLAY_TOGGLES.find(toggle => toggle.key === def.enabledBy)?.description}>
      <input type="checkbox" className="window-settings-checkbox" checked={enabled}
        onChange={event => setToggle(def.enabledBy, event.target.checked)} />
      {def.label}
    </label>
    {enabled && <div className="window-settings-line-controls" role="group" aria-label={`${def.label} 스타일`}>
      <input type="color" className="window-settings-color" aria-label={`${def.label} 색상`} value={color || fallback}
        onChange={event => setStyle(def.key, { color: event.target.value })} />
      <button type="button" className="ui-choice" aria-label={`${def.label} 자동 색상`} aria-pressed={!color}
        data-tooltip="테마 색상 사용" onClick={() => setStyle(def.key, { color: '' })}>자동</button>
      <select className="ui-field font-data" aria-label={`${def.label} 두께`} value={prefs[`${def.key}Width`]}
        onChange={event => setStyle(def.key, { lineWidth: Number(event.target.value) as ChartLineWidth })}>
        {[1, 2, 3, 4].map(width => <option key={width} value={width}>{width}px</option>)}
      </select>
    </div>}
  </div>;
}

function ChartToggle({ def }: { def: ToggleDefinition }) {
  const prefs = useScopedChartPrefs();
  const { setToggle } = useChartPrefActions();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const children = CHART_DISPLAY_TOGGLES.filter(child => 'enabledBy' in child && child.enabledBy === def.key);
  const hasDetail = children.length > 0;
  return <>
    <ToggleRow label={def.label} description={def.description} checked={prefs[def.key]}
      onToggle={() => setToggle(def.key, !prefs[def.key])} testId={`settings-toggle-${def.key}`}
      className={`window-settings-chart-row${hasDetail ? ' window-settings-has-detail' : ''}`}
      actions={hasDetail && <button type="button" className="window-settings-disclosure" aria-label={`${def.label} 세부 설정`}
        aria-expanded={expanded} aria-controls={id} data-tooltip="세부 설정" onClick={() => setExpanded(value => !value)}>
        <AppIcon name="chevronRight" size={12} />
      </button>} />
    {hasDetail && <div id={id} className="window-settings-dependent" hidden={!expanded}>
      {children.map(child => {
        const line = CHART_DISPLAY_LINE_STYLES.find(style => style.enabledBy === child.key);
        return line ? <fieldset key={child.key} disabled={!prefs[def.key]}><legend className="sr-only">{child.label}</legend><PriceLineRow def={line} /></fieldset>
          : <ToggleRow key={child.key} label={child.label} description={child.description} checked={prefs[child.key]}
            onToggle={() => setToggle(child.key, !prefs[child.key])} disabled={!prefs[def.key]}
            testId={`settings-toggle-${child.key}`} />;
      })}
    </div>}
  </>;
}

export function ChartWindowSettingsRows() {
  return groups.map(group => <WindowSettingsGroup key={group.label} title={group.label}>
    {group.keys.map(key => <ChartToggle key={key} def={CHART_DISPLAY_TOGGLES.find(def => def.key === key)!} />)}
  </WindowSettingsGroup>);
}
