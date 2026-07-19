import { useLivePageStore } from '../state/livePage';
import { activeGroupOf, useWorkspaceStore, type GroupSymbol } from '../state/workspace';
import {
  indexInstrument,
  instrumentToActiveCode,
  isLiveIndexId,
  stockInstrument,
  type LiveInstrument,
} from './liveInstrument';

/** 활성 뷰의 종목/instrument 교체 — 관심종목·헤더 검색·스크리너·히트맵·지수바
 *  클릭·드롭의 공통 동작.
 *
 *  멀티창 플립(ADR-0119 C2c-2d) 후 종목 SSOT 는 워크스페이스의 **활성 그룹**
 *  (#711: 전역 진입점 = 활성 그룹 종목 교체). 레거시 읽기 15곳 호환을 위해
 *  livePage(projectActiveView)에도 같은 값을 원자적으로 함께 쓴다 — LivePage 의
 *  미러 effect(workspace→livePage)는 포커스 전환으로 활성 그룹이 바뀌는 경우를
 *  전담하고, 여기서 이미 일치시킨 상태는 동등 비교로 no-op 이라 루프가 없다. */
export function activateLiveInstrument(instrument: LiveInstrument): void {
  const ws = useWorkspaceStore.getState();
  ws.setGroupSymbol(activeGroupOf(ws), toGroupSymbol(instrument));
  const page = useLivePageStore.getState();
  page.projectActiveView({
    instrument,
    code: instrumentToActiveCode(instrument) ?? '',
    timeframe: page.candleTimeframe,
    historicalFromDate: null,
    lastMinuteHistoricalFromDate: null,
    viewport: null,
  });
}

export function activateLiveCode(code: string, label?: string): void {
  activateLiveInstrument(stockInstrument(code, label ?? code));
}

export function toGroupSymbol(instrument: LiveInstrument): GroupSymbol {
  return instrument.kind === 'index'
    ? { code: instrument.id, name: instrument.label, kind: 'index' }
    : { code: instrument.code, name: instrument.label };
}

/** 워크스페이스 활성 그룹 → livePage 레거시 미러 (LivePage 전용 헬퍼).
 *  projectActiveView 로 원자적 반영 — 관심종목 하트·검색 하이라이트 등 전역
 *  activeCode 읽기가 플립 후에도 활성 그룹 종목을 본다(ADR-0119 호환층). */
export function mirrorActiveGroupToLivePage(
  symbol: GroupSymbol | null,
  focusedTimeframe: ReturnType<typeof useLivePageStore.getState>['candleTimeframe'],
): void {
  const page = useLivePageStore.getState();
  const instrument: LiveInstrument | null = symbol
    ? symbol.kind === 'index'
      ? (isLiveIndexId(symbol.code) ? indexInstrument(symbol.code, symbol.name) : null)
      : stockInstrument(symbol.code, symbol.name)
    : null;
  const code = instrumentToActiveCode(instrument);
  if (
    page.activeCode === code &&
    page.activeInstrument?.label === instrument?.label &&
    page.activeInstrument?.kind === instrument?.kind &&
    page.candleTimeframe === focusedTimeframe
  ) {
    return; // 변화 없음 — persist 낭비·재렌더 회피
  }
  page.projectActiveView({
    instrument,
    code: code ?? '',
    timeframe: focusedTimeframe,
    historicalFromDate: null,
    lastMinuteHistoricalFromDate: null,
    viewport: null,
  });
}
