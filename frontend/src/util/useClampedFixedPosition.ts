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

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos(clampToViewport(rawLeft, rawTop, width, height, window.innerWidth, window.innerHeight));
  }, [rawLeft, rawTop]);

  return { ref, left: pos.left, top: pos.top };
}
