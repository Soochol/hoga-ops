import type { MaParams, MaSource } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num, Select } from '../paramForms';

const PRICE_SOURCE_OPTIONS: [MaSource, string][] = [
  ['open', '시가'],
  ['high', '고가'],
  ['low', '저가'],
  ['close', '종가'],
];

const PRICE_SOURCE_LABEL: Record<MaSource, string> = {
  open: '시가',
  high: '고가',
  low: '저가',
  close: '종가',
};

const sourceOf = (params: MaParams): MaSource => params.source ?? 'close';

function MaForm({ params, onChange }: { params: MaParams; onChange: (p: MaParams) => void }) {
  return <div className="flex items-center gap-2">
    <Select label="MA 기준가격" value={sourceOf(params)}
      onChange={(source) => onChange({ ...params, source })}
      options={PRICE_SOURCE_OPTIONS} />
    <Select label="이평선 관계" value={params.relation} onChange={(relation) => onChange({ ...params, relation })}
      options={[['above', '≥'], ['below', '≤']]} />
    <span className="text-sm text-fg-dim">MA</span>
    <Num value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} w="w-16" /></div>;
}

export const ma: CatalogEntry = {
  label: '이동평균', defaultParams: { period: 20, relation: 'above' }, ParamForm: MaForm,
  summarize: (p) => `${PRICE_SOURCE_LABEL[sourceOf(p)]} ${p.relation === 'above' ? '≥' : '≤'} MA${p.period}`,
};
