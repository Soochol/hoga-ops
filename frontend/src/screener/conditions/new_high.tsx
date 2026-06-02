import type { CatalogEntry } from './types';
import { BreakoutForm } from '../paramForms';

export const new_high: CatalogEntry = {
  label: '기간내 신고가', defaultParams: { lookback: 200, period: 500 }, ParamForm: BreakoutForm,
  summarize: (p) => `${p.lookback}·${p.period}`,
};
