import type { CatalogEntry } from './types';
import { BreakoutForm } from '../paramForms';

export const new_high_vol: CatalogEntry = {
  label: '기간내 신고거래량', defaultParams: { lookback: 60, period: 250 }, ParamForm: BreakoutForm,
  summarize: (p) => `${p.lookback}·${p.period}`,
};
