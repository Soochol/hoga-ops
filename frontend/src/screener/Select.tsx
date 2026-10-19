export function Select<T extends string>({ value, onChange, options, label, caption = label }: {
  value: T; onChange: (v: T) => void; options: [T, string][]; label: string; caption?: string;
}) {
  return (
    <label className="condition-field">
      <span className="condition-field-label">{caption}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}
        className="condition-select">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
