// frontend/src/util/useAnchoredPopover.ts
//
// 트리거에 붙어 뜨는 팝오버를 **조상의 overflow 밖으로 탈출**시키는 배치 계약.
//
// `position: absolute` 팝오버는 조상 중 하나라도 `overflow: hidden|auto` 면 거기서
// 잘린다. 설정 모달이 정확히 그 형상이라 색·굵기 팔레트가 카드 오른쪽에서 잘려
// 나갔다(실측 2026-08-22: 8열 팔레트 중 4열, 굵기 카드 4개 중 1개만 보였다).
// 클리핑 주체는 **두 겹**이었다 —
//   1. `WORKSPACE_PANEL_SHELL_CLASS` 의 `overflow-hidden` (카드 경계 하드 클립)
//   2. 상세 `<section>` 의 `overflow-y-auto` — CSS 명세상 한 축이 `visible` 이 아니면
//      나머지 축의 `visible` 은 `auto` 로 승격된다. 그래서 세로 스크롤만 원했는데
//      **가로 스크롤바가 유령처럼 생기고** 팝오버는 스크롤 영역 안에 갇힌다.
// 두 컨테이너 모두 제 역할이 있어 손댈 수 없다(둥근 모서리 클립·마스터-디테일 스크롤).
// 답은 팝오버를 조상 사슬에서 빼내는 것 — `createPortal(document.body)` + `fixed`.
//
// 위치는 `useClampedFixedPosition` 이 마운트 후 실측으로 뷰포트에 클램프하므로
// 호출부는 "트리거 왼쪽 아래" 라는 의도만 적으면 된다. 오른쪽으로 넘치면 훅이
// 왼쪽으로 미끄러뜨린다 — 호출부가 `left`/`right` 정렬을 미리 고를 필요가 없다.
//
// 스크롤·리사이즈에는 **닫는다**. `fixed` 는 뒤 컨테이너가 스크롤돼도 따라가지
// 않아 트리거에서 떨어져 나가는데, 그 상태는 "잘림" 보다 더 헷갈린다. 위치를 매
// 스크롤 프레임 재계산하는 길도 있지만, 팔레트는 열자마자 한 번 클릭하고 닫는
// 표면이라 닫기가 더 예측 가능하다(MUI Popover 의 기본값과 같은 선택).

import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import { useClampedFixedPosition } from './useClampedFixedPosition';
import { useDismissablePopover } from './useDismissablePopover';

/** 트리거와 팝오버 사이 간격(px). DESIGN.md 의 --space-xs 와 같은 4px. */
const GAP = 4;

export function useAnchoredPopover<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  /** 트리거(또는 트리거를 감싼 wrapper) — 앵커 측정과 dismiss 판정에 함께 쓴다. */
  anchorRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  // 열릴 때 트리거 rect 를 읽어 raw 앵커(트리거 왼쪽 아래)를 잡는다. jsdom 은
  // 레이아웃을 못 해 rect 가 전부 0 이지만 클램프도 0 을 통과시키므로 무해하다.
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!isOpen) return;
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.left, top: r.bottom + GAP });
  }, [isOpen, anchorRef]);

  const { ref, left, top } = useClampedFixedPosition<T>(anchor.left, anchor.top);

  // 포털이라 팝오버가 앵커 서브트리 밖 — 레이어 ref 를 함께 넘겨야 팝오버 안
  // mousedown 이 "바깥" 으로 오해받지 않는다(넘기지 않으면 색을 **고를 수 없다**).
  useDismissablePopover(isOpen, anchorRef, onDismiss, ref);

  // capture 단계라 안쪽 스크롤 컨테이너(설정 상세 section)의 스크롤도 잡는다 —
  // scroll 은 버블링하지 않으므로 bubble 리스너로는 window 스크롤만 보인다.
  useEffect(() => {
    if (!isOpen) return;
    const close = () => onDismiss();
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [isOpen, onDismiss]);

  // z: ModalShell 백드롭이 z-[60] 이다. 포털된 팝오버는 백드롭과 같은 body 자식이라
  // 그보다 낮으면 **백드롭 뒤로 숨는다** — 잘리는 것보다 나쁘다(게다가 백드롭이
  // mousedown 을 먹어 설정 모달이 통째로 닫힌다). 토스트(z-[90]) 아래에 둔다.
  const style = useMemo<CSSProperties>(
    () => ({ position: 'fixed', left, top, zIndex: 70 }),
    [left, top],
  );

  return { ref, style };
}
