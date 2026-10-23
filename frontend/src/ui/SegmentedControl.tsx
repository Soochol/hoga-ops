import type { ReactNode } from 'react';
import { SegmentedControl as SegmentShell } from './PageShell';

export type SegmentOption<T extends string> = { value: T; label: ReactNode; title?: string; disabled?: boolean; testId?: string };

/** One selection grammar for units, periods and view modes. */
export function SegmentedControl<T extends string>({ label, value, options, onChange, className = '' }: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return <SegmentShell aria-label={label} className={className}>
    {options.map(option => <button key={option.value} type="button" className="ui-choice"
      aria-pressed={value === option.value} disabled={option.disabled} data-tooltip={option.title} data-testid={option.testId}
      onClick={() => { if (value !== option.value) onChange(option.value); }}>{option.label}</button>)}
  </SegmentShell>;
}
