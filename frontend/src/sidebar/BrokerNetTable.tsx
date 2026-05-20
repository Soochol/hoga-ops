import { useMemo } from 'react';
import type { BrokerEntry } from '../api/types';

type Props = { brokers: BrokerEntry[] | null };

export default function BrokerNetTable({ brokers }: Props) {
  const rows = useMemo(() => computeNet(brokers ?? []), [brokers]);
  if (!brokers) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        커서 위치 로딩 중…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">거래원 정보 없음</div>
    );
  }
  return (
    <div className="font-mono text-[11.5px] tabular-nums">
      {rows.map((r) => (
        <div key={r.name} className="grid grid-cols-[1fr_auto] gap-3 px-2.5 py-0.5">
          <span className="truncate">{trunc(r.name)}</span>
          <span className={r.net > 0 ? 'text-up' : r.net < 0 ? 'text-down' : 'text-fg-dim'}>
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

function computeNet(entries: BrokerEntry[]): { name: string; net: number }[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    const cur = map.get(e.name) ?? 0;
    map.set(e.name, cur + (e.side === 'buy' ? e.qty : -e.qty));
  }
  return [...map.entries()]
    .map(([name, net]) => ({ name, net }))
    .sort((a, b) => b.net - a.net)
    .slice(0, 10);
}
