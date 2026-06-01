import { useNavigate, useLocation } from 'react-router';
import { useLivePageStore } from '../state/livePage';

/** 차트로 점프: activeCode(SSOT)를 code 로 설정하고, /live 가 아니면 이동한다.
 *  관심종목/스크리너 패널 행 클릭의 공통 jump-to-chart 동작(CONTEXT.md)을 한 곳에
 *  모은다 — 두 패널에서 router 보일러플레이트(useNavigate/useLocation)를 제거. */
export function useJumpToLive() {
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (code: string) => {
    setActiveCode(code);
    if (pathname !== '/live') navigate('/live');
  };
}
