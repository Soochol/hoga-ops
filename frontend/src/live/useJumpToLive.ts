import { useNavigate, useLocation } from 'react-router';
import { useLiveTabsStore } from '../state/liveTabs';

/** 차트로 점프: 종목 탭을 열거나 포커스하고, /live 가 아니면 이동한다.
 *  관심종목/스크리너/히트맵 행 클릭의 공통 jump-to-chart 동작(CONTEXT.md).
 *  탭 도입(ADR-0069) 이후 setActiveCode 직접 호출 대신 openOrFocusTab을 쓴다 —
 *  활성 탭이 useLivePageStore.activeCode의 단일 writer(D4). */
export function useJumpToLive() {
  const openOrFocusTab = useLiveTabsStore((s) => s.openOrFocusTab);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (code: string, label?: string) => {
    openOrFocusTab(code, label);
    if (pathname !== '/live') navigate('/live');
  };
}
