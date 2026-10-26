import { useWindowIndicatorTimeframe } from '../workspace/windowView';
import { isSecondTimeframe } from '../../state/livePage';
import SignColorLegend from './SignColorLegend';

// Volume data semantics; placement and style belong to the chart window.
export default function VolumeConfig() {
  const timeframe = useWindowIndicatorTimeframe();
  const seconds = timeframe != null && isSecondTimeframe(timeframe);
  return (
    <div>
      <SignColorLegend up="상승봉" down="하락봉" />
      <div className="border-b border-border my-3" />
      {seconds ? <p className="text-xs text-fg-dim">수집된 체결의 관측 거래량입니다. 미수집 구간은 포함되지 않습니다.</p>
        : <p className="text-xs text-fg-dim">캔들 차트 설정에서 거래량을 캔들 영역에 겹쳐 표시할 수 있습니다.</p>}
    </div>
  );
}
