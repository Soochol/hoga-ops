import { useNavigate, useLocation } from 'react-router';
import { activateLiveCode, openLiveInNewTab } from './liveNavigate';
import { stockInstrument } from './liveInstrument';

/** 새 탭 여부 판정에 필요한 최소 지분 — React 의 Mouse/Keyboard 이벤트와 네이티브
 *  MouseEvent 가 모두 구조적으로 들어맞아, 호출부가 어떤 이벤트를 넘겨도 된다. */
export type JumpModifiers = Pick<MouseEvent, 'ctrlKey' | 'metaKey'>;

/** 새 탭 요청 = ctrl(Win/Linux) 또는 ⌘(mac) — 브라우저 링크의 보편 관용구.
 *  shift 는 제외한다: 브라우저에서 '새 창'이고, 리스트에서는 범위 선택 후보라
 *  나중에 충돌한다. */
function wantsNewTab(e: JumpModifiers | undefined): boolean {
  return e !== undefined && (e.ctrlKey || e.metaKey);
}

/** 차트로 점프: 현재 뷰의 종목을 바꾸고, `/live`가 아니면 이동한다.
 *  관심종목/스크리너/히트맵/알림 행 클릭의 공통 jump-to-chart 동작(CONTEXT.md).
 *  activeCode 단일 writer = `projectActiveView`(ADR-0113 — 탭 제거로 단일 뷰 복귀).
 *
 *  ctrl/⌘ 를 누른 채였다면 현재 뷰를 건드리지 않고 새 브라우저 탭으로 연다 —
 *  모든 리스트가 이 훅 하나로 수렴하므로 분기도 여기 한 곳에 둔다. */
export function useJumpToLive() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (code: string, label?: string, e?: JumpModifiers) => {
    if (wantsNewTab(e)) {
      openLiveInNewTab(stockInstrument(code, label ?? code));
      return;
    }
    activateLiveCode(code, label);
    if (pathname !== '/live') navigate('/live');
  };
}
