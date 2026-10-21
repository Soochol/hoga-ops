import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { InvestorTrendEstimateCard } from '../../../src/sidebar/InvestorTrendEstimateCard';
import { useInvestorEstimateUnitStore } from '../../../src/state/investorEstimateUnit';

export function mount(width: number, large: boolean) {
  useInvestorEstimateUnitStore.setState({ unit: 'qty' });
  const samples = [
    { qty: 1, amount: 1 }, { qty: -0.1, amount: -0.1 }, { qty: 0, amount: 0 },
    { qty: 1, amount: 10 }, { qty: null, amount: null },
  ];
  const rows = samples.map(({ qty, amount }, i) => ({
    slot: String(i + 10), observed_at_ms: Date.parse(`2026-10-19T0${i}:20:00Z`),
    foreign_qty: qty === null ? null : Math.round(-123456789 * qty * (large ? 10000 : 1)),
    institution_qty: qty === null ? null : Math.round(23456789 * qty * (large ? 10000 : 1)),
    sum_qty: qty === null ? null : Math.round(-100000000 * qty * (large ? 10000 : 1)),
    foreign_amt_mwon: amount === null ? null : -540 * amount,
    institution_amt_mwon: amount === null ? null : 360 * amount,
    sum_amt_mwon: amount === null ? null : -180 * amount,
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
          rows, latest: rows[rows.length - 1] } }} />
      </div>
    </div>,
  ));
}
