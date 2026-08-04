import type { TradeValuePeriodParams } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num } from '../paramForms';

function TradeValuePeriodForm({ params, onChange }: { params: TradeValuePeriodParams; onChange: (p: TradeValuePeriodParams) => void }) {
  return <div className="flex items-center gap-2 flex-wrap">
    <span className="text-sm text-fg-dim">최근</span>
    <Num ariaLabel="최근 기간(일)" w="w-16" min={1} max={1000}
      value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
    <span className="text-sm text-fg-dim">일 내 ≥</span>
    <Num ariaLabel="최소 거래대금(억)" min={0}
      value={params.min_eok} onChange={(n) => onChange({ ...params, min_eok: n ?? 0 })} />
    <span className="text-sm text-fg-dim">억</span></div>;
}

export const trade_value_period: CatalogEntry = {
  label: '기간내 거래대금', defaultParams: { lookback: 60, min_eok: 1000 }, ParamForm: TradeValuePeriodForm,
  summarize: (p) => `${p.lookback}일내 ≥${p.min_eok}억`,
};
