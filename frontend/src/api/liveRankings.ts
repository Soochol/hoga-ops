/** GET /api/live/rankings — 우측 RightRail "순위" 드로어(특징주).
 *
 * 백엔드가 (kind,market,direction) TTL~8s 로 키움 rkinfo 콜을 코얼레스하므로
 * 프론트는 10s 폴링만 한다. 폴링은 응답의 market_open 이 true 일 때만 계속되고,
 * 장외(false)엔 열 때 1회 조회 후 멈춘다(그릴링 결정 9) — refetchInterval 을
 * market_open 으로 게이트해 프론트에 장운영 시계를 두지 않는다. 자격증명 부재 시
 * 503 이고, 드로어가 에러 상태를 렌더한다. */
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export type RankingKind = 'change' | 'surge' | 'volume' | 'value';
export type RankingMarket = 'all' | 'kospi' | 'kosdaq';
export type RankingDirection = 'up' | 'down';

export interface RankingRow {
  rank: number;
  code: string;
  name: string;
  price: number | null;
  change_pct: number | null;
}

interface RankingsResponseWire {
  kind: RankingKind;
  market: RankingMarket;
  direction: RankingDirection;
  rows: RankingRow[];
  market_open: boolean;
  fetched_at_ms: number;
}

export interface RankingsView {
  rows: RankingRow[];
  marketOpen: boolean;
  fetchedAtMs: number;
}

export const RANKINGS_REFETCH_MS = 10_000;

export function useLiveRankings(params: {
  kind: RankingKind;
  market: RankingMarket;
  direction: RankingDirection;
  excludeEtf: boolean;
}) {
  const { kind, market, direction, excludeEtf } = params;
  return useQuery({
    queryKey: ['live-rankings', kind, market, direction, excludeEtf],
    queryFn: async ({ signal }): Promise<RankingsView> => {
      const q = new URLSearchParams({ kind, market, direction });
      if (excludeEtf) q.set('exclude_etf', 'true');
      const res = await apiCall<RankingsResponseWire>(`/api/live/rankings?${q}`, { signal });
      return { rows: res.rows, marketOpen: res.market_open, fetchedAtMs: res.fetched_at_ms };
    },
    // 장중이면 10s 폴링, 장외면 첫 응답(market_open=false) 뒤 멈춘다.
    refetchInterval: (query) => (query.state.data?.marketOpen ? RANKINGS_REFETCH_MS : false),
    staleTime: 8_000,
  });
}
