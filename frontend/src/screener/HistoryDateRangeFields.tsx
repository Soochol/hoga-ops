/** Shared inclusive date inputs for historical screener conditions. */
export function HistoryDateRangeFields({ label, start, end, onChange }: {
  label: string; start: string; end: string;
  onChange: (dates: { start_date: string; end_date: string }) => void;
}) {
  return <>
    <label className="condition-field condition-date-field">
      <span className="condition-field-label">시작</span>
      <input type="date" aria-label={`${label} 발생 시작일`} value={start}
        className="condition-select font-data"
        onChange={e => onChange({ start_date: e.target.value, end_date: end })} />
    </label>
    <label className="condition-field condition-date-field">
      <span className="condition-field-label">종료</span>
      <input type="date" aria-label={`${label} 발생 종료일`} value={end}
        className="condition-select font-data"
        onChange={e => onChange({ start_date: start, end_date: e.target.value })} />
    </label>
  </>;
}
