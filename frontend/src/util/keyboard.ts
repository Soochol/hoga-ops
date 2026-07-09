/**
 * 전역(window/document) 키보드 단축키 공용 유틸.
 *
 * 페이지 단축키는 어디서든 발동하므로 사용자가 입력 중일 때는 양보해야 한다.
 * 이 판정을 각 리스너가 제각각 복제하지 않도록 한곳에 둔다. 기능 레이어(live/,
 * chart/, studyViews/) 어디서든 참조할 수 있게 중립 util/ 에 위치한다.
 */

/**
 * 전역 단축키를 무시해야 하는 이벤트인지 판정한다.
 * INPUT/TEXTAREA/SELECT, contentEditable, 그리고 `[data-prevent-shortcuts]`
 * 하위에서 발생한 이벤트면 true(=단축키 억제). 심볼 검색 등 텍스트 입력과의
 * 충돌을 막는다.
 */
export function shouldIgnoreEvent(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.closest('[data-prevent-shortcuts]')) return true;
  return false;
}
