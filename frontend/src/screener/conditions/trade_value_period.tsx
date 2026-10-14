import type { CatalogEntry } from './types';
import { TradeValuePeriodForm } from './trade_value_periodForm';


export const trade_value_period: CatalogEntry<'trade_value_period'> = {
  label: '기간내 거래대금', defaultParams: { lookback: 60, min_eok: 1000 }, ParamForm: TradeValuePeriodForm,
  summarize: (p) => 'mode' in p ? `${p.start_date}~${p.end_date} 내 ≥${p.min_eok}억` : `${p.lookback}일내 ≥${p.min_eok}억`,
};
