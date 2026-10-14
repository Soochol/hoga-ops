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
  // auto 폭의 fixed 메뉴는 현재 left에 따라 가용 폭·줄바꿈·높이가 달라진다.
  // 보정된 위치에서 다시 재면 크기 → 위치 → 크기의 순환이 생길 수 있으므로,
  // paint 전에 잠깐 원점에서 재고 원래 inline 위치를 복구한다. 매 커밋 같은
  // 공간에서 측정하므로 내용이 바뀔 때만 크기가 바뀐다.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { left, top } = el.style;
    let rect: DOMRect;
    try {
      el.style.left = '0px';
      el.style.top = '0px';
      rect = el.getBoundingClientRect();
    } finally {
      el.style.left = left;
      el.style.top = top;
    }
    const { width, height } = rect;
    const next = clampToViewport(rawLeft, rawTop, width, height, window.innerWidth, window.innerHeight);
    setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  });

  return { ref, left: pos.left, top: pos.top };
}
