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
  useWorkspaceStore,
  type GroupSymbol,
  type WorkspaceWindow,
} from '../../state/workspace';

/** 대상 차트 창 = 포커스 창이 차트면 그 창, 아니면 z순서 최상위 차트 창. */
export function targetChartWindow(
  windows: readonly WorkspaceWindow[],
  zOrder: readonly string[],
): WorkspaceWindow | null {
  for (let i = zOrder.length - 1; i >= 0; i--) {
    const w = windows.find((win) => win.id === zOrder[i]);
    if (w?.kind === 'chart') return w;
  }
  return null;
}

/** 지표 버튼 활성 여부 — 차트 창이 하나라도 있어야 드로어를 열 수 있다. */
export function useCanOpenIndicatorDrawer(): boolean {
  return useWorkspaceStore((s) => s.windows.some((w) => w.kind === 'chart'));
}

export function WorkspaceIndicatorDrawer({ onClose }: { onClose: () => void }) {
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

  const view: WindowViewValue | null = useMemo(() => {
    if (!target) return null;
    return {
      windowId: target.id,
      group: target.group,
      code: isIndex ? null : symbol?.code ?? null,
      timeframe,
      historicalFromDate: null, // 드로어는 페치를 돌리지 않는다 — 뷰 식별용 아님
      indicators,
    };
  }, [target, isIndex, symbol?.code, timeframe, indicators]);

  if (!target || !view) return null;

  return (
    <WindowViewContext.Provider value={view}>
      <IndicatorPanel
        onClose={onClose}
        capabilities={capabilitiesForInstrument(instrument)}
        timeframe={timeframe}
        targetLabel={symbol?.name ?? `그룹 ${target.group}`}
      />
    </WindowViewContext.Provider>
  );
}
