import ColorSwatchPicker from './ColorSwatchPicker';
import { IndicatorSettingsGroup, IndicatorRangeRow } from './IndicatorSettingsLayout';
import { SettingsRow } from '../settings/SettingsRow';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

/** 호가 잔량 히트맵 상세 설정 — 매수/매도 색(MAStylePicker) + 최대 불투명도. */
export default function DepthHeatmapConfig() {
  const bidColor = useWindowIndicator((s) => s.depthHeatmapBidColor);
  const askColor = useWindowIndicator((s) => s.depthHeatmapAskColor);
  const maxOpacity = useWindowIndicator((s) => s.depthHeatmapMaxOpacity);
  const setStyle = useIndicatorActions().setDepthHeatmapStyle;
  return <div className="indicator-settings-groups">
    <IndicatorSettingsGroup label="조건">
      <IndicatorPrefRows toggleKeys={['depthHeatmapIntraMax', 'depthHeatmapTopLevelsOnly']} />
    </IndicatorSettingsGroup>
    <IndicatorSettingsGroup label="표시·스타일">
      <SettingsRow label="매수 색상"><ColorSwatchPicker label="매수 색상" color={bidColor}
        onChange={bidColor => setStyle({ bidColor })} /></SettingsRow>
      <SettingsRow label="매도 색상"><ColorSwatchPicker label="매도 색상" color={askColor}
        onChange={askColor => setStyle({ askColor })} /></SettingsRow>
      <IndicatorRangeRow label="최대 불투명도" value={Math.round(maxOpacity * 100)} min={20} max={100} step={5}
        onChange={value => setStyle({ maxOpacity: value / 100 })} />
    </IndicatorSettingsGroup>
  </div>;
}
