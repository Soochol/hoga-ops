import { IndicatorSettingsGroup } from './IndicatorSettingsLayout';
import { SettingsRow } from '../settings/SettingsRow';
import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import ToggleRow from '../settings/ToggleRow';
import MAStylePicker from './MAStylePicker';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

/** 호가비 상세 — 매수/매도 우위 범례 + 현재값 수평선 + 극단값 필터 설정.
 *  값이 양수면 매도 우위(파랑), 음수면 매수 우위(빨강)이나 범례는 색→의미로 표기. */
export default function RatioConfig() {
  const levelEnabled = useWindowIndicator((s) => s.ratioLevelLineEnabled);
  const setLevelEnabled = useIndicatorActions().setRatioLevelLineEnabled;
  const color = useWindowIndicator((s) => s.ratioLevelColor);
  const width = useWindowIndicator((s) => s.ratioLevelWidth);
  const style = useWindowIndicator((s) => s.ratioLevelStyle);
  const setStyle = useIndicatorActions().setRatioLevelStyle;
  return (
    <div className="indicator-settings-groups">
      <IndicatorSettingsGroup label="조건">
        <IndicatorPrefRows toggleKeys={['ratioOutlierFilterEnabled', 'ratioIntraMax']} />
      </IndicatorSettingsGroup>
      <IndicatorSettingsGroup label="표시·스타일">
      <ToggleRow
        label="현재값 수평선"
        description="현재 호가비에 수평선을 표시합니다."
        checked={levelEnabled}
        onToggle={() => setLevelEnabled(!levelEnabled)}
        testId="settings-toggle-ratioLevelLineEnabled"
      />
      <fieldset disabled={!levelEnabled} key={String(levelEnabled)} className="indicator-child-rows">
          <SettingsRow label="수평선">
          <MAStylePicker
            color={color}
            lineWidth={width}
            lineStyle={style}
            onChange={setStyle}
            onLineStyleChange={(lineStyle) => setStyle({ lineStyle })}
            label="호가비 수평선"
          />
          </SettingsRow>
        </fieldset>
      <SignColorLegend up="매수 우위" down="매도 우위" />
      </IndicatorSettingsGroup>
    </div>
  );
}
