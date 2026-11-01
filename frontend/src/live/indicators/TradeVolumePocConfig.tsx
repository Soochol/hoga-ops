import { IndicatorSettingsGroup, IndicatorRangeRow } from './IndicatorSettingsLayout';
import { SettingsRow } from '../settings/SettingsRow';
import ColorSwatchPicker from './ColorSwatchPicker';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

export default function TradeVolumePocConfig() {
  const color = useWindowIndicator((s) => s.tradeVolumePocColor);
  const opacity = useWindowIndicator((s) => s.tradeVolumePocOpacity);
  const rangeCount = useWindowIndicator((s) => s.volumeDistributionRangeCount);
  const setStyle = useIndicatorActions().setTradeVolumePocStyle;
  const opacityPct = Math.round(opacity * 100);

  return <div className="indicator-settings-groups">
    <IndicatorSettingsGroup label="표시·스타일">
      <SettingsRow label="밴드 색상"><ColorSwatchPicker label="당일 최대 매물대 색상" color={color}
        onChange={color => setStyle({ color })} /></SettingsRow>
      <IndicatorRangeRow label="불투명도" ariaLabel="당일 최대 매물대 불투명도" value={opacityPct} min={5} max={40}
        onChange={value => setStyle({ opacity: value / 100 })} />
    </IndicatorSettingsGroup>
    <p className="text-xs text-fg-dim">매물대 분포와 같은 {rangeCount}개 구간 중 체결량이 가장 많은 가격대를 밴드로 표시합니다.</p>
  </div>;
}
