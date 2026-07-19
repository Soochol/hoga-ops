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


/** 지표 버튼 활성 여부 — 차트 창이 하나라도 있어야 드로어를 열 수 있다. */
export function useCanOpenIndicatorDrawer(): boolean {
  return useWorkspaceStore((s) => s.windows.some((w) => w.kind === 'chart'));
}

/** 포커스 차트 창의 (WindowViewValue·창·심볼·instrument) — 드로어와 설정 모달이
 *  같은 대상 규칙(#712 실시간 추적)을 공유한다. 차트 창이 없으면 null. */
export function useFocusedChartWindowView(): {
  view: WindowViewValue;
  target: WorkspaceWindow;
  symbol: GroupSymbol | null;
  instrument: ReturnType<typeof stockInstrument> | null;
} | null {
  const windows = useWorkspaceStore((s) => s.windows);
  const zOrder = useWorkspaceStore((s) => s.zOrder);
  const groupSymbols = useWorkspaceStore((s) => s.groupSymbols);

  const target = targetChartWindow(windows, zOrder);
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

export function WorkspaceIndicatorDrawer({ onClose }: { onClose: () => void }) {
  const focusedView = useFocusedChartWindowView();
  if (!focusedView) return null;
  const { view, target, symbol, instrument } = focusedView;

  return (
    <WindowViewContext.Provider value={view}>
      <IndicatorPanel
        onClose={onClose}
        capabilities={capabilitiesForInstrument(instrument)}
        timeframe={view.timeframe}
        targetLabel={symbol?.name ?? `그룹 ${target.group}`}
      />
    </WindowViewContext.Provider>
  );
}
