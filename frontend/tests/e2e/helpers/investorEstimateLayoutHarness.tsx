import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { InvestorTrendEstimateCard } from '../../../src/sidebar/InvestorTrendEstimateCard';
import { useInvestorEstimateUnitStore } from '../../../src/state/investorEstimateUnit';

export function mount(width: number, large: boolean) {
  useInvestorEstimateUnitStore.setState({ unit: 'qty' });
  const rows = [1, -0.1, 0].map((factor, i) => ({
    slot: String(i + 10), observed_at_ms: Date.parse(`2026-10-19T0${i}:20:00Z`),
    foreign_qty: Math.round(-123456789 * factor * (large ? 10000 : 1)),
    institution_qty: Math.round(23456789 * factor * (large ? 10000 : 1)),
    sum_qty: Math.round(-100000000 * factor * (large ? 10000 : 1)),
    foreign_amt_mwon: -540 * factor, institution_amt_mwon: 360 * factor,
    sum_amt_mwon: -180 * factor,
  }));
  const host = document.createElement('div');
  host.className = 'live-window';
  host.style.cssText = `width:${width}px;height:240px;background:var(--bg-card)`;
  document.body.append(host);
  flushSync(() => createRoot(host).render(
    <div className="flex h-full flex-col bg-bg-card">
      <div className="min-h-0 flex-1 overflow-auto" aria-label="잠정투자자 내역">
        <InvestorTrendEstimateCard query={{ data: { code: '005930', trading_day: '20261019',
          fetched_at_ms: 0, source: 'kis', status: 'ok', data_warning: null,
          rows, latest: rows[2] } }} />
      </div>
    </div>,
  ));
}
