import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { applySectorTick } from './sectorTickOverlay';
import type { PushEvent } from './types';
import { subscribeEvents } from './ws';

/** 키움 0J/0U 오버레이 구독 — **앱 루트에 하나만** 건다.
 *
 *  `/market` 안에 두면 안 된다: 하단 지수 바(`MarketIndexBar`)가 모든 페이지에
 *  붙어 있어서, 라이브·히트맵·스크리너에서도 지수가 실시간이어야 한다. 페이지마다
 *  걸면 같은 이벤트를 여러 번 적용해 캐시 쓰기가 중복된다.
 *
 *  이 훅이 없거나 죽어도 화면은 폴링(30s)으로 정상 동작한다 — 그래서 **누락이
 *  무증상**이고, 실제로 흐르는지는 `/api/live/status` 의 `kiwoom.sector` 로 본다.
 */
export function useSectorTickEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeEvents((e: PushEvent) => {
      if (e.type === 'market_sector_tick') applySectorTick(qc, e);
    });
  }, [qc]);
}
