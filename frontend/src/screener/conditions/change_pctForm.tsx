import type { ChangePctParams } from '../../api/screener';
import { Num, Select } from '../paramForms';


export function ChangePctForm({ params, onChange }: { params: ChangePctParams; onChange: (p: ChangePctParams) => void }) {
  return <div className="flex items-center gap-2 flex-wrap">
    <Select label="등락률 연산" value={params.op}
      onChange={(op) => onChange(op === 'between'
        ? { op: 'between', lo: params.lo ?? 2, hi: params.hi ?? 5 }
        : { op, pct: params.pct ?? 5 })}
      options={[['gte', '≥'], ['lte', '≤'], ['between', '사이']]} />
    {params.op === 'between' ? (<>
      <Num ariaLabel="등락률 하한(%)" min={-30} max={30}
        value={params.lo} onChange={(n) => onChange({ ...params, lo: n })} w="w-16" />
      <span className="text-sm text-fg-dim">~</span>
      <Num ariaLabel="등락률 상한(%)" min={-30} max={30}
        value={params.hi} onChange={(n) => onChange({ ...params, hi: n })} w="w-16" /></>
    ) : <Num ariaLabel="등락률(%)" min={-30} max={30}
      value={params.pct} onChange={(n) => onChange({ ...params, pct: n })} w="w-16" />}
    <span className="text-sm text-fg-dim">%</span></div>;
}
