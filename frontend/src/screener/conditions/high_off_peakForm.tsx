import type { HighOffPeakParams } from '../../api/screener';
import { CandleSettings } from '../CandleSettings';
import { Num } from '../paramForms';
import { ConditionChoice, ConditionFields } from '../ConditionControls';


/** (기간 N, 고점 대비 pct%, 이내/이외) 폼 — 최근 N일 고가 peak 대비 현재 고가 위치. */
export function HighOffPeakForm({ params, onChange }: { params: HighOffPeakParams; onChange: (p: HighOffPeakParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <ConditionFields>
    <Num label="최고 고가 검색 기간" ariaLabel="기간(봉)" suffix="봉" min={1} max={1000}
      value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} />
    <Num label="고점 대비 하락 폭" ariaLabel="고점 대비(%)" suffix="%" min={0} max={100}
      value={params.pct} onChange={n => onChange({ ...params, pct: n ?? 0 })} />
    </ConditionFields>
    <ConditionChoice label="이내/이외" value={params.side}
      onChange={(side) => onChange({ ...params, side })}
      options={[['within', '이내'], ['outside', '이외']]} />
    <p className="condition-help">종가가 아닌 최신 봉의 고가를 비교합니다.</p>
  </CandleSettings>;
}
