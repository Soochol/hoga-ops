/** ↑↓ 로 인접 행에 포커스를 옮기고 **그 행을 누른다**(= 차트 종목 전환).
 *
 *  스코프는 가장 가까운 `[data-quote-nav]`(드로어 스크롤 컨테이너) — 관심종목은 폴더별로
 *  `<ul>` 이 여러 개라 형제 이동만으론 그룹 경계를 못 넘는다. 없으면 부모로 폴백.
 *
 *  **선택을 `click()` 으로 하는 것이 이 함수의 계약이다.** 행마다 이동의 뜻이 다르고
 *  (관심종목은 종목만, 패턴 매치는 종목 + 그 날의 구간) 그걸 여기서 다시 알 필요가 없다.
 *  클릭 경로 하나만 남으므로 마우스와 키보드가 조용히 갈라지지도 않는다.
 *
 *  행 마커는 `data-quote-row` 다. 붙이지 않은 행은 이동에서 **건너뛴다** —
 *  `watchlist/MemoRow` 가 그렇게 빠져 있다(차트로 가지 않는 행이라서).
 *
 *  반환 `true` = 이 키를 처리했다. 호출자는 `preventDefault()` 로 **컨테이너 스크롤을
 *  막는다** — 갈 곳이 없어도(첫·마지막 행) true 다. 거기서 스크롤이 튀면 「경계에서
 *  멈춘다」 는 약속이 화면에서 깨진 것처럼 보인다.
 *
 *  소비자: `QuoteRow`(관심·히트맵·스크리너·순위)와 `pattern/PatternDrawer` 의 매치 행.
 */
export function moveToAdjacentQuoteRow(key: string, el: HTMLElement): boolean {
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return false;
  const scope = el.closest<HTMLElement>('[data-quote-nav]') ?? el.parentElement;
  if (!scope) return true;
  const rows = Array.from(scope.querySelectorAll<HTMLElement>('[data-quote-row]'));
  const target = rows[rows.indexOf(el) + (key === 'ArrowDown' ? 1 : -1)];
  if (!target) return true; // 첫/마지막 행 경계에서 멈춤(순환 없음)
  target.focus();
  target.click();
  return true;
}
