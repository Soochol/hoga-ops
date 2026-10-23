import { useState } from 'react';
import type { ProgramTradeTick } from '../live/programTradeTicks';
import { priceDirClass } from '../ui/priceDir';
import { unixMsToKSTClock } from '../util/time';
import { SidebarState } from './SidebarSurface';
import './TradeTickTable.css';

export function ProgramTradeTickTable({ ticks, emptyText }: {
  ticks: readonly ProgramTradeTick[];
  emptyText: string;
}) {
  let price = 0, quantity = 0;
  for (const tick of ticks) {
    price = Math.max(price, tick.price ?? 0);
    quantity = Math.max(quantity, Math.abs(tick.deltaQty));
  }
  const [reserved, setReserved] = useState(() => ({ price, quantity }));
  // The owner remounts on code/venue/date changes. Keep widths when large
  // events leave the visible buffer, including through a temporary empty list.
  if (price > reserved.price || quantity > reserved.quantity) {
    setReserved({ price: Math.max(price, reserved.price), quantity: Math.max(quantity, reserved.quantity) });
  }
  if (ticks.length === 0) return <SidebarState>{emptyText}</SidebarState>;
  const figure = reserved.quantity.toLocaleString('ko-KR');
  return <div role="table" aria-label="프로그램 체결 내역" className="trade-tick-table grid font-data text-sm tabular-nums">
    <div aria-hidden="true" className="trade-tick-sizer">
      <span data-figure={reserved.price.toLocaleString('ko-KR')} />
      {/* Both signs use their actual glyph widths; never size only the digits. */}
      <span className="col-start-3 row-start-1" data-figure={`+${figure}`} />
      <span className="col-start-3 row-start-1" data-figure={`−${figure}`} />
    </div>
    <div role="row" className="trade-tick-row trade-tick-header sticky top-0 z-10 bg-bg-subtle py-1 text-2xs text-fg-dim">
      <span role="columnheader" data-tooltip="과거 내역은 키움 제공 시각, 실시간 내역은 수신 시각">시간</span>
      <span role="columnheader" className="text-right">현재가(원)</span>
      <span role="columnheader" className="text-right">순매수 증감(주)</span>
    </div>
    {ticks.map(tick => <div role="row" key={tick.key} data-tape-event={tick.key} className="trade-tick-row py-0.5">
      <span role="cell" className="text-fg-dim">{unixMsToKSTClock(tick.tMs)}</span>
      <span role="cell" className="text-right">{tick.price?.toLocaleString('ko-KR') ?? '—'}</span>
      <span role="cell" className={`text-right ${priceDirClass(tick.deltaQty)}`}>
        {tick.deltaQty > 0 ? '+' : '−'}{Math.abs(tick.deltaQty).toLocaleString('ko-KR')}
      </span>
    </div>)}
  </div>;
}
