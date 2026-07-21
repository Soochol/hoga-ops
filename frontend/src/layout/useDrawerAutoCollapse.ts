import { useEffect, useRef } from 'react';
import { useRightRailStore } from '../state/rightRail';

/**
 * 우측 드로어가 열려 있을 때만 걸리는 2차 바닥.
 *
 * 셸 바닥(`--app-floor-min-w`)은 **드로어가 닫힌** 상태의 크롬을 기준으로 잡혀
 * 있다(TopNav 자연폭 939px + 레일 54px). 드로어가 열리면 TopNav 가 있는 1fr 열이
 * 드로어 폭만큼 줄어서, 바닥 위인데도 nav 가 잘린다 — 1100px + 관심 드로어에서
 * 가용 695px vs 필요 939px 실측(2026-07-21). 그래서 좁아질 때 주변부(드로어)가
 * 코어에게 자리를 양보한다. 접는 건 주변부뿐이고 코어는 건드리지 않는다(토스식).
 *
 * 임계 = 셸 바닥 + 드로어 폭. 하드 최소는 939+315+54=1308px 이고 임계는 그 위다.
 * 값을 토큰에서 실시간으로 읽는 이유: 미디어쿼리는 CSS 변수를 못 쓰고, 하드코딩하면
 * 밀도 다이얼(:root font-size)이 바뀔 때 조용히 어긋난다. `/study` 스플리터가
 * 더블클릭 시 토큰을 getComputedStyle 로 읽는 것과 같은 이유(DESIGN.md Layout).
 *
 * **1회성 양보**: 자동으로 닫는 건 좁아진 뒤 한 번뿐이다. 그 폭에서 사용자가 다시
 * 열면 그대로 둔다 — 사용자가 상황을 알고 연 것이므로. 다시 넓어지면 양보 플래그가
 * 풀려, 다음에 좁아질 때 한 번 더 양보한다. 자동으로 다시 열지는 않는다(사용자가
 * 직접 닫은 것과 구분되지 않으므로).
 */
function readTokenPx(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (raw.endsWith('rem')) {
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return parseFloat(raw) * rootPx;
  }
  return parseFloat(raw) || 0;
}

export function useDrawerAutoCollapse(): void {
  const yielded = useRef(false);

  useEffect(() => {
    const check = () => {
      const threshold = readTokenPx('--app-floor-min-w') + readTokenPx('--watchlist-panel-w');
      if (window.innerWidth >= threshold) {
        yielded.current = false;
        return;
      }
      if (yielded.current) return;
      const { activePanel, setActivePanel } = useRightRailStore.getState();
      if (activePanel === null) return;
      yielded.current = true;
      setActivePanel(null);
    };

    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
}
