import { useNavigate, useLocation } from 'react-router';
import { useLiveTabsStore } from '../state/liveTabs';

/** 차트로 점프: 현재(활성) 탭의 종목을 바꾸고, /live 가 아니면 이동한다.
 *  관심종목/스크리너/히트맵 행 클릭의 공통 jump-to-chart 동작(CONTEXT.md).
 *  단일-탭 내비게이션 모델(ADR-0069 개정): 클릭은 새 탭을 열지 않고 현재 탭을 바꾼다.
 *  활성 탭이 없으면 setActiveTabCode가 첫 탭을 만든다. 활성 탭이
 *  useLivePageStore.activeCode의 단일 writer(D4). */
export function useJumpToLive() {
  const setActiveTabCode = useLiveTabsStore((s) => s.setActiveTabCode);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (code: string, label?: string) => {
    setActiveTabCode(code, label);
    if (pathname !== '/live') navigate('/live');
  };
}
