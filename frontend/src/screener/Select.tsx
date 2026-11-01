import { useContext } from 'react';
import { ConditionSettingsContext } from './ConditionFormLayout';

export function Select<T extends string>({ value, onChange, options, label, caption = label }: {
  value: T; onChange: (v: T) => void; options: [T, string][]; label: string; caption?: string;
}) {
  const settings = useContext(ConditionSettingsContext);
  return (
    <label className="condition-field">
      <span className="condition-field-label">{settings && !caption ? label : caption}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}
        className="condition-select">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
