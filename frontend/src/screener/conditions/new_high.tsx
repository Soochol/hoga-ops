import { candleSummary } from '../candleLabels';
import type { CatalogEntry } from './types';
import { BreakoutForm } from '../paramForms';

export const new_high: CatalogEntry<'new_high'> = {
  label: '기간내 신고가', defaultParams: { lookback: 200, period: 500 }, ParamForm: BreakoutForm,
  summarize: (p) => candleSummary(p, `최근 ${p.lookback}봉 이내 · ${p.period}봉 신고가`),
};
