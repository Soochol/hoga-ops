import { createRoot } from 'react-dom/client';
import BookPanel from '../../../src/live/workspace/BookPanel';
import { EMPTY_TRADE_SUMMARY } from '../../../src/live/liveSidebarAdapters';
import '../../../src/styles/global.css';
import '../../../src/live/LiveWorkspace.css';
import 'pretendard/dist/web/variable/pretendardvariable.css';

const ask = Array.from({ length: 10 }, (_, i) => ({ price: 1_631_000 + i * 1_000, qty: 826 }));
const bid = Array.from({ length: 10 }, (_, i) => ({ price: 1_630_000 - i * 1_000, qty: 630 }));
createRoot(document.getElementById('fixture')!).render(
  <BookPanel
    snapshot={{ ts_ms: 1, seq: 0, ask, bid, tot_ask: 8260, tot_bid: 6300 }}
    baselinePrice={1_261_539}
    summary={{ ...EMPTY_TRADE_SUMMARY, dayOpen: 1_631_000, dayHigh: 1_640_000, dayLow: 1_621_000 }}
    trades={[]}
    maskRatio={false}
    lastPrice={1_630_000}
  />,
);
