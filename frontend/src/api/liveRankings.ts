/** GET /api/live/rankings — 우측 RightRail "순위" 드로어(특징주).
 *
 * 백엔드가 (kind,market,direction) TTL~8s 로 키움 rkinfo 콜을 코얼레스하므로
 * 프론트는 10s 폴링만 한다. 폴링 주기는 응답의 market_open 이 정하고, 장외엔 60s
 * 하트비트로 낮춘다(그릴링 결정 9 의 "장외엔 아끼자" 를 지키는 최소 주기 —
 * 완전히 멈추면 장이 열려도 못 깨어난다) — refetchInterval 을
 * market_open 으로 게이트해 프론트에 장운영 시계를 두지 않는다. 자격증명 부재 시
 * 503 이고, 드로어가 에러 상태를 렌더한다. */
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import { useLiveVenueStore } from '../state/liveVenue';

export type RankingKind = 'change' | 'surge' | 'volume' | 'value' | 'program' | 'institution' | 'foreign';
export type RankingMarket = 'all' | 'kospi' | 'kosdaq';
export type RankingDirection = 'up' | 'down';

export interface RankingRow {
  rank: number;
  code: string;
  name: string;
  price: number | null;
  change_pct: number | null;
  trade_value_won: number | null;
  program_net_buy_won?: number | null;
  investor_net_buy_won?: number | null;
}

interface RankingsResponseWire {
  kind: RankingKind;
  market: RankingMarket;
  direction: RankingDirection;
  rows: RankingRow[];
  market_open: boolean;
  fetched_at_ms: number;
  /** 순위 거래소. 기관·외국인은 지정 미지원(null), 구버전의 생략은 KRX. */
  venue?: string | null;
  quote_venue?: string | null;
  /** 비치명 경고. 구버전 백엔드는 이 키가 없으므로 옵셔널. */
  warnings?: string[];
}

export interface RankingsView {
  rows: RankingRow[];
  marketOpen: boolean;
  fetchedAtMs: number;
  /** 순위 거래소. 기관·외국인 API는 거래소 지정 미지원(null). */
  venue: string | null;
  quoteVenue?: string | null;
  /** exclude_etf 를 요청했으나 심볼 마스터 미로드로 걸러내지 못했다. 드로어가
   *  배지를 띄운다 — 이게 없으면 사용자에겐 "토글이 안 먹는" 상태로만 보인다. */
  etfFilterUnavailable: boolean;
}

export const RANKINGS_REFETCH_MS = 10_000;
/** 순매수 탭은 연속조회·배치 시세가 필요하므로 30초 단위로 갱신한다. */
export const NET_BUY_RANKINGS_REFETCH_MS = 30_000;
/** 장외 하트비트 — 게이트를 살려 두기 위한 최소 주기다(0 이나 false 가 아니다). */
export const RANKINGS_OFF_HOURS_MS = 60_000;

export function useLiveRankings(params: {
  kind: RankingKind;
  market: RankingMarket;
  direction: RankingDirection;
  excludeEtf: boolean;
}) {
  const { kind, market, direction, excludeEtf } = params;
  const netBuy = kind === 'program' || kind === 'institution' || kind === 'foreign';
  const requestDirection = netBuy ? 'up' : direction;
  const refetchMs = netBuy ? NET_BUY_RANKINGS_REFETCH_MS : RANKINGS_REFETCH_MS;
  // 기존 순위와 프로그램은 거래소 선택기를 따른다(ADR-0140).
  // 기관·외국인은 거래소 입력이 없어 순위를 그대로 두고 보완 시세에만 적용한다.
  const venue = useLiveVenueStore((s) => s.venue);
  return useQuery({
    // ⚠ venue 가 **쿼리 키에도** 있어야 한다 — 없으면 venue 를 바꿔도 캐시가 안 갈려
    // 이전 거래소 순위가 그대로 보인다.
    queryKey: ['live-rankings', kind, market, requestDirection, excludeEtf, venue],
    queryFn: async ({ signal }): Promise<RankingsView> => {
      const q = new URLSearchParams({ kind, market, direction: requestDirection, venue });
      if (excludeEtf) q.set('exclude_etf', 'true');
      const res = await apiCall<RankingsResponseWire>(`/api/live/rankings?${q}`, { signal });
      return {
        rows: res.rows,
        marketOpen: res.market_open,
        fetchedAtMs: res.fetched_at_ms,
        // 응답이 되싣은 값을 쓴다 — 요청 venue 를 그대로 믿지 않는다.
        venue: res.venue === undefined ? 'KRX' : res.venue,
        quoteVenue: res.quote_venue,
        etfFilterUnavailable: res.warnings?.includes('etf_filter_unavailable') ?? false,
      };
    },
    // 장중이면 10s, 장외면 60s 하트비트. **`false` 로 완전히 멈추면 안 된다** —
    // 함수형 `refetchInterval` 은 `false` 를 반환하는 순간 타이머가 사라지고,
    // 타이머가 없으면 fetch 도 재평가도 없어 **장이 열려도 스스로 못 깨어난다**
    // (2026-08-07 실측 · `api/market.ts` 의 `pollWhileOpen` 과 같은 함정).
    // 장외 폴링을 아끼려던 원 의도(그릴링 결정 9)는 60s 하트비트로 지킨다 —
    // 백엔드가 TTL~8s 로 코얼레스하므로 유휴 요청은 캐시 응답이다.
    refetchInterval: (query) =>
      query.state.data?.marketOpen ? refetchMs : RANKINGS_OFF_HOURS_MS,
    staleTime: netBuy ? NET_BUY_RANKINGS_REFETCH_MS : 8_000,
  });
}
