import { IndicatorSettingsGroup } from './IndicatorSettingsLayout';
import { SettingsRow } from '../settings/SettingsRow';
import { useWindowIndicators, useIndicatorActions } from '../workspace/windowView';
import ToggleRow from '../settings/ToggleRow';
import ColorSwatchPicker from './ColorSwatchPicker';
import { IndicatorExplanation } from './IndicatorExplanation';

export default function VolumeDistributionConfig() {
  const ind = useWindowIndicators();
  const actions = useIndicatorActions();
  const { volumeDistributionRangeCount, volumeDistributionHoverCutoffEnabled, volumeDistributionColor, volumeDistributionMaxColor } = ind;
  const { setVolumeDistributionRangeCount, setVolumeDistributionHoverCutoffEnabled, setVolumeDistributionStyle } = actions;
  return (
    <div className="indicator-settings-groups">
      <IndicatorSettingsGroup label="조건">
      <div className="mb-3">
        <label className="flex items-center justify-between gap-3 text-sm text-fg">
          <span>구간 수</span>
          <input
            type="number"
            min={5}
            max={30}
            step={1}
            aria-label="연속체결 매물대 분포 구간 수"
            className="w-[84px] rounded-md border border-border-strong bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-fg focus:border-accent focus:outline-none"
            value={volumeDistributionRangeCount}
            onChange={(event) => setVolumeDistributionRangeCount(Number(event.currentTarget.value))}
          />
        </label>
      </div>
      <div className="mb-3">
        <ToggleRow
          label="호버 시점 누적"
          description="마우스를 올린 시점까지의 연속체결량만 누적합니다."
          checked={volumeDistributionHoverCutoffEnabled}
          onToggle={() => setVolumeDistributionHoverCutoffEnabled(!volumeDistributionHoverCutoffEnabled)}
          testId="settings-toggle-volumeDistributionHoverCutoff"
        />
      </div>
      </IndicatorSettingsGroup>
      <IndicatorSettingsGroup label="표시·스타일">
        <SettingsRow label="기본 구간"><ColorSwatchPicker label="연속체결 매물대 분포 색상"
          color={volumeDistributionColor} onChange={color => setVolumeDistributionStyle({ color })} /></SettingsRow>
        <SettingsRow label="최대 구간"><ColorSwatchPicker label="연속체결 매물대 분포 최대 구간 색상"
          color={volumeDistributionMaxColor} onChange={maxColor => setVolumeDistributionStyle({ maxColor })} /></SettingsRow>
      </IndicatorSettingsGroup>
      <IndicatorExplanation>
        거래일 내 체결량이 가장 많은 구간을 별도 색상으로 강조합니다.
      </IndicatorExplanation>
    </div>
  );
}
