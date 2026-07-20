/**
 * WorkspaceIndicatorDrawer — 지표 드로어의 멀티창 호스트 (ADR-0119 C2c-2c, #712).
 *
 * 드로어 = **포커스 차트 창의 설정 편집기(실시간 추적)**. 포커스가 데이터 창이면
 * z순서상 최상위 차트 창을 대상으로, 대상 창의 WindowViewContext 로 IndicatorPanel
 * 을 감싸 읽기(useWindowIndicators)·쓰기(useIndicatorActions)가 그 창의 봉 버킷을
 * 향하게 한다. 헤더에는 대상 창(종목·봉)을 표시한다. 차트 창이 없으면 열 수 없다
 * (호출부가 지표 버튼을 비활성화 — canOpenIndicatorDrawer).
 */
import { useMemo } from 'react';
import IndicatorPanel from '../indicators/IndicatorPanel';
import {
  capabilitiesForInstrument,
} from '../liveInstrumentCapabilities';
import { indexInstrument, isLiveIndexId, stockInstrument } from '../liveInstrument';
import {
  FACTORY_INDICATOR_SETTINGS,
  resolveIndicatorSettings,
} from '../../state/indicatorSettingsV2';
import { WindowViewContext, type WindowViewValue } from './windowView';
import {
  targetChartWindow,
  useWorkspaceStore,
  type GroupSymbol,
  type WorkspaceWindow,
} from '../../state/workspace';

export { targetChartWindow };


type ChartWindowView = {
  view: WindowViewValue;
  target: WorkspaceWindow;
  symbol: GroupSymbol | null;
  instrument: ReturnType<typeof stockInstrument> | null;
};

/** 지정한 차트 창의 (WindowViewValue·창·심볼·instrument). 그 창이 없으면 null.
 *
 *  드로어는 이제 z-최상위를 **추론하지 않고** 헤더 버튼이 지정한 창을 편집한다
 *  (#759 결정 3·4) — 트리거가 창 안에 있으므로 대상이 자명하고, 열린 뒤 다른
 *  창을 클릭해도 따라가지 않는다(명시적으로 연 것은 명시적으로 바꿀 때까지 유지). */
export function useChartWindowView(windowId: string | null): ChartWindowView | null {
  const windows = useWorkspaceStore((s) => s.windows);
  const groupSymbols = useWorkspaceStore((s) => s.groupSymbols);

  const target = windowId
    ? windows.find((w) => w.id === windowId && w.kind === 'chart') ?? null
    : null;
  const symbol: GroupSymbol | null = target ? groupSymbols[target.group] ?? null : null;
  const timeframe = target?.chart?.timeframe ?? '1m';
  const byTimeframe = target?.chart?.indicators.byTimeframe;
  const isIndex = symbol?.kind === 'index';

  const indicators = useMemo(
    () => (byTimeframe ? resolveIndicatorSettings(byTimeframe, timeframe) : FACTORY_INDICATOR_SETTINGS),
    [byTimeframe, timeframe],
  );
  const instrument = useMemo(() => {
    if (!symbol) return null;
    if (symbol.kind === 'index') {
      return isLiveIndexId(symbol.code) ? indexInstrument(symbol.code, symbol.name) : null;
    }
    return stockInstrument(symbol.code, symbol.name);
  }, [symbol]);

  return useMemo(() => {
    if (!target) return null;
    const view: WindowViewValue = {
      windowId: target.id,
      group: target.group,
      code: isIndex ? null : symbol?.code ?? null,
      timeframe,
      historicalFromDate: null, // 드로어/설정은 페치를 돌리지 않는다 — 뷰 식별용 아님
      indicators,
    };
    return { view, target, symbol, instrument };
  }, [target, isIndex, symbol, timeframe, indicators, instrument]);
}

/** 포커스 차트 창 기준 — 설정 모달이 아직 쓰는 경로(#712 호환). */
export function useFocusedChartWindowView(): ChartWindowView | null {
  const windows = useWorkspaceStore((s) => s.windows);
  const zOrder = useWorkspaceStore((s) => s.zOrder);
  return useChartWindowView(targetChartWindow(windows, zOrder)?.id ?? null);
}

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
