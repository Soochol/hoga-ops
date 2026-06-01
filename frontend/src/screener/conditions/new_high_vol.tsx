import type { BreakoutParams } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num } from '../paramForms';

function BreakoutForm({ params, onChange }: { params: BreakoutParams; onChange: (p: BreakoutParams) => void }) {
  return <div className="flex items-center gap-3 flex-wrap">
    <Num label="lookback (N)" value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} /></div>;
}

export const new_high_vol: CatalogEntry = {
  label: '기간내 신고거래량', defaultParams: { lookback: 60, period: 250 }, ParamForm: BreakoutForm,
  summarize: (p) => `${p.lookback}·${p.period}`,
};
