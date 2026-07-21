import { useMemo } from 'react';
import type { OrderbookSnapshot } from '../api/types';

export type Totals = {
  askTotal: number;
  bidTotal: number;
  askPct: number;
  bidPct: number;
};

export function computeTotals(snapshot: OrderbookSnapshot): Totals {
  const askTotal = snapshot.tot_ask;
  const bidTotal = snapshot.tot_bid;
  const total = askTotal + bidTotal;
  const askPct = total > 0 ? askTotal / total : 0.5;
  const bidPct = total > 0 ? bidTotal / total : 0.5;
  return { askTotal, bidTotal, askPct, bidPct };
}

type Props = {
  snapshot: OrderbookSnapshot | null | undefined;
  maskRatio: boolean;
};

// color-mix over the price tokens so the fills track the theme (Obsidian brass
// era palette AND the Ledger light palette). DOM inline style resolves var()
// lazily, so no resolveTokensThemed needed here (unlike the canvas projectors).
const ASK_FILL = 'color-mix(in srgb, var(--price-down) 55%, transparent)';
const BID_FILL = 'color-mix(in srgb, var(--price-up) 55%, transparent)';
const HAIRLINE = 'var(--border-strong)';

export default function TotalQtyBar({ snapshot, maskRatio }: Props) {
  const totals = useMemo(() => (snapshot ? computeTotals(snapshot) : null), [snapshot]);
  if (snapshot == null || totals == null) return null;

  const { askTotal, bidTotal } = totals;
  const askStr = askTotal.toLocaleString('ko-KR');
  const bidStr = bidTotal.toLocaleString('ko-KR');

  return (
    <div
      role="group"
      aria-label="총잔량"
      className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 px-2.5 py-1 font-data text-sm tabular-nums border-t border-border-strong"
    >
      <span
        aria-label={`매도총잔량 ${askStr}`}
        className="min-w-[6ch] text-right text-price-down"
      >
        {askStr}
      </span>
      <div
        className="h-2.5 rounded-sm border border-border-strong bg-bg-subtle overflow-hidden"
      >
        {maskRatio ? (
          <div
            data-testid="total-qty-bar-masked"
            className="h-full flex items-center justify-center text-fg-dimmer text-[8px] leading-none uppercase"
          >
            Auction
          </div>
        ) : (
          <div
            data-testid="total-qty-bar-fill"
            className="grid h-full"
            style={{ gridTemplateColumns: `${askTotal}fr ${bidTotal}fr` }}
          >
            <div style={{ background: ASK_FILL, borderRight: `1px solid ${HAIRLINE}` }} />
            <div style={{ background: BID_FILL }} />
          </div>
        )}
      </div>
      <span
        aria-label={`매수총잔량 ${bidStr}`}
        className="min-w-[6ch] text-left text-price-up"
      >
        {bidStr}
      </span>
    </div>
  );
}
