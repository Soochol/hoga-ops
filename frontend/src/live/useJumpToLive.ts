import { useNavigate, useLocation } from 'react-router';
import { activateLiveCode } from './liveNavigate';

/** 차트로 점프: 현재 뷰의 종목을 바꾸고, `/live`가 아니면 이동한다.
 *  관심종목/스크리너/히트맵/알림 행 클릭의 공통 jump-to-chart 동작(CONTEXT.md).
 *  activeCode 단일 writer = `projectActiveView`(ADR-0113 — 탭 제거로 단일 뷰 복귀). */
export function useJumpToLive() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (code: string, label?: string) => {
    activateLiveCode(code, label);
    if (pathname !== '/live') navigate('/live');
  };
}
