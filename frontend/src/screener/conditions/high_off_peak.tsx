import type { HighOffPeakParams, HighOffPeakSide } from '../../api/screener';
import type { CatalogEntry } from './types';
import { Num, Select } from '../paramForms';

const SIDE: Record<HighOffPeakSide, string> = { within: '이내', outside: '이외' };

/** (기간 N, 고점 대비 pct%, 이내/이외) 폼 — 최근 N일 고가 peak 대비 현재 고가 위치. */
function HighOffPeakForm({ params, onChange }: { params: HighOffPeakParams; onChange: (p: HighOffPeakParams) => void }) {
  return <div className="flex items-center gap-2 flex-wrap">
    <Num label="기간 (N)" value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} />
    <span className="text-sm text-fg-dimmer">일</span>
    <span className="text-[10.5px] text-fg-dimmer">고점 대비 −</span>
    <Num value={params.pct} onChange={(n) => onChange({ ...params, pct: n ?? 0 })} w="w-16" />
    <span className="text-sm text-fg-dimmer">%</span>
    <Select label="이내/이외" value={params.side}
      onChange={(side) => onChange({ ...params, side })}
      options={[['within', '이내'], ['outside', '이외']]} />
  </div>;
}

export const high_off_peak: CatalogEntry = {
  label: '신고가 대비 고가', defaultParams: { period: 250, pct: 30, side: 'within' }, ParamForm: HighOffPeakForm,
  summarize: (p) => `${p.period}일·−${p.pct}%${SIDE[p.side as HighOffPeakSide]}`,
};
