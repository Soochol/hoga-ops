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
