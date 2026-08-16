/**
 * 설정 드로어 명령 채널 (#1133 후속 · 2026-08-16 소유자 이동).
 *
 * **열림 상태의 소유자는 `App` 이다** — 전에는 `LivePage` 였는데, 설정 표면이 앱 전역
 * 하나로 합쳐지면서(#1339) 트리거가 `/live` 밖으로 퍼졌다(실시간 불가 배너 · 종목검색의
 * 「설정에서 갱신」 · 전 라우트 TopNav ⚙). 아래 슬롯은 **하나뿐이고 스택이 없어서**
 * 소유자가 둘이면 나중 등록이 앞의 것을 덮고, 그 페이지가 언마운트되면 `null` 로
 * 떨어진다(앞의 소유자로 복원되지 않는다). 그래서 등록 지점은 App 한 곳으로 못박는다.
 *
 * `indicatorDrawerControls` 와 같은 idiom 이다. 차이는 **대상이 없다**는 것 하나 —
 * 설정은 앱 전역 값이라 어디서 열든 같은 화면이다(그래서 인자가 없다).
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
