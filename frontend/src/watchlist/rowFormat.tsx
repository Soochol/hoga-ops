import { fmtDate } from './rowFormatHelpers';


export function LastSuccessBadge({ date }: { date: string | null }) {
  return (
    <span className="font-data text-xs">
      {date
        ? <span className="text-success">{fmtDate(date)}</span>
        : <span className="text-fg-dimmer italic">아직 없음</span>}
    </span>
  );
}
