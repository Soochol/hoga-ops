import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { VolumeDistributionCard } from '../../../src/sidebar/VolumeDistributionCard';
import ProgramTradeSummaryCard from '../../../src/sidebar/ProgramTradeSummaryCard';
import type { ProgramTradeSeries } from '../../../src/api/types';

export function mount(firstMinute: number) {
  const at = (minute: number) => Date.parse('2026-10-21T00:00:00+09:00') + minute * 60_000;
  const host = document.createElement('main');
  host.style.cssText = 'width:640px;max-width:100vw;padding:8px;background:var(--bg-card);';
  document.body.replaceChildren(host);
  const root = createRoot(host);
  const prices = [{ t_ms: at(firstMinute), close: 100 },
    { t_ms: at(firstMinute + 15), close: 110 }, { t_ms: at(600), close: 120 }];
  const profile = { date: '20261021', range_count: 2, price_min: 100, price_max: 120,
    session_open_ms: at(540), session_close_ms: at(930), last_trade_ms: at(600),
    bins: [{ price_low: 100, price_high: 110, qty: 10 }, { price_low: 110, price_high: 120, qty: 30 }] };
  const series: ProgramTradeSeries = { source: 'kis_program_trade', points: [firstMinute + 1, firstMinute + 2, 601].map((minute, i) => ({
    t: at(minute), net_amount: (i + 1) * 1_000_000, net_qty: null, buy_qty: null, sell_qty: null,
    buy_amount: null, sell_amount: null, gap_risk: false,
  })) };
  let cursor: number | null = null;
  const render = () => flushSync(() => root.render(<>
    <section data-testid="program-comparison" style={{ height: 260 }}>
      <ProgramTradeSummaryCard series={series} closePoints={prices} />
    </section>
    <section data-testid="distribution-comparison" style={{ height: 300 }}>
      <VolumeDistributionCard profile={cursor == null ? profile : { ...profile, last_trade_ms: cursor }} axisProfile={profile}
        cursorMs={cursor} closePoints={prices} color="var(--fg-dim)" maxColor="var(--accent)" />
    </section>
  </>));
  render();
  return { hover() { cursor = at(firstMinute + 15); render(); } };
}
