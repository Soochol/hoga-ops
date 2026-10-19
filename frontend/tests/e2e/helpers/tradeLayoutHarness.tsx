import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import TradeTickTable from '../../../src/sidebar/TradeTickTable';
import type { TradeTick } from '../../../src/live/tradeTicks';

let root: Root;
const t = Date.parse('2026-10-19T00:00:00Z');
export function render(mode: 'normal' | 'large' | 'small' | 'empty', scope = 'same') {
  const ticks: TradeTick[] = mode === 'empty' ? [] : mode === 'small'
    ? [{ key: 'small', tMs: t, price: 70100, qty: 10, side: -1 }]
    : [0, 1, 2].map(i => ({ key: `trade-${i}`, tMs: t + (2 - i) * 1000,
      price: i === 0 ? 1234500 : 70100, qty: i === 0 ? mode === 'large' ? 1234567890123 : 123456789 : i === 1 ? 40 : 0,
      side: i === 0 ? 1 : i === 1 ? -1 : 0 }));
  flushSync(() => root.render(<div className="flex h-full flex-col bg-bg-card [container:trade-tape/inline-size]">
    <div aria-label="체결 목록" className="min-h-0 flex-1 overflow-auto">
      <TradeTickTable key={scope} view={{ ticks, prevClose: 70000 }}
        highlight={{ thresholdWon: 1000000, color: '#EAB308' }} />
    </div>
  </div>));
}

export function mount() {
  const host = document.createElement('div');
  host.className = 'live-window';
  host.style.cssText = 'width:720px;height:240px;background:var(--bg-card)';
  document.body.append(host);
  root = createRoot(host);
  render('normal');
}
