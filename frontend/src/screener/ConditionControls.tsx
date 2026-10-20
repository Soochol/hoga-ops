import type { ReactNode } from 'react';
import type { ScreenerTimeframe } from '../api/screener';
import { Select } from './Select';
import './ConditionEditor.css';

export function ConditionFields({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function ConditionChoice<T extends string>({ label, caption, value, options, onChange }: {
  label: string; caption?: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void;
}) {
  return <Select label={label} caption={caption} value={value} onChange={onChange}
    options={options.map(([key, text]) => [key, text])} />;
}

const TIMEFRAMES: [ScreenerTimeframe, string][] = [
  ['D', '일봉'], ['W', '주봉'], ['M', '월봉'],
  ...[1, 3, 5, 10, 15, 30, 60].map(n => [`${n}m` as ScreenerTimeframe, `${n}분봉`] as [ScreenerTimeframe, string]),
];

export function ConditionTimeframe({ value, onChange, label = '봉 주기', children }: {
  value: ScreenerTimeframe; onChange: (value: ScreenerTimeframe) => void; label?: string; children?: ReactNode;
}) {
  return <>
    <Select label={label} caption="주기" value={value} options={TIMEFRAMES} onChange={onChange} />
    {children}
  </>;
}
