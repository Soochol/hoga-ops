/**
 * 부동 레이어(position:fixed 메뉴/popover)를 뷰포트 안으로 미끄러뜨려 클램프한다.
 * 우/하단으로 넘치면 가장자리까지 슬라이드하고, 레이어가 뷰포트보다 크면 0에 바닥을
 * 둔다. 순수 함수 — `width`/`height` 는 측정된 rect, `(left, top)` 은 원하는 위치,
 * `viewportW`/`viewportH` 는 `window.innerWidth`/`innerHeight`(호출부에서 주입).
 * window 의존이 없어 단위 테스트 가능(jsdom 은 레이아웃을 못 함 — 측정은 호출부 몫).
 */
export function clampToViewport(
  left: number,
  top: number,
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
): { left: number; top: number } {
  return {
    left: left + width > viewportW ? Math.max(0, viewportW - width) : left,
    top: top + height > viewportH ? Math.max(0, viewportH - height) : top,
  };
}
