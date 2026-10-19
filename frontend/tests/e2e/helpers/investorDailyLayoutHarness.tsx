import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InvestorSubjectBreakdown } from '../../../src/api/types';
import { InvestorDailyWindow } from '../../../src/live/workspace/InvestorDailyWindow';
import { useInvestorDailyDisplayStore } from '../../../src/state/investorDailyDisplay';
import { useInvestorDailySpanStore } from '../../../src/state/investorDailySpan';
import { useInvestorEstimateUnitStore } from '../../../src/state/investorEstimateUnit';
import { subtractDaysKst, todayKstYyyymmdd } from '../../../src/live/liveDateTime';

/** Real queries, stores, fonts and table; cached fixtures need no vendor connection. */
export function mount(width: number, amount = false, large = false) {
  useInvestorDailyDisplayStore.setState({ compactDisplay: 'all', selectedTradeSide: 'net', useK: true,
    showDetails: false, followCursor: false });
  useInvestorDailySpanStore.setState({ span: 20 });
  useInvestorEstimateUnitStore.setState({ unit: amount ? 'amount' : 'qty' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const today = todayKstYyyymmdd(), from = subtractDaysKst(today, 130);
  const base: InvestorSubjectBreakdown = { individual: 8658155, native_foreign: 27186, other_corp: 278288,
    fin_invest: -3563890, insurance: 51236, trust: -1292721, other_fin: 8289,
    bank: 6344, pension: -129133, private_fund: -120079, nation: 0 };
  for (const axis of ['qty', 'amount'] as const) {
    for (const side of ['net', 'buy', 'sell'] as const) {
      const points = [1, -2, 0.1].map((factor, i) => {
        const scale = factor * (axis === 'amount' ? 0.0001 : large ? 1000000 : 1);
        const value = (net: number) => {
          const n = Math.round(net * scale), buy = Math.abs(n) + 100;
          return side === 'net' ? n : side === 'buy' ? buy : buy - n;
        };
        const date = subtractDaysKst(today, i + 1);
        return { t_ms: Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`),
          foreign_net: value(-3896489), institution_net: value(-5039954),
          breakdown: Object.fromEntries(Object.entries(base).map(([key, v]) => [key, value(v)])) };
      });
      client.setQueryData(['live', 'past-investor-net', '005930', from, today, axis, side], {
        code: '005930', from, to: today, unit: axis === 'qty' ? 'qty_shares' : 'amt_mwon', trade_side: side,
        points, cached_batches: [], fresh_batches: [], data_warnings: [],
      });
    }
  }
  const host = document.createElement('div');
  host.className = 'live-window';
  host.style.cssText = `width:${width}px;height:360px;background:var(--bg-card)`;
  document.body.append(host);
  flushSync(() => createRoot(host).render(<QueryClientProvider client={client}>
    <InvestorDailyWindow code="005930" cursorDate={null} />
  </QueryClientProvider>));
}
