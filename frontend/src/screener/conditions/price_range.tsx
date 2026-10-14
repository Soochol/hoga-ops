import type { CatalogEntry } from './types';
import { PriceRangeForm } from './price_rangeForm';


export const price_range: CatalogEntry<'price_range'> = {
  label: '현재가 범위', defaultParams: { min: 1000 }, ParamForm: PriceRangeForm,
  summarize: (p) => {
    if (p.min != null && p.max != null) return `${p.min}~${p.max}원`;
    if (p.min != null) return `≥ ${p.min}원`;
    if (p.max != null) return `≤ ${p.max}원`;
    return '—';
  },
};
