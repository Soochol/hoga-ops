import { useLivePageStore } from '../state/livePage';
import { activationTarget, useWorkspaceStore, type GroupSymbol } from '../state/workspace';
import {
  indexInstrument,
  instrumentToActiveCode,
  isLiveIndexId,
  stockInstrument,
  type LiveInstrument,
} from './liveInstrument';

/** 활성 뷰의 종목/instrument 교체 — 관심종목·헤더 검색·스크리너·히트맵·지수바
 *  **클릭**의 공통 동작.
 *
 *  멀티창 플립(ADR-0119 C2c-2d) 후 종목 SSOT 는 워크스페이스의 **활성 그룹**
 *  (#711: 전역 진입점 = 활성 그룹 종목 교체). 레거시 읽기 15곳 호환을 위해
 *  livePage(projectActiveView)에도 같은 값을 원자적으로 함께 쓴다 — LivePage 의
 *  미러 effect(workspace→livePage)는 포커스 전환으로 활성 그룹이 바뀌는 경우를
 *  전담하고, 여기서 이미 일치시킨 상태는 동등 비교로 no-op 이라 루프가 없다.
 *
 *  **목적지는 포커스 창이 아니라 `activationTarget`** 이다(2026-08-21 창 고정). 포커스
 *  창이 핀이면 클릭은 그 아래 핀 아닌 창으로 넘어가고, 그 창을 포커스로 올린다 —
 *  안 올리면 아래 미러가 "화면에 없는 종목" 을 활성으로 잡아 관심종목 하트·검색
 *  하이라이트·탭 제목이 착지 지점과 어긋난다.
 *
 *  **드롭은 여기를 타지 않는다** — 좌표 아래 창에 직접 쓴다(`WorkspaceCanvas` 리졸버 →
 *  `setWindowSymbol`). 그래서 핀 창은 "직접 놓을 때만" 바뀐다.
 *
 *  **반환값은 없다** — 막힘은 호출부가 분기할 것이 아니라 사용자에게 알릴 것이라,
 *  여기서 토스트 슬롯(`reportBlockedActivation`)을 세우고 끝낸다. 아무도 안 읽는
 *  boolean 을 돌려주면 그 자리가 write-only 슬롯으로 썩는다. */
export function activateLiveInstrument(instrument: LiveInstrument): void {
  const ws = useWorkspaceStore.getState();
  const symbol = toGroupSymbol(instrument);
  const target = activationTarget(ws);
  if (target.kind === 'blocked') {
    ws.reportBlockedActivation(symbol.name);
    return;
  }
  if (target.kind === 'window') {
    ws.setGroupSymbol(target.window.group, symbol);
    ws.focusWindow(target.window.id);
  } else {
    // 창이 하나도 없는 워크스페이스 — 종전대로 그룹 1 에 시드해 둔다(다음에 추가하는
    // 창이 활성 그룹을 물려받아 이 종목으로 열린다).
    ws.setGroupSymbol(target.group, symbol);
  }
  const page = useLivePageStore.getState();
  // 저장뷰 기간 슬롯 해제 — **종목이 실제로 바뀔 때만**. 관심종목에서 같은 종목을
  // 다시 눌러도 이 함수는 발화하므로, 무조건 지우면 "종목 변경 시 해제" 가 아니라
  // "아무 클릭에나 해제" 가 된다. blocked early-return 뒤에 두는 것도 같은 이유다
  // (아무것도 안 바뀐 클릭이 슬롯을 지우면 안 된다).
  //
  // 해제를 `projectActiveView` 쪽에 걸지 않는 이유는 그 액션의 주석에 있다 —
  // 창 포커스 전환 미러가 같은 경로를 타서, 다른 종목 창을 클릭만 해도 풀린다.
  if (page.savedRangeFocus && instrumentToActiveCode(instrument) !== page.savedRangeFocus.code) {
    page.clearSavedRange();
  }
  page.projectActiveView({
    instrument,
    code: instrumentToActiveCode(instrument) ?? '',
    timeframe: page.candleTimeframe,
    historicalFromDate: null,
    lastMinuteHistoricalFromDate: null,
    lastMinuteHistoricalTimeframe: null,
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

/** 워크스페이스 **포커스 창이 그리는 종목** → livePage 레거시 미러 (LivePage 전용 헬퍼).
 *  projectActiveView 로 원자적 반영 — 관심종목 하트·검색 하이라이트 등 전역
 *  activeCode 읽기가 플립 후에도 화면의 종목을 본다(ADR-0119 호환층).
 *
 *  출처가 `groupSymbols[활성 그룹]` 이 아니라 `focusedWindowSymbol` 인 이유는 창 고정
 *  때문이다 — 포커스 창이 핀이면 그룹 종목과 화면이 갈린다(그 함수 주석). */
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
    lastMinuteHistoricalTimeframe: null,
  });
}
