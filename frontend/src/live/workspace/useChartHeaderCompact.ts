import { type RefObject, useEffect, useState } from 'react';
import { HEADER_FOLD_NONE, nextHeaderFold, type HeaderFold } from './chartHeaderCompact';

/**
 * 헤더 컨테이너 폭을 관측해 접힘 단계를 정한다 — 접힘의 React 경계.
 *
 * 판정 로직은 `chartHeaderCompact.ts` 가 갖고, 여기서는 관측만 한다
 * (`usePaneFolding` 과 같은 분리). 관측 대상이 **컨테이너 폭**이라 접힘이
 * 관측값을 되바꾸지 않는다 — 피드백 루프 없음.
 */
export function useChartHeaderFold(ref: RefObject<HTMLElement | null>): HeaderFold {
  const [fold, setFold] = useState<HeaderFold>(HEADER_FOLD_NONE);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // 직전 상태는 setState 업데이터로 읽는다 — effect 를 fold 에 의존시키면
    // 상태가 바뀔 때마다 관측자가 재구독된다.
    const push = (width: number): void => {
      setFold((prev) => {
        const next = nextHeaderFold(width, prev);
        return next.compactActions === prev.compactActions
          && next.compactTimeframe === prev.compactTimeframe
          ? prev
          : next;
      });
    };
    push(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      push(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return fold;
}
