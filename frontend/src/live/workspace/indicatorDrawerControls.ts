/**
 * 지표 드로어 명령 채널 (#759 결정 3).
 *
 * 드로어 본체는 화면 우측 전폭 도킹 오버레이라 **전역 1개**이고, 열림 상태는
 * 셸(`LivePage`)이 소유한다. 트리거는 그 바깥 — 캔버스 안 차트 창 헤더 — 에
 * 있으므로, 창이 "나를 대상으로 열어라" 를 셸에 전달할 경로가 필요하다.
 * `workspaceCanvasControls` 와 같은 모듈 레지스트리 idiom(드로어는 페이지당
 * 1개라 단일 슬롯으로 충분).
 *
 * 창이 창당 드로어를 렌더하지 않는 이유: 폭 760px 도킹 패널이라 두 창이 동시에
 * 열면 같은 자리에 겹친다. 어차피 한 번에 하나만 보이는 물건이므로 하나만 두고
 * **대상만 바꾼다**.
 */
let opener: ((windowId: string) => void) | null = null;

export function registerIndicatorDrawerOpener(open: (windowId: string) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** 차트 창 헤더의 보조지표 버튼 → 셸에 "이 창을 대상으로 열어라". */
export function requestIndicatorDrawer(windowId: string): void {
  opener?.(windowId);
}
