import type { PeriodParams } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num } from '../paramForms';

function PeriodForm({ params, onChange }: { params: PeriodParams; onChange: (p: PeriodParams) => void }) {
  return <div className="flex items-center gap-2">
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ period: n ?? 1 })} />
    <span className="text-sm text-fg-dimmer">일</span></div>;
}

export const new_high_today: CatalogEntry = {
  label: '신고가', defaultParams: { period: 200 }, ParamForm: PeriodForm,
  summarize: (p) => `${p.period}일`,
};
