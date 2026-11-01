import type { ReactNode } from 'react';
import { SettingsGroup } from '../settings/SettingsGroup';
import { SettingsRow } from '../settings/SettingsRow';

export function IndicatorSettingsGroup(props: { label: ReactNode; children: ReactNode }) {
  return <SettingsGroup {...props} className="indicator-settings-group" />;
}

export function IndicatorRangeRow({ label, ariaLabel = label, value, min = 0, max = 100, step = 1, onChange, disabled = false }: {
  label: string; ariaLabel?: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return <SettingsRow label={label} disabled={disabled}>
    <div className="indicator-range-control">
      <input type="range" aria-label={ariaLabel} aria-valuetext={`${value}%`} min={min} max={max} step={step}
        value={value} disabled={disabled} onChange={event => onChange(Number(event.currentTarget.value))} />
      <output>{value}%</output>
    </div>
  </SettingsRow>;
}

export function IndicatorLineWidthRow({ label, value, onChange }: {
  label: string; value: 1 | 2 | 3 | 4; onChange: (value: 1 | 2 | 3 | 4) => void;
}) {
  return <SettingsRow label="선 두께 · 공통">
    <select aria-label={`${label} 공통 선 두께`} value={value}
      onChange={event => onChange(Number(event.currentTarget.value) as 1 | 2 | 3 | 4)}>
      {[1, 2, 3, 4].map(width => <option value={width} key={width}>{width}px</option>)}
    </select>
  </SettingsRow>;
}

export function IndicatorThemeColor({ direction }: { direction: 'up' | 'down' }) {
  return <span className="indicator-theme-color"><span aria-hidden="true" style={{ background: `var(--price-${direction})` }} />테마</span>;
}
