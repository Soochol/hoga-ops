import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import { flowRefetchInterval, type FlowCollection, type InvestorFlowPoint } from './market';

export interface InvestorFlowSummaryGroup {
  date: string;
  unit: string | null;
  confirmed: boolean;
  collection: FlowCollection | null;
  markets: Record<string, InvestorFlowPoint | null>;
}

export interface InvestorFlowSummaryResponse {
  stock: InvestorFlowSummaryGroup;
  futures: InvestorFlowSummaryGroup;
}

/** 전역 하단 바에는 일별 이력이나 하루치 시계열을 내려받지 않는다. */
export function useMarketInvestorFlowSummary() {
  return useQuery({
    queryKey: ['market', 'investor-flow-summary'],
    queryFn: async ({ signal }) => {
      const response = await apiCall<InvestorFlowSummaryResponse>(
        '/api/market/investor-flow-summary', { signal },
      );
      if (!response?.stock?.markets || !response?.futures?.markets) {
        throw new Error('시장 수급 응답 형식 오류');
      }
      return response;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      return Math.min(
        flowRefetchInterval(data?.stock.collection),
        flowRefetchInterval(data?.futures.collection),
      );
    },
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 5_000,
  });
}
