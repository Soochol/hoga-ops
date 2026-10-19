import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ProgramTradeSummaryCard from '../../../src/sidebar/ProgramTradeSummaryCard';
import { useProgramTradeDisplayStore } from '../../../src/state/programTradeDisplay';

export function mount(large: boolean) {
  useProgramTradeDisplayStore.setState({ view: 'daily', measure: 'qty', dailyDisplay: 'all',
    dailySpan: 20, dailyUseK: true, dailyFollowCursor: false });
  const t = Date.parse('2026-10-19T00:00:00Z');
  const scale = large ? 10000 : 1;
  const rows = [1, 0.1, 0].map((factor, i) => ({
    t_ms: t - i * 86400000,
    net_qty: Math.round(-123456789 * factor * scale),
    buy_qty: Math.round(23456789 * factor * scale),
    sell_qty: Math.round(146913578 * factor * scale),
    net_amount: -540000000 * factor, buy_amount: 1200000000 * factor,
    sell_amount: 1740000000 * factor,
  }));
  const points = rows.slice(0, 2).reverse().map((row, i) => ({ ...row, t: t + i * 60000, gap_risk: false }));
  const host = document.createElement('div');
  host.className = 'live-window';
  host.style.cssText = 'width:720px;height:360px;background:var(--bg-card)';
  document.body.append(host);
  flushSync(() => createRoot(host).render(<ProgramTradeSummaryCard dailyPoints={rows}
    series={{ points, source: 'kis_program_trade' }} />));
}
