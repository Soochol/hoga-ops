import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaneStretchMap } from '../chart/paneOrder';
import { paneGroupStretch, type PaneSpecGroup } from './paneGroupSpecs';
import {
  foldPanes,
  INITIAL_FOLD_STATE,
  type PaneFoldState,
} from './paneFolding';

/** 접기 결과 — 원자 단위가 **pane 그룹**이다(그룹의 절반만 접는 상태는 없다). */
export type PaneGroupFoldResult = {
  groups: readonly PaneSpecGroup[];
  foldedCount: number;
  timeAxisVisible: boolean;
};

/**
 * 차트 컨테이너 높이를 관측해 `foldPanes` 를 적용한다 — 접기의 React 경계.
 *
 * 순수 계산(무엇을 접을지)은 `paneFolding.ts` 가, 여기서는 두 가지만 한다:
 * 높이 관측과 히스테리시스에 필요한 직전 상태 보관. pane 병합 이후 접기의 원자
 * 단위는 **그룹**이다 — 항목이 그룹이고 stretch 가 `paneGroupStretch` 일 뿐,
 * 판정은 종전과 동일하다(`foldPanes` 는 제네릭).
 *
 * **피드백 루프가 없다는 점이 중요하다.** 관측 대상인 컨테이너 높이는 상위 그리드가
 * `minmax(0,1fr)` 로 확정해 주므로(#730), 접기가 pane 수를 바꿔도 컨테이너 높이는
 * 변하지 않는다. 즉 `높이 → 접힘 → 높이` 로 되돌아오는 경로가 없다. lightweight-charts
 * 의 `autoSize` 가 같은 요소를 관측하지만 그쪽도 컨테이너를 *읽기*만 한다.
 *
 * **관측 대상은 `RefObject` 로 받지 않고 callback ref 를 돌려준다**(`useChartHeaderFold`
 * 와 같은 형태). ref 객체는 렌더 간 identity 가 고정이라 deps 에 넣어도 "노드가
 * 생겼다" 를 말해 주지 못하고, effect 가 첫 렌더에 `ref.current === null` 로 조기
 * 반환하면 다시 돌 기회가 없다 — 관측자가 영영 안 붙는다.
 *
 * ⚠️ **이 전환은 예방이다.** 지금 유일한 호출처(`LiveChartRoot`)의 차트 컨테이너는
 * 조건부 렌더 아래가 아니라 항상 첫 커밋에 있어 옛 형태로도 관측이 붙었다 — 즉
 * 고친 증상이 없다. 같은 결함이 실제로 터진 것은 `/live` 차트 창 헤더 쪽이었고
 * (헤더는 종목이 없으면 렌더되지 않아 **첫 마운트 이후에 등장**한다), 이 훅은 그때
 * 지목된 동류다. 컨테이너를 조건부 렌더 아래로 옮기면 옛 형태는 조용히 죽는다.
 *
 * 타이밍은 등가다: callback ref 도 커밋의 ref-부착 단계에 돌고 측정은 양쪽 다
 * `useEffect`(페인트 후)라, 마운트 시 리렌더 1회가 느는 것 외에 관찰 가능한 차이가
 * 없다.
 */
export function usePaneFolding(
  groups: readonly PaneSpecGroup[],
  paneStretch: PaneStretchMap,
): [PaneGroupFoldResult, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [heightPx, setHeightPx] = useState(0);

  useEffect(() => {
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
  }, [el]);

  // 히스테리시스 기준점. 렌더 중 갱신하지만 `foldPanes` 는 dead band 안에서 멱등이라
  // (같은 입력+같은 직전 상태 → 같은 출력) StrictMode 이중 렌더에서도 수렴한다.
  const stateRef = useRef<PaneFoldState>(INITIAL_FOLD_STATE);

  const { foldedCount, timeAxisVisible } = useMemo(() => {
    const stretchOf = (group: PaneSpecGroup): number => paneGroupStretch(group, paneStretch);
    const next = foldPanes(groups, heightPx, stretchOf, stateRef.current);
    stateRef.current = {
      foldedCount: next.foldedCount,
      timeAxisVisible: next.timeAxisVisible,
    };
    return next;
  }, [groups, heightPx, paneStretch]);

  // 목록 identity 는 (원본, 접힘 수)에만 의존한다 — 드래그 중 높이가 1px 씩 바뀌어도
  // 접힘 수가 그대로면 같은 배열을 돌려줘 하위 재조정이 돌지 않는다.
  const foldedGroups = useMemo(
    () => (foldedCount === 0 ? groups : groups.slice(0, groups.length - foldedCount)),
    [groups, foldedCount],
  );

  // 결과 객체는 접힘 수가 그대로면 같은 필드값을 돌려주지만 객체 자체는 매 렌더
  // 새로 만든다 — 소비처가 구조분해로 받아 쓰므로(위 `foldedGroups` 의 identity 가
  // 실제 계약) 여기서 memo 할 이득이 없다. 튜플로 감싸도 같다.
  return [{ groups: foldedGroups, foldedCount, timeAxisVisible }, setEl];
}
