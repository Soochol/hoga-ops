import { useMemo } from 'react';
import type { BrokerEntry } from '../api/types';

type Props = { brokers: BrokerEntry[] | null | undefined };

export default function BrokerNetTable({ brokers }: Props) {
  const rows = useMemo(() => computeNet(brokers ?? []), [brokers]);
  if (brokers === undefined) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        커서 위치 로딩 중…
      </div>
    );
  }
  if (brokers === null || rows.length === 0) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">거래원 정보 없음</div>
    );
  }
  return (
    <div className="font-mono text-sm tabular-nums">
      {rows.map((r) => (
        <div key={r.broker} className="grid grid-cols-[1fr_auto] gap-3 px-2.5 py-0.5">
          <span className="truncate">{trunc(r.broker)}</span>
          <span className={r.net > 0 ? 'text-price-up' : r.net < 0 ? 'text-price-down' : 'text-fg-dim'}>
            {r.net > 0 ? '+' : ''}
            {r.net.toLocaleString('ko-KR')}
          </span>
        </div>
      ))}
    </div>
  );
}

function trunc(name: string): string {
  // Korean broker names are typically already short. Cap at 4 characters per spec §5.2.
  return name.length > 4 ? name.slice(0, 4) : name;
}

/**
 * Aggregate cumulative `qty_today` per broker, signed by side (buy +, sell −),
 * sort by signed net descending so net buyers stack on top and net sellers
 * on the bottom, and keep the top 10. `qty_today` (the cumulative position
 * through the cursor moment) is the right magnitude for "net pressure" —
 * `qty_delta` would show only the most recent tick's movement, which
 * jitters as new ticks arrive.
 */
function computeNet(entries: BrokerEntry[]): { broker: string; net: number }[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    const cur = map.get(e.broker) ?? 0;
    map.set(e.broker, cur + (e.side === 'buy' ? e.qty_today : -e.qty_today));
  }
  return [...map.entries()]
    .map(([broker, net]) => ({ broker, net }))
    .sort((a, b) => b.net - a.net)
    .slice(0, 10);
}
