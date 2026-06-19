import { useNavigate, useLocation } from 'react-router';
import { useLiveTabsStore } from '../state/liveTabs';
import type { LiveOpenDisposition } from './liveActivation';

type JumpToLiveOptions = {
  disposition?: LiveOpenDisposition;
};

/** 차트로 점프: 기본은 현재(활성) 탭의 종목을 바꾸고, 명시적 새 탭 intent(Ctrl/Meta 클릭)는
 *  종목이 채워진 새 탭을 만든다. /live 가 아니면 이동한다.
 *  관심종목/스크리너/히트맵 행 클릭의 공통 jump-to-chart 동작(CONTEXT.md).
 *  활성 탭이 없으면 setActiveTabCode가 첫 탭을 만든다. 활성 탭이
 *  useLivePageStore.activeCode의 단일 writer(D4). */
export function useJumpToLive() {
  const setActiveTabCode = useLiveTabsStore((s) => s.setActiveTabCode);
  const openSymbolInNewTab = useLiveTabsStore((s) => s.openSymbolInNewTab);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (code: string, label?: string, options: JumpToLiveOptions = {}) => {
    if (options.disposition === 'new-tab') openSymbolInNewTab(code, label);
    else setActiveTabCode(code, label);
    if (pathname !== '/live') navigate('/live');
  };
}
