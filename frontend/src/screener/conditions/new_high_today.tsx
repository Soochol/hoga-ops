import { candleSummary } from '../candleLabels';
import type { CatalogEntry } from './types';
import { PeriodForm } from '../paramForms';

export const new_high_today: CatalogEntry<'new_high_today'> = {
  label: '신고가', defaultParams: { period: 200 }, ParamForm: PeriodForm,
  summarize: (p) => candleSummary(p, `최신 · ${p.period}봉 신고`),
};
