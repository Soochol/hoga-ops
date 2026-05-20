import type { OrderbookSnapshot } from '../api/types';

type Props = { snapshot: OrderbookSnapshot | null | undefined };

export default function OrderbookTable({ snapshot }: Props) {
  if (snapshot === undefined) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        커서 위치 로딩 중…
      </div>
    );
  }
  if (snapshot === null) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        호가 데이터 없음
      </div>
    );
  }
  // Wire shape per ADR-0004: ask/bid each ship as length-10 arrays with
  // index 0 = best price. Rank is the (1-based) index.
  const asks = snapshot.ask;
  const bids = snapshot.bid;

  // Depth bar normalization across all 20 levels.
  const maxQty = Math.max(
    1,
    ...asks.map((l) => l.qty),
    ...bids.map((l) => l.qty),
  );

  // Asks displayed worst → best (top → bottom), so best ask hugs the spread
  // divider. Bids continue best → worst below the divider.
  const displayedAsks = [...asks].reverse();

  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null;

  return (
    <div className="font-mono text-[11.5px] tabular-nums">
      {displayedAsks.map((l, i) => (
        // i counts top→bottom across displayedAsks; reverse it for stable
        // keys tied to rank (best = 1).
        <Row key={`a-${asks.length - i}`} side="ask" price={l.price} qty={l.qty} maxQty={maxQty} />
      ))}
      <SpreadDivider spread={spread} />
      {bids.map((l, i) => (
        <Row key={`b-${i + 1}`} side="bid" price={l.price} qty={l.qty} maxQty={maxQty} />
      ))}
    </div>
  );
}

function Row({
  side,
  price,
  qty,
  maxQty,
}: {
  side: 'ask' | 'bid';
  price: number;
  qty: number;
  maxQty: number;
}) {
  const widthPct = maxQty > 0 ? (qty / maxQty) * 100 : 0;
  const barClass = side === 'ask' ? 'bg-tint-down' : 'bg-tint-up';
  const priceColor = side === 'ask' ? 'text-down' : 'text-up';
  // Depth bar extends from the left on the qty side; spec §5.1 shows depth
  // bars rendered behind the qty column.
  return (
    <div className="relative grid grid-cols-[1fr_1fr] gap-3 px-2.5 py-0.5">
      <span
        className={`absolute inset-y-0 left-0 ${barClass}`}
        style={{ width: `${widthPct}%` }}
      />
      <span className={`relative text-right ${priceColor}`}>{price.toLocaleString('ko-KR')}</span>
      <span className="relative text-right text-fg-dim">{qty.toLocaleString('ko-KR')}</span>
    </div>
  );
}

function SpreadDivider({ spread }: { spread: number | null }) {
  return (
    <div className="border-y bg-bg-subtle px-2.5 py-1 text-[10px] font-semibold tracking-wider uppercase text-fg-dimmer flex justify-between">
      <span>Spread</span>
      <span className="font-mono">{spread != null ? spread.toLocaleString('ko-KR') : '—'}</span>
    </div>
  );
}
