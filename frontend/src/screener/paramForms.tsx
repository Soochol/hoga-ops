import type { BreakoutParams, DepthPeakParams, PeriodParams } from '../api/screener';

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10.5px] font-semibold uppercase text-fg-dimmer">{children}</div>;
}
export function Num({ value, onChange, label, w = 'w-20' }: {
  value: number | undefined; onChange: (n: number | undefined) => void; label?: string; w?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      {label && <span className="text-[10.5px] text-fg-dimmer">{label}</span>}
      <input type="number" inputMode="numeric" aria-label={label}
        value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={`${w} bg-bg-input border border-border rounded-md px-2 py-1 font-data text-sm tabular-nums text-fg`} />
    </label>
  );
}
export function Select<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: [T, string][]; label: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}
      className="bg-bg-input border border-border-strong rounded-md px-2 py-1 text-sm text-fg">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

/** (lookback N, period M) 돌파 폼 — new_high / new_high_vol 공용. */
export function BreakoutForm({ params, onChange }: { params: BreakoutParams; onChange: (p: BreakoutParams) => void }) {
  return <div className="flex items-center gap-3 flex-wrap">
    <Num label="lookback (N)" value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} /></div>;
}

/** (period M)일 폼 — new_high_today / new_high_vol_today(당일) 공용. */
export function PeriodForm({ params, onChange }: { params: PeriodParams; onChange: (p: PeriodParams) => void }) {
  return <div className="flex items-center gap-2">
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ period: n ?? 1 })} />
    <span className="text-sm text-fg-dimmer">일</span></div>;
}

/** (비교기간 N, 과거 peak 대비 X%) 폼 — ask/bid_depth_new_high(총잔량 신고) 공용. */
export function DepthPeakForm({ params, onChange }: { params: DepthPeakParams; onChange: (p: DepthPeakParams) => void }) {
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2 flex-wrap">
      <Num label="비교 기간 (N)" value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
      <span className="text-sm text-fg-dimmer">일</span>
      <Num label="과거 peak 대비" value={params.threshold_pct} onChange={(n) => onChange({ ...params, threshold_pct: n ?? 100 })} />
      <span className="text-sm text-fg-dimmer">% 이상</span>
    </div>
    <div className="text-[10.5px] text-fg-dimmer">관심·히트맵 종목 중 데이터 보유 종목 대상</div>
  </div>;
}


