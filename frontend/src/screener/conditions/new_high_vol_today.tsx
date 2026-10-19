import { candleSummary } from '../candleLabels';
import type { CatalogEntry } from './types';
import { PeriodForm } from '../paramForms';

export const new_high_vol_today: CatalogEntry<'new_high_vol_today'> = {
  label: '신고거래량', defaultParams: { period: 60 }, ParamForm: PeriodForm,
  summarize: (p) => candleSummary(p, `최신 · ${p.period}봉 신고`),
};
