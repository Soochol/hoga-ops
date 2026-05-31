import type {
  TradeValueParams, BreakoutParams, ChangePctParams, PriceRangeParams, MaParams,
} from '../api/screener';

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">{children}</div>;
}
function Num({ value, onChange, label, w = 'w-20' }: {
  value: number | undefined; onChange: (n: number | undefined) => void; label?: string; w?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      {label && <span className="text-[10.5px] text-fg-dimmer">{label}</span>}
      <input type="number" inputMode="numeric" aria-label={label}
        value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={`${w} bg-bg-input border border-border rounded-md px-2 py-1 font-mono text-sm tabular-nums text-fg`} />
    </label>
  );
}
function Select<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: [T, string][]; label: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}
      className="bg-bg-input border border-border-strong rounded-md px-2 py-1 text-sm text-fg">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function TradeValueForm({ params, onChange }: { params: TradeValueParams; onChange: (p: TradeValueParams) => void }) {
  return <div className="flex items-center gap-2"><span className="text-sm text-fg-dim">≥</span>
    <Num value={params.min_eok} onChange={(n) => onChange({ min_eok: n ?? 0 })} /><span className="text-sm text-fg-dimmer">억</span></div>;
}
export function BreakoutForm({ params, onChange }: { params: BreakoutParams; onChange: (p: BreakoutParams) => void }) {
  return <div className="flex items-center gap-3 flex-wrap">
    <Num label="lookback (N)" value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} /></div>;
}
export function ChangePctForm({ params, onChange }: { params: ChangePctParams; onChange: (p: ChangePctParams) => void }) {
  return <div className="flex items-center gap-2 flex-wrap">
    <Select label="등락률 연산" value={params.op} onChange={(op) => onChange({ ...params, op })}
      options={[['gte', '≥'], ['lte', '≤'], ['between', '사이']]} />
    {params.op === 'between' ? (<>
      <Num label="lo" value={params.lo} onChange={(n) => onChange({ ...params, lo: n })} w="w-16" />
      <span className="text-fg-dimmer">~</span>
      <Num label="hi" value={params.hi} onChange={(n) => onChange({ ...params, hi: n })} w="w-16" /></>
    ) : <Num value={params.pct} onChange={(n) => onChange({ ...params, pct: n })} w="w-16" />}
    <span className="text-sm text-fg-dimmer">%</span></div>;
}
export function PriceRangeForm({ params, onChange }: { params: PriceRangeParams; onChange: (p: PriceRangeParams) => void }) {
  return <div className="flex items-center gap-2">
    <Num label="min" value={params.min} onChange={(n) => onChange({ ...params, min: n })} w="w-24" />
    <span className="text-fg-dimmer">~</span>
    <Num label="max" value={params.max} onChange={(n) => onChange({ ...params, max: n })} w="w-24" />
    <span className="text-sm text-fg-dimmer">원</span></div>;
}
export function MaForm({ params, onChange }: { params: MaParams; onChange: (p: MaParams) => void }) {
  return <div className="flex items-center gap-2">
    <span className="text-sm text-fg-dim">MA</span>
    <Num value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} w="w-16" />
    <Select label="이평선 관계" value={params.relation} onChange={(relation) => onChange({ ...params, relation })}
      options={[['above', '위'], ['below', '아래']]} /></div>;
}
