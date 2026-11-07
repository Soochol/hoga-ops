import { useIndicatorActions, useWindowIndicators } from '../workspace/windowView';
import { IndicatorSettingsGroup, IndicatorLineWidthRow } from './IndicatorSettingsLayout';
import LineVisibilityRow from './LineVisibilityRow';
import ColorSwatchPicker from './ColorSwatchPicker';
export default function InvestorCumulativeConfig({ subject }: {
    subject: 'foreign' | 'institution';
}) {
    const settings = useWindowIndicators();
    const actions = useIndicatorActions();
    const institution = subject === 'institution';
    const label = institution ? '기관 누적 순매수' : '외국인 누적 순매수';
    const color = institution ? settings.institutionCumulativeColor : settings.foreignCumulativeColor;
    const width = institution ? settings.institutionCumulativeWidth : settings.foreignCumulativeWidth;
    return <div className="indicator-settings-groups">
    <IndicatorSettingsGroup label="표시·스타일">
      <LineVisibilityRow label={`${label}(주)`} lineKey={institution ? 'institutionCumulative' : 'foreignCumulative'} toggleLabel={`${label} 표시`}>
        <ColorSwatchPicker label={label} color={color} onChange={color => institution ? actions.setInstitutionCumulativeSettings({ institutionCumulativeColor: color }) : actions.setForeignCumulativeSettings({ foreignCumulativeColor: color })}/>
      </LineVisibilityRow>
      <IndicatorLineWidthRow label={label} value={width} onChange={width => institution ? actions.setInstitutionCumulativeSettings({ institutionCumulativeWidth: width }) : actions.setForeignCumulativeSettings({ foreignCumulativeWidth: width })}/>
    </IndicatorSettingsGroup>
    <IndicatorSettingsGroup label="누적 기준">
      {!institution && <p className="text-xs text-fg-dim">외국인투자자 + 내외국인 · 기존 일별 순매수와 같은 집계</p>}
      <p className="text-xs text-fg-dim">조회자료 첫날 0 · 다음 날 순매수부터 누적 · 과거 자료가 추가되면 기준일과 전체 값을 다시 계산</p>
      <p className="text-xs text-fg-dim">국내 개별주식 일봉 · 키움 KRX · 실제 보유잔고 아님</p>
      <p className="text-xs text-fg-dim">비중 미지원 · 과거 날짜별 발행주식수 자료 없음 · 기업행사에 따른 과거 순매수 수량을 자체 보정하지 않음 · 당일 값은 잠정</p>
      <p className="text-xs text-fg-dim">누락·상충 자료 이후는 빈 값 · 받은 자료의 합계를 먼저 표시하고 추가 자료가 오면 보정</p>
    </IndicatorSettingsGroup>
  </div>;
}
