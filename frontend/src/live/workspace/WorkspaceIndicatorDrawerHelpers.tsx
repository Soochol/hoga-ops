import { useMemo } from 'react';
import { indexInstrument, isLiveIndexId, stockInstrument } from '../liveInstrument';
import { type WindowViewValue } from './windowView';
import { targetChartWindow, useWorkspaceStore, windowSymbolOf, type GroupSymbol, type WorkspaceWindow } from '../../state/workspace';



export type ChartWindowView = {
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
  const symbol: GroupSymbol | null = windowSymbolOf({ groupSymbols }, target);
  const timeframe = target?.chart?.timeframe ?? '1m';
  const isIndex = symbol?.kind === 'index';

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
      instrumentKind: isIndex ? 'index' : 'stock',
      timeframe,
      historicalFromDate: null, // 드로어/설정은 페치를 돌리지 않는다 — 뷰 식별용 아님
    };
    return { view, target, symbol, instrument };
  }, [target, isIndex, symbol, timeframe, instrument]);
}


/** 포커스 차트 창 기준 — 설정 모달이 아직 쓰는 경로(#712 호환). */
export function useFocusedChartWindowView(): ChartWindowView | null {
  const windows = useWorkspaceStore((s) => s.windows);
  const zOrder = useWorkspaceStore((s) => s.zOrder);
  return useChartWindowView(targetChartWindow(windows, zOrder)?.id ?? null);
}
