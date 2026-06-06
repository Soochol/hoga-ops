export function fmtDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

export function LastSuccessBadge({ date }: { date: string | null }) {
  return (
    <span className="font-mono text-xs">
      {date
        ? <span className="text-success">{fmtDate(date)}</span>
        : <span className="text-fg-dimmer italic">아직 없음</span>}
    </span>
  );
}
