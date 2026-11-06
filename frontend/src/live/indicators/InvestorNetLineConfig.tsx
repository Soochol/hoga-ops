import { useIndicatorActions, useWindowIndicators } from '../workspace/windowView';
import { IndicatorSettingsGroup, IndicatorLineWidthRow } from './IndicatorSettingsLayout';
import ColorSwatchPicker from './ColorSwatchPicker';
import LineVisibilityRow from './LineVisibilityRow';

export default function InvestorNetLineConfig() {
  const settings = useWindowIndicators();
  const { setInvestorNetLineSettings } = useIndicatorActions();
  return <div className="indicator-settings-groups">
    <IndicatorSettingsGroup label="표시·스타일">
      {([
        ['외국인', 'investorNetLineForeignColor', 'investorNetLineForeign'],
        ['기관', 'investorNetLineInstitutionColor', 'investorNetLineInstitution'],
      ] as const).map(([label, key, lineKey]) => <LineVisibilityRow key={key} label={label} lineKey={lineKey} toggleLabel={`순매수 라인 ${label} 표시`}>
        <ColorSwatchPicker label={`순매수 라인 ${label}`} color={settings[key]} onChange={color => setInvestorNetLineSettings({ [key]: color })} />
      </LineVisibilityRow>)}
      <IndicatorLineWidthRow label="순매수 라인" value={settings.investorNetLineWidth}
        onChange={investorNetLineWidth => setInvestorNetLineSettings({ investorNetLineWidth })} />
    </IndicatorSettingsGroup>
    <IndicatorSettingsGroup label="기준">
      <p className="text-xs text-fg-dim">하루별 순매수 수량(주) · 양수는 순매수, 음수는 순매도입니다. 기간 누적이 아니며 당일 값은 잠정입니다.</p>
    </IndicatorSettingsGroup>
  </div>;
}
