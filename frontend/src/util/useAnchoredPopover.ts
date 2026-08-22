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
// **정렬은 트리거 오른쪽 끝 기준**이다. 이 픽커들은 설정 행의 오른쪽 열에 사는데,
// 왼쪽 정렬로 펼치면 폭 280px 이 그대로 모달 밖(백드롭 위)으로 튀어나가 "설정 창
// 바깥에 뜬 것" 처럼 보인다. 오른쪽 정렬이면 카드 안쪽으로 펼쳐진다. 그래서 폭을
// **호출부가 값으로 넘기고** 그 값을 style 의 `width` 로도 쓴다 — 추정폭과 실제폭이
// 갈리면 정렬이 그만큼 어긋나므로, 둘을 같은 하나의 숫자로 묶어 갈릴 여지를 없앤다.
//
// 뷰포트 클램프(`useClampedFixedPosition`)는 그 뒤의 안전망이다 — 좁은 창에서
// 오른쪽 정렬조차 넘칠 때 왼쪽으로 미끄러뜨린다.
//
// 스크롤·리사이즈에는 **따라간다**(닫지 않는다). 처음엔 닫게 만들었는데 실측에서
// 바로 무너졌다: 부분적으로만 보이는 트리거를 누르면 브라우저가 포커스 스크롤을
// 일으켜 **열자마자 닫힌다**(`/browse` 에서 scrollIntoView+click 으로 재현). 앵커를
// 다시 읽어 따라가면 그 창이 아예 없어진다.
//
// 닫는 조건은 따로다 — **트리거가 보이지 않게 되면** 닫는다. `absolute` 시절에는
// 팝오버가 트리거와 함께 스크롤돼 같이 사라졌는데, `fixed` 로 옮기면서 "카드에 가려
// 안 보이는 트리거에 팝오버만 붙어 있는" 상태가 생겼다(실측: 상세 영역을 400px
// 밀면 트리거 top 68 < section top 103 인데 팝오버는 그대로 떠 있었다). 이건 포털이
// 만든 회귀라 포털이 갚아야 한다.
//
// 판정은 `IntersectionObserver` 로 한다. rect 비교로는 **조상 overflow 에 가려진**
// 경우를 알 수 없다 — 트리거는 뷰포트 좌표 안에 멀쩡히 있고 카드가 덮고 있을 뿐이다.
// IO 는 명세상 root(여기선 뷰포트)까지의 클립 사슬을 적용한 교차 영역을 주므로
// "가려짐" 과 "화면 밖" 을 한 신호로 덮는다. jsdom 에는 IO 가 없어 가드를 두지만
// **폴백 경로는 두지 않는다** — 폴백을 만들면 테스트가 재는 경로와 브라우저가 타는
// 경로가 갈린다. 테스트는 IO 를 스텁해 같은 경로를 지난다.

import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import { useClampedFixedPosition } from './useClampedFixedPosition';
import { useDismissablePopover } from './useDismissablePopover';

/** 트리거와 팝오버 사이 간격(px). DESIGN.md 의 --space-xs 와 같은 4px. */
const GAP = 4;

/** ModalShell 크롬(z-[60])보다 위, ToastViewport(z-[90])보다 아래. */
export const POPOVER_Z = 70;

/** 트리거 rect → 팝오버 raw 앵커(오른쪽 정렬, 트리거 아래). */
function anchorFrom(rect: DOMRect, width: number) {
  return { left: rect.right - width, top: rect.bottom + GAP };
}

export function useAnchoredPopover<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  /** 트리거(또는 트리거를 감싼 wrapper) — 앵커 측정과 dismiss 판정에 함께 쓴다. */
  anchorRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  /** 팝오버 폭(px). 오른쪽 정렬의 기준이자 style 의 `width` 로 그대로 나간다. */
  width: number,
) {
  // 열릴 때 트리거 rect 를 읽어 raw 앵커를 잡는다. jsdom 은 레이아웃을 못 해 rect 가
  // 전부 0 이지만 클램프도 0 을 통과시키므로 무해하다(테스트가 좌표를 재지 않는 이유).
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!isOpen) return;
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setAnchor(anchorFrom(r, width));
  }, [isOpen, anchorRef, width]);

  const { ref, left, top } = useClampedFixedPosition<T>(anchor.left, anchor.top);

  // 포털이라 팝오버가 앵커 서브트리 밖 — 레이어 ref 를 함께 넘겨야 팝오버 안
  // mousedown 이 "바깥" 으로 오해받지 않는다(넘기지 않으면 색을 **고를 수 없다**).
  useDismissablePopover(isOpen, anchorRef, onDismiss, ref);

  // capture 단계라 안쪽 스크롤 컨테이너(설정 상세 section)의 스크롤도 잡는다 —
  // scroll 은 버블링하지 않으므로 bubble 리스너로는 window 스크롤만 보인다.
  useEffect(() => {
    if (!isOpen) return;
    const sync = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const next = anchorFrom(r, width);
      // 값이 그대로면 state 를 갈아치우지 않는다 — 스크롤 프레임마다 새 객체를
      // 넣으면 움직이지도 않은 팝오버가 매번 리렌더된다.
      setAnchor((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
    };
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [isOpen, anchorRef, width]);

  // 트리거가 (스크롤이든 접힘이든) 보이지 않게 되면 닫는다 — 위 헤더의 사연 참조.
  useEffect(() => {
    if (!isOpen) return;
    const el = anchorRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      // threshold 기본 0 — 조금이라도 걸쳐 있으면 살려 둔다. 완전히 가려졌을 때만 닫힘.
      if (entries.some((e) => !e.isIntersecting)) onDismiss();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [isOpen, anchorRef, onDismiss]);

  const style = useMemo<CSSProperties>(
    () => ({
      position: 'fixed',
      left,
      top,
      width,
      // ModalShell 백드롭·카드가 z-[60] 이다. 포털된 팝오버는 그 형제(body 자식)라
      // z 를 넘겨주지 않으면 **모달 뒤에 깔린다** — 잘리는 것보다 나쁘고, 좌표는
      // 멀쩡해서 rect 검사는 전부 통과한다(실측으로 한 번 놓쳤다: `fullyVisible:
      // true` 인데 스크린샷에는 아무것도 없었다). 토스트(z-[90]) 아래에 둔다.
      zIndex: POPOVER_Z,
      // 뷰포트보다 넓어지면 클램프도 구할 수 없다(왼쪽 0 에 붙이고 오른쪽이 잘린다).
      // 아주 좁은 창에서 팝오버가 스스로 줄어들도록 상한을 둔다.
      maxWidth: 'calc(100vw - 8px)',
    }),
    [left, top, width],
  );

  return { ref, style };
}
