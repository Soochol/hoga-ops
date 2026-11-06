import { useState } from 'react';
import { useIndicatorActions, useWindowIndicators } from '../workspace/windowView';
import { SettingsRow } from '../settings/SettingsRow';
import LineVisibilityRow, { LineDisplayRow } from './LineVisibilityRow';
import ColorSwatchPicker from './ColorSwatchPicker';
import { IndicatorLineWidthRow, IndicatorRangeRow, IndicatorSettingsGroup } from './IndicatorSettingsLayout';
import { IndicatorExplanation } from './IndicatorExplanation';
import { ICHIMOKU_PRESENTATION } from './ichimokuPresentation';
import { ICHIMOKU_LINES } from '../../chart/projectors/ichimoku';
const PARAMETERS = [
  ['ichimokuConversionPeriod', '전환 기간', 1, 2000], ['ichimokuBasePeriod', '기준 기간', 1, 2000],
  ['ichimokuLeadingBPeriod', '선행 B 기간', 1, 2000], ['ichimokuDisplacement', '이동 봉 수', 0, 500],
] as const;
export default function IchimokuConfig() {
  const settings = useWindowIndicators();
  const { setIchimokuSettings } = useIndicatorActions();
  const [draft, setDraft] = useState<{ key: typeof PARAMETERS[number][0]; base: number; text: string } | null>(null);
  const commit = () => {
    if (draft) {
      const value = Number(draft.text), parameter = PARAMETERS.find(([key]) => key === draft.key)!;
      if (draft.text.trim() && Number.isInteger(value) && value >= parameter[2] && value <= parameter[3]) setIchimokuSettings({ [draft.key]: value });
    }
    setDraft(null);
  };
  return <div className="indicator-settings-groups">
    <IndicatorSettingsGroup label="계산">
      {PARAMETERS.map(([key, label, min, max]) => <label key={key} className="indicator-parameter-row flex items-center justify-between gap-2 text-sm text-fg">
        {label} (봉 개수)
        <input aria-label={`일목 ${label}`} type="number" min={min} max={max} step={1}
          value={draft?.key === key && draft.base === settings[key] ? draft.text : settings[key]}
          onChange={e => setDraft({ key, base: settings[key], text: e.target.value })} onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
          className="w-24 text-right text-sm bg-bg-input border border-border rounded-md px-2 py-1 tabular-nums" />
      </label>)}
    </IndicatorSettingsGroup>
    <IndicatorSettingsGroup label="표시·스타일">
      {ICHIMOKU_LINES.map(line => {
        const { label, color, line: lineKey } = ICHIMOKU_PRESENTATION[line];
        return <LineVisibilityRow key={line} lineKey={lineKey} label={label} toggleLabel={`일목 ${label} 표시`}>
          <ColorSwatchPicker label={`일목 ${label}`} color={settings[color]} onChange={value => setIchimokuSettings({ [color]: value })} />
        </LineVisibilityRow>;
      })}
      <IndicatorLineWidthRow label="일목" value={settings.ichimokuLineWidth} onChange={value => setIchimokuSettings({ ichimokuLineWidth: value })} />
    </IndicatorSettingsGroup>
    <IndicatorSettingsGroup label="구름">
      <LineDisplayRow label="구름 표시" toggleLabel="일목 구름 표시" checked={settings.ichimokuCloudVisible} onToggle={() => setIchimokuSettings({ ichimokuCloudVisible: !settings.ichimokuCloudVisible })} />
      <SettingsRow label="상승 구름 · A ≥ B"><ColorSwatchPicker label="일목 상승 구름" color={settings.ichimokuCloudPositiveColor} onChange={color => setIchimokuSettings({ ichimokuCloudPositiveColor: color })} /></SettingsRow>
      <SettingsRow label="하락 구름 · A < B"><ColorSwatchPicker label="일목 하락 구름" color={settings.ichimokuCloudNegativeColor} onChange={color => setIchimokuSettings({ ichimokuCloudNegativeColor: color })} /></SettingsRow>
      <IndicatorRangeRow label="구름 불투명도" ariaLabel="일목 구름 불투명도" value={Math.round(settings.ichimokuCloudOpacity * 100)} onChange={value => setIchimokuSettings({ ichimokuCloudOpacity: value / 100 })} />
    </IndicatorSettingsGroup>
    <IndicatorExplanation>현재봉을 포함한 완전한 고저 범위의 중간값을 계산합니다. 기본 전환 9·기준 26·선행 B 52봉이며 선행선은 정확히 26봉 앞, 후행 종가는 26봉 뒤에 표시됩니다. 값은 표시 위치 기준입니다. 기본 설정에서는 최근봉 위치에 과거에 계산한 선행값이 표시되고 후행값은 없습니다. 이동 봉 수가 0이면 다섯 선 모두 원본 봉 위치에 표시됩니다. 후행선의 값은 해당 위치보다 나중에 관측됐습니다. 미래 구름은 미래 가격·거래일을 뜻하지 않습니다. 전체 선행 구름은 차트를 왼쪽으로 밀어 확인할 수 있습니다. 구름은 선행선 표시와 독립적입니다.</IndicatorExplanation>
  </div>;
}
