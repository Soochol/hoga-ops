import { useContext, useId } from 'react';
import { useIndicatorActions, useWindowIndicator, useWindowIndicatorTimeframe, WindowViewContext } from '../workspace/windowView';
import { IndicatorEditorDraftContext } from '../../state/indicatorEditorDraftContext';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { VolumeOverlaySettings } from '../workspace/VolumeOverlaySettings';
import { isSecondTimeframe } from '../../state/livePage';
import SignColorLegend from './SignColorLegend';
import { IndicatorExplanation } from './IndicatorExplanation';

// Placement edits the existing chart-window values, only for the primary volume.
export default function VolumeConfig() {
  const name = useId();
  const windowId = useContext(WindowViewContext)?.windowId;
  const draft = useContext(IndicatorEditorDraftContext);
  const colorMode = useWindowIndicator(s => s.volumeColorMode);
  const { setVolumeColorMode } = useIndicatorActions();
  const timeframe = useWindowIndicatorTimeframe();
  const seconds = timeframe != null && isSecondTimeframe(timeframe);
  const compare = colorMode === 'previous-volume';
  return (
    <div className="space-y-3">
      {windowId && !draft && <section aria-label="표시 방식" className="space-y-2">
        <h4 className="text-xs text-fg">표시 방식</h4>
        <IndicatorPrefRows toggleKeys={['volumeOverlayEnabled']} />
        <VolumeOverlaySettings windowId={windowId} />
      </section>}
      <fieldset className="space-y-2 text-xs text-fg">
        <legend className="mb-2">색상 기준</legend>
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
      <IndicatorExplanation>{compare
        ? '직전 봉보다 거래량이 많으면 양봉 색상, 같거나 적으면 음봉 색상으로 표시합니다. 직전 봉이 없으면 캔들 색상을 사용합니다.'
        : '해당 캔들의 양봉·음봉 색상으로 표시합니다.'}</IndicatorExplanation>
      <SignColorLegend up={compare ? '거래량 증가' : '상승봉'} down={compare ? '같거나 감소' : '하락봉'} />
      {draft?.instanceId && <p className="text-xs text-fg-dim">추가한 거래량은 별도 패널에 표시합니다. 캔들에 겹쳐 표시는 기본 거래량에서 설정할 수 있습니다.</p>}
      {seconds && <p className="text-xs text-fg-dim">수집된 체결의 관측 거래량입니다. 미수집 구간은 포함되지 않습니다.</p>}
    </div>
  );
}
