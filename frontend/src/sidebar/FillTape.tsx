import { useMemo } from 'react';
import type { Trade } from '../api/types';

type Props = { trades: Trade[] | null };

export default function FillTape({ trades }: Props) {
  const display = useMemo(() => {
    if (!trades) return null;
    // Newest at top — copy + reverse if API returns ascending.
    return [...trades].sort((a, b) => b.ts_ms - a.ts_ms);
  }, [trades]);

  if (!display) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        커서 위치 로딩 중…
      </div>
    );
  }
  if (display.length === 0) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">체결 없음</div>
    );
  }
  return (
    <div className="font-mono text-[11.5px] tabular-nums">
      {display.map((t) => (
        <FillRow key={`${t.ts_ms}-${t.seq}`} trade={t} />
      ))}
    </div>
  );
}

function FillRow({ trade }: { trade: Trade }) {
  const icon = trade.side > 0 ? '▲' : trade.side < 0 ? '▼' : '◆';
  const iconCls = trade.side > 0 ? 'text-up' : trade.side < 0 ? 'text-down' : 'text-fg-dim';
  const time = formatTime(trade.ts_ms);
  return (
    <div className="grid grid-cols-[16px_1fr_auto_auto] gap-2 px-2.5 py-0.5 items-center">
      <span className={iconCls}>{icon}</span>
      <span className="text-fg-dimmer text-[10.5px]">{time}</span>
      <span>{trade.price.toLocaleString('ko-KR')}</span>
      <span className="text-fg-dim">{trade.qty.toLocaleString('ko-KR')}</span>
    </div>
  );
}

function formatTime(ts_ms: number): string {
  // Local time as HH:MM:SS — KST is the only locale that matters per ADR 0003.
  const d = new Date(ts_ms);
  return d.toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
