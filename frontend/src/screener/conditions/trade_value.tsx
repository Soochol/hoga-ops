import type { TradeValueParams } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num } from '../paramForms';

function TradeValueForm({ params, onChange }: { params: TradeValueParams; onChange: (p: TradeValueParams) => void }) {
  return <div className="flex items-center gap-2"><span className="text-sm text-fg-dim">≥</span>
    <Num value={params.min_eok} onChange={(n) => onChange({ min_eok: n ?? 0 })} /><span className="text-sm text-fg-dimmer">억</span></div>;
}

export const trade_value: CatalogEntry = {
  label: '거래대금', defaultParams: { min_eok: 50 }, ParamForm: TradeValueForm,
  summarize: (p) => `≥ ${p.min_eok}억`,
};
