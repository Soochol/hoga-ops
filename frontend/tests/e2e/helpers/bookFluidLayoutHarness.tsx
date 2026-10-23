import 'pretendard/dist/web/variable/pretendardvariable.css';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import BookPanel from '../../../src/live/workspace/BookPanel';
import { EMPTY_TRADE_SUMMARY } from '../../../src/live/liveSidebarAdapters';

let root: Root;
export function render(mode: 'normal' | 'large' | 'plain', symbol = 'same', priceOffset = 0, expectedPrice?: number) {
  const scale = mode === 'large' ? 1000 : 1;
  const ask = Array.from({ length: 10 }, (_, i) => ({ price: 100000 + priceOffset + i * 100, qty: (14200 + i * 1100) * scale }));
  const bid = Array.from({ length: 10 }, (_, i) => ({ price: 99900 + priceOffset - i * 100, qty: (48500 - i * 2100) * scale }));
  const trades = Array.from({ length: 9 }, (_, i) => ({ price: (i % 2 ? 99900 : 100000) + priceOffset,
    qty: mode === 'large' ? 123456789 : i % 2 ? 850 : 12400, side: i % 2 ? -1 : 1 }));
  const deltaBadges = mode === 'plain' ? null : new Map([
    ...ask.map(level => [`a:${level.price}`, { delta: 5400 * scale, atMs: 1 }] as const),
    ...bid.map(level => [`b:${level.price}`, { delta: -5400 * scale, atMs: 1 }] as const),
  ]);
  flushSync(() => root.render(<BookPanel symbol={symbol}
    snapshot={{ ts_ms: 1, seq: 0, ask, bid, tot_ask: 234842, tot_bid: 276600 }}
    baselinePrice={99900 + priceOffset} summary={{ ...EMPTY_TRADE_SUMMARY, dayOpen: 99500 + priceOffset, dayHigh: 100900 + priceOffset,
      dayLow: 99000 + priceOffset, fillStrengthPct: 134.2,
      cumVolume: 83_338_888, cumValue: 12_345_678_900_000, vsPrevVolumePct: 184.55 }} trades={trades} deltaBadges={deltaBadges}
    lastPrice={100000 + priceOffset} maskRatio={false}
    expectedFill={expectedPrice === undefined ? null : { price: expectedPrice, qty: 123_456_789 }} />));
}

export function mount() {
  const host = document.createElement('div');
  host.className = 'live-window';
  host.style.cssText = 'width:640px;height:540px;background:var(--bg-card)';
  document.body.append(host);
  root = createRoot(host);
  render('normal');
}
