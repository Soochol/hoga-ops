import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { BoundPaneSpec } from '../chart/paneSpecs';
import type { PaneStretchMap } from '../chart/paneOrder';
import {
  foldPanes,
  INITIAL_FOLD_STATE,
  type PaneFoldResult,
  type PaneFoldState,
} from './paneFolding';

/**
 * 차트 컨테이너 높이를 관측해 `foldPanes` 를 적용한다 — 접기의 React 경계.
 *
 * 순수 계산(무엇을 접을지)은 `paneFolding.ts` 가, 여기서는 두 가지만 한다:
 * 높이 관측과 히스테리시스에 필요한 직전 상태 보관.
 *
 * **피드백 루프가 없다는 점이 중요하다.** 관측 대상인 컨테이너 높이는 상위 그리드가
 * `minmax(0,1fr)` 로 확정해 주므로(#730), 접기가 pane 수를 바꿔도 컨테이너 높이는
 * 변하지 않는다. 즉 `높이 → 접힘 → 높이` 로 되돌아오는 경로가 없다. lightweight-charts
 * 의 `autoSize` 가 같은 요소를 관측하지만 그쪽도 컨테이너를 *읽기*만 한다.
 */
export function usePaneFolding(
  specs: readonly BoundPaneSpec[],
  containerRef: RefObject<HTMLElement | null>,
  paneStretch: PaneStretchMap,
): PaneFoldResult {
  const [heightPx, setHeightPx] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    // 서브픽셀 진동으로 재계산이 도는 것을 막는다 — 0.5px 미만 변화는 무시.
    const push = (h: number): void => {
      setHeightPx((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
    };
    push(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      push(entries[0]?.contentRect.height ?? el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // 히스테리시스 기준점. 렌더 중 갱신하지만 `foldPanes` 는 dead band 안에서 멱등이라
  // (같은 입력+같은 직전 상태 → 같은 출력) StrictMode 이중 렌더에서도 수렴한다.
  const stateRef = useRef<PaneFoldState>(INITIAL_FOLD_STATE);

  const { foldedCount, timeAxisVisible } = useMemo(() => {
    const stretchOf = (spec: BoundPaneSpec): number => paneStretch[spec.name] ?? spec.stretch;
    const next = foldPanes(specs, heightPx, stretchOf, stateRef.current);
    stateRef.current = {
      foldedCount: next.foldedCount,
      timeAxisVisible: next.timeAxisVisible,
    };
    return next;
  }, [specs, heightPx, paneStretch]);

  // 목록 identity 는 (원본, 접힘 수)에만 의존한다 — 드래그 중 높이가 1px 씩 바뀌어도
  // 접힘 수가 그대로면 같은 배열을 돌려줘 하위 재조정이 돌지 않는다.
  const foldedSpecs = useMemo(
    () => (foldedCount === 0 ? specs : specs.slice(0, specs.length - foldedCount)),
    [specs, foldedCount],
  );

  return { specs: foldedSpecs, foldedCount, timeAxisVisible };
}
