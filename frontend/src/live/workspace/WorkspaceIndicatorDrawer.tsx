import IndicatorPanel from '../indicators/IndicatorPanel';
import { capabilitiesForInstrument } from '../liveInstrumentCapabilities';
import { WindowViewContext } from './windowView';
import { useChartWindowView } from './WorkspaceIndicatorDrawerHelpers';





export function WorkspaceIndicatorDrawer({
  windowId,
  onClose,
}: {
  /** 헤더 버튼이 지정한 대상 창 — 추론하지 않는다(#759). */
  windowId: string;
  onClose: () => void;
}) {
  const targetView = useChartWindowView(windowId);
  if (!targetView) return null;
  const { view, target, symbol, instrument } = targetView;

  return (
    <WindowViewContext.Provider value={view}>
      {/* key=대상 창 id — 다른 창의 헤더 버튼으로 대상이 교체될 때 드로어 로컬
          상태(2-단계 리셋 확인·HH:MM draft)가 창 경계를 넘지 않게 재마운트
          (#712 리뷰 #4 의 규율은 대상 교체 경로가 바뀌어도 그대로 유효). */}
      <IndicatorPanel
        key={view.windowId}
        onClose={onClose}
        capabilities={capabilitiesForInstrument(instrument)}
        timeframe={view.timeframe}
        targetLabel={symbol?.name ?? `그룹 ${target.group}`}
      />
    </WindowViewContext.Provider>
  );
}
