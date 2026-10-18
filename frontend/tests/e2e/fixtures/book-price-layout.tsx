import { createRoot } from 'react-dom/client';
import BookPanel from '../../../src/live/workspace/BookPanel';
import { EMPTY_TRADE_SUMMARY } from '../../../src/live/liveSidebarAdapters';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import 'pretendard/dist/web/variable/pretendardvariable.css';

const offset = Number(new URLSearchParams(location.search).get('offset') ?? 0);
const ask = Array.from({ length: 10 }, (_, i) => ({ price: offset + 1_631_000 + i * 1_000, qty: 8_260_000 }));
const bid = Array.from({ length: 10 }, (_, i) => ({ price: offset + 1_630_000 - i * 1_000, qty: 8_260_000 }));
const depth = new URLSearchParams(location.search).get('depth');
const visibleAsks = depth === 'bid-only' ? 0 : depth === 'partial' || depth === 'ask-only' ? 4 : depth === 'five' ? 5 : 10;
const visibleBids = depth === 'ask-only' ? 0 : depth === 'partial' || depth === 'bid-only' ? 3 : depth === 'five' ? 5 : 10;
const paddedAsk = ask.map((level, i) => i < visibleAsks ? level : { price: 0, qty: 0 });
const paddedBid = bid.map((level, i) => i < visibleBids ? level : { price: 0, qty: 0 });
createRoot(document.getElementById('fixture')!).render(
  <BookPanel
    snapshot={{ ts_ms: 1, seq: 0, ask: paddedAsk, bid: paddedBid, tot_ask: 8260, tot_bid: 8260 }}
    baselinePrice={offset + 1_261_539}
    summary={{ ...EMPTY_TRADE_SUMMARY, dayOpen: offset + 1_631_000, dayHigh: offset + 1_640_000, dayLow: offset + 1_621_000 }}
    trades={[{ price: 1_631_000, qty: 12345, side: 1 }]}
    maskRatio={false}
    lastPrice={offset + 1_630_000}
    deltaBadges={new Map<string, { delta: number; atMs: number }>([
      ...ask.map(l => [`a:${l.price}`, { delta: 12345, atMs: 1 }] as const),
      ...bid.map(l => [`b:${l.price}`, { delta: -12345, atMs: 1 }] as const),
    ])}
  />,
);
