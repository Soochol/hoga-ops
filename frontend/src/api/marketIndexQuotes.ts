/** GET /api/live/index-quotes — 하단 시장지표 바 데이터.
 *
 * 백엔드가 20s TTL 로 키움 콜을 코얼레스하므로 프론트는 30s 폴링만 한다
 * (RQ 기본값이 백그라운드 탭 폴링을 멈춘다). 자격증명/용량 부재 시 빈
 * 배열이 오고, MarketIndexBar 가 행 자체를 렌더하지 않는다. */
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';

interface MarketIndexQuoteWire {
  id: string;
  label: string;
  value: number;
  change: number;
  change_rate: number;
  t_ms: number;
}

interface MarketIndexQuotesResponseWire {
  quotes: MarketIndexQuoteWire[];
}

export interface MarketIndexQuote {
  id: string;
  label: string;
  value: number;
  change: number;
  changeRate: number;
  tMs: number;
}

function mapQuote(wire: MarketIndexQuoteWire): MarketIndexQuote {
  return {
    id: wire.id,
    label: wire.label,
    value: wire.value,
    change: wire.change,
    changeRate: wire.change_rate,
    tMs: wire.t_ms,
  };
}

/** Preserve a newer WS observation when an older REST poll completes. */
export function mergeIndexQuotes(previous: MarketIndexQuote[] | undefined, incoming: MarketIndexQuote[]): MarketIndexQuote[] {
  const before = new Map(previous?.map((q) => [q.id, q]));
  return incoming.map((q) => {
    const old = before.get(q.id);
    return old && old.tMs > q.tMs ? old : q;
  });
}

export const MARKET_INDEX_QUOTES_REFETCH_MS = 30_000;

export function useMarketIndexQuotes() {
  const qc = useQueryClient();
  // WS가 쓰는 표시 캐시에는 타이머를 걸지 않는다. setQueryData마다 QueryObserver가
  // 타이머를 다시 시작하므로 잦은 틱이 REST 전용 KRX100의 조회를 영원히 미룬다.
  const display = useQuery<MarketIndexQuote[]>({
    queryKey: ['market-index-quotes'],
    queryFn: skipToken,
  });
  const poll = useQuery({
    queryKey: ['market-index-quotes-poll'],
    queryFn: async ({ signal }) => {
      const response = await apiCall<MarketIndexQuotesResponseWire>(
        '/api/live/index-quotes',
        { signal },
      );
      const incoming = response.quotes.map(mapQuote);
      qc.setQueryData<MarketIndexQuote[]>(['market-index-quotes'], (previous) =>
        mergeIndexQuotes(previous, incoming),
      );
      return incoming;
    },
    refetchInterval: MARKET_INDEX_QUOTES_REFETCH_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 20_000,
  });
  return { ...poll, data: display.data ?? poll.data };
}
