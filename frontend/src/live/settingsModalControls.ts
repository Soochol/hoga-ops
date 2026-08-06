/**
 * 설정 모달 명령 채널 (#1133 후속).
 *
 * 모달 본체는 화면 중앙 오버레이라 **페이지당 1개**이고 열림 상태는 셸(`LivePage`)이
 * 소유한다. 트리거는 그 바깥 — 캔버스 안 차트 창의 빈 상태 — 에 있으므로, 창이
 * "설정을 열어라" 를 셸에 전달할 경로가 필요하다.
 *
 * `indicatorDrawerControls` 와 같은 idiom 이다. 차이는 **대상이 없다**는 것 하나 —
 * 설정은 앱 전역 값이라 어느 창에서 열든 같은 화면이다(그래서 인자가 없다).
 */
let opener: (() => void) | null = null;

export function registerSettingsModalOpener(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** 빈 상태의 "설정 열기" → 셸에 요청. 셸이 없으면(테스트·다른 페이지) 무해한 no-op. */
export function requestSettingsModal(): void {
  opener?.();
}
