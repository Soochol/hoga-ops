import type { HighOffPeakParams } from '../../api/screener';
import { CandleSettings } from '../CandleSettings';
import { Num } from '../paramForms';
import { ConditionChoice, ConditionFields } from '../ConditionControls';


/** (기간 N, 고점 대비 pct%, 이내/이외) 폼 — 최근 N일 고가 peak 대비 현재 고가 위치. */
export function HighOffPeakForm({ params, onChange }: { params: HighOffPeakParams; onChange: (p: HighOffPeakParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <ConditionFields>
    <Num label="기간" ariaLabel="기간(봉)" suffix="봉" step={1} min={1} max={1000}
      value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} />
    <Num label="하락" ariaLabel="고점 대비(%)" suffix="%" min={0} max={100}
      value={params.pct} onChange={n => onChange({ ...params, pct: n ?? 0 })} />
    </ConditionFields>
    <ConditionChoice label="이내/이외" caption="범위" value={params.side}
      onChange={(side) => onChange({ ...params, side })}
      options={[['within', '이내'], ['outside', '이외']]} />
  </CandleSettings>;
}
