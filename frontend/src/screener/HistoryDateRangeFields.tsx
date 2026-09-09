/** Shared inclusive date inputs for historical screener conditions. */
export function HistoryDateRangeFields({ label, start, end, onChange }: {
  label: string; start: string; end: string;
  onChange: (dates: { start_date: string; end_date: string }) => void;
}) {
  return <>
    <input type="date" aria-label={`${label} 발생 시작일`} value={start}
      className="bg-bg-input border border-border rounded-md px-2 py-1 text-sm"
      onChange={e => onChange({ start_date: e.target.value, end_date: end })} />
    <span>~</span>
    <input type="date" aria-label={`${label} 발생 종료일`} value={end}
      className="bg-bg-input border border-border rounded-md px-2 py-1 text-sm"
      onChange={e => onChange({ start_date: start, end_date: e.target.value })} />
  </>;
}
