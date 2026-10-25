import { useWindowIndicatorTimeframe } from '../workspace/windowView';
import { isSecondTimeframe } from '../../state/livePage';
import SignColorLegend from './SignColorLegend';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';

// Detail pane for the 거래량 (volume) indicator. Volume bars are sign-colored
// and have no per-slot configuration (unlike MovingAverageConfig), so this is
// an informational page; the on/off control is the category checkbox.
export default function VolumeConfig() {
  const timeframe = useWindowIndicatorTimeframe();
  const seconds = timeframe != null && isSecondTimeframe(timeframe);
  return (
    <div>
      <SignColorLegend up="상승봉" down="하락봉" />
      <div className="border-b border-border my-3" />
      {seconds ? <p className="text-xs text-fg-dim">수집된 체결의 관측 거래량입니다. 미수집 구간은 포함되지 않습니다.</p>
        : <IndicatorPrefRows toggleKeys={['volumeFillStrengthCumulative']} />}
    </div>
  );
}
