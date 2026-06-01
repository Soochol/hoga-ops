import type { ChangePctParams } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num, Select } from '../paramForms';

const OP = { gte: '≥', lte: '≤', between: '사이' } as const;

function ChangePctForm({ params, onChange }: { params: ChangePctParams; onChange: (p: ChangePctParams) => void }) {
  return <div className="flex items-center gap-2 flex-wrap">
    <Select label="등락률 연산" value={params.op}
      onChange={(op) => onChange(op === 'between'
        ? { op: 'between', lo: params.lo ?? 2, hi: params.hi ?? 5 }
        : { op, pct: params.pct ?? 5 })}
      options={[['gte', '≥'], ['lte', '≤'], ['between', '사이']]} />
    {params.op === 'between' ? (<>
      <Num label="lo" value={params.lo} onChange={(n) => onChange({ ...params, lo: n })} w="w-16" />
      <span className="text-fg-dimmer">~</span>
      <Num label="hi" value={params.hi} onChange={(n) => onChange({ ...params, hi: n })} w="w-16" /></>
    ) : <Num value={params.pct} onChange={(n) => onChange({ ...params, pct: n })} w="w-16" />}
    <span className="text-sm text-fg-dimmer">%</span></div>;
}

export const change_pct: CatalogEntry = {
  label: '등락률', defaultParams: { op: 'gte', pct: 5 }, ParamForm: ChangePctForm,
  summarize: (p) => {
    if (p.op === 'between') return (p.lo != null && p.hi != null) ? `${p.lo}~${p.hi}%` : '사이';
    return `${OP[p.op as 'gte' | 'lte']} ${p.pct ?? ''}%`;
  },
};
