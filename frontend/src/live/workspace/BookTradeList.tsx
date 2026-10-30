import { useState } from 'react';
import { priceDirClass } from '../../ui/priceDir';
import { tradeHighlightBackground, useTradeHighlight } from '../tradeHighlight';
import { TradeWindowTrigger } from './TradeWindowTrigger';
import './BookTradeList.css';

export type BookTrade = { key?: string; price: number; qty: number; side: number };
export const BOOK_TRADE_LIMIT = 200;

/** Keep the same nine-row viewport. Pause older rows until the reader returns to the top. */
export function BookTradeList({ trades, baselinePrice, layout, onOpen }: {
  trades: readonly BookTrade[]; baselinePrice: number | null; layout: 'book' | 'order'; onOpen?: () => void;
}) {
  const highlight = useTradeHighlight();
  const [reading, setReading] = useState<readonly BookTrade[] | null>(null);
  const rows = reading ?? trades.slice(0, BOOK_TRADE_LIMIT);
  const height = layout === 'book' ? 22 : 24;
  const font = layout === 'book' ? 'font-data text-sm ' : '';
  return <TradeWindowTrigger className={`book-trade-scroll ${layout === 'order' ? 'order-trades-scroll' : ''}`}
    style={{ height: height * 9, minHeight: height * 9 }} onOpen={onOpen}
    data-testid="book-trade-list" data-reading={reading !== null ? 'true' : 'false'}
    data-scrollable={rows.length > 9 ? 'true' : 'false'}
    onScroll={event => {
      if (event.currentTarget.scrollTop === 0) setReading(null);
      else if (reading === null) setReading(trades.slice(0, BOOK_TRADE_LIMIT));
    }} onWheel={event => event.stopPropagation()}>
    {rows.map((trade, index) => <div key={trade.key ?? `${trade.price}:${trade.qty}:${trade.side}:${index}`}
      className={layout === 'book' ? 'book-trade-row grid items-center' : 'order-info order-trade'}
      style={{ height }}>
      <span className={`text-right ${font}tabular-nums ${baselinePrice == null || baselinePrice <= 0
        ? 'text-fg-dim' : priceDirClass(trade.price - baselinePrice)}`}>{trade.price.toLocaleString('ko-KR')}</span>
      <span className={`rounded-sm text-right ${font}tabular-nums ${priceDirClass(trade.side)}`}
        style={{ background: tradeHighlightBackground(trade, highlight) }}>{trade.qty.toLocaleString('ko-KR')}</span>
    </div>)}
  </TradeWindowTrigger>;
}
