import type { ReactNode } from 'react';
import type { BreakoutParams, DepthPeakParams, DepthPeakPeriodParams, DepthRenewalParams, PeriodParams } from '../api/screener';
import { CandleSettings } from './CandleSettings';
import { ConditionFields } from './ConditionControls';
import { RENEWAL_MIN_HHMM, RENEWAL_MAX_HHMM, hhmmToTimeValue, timeValueToHhmm } from './paramFormsHelpers';

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-2xs font-semibold uppercase text-fg-dim">{children}</div>;
}

export function Num({ value, onChange, label, ariaLabel, suffix, placeholder, min, max }: {
  value: number | undefined; onChange: (n: number | undefined) => void;
  label?: string; ariaLabel?: string; suffix?: string; placeholder?: string; min?: number; max?: number;
}) {
  // Keep typing unrestricted; clamp only on blur. These bounds mirror the server.
  const commit = (raw: string) => {
    if (raw === '') { onChange(undefined); return; }
    const n = Number(raw);
    onChange(Number.isFinite(n) ? n : undefined);
  };
  const clampOnBlur = (raw: string) => {
    if (raw === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    if (c !== n) onChange(c);
  };
  return <label className="condition-field">
    <span className="condition-field-label">{label ?? ariaLabel}</span>
    <span className="condition-input-wrap">
      <input type="number" inputMode="decimal" aria-label={ariaLabel ?? label} min={min} max={max}
        value={value ?? ''} placeholder={placeholder} onChange={e => commit(e.target.value)}
        onBlur={e => clampOnBlur(e.target.value)} className="font-data" />
      {suffix && <span className="condition-unit">{suffix}</span>}
    </span>
  </label>;
}

export { Select } from './Select';

export function BreakoutForm({ params, onChange }: { params: BreakoutParams; onChange: (p: BreakoutParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <ConditionFields>
      <Num label="발생 검색 범위" ariaLabel="최근 기간(봉)" suffix="봉 이내" min={1} max={1000}
        value={params.lookback} onChange={n => onChange({ ...params, lookback: n ?? 1 })} />
      <Num label="신고 비교 기간" ariaLabel="신고 기준 기간(봉)" suffix="봉" min={1} max={1000}
        value={params.period} onChange={n => onChange({ ...params, period: n ?? 1 })} />
    </ConditionFields>
  </CandleSettings>;
}

export function PeriodForm({ params, onChange }: { params: PeriodParams; onChange: (p: PeriodParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <Num label="신고 비교 기간 · 최신 봉 기준" ariaLabel="신고 기준 기간(봉)" suffix="봉" min={1} max={1000}
      value={params.period} onChange={n => onChange({ ...params, period: n ?? 1 })} />
  </CandleSettings>;
}

export function DepthPeakForm({ params, onChange }: { params: DepthPeakParams; onChange: (p: DepthPeakParams) => void }) {
  return <div className="condition-form">
    <ConditionFields>
      <Num label="과거 peak 비교 기간" ariaLabel="비교 기간(일)" suffix="거래일" min={1} max={1000}
        value={params.lookback} onChange={n => onChange({ ...params, lookback: n ?? 1 })} />
      <Num label="과거 peak 대비" suffix="% 이상" min={1}
        value={params.threshold_pct} onChange={n => onChange({ ...params, threshold_pct: n ?? 100 })} />
    </ConditionFields>
  </div>;
}

export function DepthPeakPeriodForm({ params, onChange }: { params: DepthPeakPeriodParams; onChange: (p: DepthPeakPeriodParams) => void }) {
  return <div className="condition-form">
    <ConditionFields>
      <Num label="발생 검색 범위" ariaLabel="최근 기간(일)" suffix="거래일 이내" min={1} max={1000}
        value={params.lookback} onChange={n => onChange({ ...params, lookback: n ?? 1 })} />
      <Num label="과거 peak 비교 기간" ariaLabel="비교 기간(일)" suffix="거래일" min={1} max={1000}
        value={params.period} onChange={n => onChange({ ...params, period: n ?? 1 })} />
    </ConditionFields>
    <Num label="과거 peak 대비" ariaLabel="과거 peak 대비(%)" suffix="% 이상" min={1}
      value={params.threshold_pct} onChange={n => onChange({ ...params, threshold_pct: n ?? 100 })} />
  </div>;
}

export function DepthRenewalForm({ params, onChange }: { params: DepthRenewalParams; onChange: (p: DepthRenewalParams) => void }) {
  // Incomplete or out-of-session times retain the last valid HHMM value.
  const onTime = (value: string) => {
    const hhmm = timeValueToHhmm(value);
    if (hhmm != null) onChange({ ...params, start_hhmm: hhmm });
  };
  return <div className="condition-form">
    <ConditionFields>
      <label className="condition-field">
        <span className="condition-field-label">기준 시각 · KST</span>
        <span className="condition-input-wrap">
          <input type="time" aria-label="기준 시각" step={60}
            min={hhmmToTimeValue(RENEWAL_MIN_HHMM)} max={hhmmToTimeValue(RENEWAL_MAX_HHMM)}
            value={hhmmToTimeValue(params.start_hhmm)} onChange={e => onTime(e.target.value)} className="font-data" />
        </span>
      </label>
      <Num label="기준시각 이전 최대 대비" ariaLabel="이전 최대 대비" suffix="% 이상" min={1} value={params.threshold_pct}
        onChange={n => onChange({ ...params, threshold_pct: n ?? 100 })} />
    </ConditionFields>
  </div>;
}
