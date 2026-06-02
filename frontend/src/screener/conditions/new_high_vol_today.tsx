import type { CatalogEntry } from './types';
import { PeriodForm } from '../paramForms';

export const new_high_vol_today: CatalogEntry = {
  label: '신고거래량', defaultParams: { period: 60 }, ParamForm: PeriodForm,
  summarize: (p) => `${p.period}일`,
};
