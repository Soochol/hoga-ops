import { useLayoutEffect, useRef, useState } from 'react';
import { clampToViewport } from './clampToViewport';

/**
 * `position: fixed` 부동 레이어(커서 컨텍스트 메뉴, 버튼 앵커 드롭다운)의 위치를
 * 뷰포트 안으로 보정한다. 원하는 raw `(left, top)` 으로 일단 렌더하고, 렌더 후
 * `useLayoutEffect` 에서 자기 rect 를 측정해 `clampToViewport` 로 클램프(paint 전
 * 동기 → 깜빡임 없음, 매직넘버 없음). 반환한 `ref` 를 레이어 요소에, `{left, top}` 을
 * 그 `style` 에 연결한다.
 *
 * 측정+클램프+state 의 dance 를 한 곳에 모은다(ConditionBuilder·WatchlistRowMenu
 * 공용) — 호출부는 raw 앵커(커서 clientX/Y 또는 anchorRect 파생)만
 * 계산하면 된다. 클램프 수학은 순수 `clampToViewport` 로 분리돼 단위 테스트된다.
 */
export function useClampedFixedPosition<T extends HTMLElement = HTMLElement>(
  rawLeft: number,
  rawTop: number,
) {
  const ref = useRef<T>(null);
  const [pos, setPos] = useState({ left: rawLeft, top: rawTop });

  // **deps 가 없다 — 레이어는 뜬 뒤에 자란다.** `[rawLeft, rawTop]` 만 보면 클램프가
  // 마운트 시점의 높이로 굳는데, 이 레이어들은 그 뒤 내용이 붙으면서 커진다: 관심종목
  // 추가 팝오버는 중복 안내 배너가 붙으면 151px 이 되어 커서가 화면 아래쪽이면 **그
  // 문장이 뷰포트 밖으로 잘린다**(실측 bottom 779 > 720 — 정작 상황을 설명하는 부분이
  // 안 보인다). 크기 변화는 곧 리렌더이므로 매 커밋에서 다시 재면 그 순간을 놓치지 않는다.
  //
  // 무한 루프는 두 가지가 함께 막는다: `clampToViewport` 는 현재 위치를 입력으로 받지
  // 않는 **순수·멱등** 함수이고(같은 rect 면 같은 답), 값이 같으면 setPos 를 아예 부르지
  // 않는다. 후자가 없으면 새 객체 identity 때문에 매번 리렌더가 돈다.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const next = clampToViewport(rawLeft, rawTop, width, height, window.innerWidth, window.innerHeight);
    setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  });

  return { ref, left: pos.left, top: pos.top };
}
