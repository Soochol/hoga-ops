/** GET /api/live/index-quotes — 하단 시장지표 바 데이터.
 *
 * 백엔드가 20s TTL 로 KIS 콜을 코얼레스하므로 프론트는 30s 폴링만 한다
 * (RQ 기본값이 백그라운드 탭 폴링을 멈춘다). 자격증명/용량 부재 시 빈
 * 배열이 오고, MarketIndexBar 가 행 자체를 렌더하지 않는다. */
import { useQuery } from '@tanstack/react-query';
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

export const MARKET_INDEX_QUOTES_REFETCH_MS = 30_000;

export function useMarketIndexQuotes() {
  return useQuery({
    queryKey: ['market-index-quotes'],
    queryFn: async ({ signal }) => {
      const response = await apiCall<MarketIndexQuotesResponseWire>(
        '/api/live/index-quotes',
        { signal },
      );
      return response.quotes.map(mapQuote);
    },
    refetchInterval: MARKET_INDEX_QUOTES_REFETCH_MS,
    staleTime: 20_000,
  });
}
