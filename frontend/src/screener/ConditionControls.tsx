import type { ReactNode } from 'react';
import type { ScreenerTimeframe } from '../api/screener';
import { Select } from './Select';
import './ConditionEditor.css';

export function ConditionFields({ children }: { children: ReactNode }) {
  return <div className="condition-fields">{children}</div>;
}

export function ConditionChoice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void;
}) {
  return <div className="condition-choice" role="group" aria-label={label}>
    {options.map(([key, text]) => <button key={key} type="button" aria-pressed={value === key}
      onClick={() => { if (value !== key) onChange(key); }}>{text}</button>)}
  </div>;
}

export function ConditionTimeframe({ value, onChange, label = '봉 주기' }: {
  value: ScreenerTimeframe; onChange: (value: ScreenerTimeframe) => void; label?: string;
}) {
  const minute = value.endsWith('m');
  return <div className="condition-timeframe">
    <span className="condition-field-label">봉 주기</span>
    <ConditionChoice label={label} value={minute ? 'minute' : value}
      options={[[ 'minute', '분' ], ['D', '일'], ['W', '주'], ['M', '월']]}
      onChange={next => onChange(next === 'minute' ? '5m' : next as ScreenerTimeframe)} />
    {minute && <Select label="분봉 간격" value={value}
      options={[1, 3, 5, 10, 15, 30, 60].map(n => [`${n}m` as ScreenerTimeframe, `${n}분`])}
      onChange={onChange} />}
  </div>;
}

export function QuickValues({ values, unit, onChange }: {
  values: readonly number[]; unit: string; onChange: (value: number) => void;
}) {
  return <div className="condition-presets" role="group" aria-label={`빠른 입력 · ${unit}`}>
    <span>빠른 입력</span>
    {values.map(value => <button key={value} type="button" onClick={() => onChange(value)}>
      {value.toLocaleString('ko-KR')}{unit}
    </button>)}
  </div>;
}
