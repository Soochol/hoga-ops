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

/** `/live` 딥링크 경로. LivePage 가 마운트 시 `?code=`/`?index=` 를 1회 읽어 활성
 *  그룹에 시드한다(LivePage.tsx) — 상태→URL 반영은 없으므로 매번 코드로 조립한다. */
export function liveDeepLinkPath(instrument: LiveInstrument): string {
  const q =
    instrument.kind === 'index'
      ? `index=${encodeURIComponent(instrument.id)}`
      : `code=${encodeURIComponent(instrument.code)}`;
  return `/live?${q}`;
}

/** 종목을 새 브라우저 탭으로 연다(ctrl/⌘+클릭).
 *
 *  `noopener` 는 새 탭이 `window.opener` 로 이 창을 조작하지 못하게 하는 표준 방어.
 *  딥링크로 열린 탭은 워크스페이스를 sessionStorage 에 격리하므로(workspace.ts)
 *  이 창의 창 배치·종목을 덮어쓰지 않는다. */
export function openLiveInNewTab(instrument: LiveInstrument): void {
  window.open(liveDeepLinkPath(instrument), '_blank', 'noopener');
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
  // projectActiveView 는 종목 없음(instrument=null)일 때 activeCode 를 '' 로 쓴다
  // (livePage.ts). 가드도 같은 정규화(`?? ''`)로 비교하지 않으면 null↔'' 비대칭에
  // 걸려 종목 없는 활성 그룹에서 매 전환마다 재투영·persist 가 반복된다(리뷰 #1).
  //
  // **`label` 은 일부러 비교에서 뺀다** — write-only 슬롯 부패가 아니라 의도된 배제다.
  // 이유는 셋:
  //  1. 심볼 마스터 실명 보강(backfillSymbolNames)은 종목이 아니라 **라벨만** 바꾼다.
  //     label 을 비교에 넣으면 그 착지가 재투영을 트리거해 set·persist·지표 재투영이
  //     한 번 더 돈다 — 바뀐 게 문자열 하나뿐인데.
  //  2. **`activeInstrument` 는 런타임 리더가 0곳이다**(전수 확인). /live 차트 창은
  //     전부 `WindowViewContext.Provider` 안이라 창 자신의 값을 보고, 창 밖 소비자
  //     (관심종목 하트·검색 하이라이트)가 읽는 건 `activeCode` 다.
  //  3. 영속된 label 의 유일한 소비자는 `workspaceMigration.groupOneSymbol` 의 레거시
  //     시드인데, 그 시드가 심는 `name` 은 backfillSymbolNames 가 다시 치유한다.
  // 남는 staleness 는 유계다 — 다음 실전이(종목·봉 교체)에서 같이 따라온다.
  if (
    (page.activeCode ?? '') === (code ?? '') &&
    (page.activeInstrument?.kind ?? null) === (instrument?.kind ?? null) &&
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
