import type { CatalogEntry } from './types';
import { PeriodForm } from '../paramForms';

export const new_high_today: CatalogEntry = {
  label: '신고가', defaultParams: { period: 200 }, ParamForm: PeriodForm,
  summarize: (p) => `${p.period}일`,
};
