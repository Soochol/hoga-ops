import { useEffect } from 'react';

import { apiAction } from './client';
import type { LiveVenueOption } from '../state/liveVenue';

/** 빠른 탭 전환이 워밍 요청을 스팸하지 않게 하는 트레일링 디바운스.
 * 백엔드 warm_minute의 (venue, code) 단일 비행이 2차 방어선. */
const WARM_DEBOUNCE_MS = 1500;

/** 종목 활성화 시 과거 분봉 캐시 워밍을 fire-and-forget으로 요청한다.
 * 실패는 삼킨다 — 워밍은 best-effort이고, 놓친 날짜는 사용자가 팬할 때
 * 인터랙션 경로(/past-candles)가 어차피 같은 캐시를 채운다. 응답 바디는
 * 읽지 않는다 (백엔드가 상태에 따라 서로 다른 필드를 반환하고, 503도
 * 조용히 무시되어야 하는 best-effort 계약). */
export function useWarmPastCandles(code: string | null, venue: LiveVenueOption): void {
  useEffect(() => {
    if (!code) return;
    const id = setTimeout(() => {
      void apiAction(`/api/live/warm-past-candles?code=${code}&venue=${venue}`, {
        method: 'POST',
      }).catch(() => undefined);
    }, WARM_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [code, venue]);
}
