import type { PriceRangeParams } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num } from '../paramForms';

function PriceRangeForm({ params, onChange }: { params: PriceRangeParams; onChange: (p: PriceRangeParams) => void }) {
  return <div className="flex items-center gap-2">
    <Num label="min" value={params.min} onChange={(n) => onChange({ ...params, min: n })} w="w-24" />
    <span className="text-fg-dimmer">~</span>
    <Num label="max" value={params.max} onChange={(n) => onChange({ ...params, max: n })} w="w-24" />
    <span className="text-sm text-fg-dimmer">원</span></div>;
}

export const price_range: CatalogEntry = {
  label: '현재가 범위', defaultParams: { min: 1000 }, ParamForm: PriceRangeForm,
  summarize: (p) => {
    if (p.min != null && p.max != null) return `${p.min}~${p.max}원`;
    if (p.min != null) return `≥ ${p.min}원`;
    if (p.max != null) return `≤ ${p.max}원`;
    return '—';
  },
};
