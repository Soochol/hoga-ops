import type { MaParams, MaSource } from '../../api/screener';
import { CandleSettings } from '../CandleSettings';
import { Num, Select } from '../paramForms';
import { ConditionChoice, ConditionFields } from '../ConditionControls';


const PRICE_SOURCE_OPTIONS: [MaSource, string][] = [
  ['open', '시가'],
  ['high', '고가'],
  ['low', '저가'],
  ['close', '종가'],
];


const sourceOf = (params: MaParams): MaSource => params.source ?? 'close';


export function MaForm({ params, onChange }: { params: MaParams; onChange: (p: MaParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <ConditionFields>
    <Select label="MA 기준가격" caption="가격" value={sourceOf(params)}
      onChange={(source) => onChange({ ...params, source })}
      options={PRICE_SOURCE_OPTIONS} />
    <Num label="SMA" ariaLabel="이동평균 기간(봉)" suffix="봉" min={1} max={1000}
      value={params.period} onChange={n => onChange({ ...params, period: n ?? 1 })} />
    </ConditionFields>
    <ConditionChoice label="이평선 관계" caption="관계" value={params.relation} onChange={relation => onChange({ ...params, relation })}
      options={[['above', '이평선 이상 ≥'], ['below', '이평선 이하 ≤']]} />
  </CandleSettings>;
}
