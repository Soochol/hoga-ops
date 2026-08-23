import { isMinuteTimeframe, type LiveTimeframe } from '../../state/livePage';

/**
 * 기간 점프 명령 채널 — `g` 단축키가 **포커스 차트 창**의 점프를 실행하는 경로.
 *
 * `indicatorDrawerControls` 와 같은 모듈 레지스트리 idiom이지만 **슬롯이 창별**이다.
 * 지표 드로어는 페이지당 하나라 단일 슬롯으로 족했지만, 점프는 실행 주체가 창
 * 자신이다 — 목적지 계산이 그 창의 차트 좌표·캔들 배열을 읽어야 하고, 그건
 * `LiveChartRoot` 안에만 있다.
 *
 * 왜 셸이 창 상태를 직접 읽지 않는가: `targetChartWindow` 로 포커스 창을 찾는 것까지는
 * 워크스페이스 스토어로 되지만, 거기 담긴 것은 봉·그룹·rect 뿐이다. 뷰포트와 캔들은
 * 스토어 밖(#713 뷰포트 비저장)이라 스토어를 통해서는 도달할 수 없다.
 */
const runners = new Map<string, () => void>();

/** 차트 창이 자기 점프 실행자를 등록한다. 반환값은 해제 함수(언마운트에서 호출). */
export function registerJumpRunner(windowId: string, run: () => void): () => void {
  runners.set(windowId, run);
  return () => {
    // 등록자 본인이 아직 주인일 때만 지운다 — 같은 id 로 재등록(HMR·리마운트)이
    // 먼저 일어나면 이 해제가 **새 등록을 지워** 단축키가 조용히 죽는다.
    if (runners.get(windowId) === run) runners.delete(windowId);
  };
}

/** `g` → 그 창의 「분봉으로」. 등록이 없으면(분봉 창·미마운트) no-op. */
export function requestTimeframeJumpFrom(windowId: string): void {
  runners.get(windowId)?.();
}

/** `jumpReceiverIds` 가 보는 최소 창 모양 — 워크스페이스 타입에 묶이지 않게 좁게 받는다. */
export type JumpReceiverCandidate = {
  id: string;
  kind: string;
  group: number | null;
  chart?: { timeframe: LiveTimeframe };
};

/**
 * 이 점프를 **받는 창들** — 올릴 대상이다.
 *
 * 「분봉으로」는 이 리포에서 유일하게 **다른 창을 움직이는** 동사인데, 누른 창에는
 * 아무 변화가 없다. 그 창이 가려져 있으면 사용자 눈에는 **아무 일도 안 일어난다** —
 * 실측(2026-08-23): 「창 추가」 기본 배치가 기존 분봉 창 위에 겹쳐(일봉 404×261
 * @97,186 vs 분봉 711×596 @13,99) 칩도 뷰포트 이동도 화면에 안 들어왔다.
 *
 * 판정은 발행 게이트와 **같은 축**이다(자기 제외 · 차트 창 · 같은 창번호 · 분봉) —
 * `hasMinuteWindow` 가 세는 집합과 갈리면 "보낼 곳이 있다는데 아무것도 안 올라오는"
 * 상태가 생긴다.
 *
 * 반환 순서는 **zOrder 순**이다. 그대로 차례로 올리면 상대 순서가 보존된다(뒤에
 * 올린 것이 위). zOrder 에 없는 창은 `indexOf` 가 -1 이라 먼저 올라가고, 그것이
 * 곧 그 창의 현재 z(=0)와 같은 순서다.
 */
export function jumpReceiverIds(
  windows: readonly JumpReceiverCandidate[],
  zOrder: readonly string[],
  selfId: string,
  group: number | null,
): string[] {
  return windows
    .filter((w) => w.id !== selfId && w.kind === 'chart' && w.group === group
      && w.chart !== undefined && isMinuteTimeframe(w.chart.timeframe))
    .map((w) => w.id)
    .sort((a, b) => zOrder.indexOf(a) - zOrder.indexOf(b));
}
