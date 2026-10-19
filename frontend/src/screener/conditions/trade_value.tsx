import { candleSummary } from '../candleLabels';
import type { CatalogEntry } from './types';
import { TradeValueForm } from './trade_valueForm';


export const trade_value: CatalogEntry<'trade_value'> = {
  label: '거래대금', defaultParams: { min_eok: 50 }, ParamForm: TradeValueForm,
  summarize: (p) => candleSummary(p, `≥ ${p.min_eok}억 추정`),
};
