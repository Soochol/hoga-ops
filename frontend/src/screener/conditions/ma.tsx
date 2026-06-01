import type { MaParams } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num, Select } from '../paramForms';

function MaForm({ params, onChange }: { params: MaParams; onChange: (p: MaParams) => void }) {
  return <div className="flex items-center gap-2">
    <span className="text-sm text-fg-dim">종가</span>
    <Select label="이평선 관계" value={params.relation} onChange={(relation) => onChange({ ...params, relation })}
      options={[['above', '≥'], ['below', '≤']]} />
    <span className="text-sm text-fg-dim">MA</span>
    <Num value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} w="w-16" /></div>;
}

export const ma: CatalogEntry = {
  label: '이동평균', defaultParams: { period: 20, relation: 'above' }, ParamForm: MaForm,
  summarize: (p) => `종가 ${p.relation === 'above' ? '≥' : '≤'} MA${p.period}`,
};
