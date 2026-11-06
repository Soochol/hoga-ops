import { IndicatorSettingsGroup } from './IndicatorSettingsLayout';
import { SettingsRow } from '../settings/SettingsRow';
import { useContext, useId } from 'react';
import { useIndicatorActions, useWindowIndicator, useWindowIndicatorTimeframe, WindowViewContext } from '../workspace/windowView';
import { IndicatorEditorDraftContext } from '../../state/indicatorEditorDraftContext';
import ToggleRow from '../settings/ToggleRow';
import { DEFAULT_CHART_DISPLAY_PREFS, type VolumeOverlayPrefs } from '../../state/chartDisplayPrefs';
import { useWindowSettingsStore } from '../../state/windowSettings';
import { VolumeOverlaySettings } from '../workspace/VolumeOverlaySettings';
import { isSecondTimeframe } from '../../state/livePage';
import SignColorLegend from './SignColorLegend';
import { IndicatorExplanation } from './IndicatorExplanation';

// Placement edits the existing chart-window values, only for the primary volume.
export default function VolumeConfig() {
  const name = useId();
  const windowId = useContext(WindowViewContext)?.windowId;
  const draft = useContext(IndicatorEditorDraftContext);
  const windowPlacement = useWindowSettingsStore(s => windowId ? s.byWindow[windowId]?.chart : undefined) ?? DEFAULT_CHART_DISPLAY_PREFS;
  const additional = !!draft && (!draft.volumeOverlay || draft.volumeOverlayEditable === false);
  const placement = additional ? DEFAULT_CHART_DISPLAY_PREFS : draft?.volumeOverlay ?? windowPlacement;
  const patchPlacement = (patch: Partial<VolumeOverlayPrefs>) => {
    if (additional) return;
    if (draft?.patchVolumeOverlay) draft.patchVolumeOverlay(patch);
    else if (windowId) useWindowSettingsStore.getState().patch(windowId, 'chart', patch);
  };
  const colorMode = useWindowIndicator(s => s.volumeColorMode);
  const { setVolumeColorMode } = useIndicatorActions();
  const timeframe = useWindowIndicatorTimeframe();
  const seconds = timeframe != null && isSecondTimeframe(timeframe);
  const compare = colorMode === 'previous-volume';
  return (
    <div className="indicator-settings-groups">
      {windowId && <IndicatorSettingsGroup label="표시 방식">
        <ToggleRow label="거래량을 캔들에 겹쳐 표시"
          description={additional ? '추가한 거래량은 별도 패널에 표시합니다. 겹쳐 표시는 기본 거래량에서 설정합니다.' : '거래량을 별도 패널 대신 캔들 아래쪽에 겹쳐 표시합니다.'}
          checked={placement.volumeOverlayEnabled} disabled={additional}
          onToggle={() => patchPlacement({ volumeOverlayEnabled: !placement.volumeOverlayEnabled })}
          testId="settings-toggle-volumeOverlayEnabled" />
        <VolumeOverlaySettings prefs={placement} onChange={patchPlacement} disabled={additional || !placement.volumeOverlayEnabled} />
      </IndicatorSettingsGroup>}
      <IndicatorSettingsGroup label="색상">
      <SettingsRow label="색상 기준">
      <fieldset className="indicator-color-basis" aria-label="색상 기준">
        {([
          ['candle', '캔들 색상과 동일'],
          ['previous-volume', '이전 거래량과 비교'],
        ] as const).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input type="radio" name={name} value={value} checked={colorMode === value}
              className="accent-accent" onChange={() => setVolumeColorMode(value)} />
            {label}
          </label>
        ))}
      </fieldset>
      </SettingsRow>
      <SignColorLegend up={compare ? '거래량 증가' : '상승봉'} down={compare ? '같거나 감소' : '하락봉'} />
      </IndicatorSettingsGroup>
      <IndicatorExplanation>{compare
        ? '직전 봉보다 거래량이 많으면 양봉 색상, 같거나 적으면 음봉 색상으로 표시합니다. 직전 봉이 없으면 캔들 색상을 사용합니다.'
        : '해당 캔들의 양봉·음봉 색상으로 표시합니다.'}</IndicatorExplanation>
      {additional && <p className="text-xs text-fg-dim">추가 거래량 · 별도 패널</p>}
      <p className="text-xs text-fg-dim">공급자가 거래량을 제공하지 않는 구간은 막대와 거래량비를 표시하지 않습니다.</p>
      {seconds && <p className="text-xs text-fg-dim">수집된 체결의 관측 거래량입니다. 미수집 구간은 포함되지 않습니다.</p>}
    </div>
  );
}
