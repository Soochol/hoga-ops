import type { ChangePctParams } from '../../api/screener';
import { CandleSettings } from '../CandleSettings';
import { ConditionChoice, ConditionFields } from '../ConditionControls';
import { Num, Select } from '../paramForms';

export function ChangePctForm({ params, onChange }: { params: ChangePctParams; onChange: (p: ChangePctParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <Select label="등락률 비교 기준" value={params.change_reference ?? 'previous_day'}
      options={[[ 'previous_day', '전일 종가 대비' ], ['previous_bar', '직전 봉 종가 대비'], ['bar_open', '해당 봉 시가 대비']]}
      onChange={change_reference => onChange({ ...params, change_reference })} />
    <ConditionChoice label="등락률 연산" value={params.op}
      onChange={op => onChange(op === 'between'
        ? { timeframe: params.timeframe, include_open_bar: params.include_open_bar, change_reference: params.change_reference, op: 'between', lo: params.lo ?? 2, hi: params.hi ?? 5 }
        : { timeframe: params.timeframe, include_open_bar: params.include_open_bar, change_reference: params.change_reference, op, pct: params.pct ?? 5 })}
      options={[['gte', '이상 ≥'], ['lte', '이하 ≤'], ['between', '범위']]} />
    {params.op === 'between' ? <ConditionFields>
      <Num label="등락률 하한" ariaLabel="등락률 하한(%)" suffix="%"
        value={params.lo} onChange={lo => onChange({ ...params, lo })} />
      <Num label="등락률 상한" ariaLabel="등락률 상한(%)" suffix="%"
        value={params.hi} onChange={hi => onChange({ ...params, hi })} />
    </ConditionFields> : <Num label="등락률" ariaLabel="등락률(%)" suffix="%"
      value={params.pct} onChange={pct => onChange({ ...params, pct })} />}
    <p className="condition-help">최신 선택 봉의 종가 기준입니다. 전일 종가는 해당 봉 마지막 거래일의 직전 거래일 종가이며,
      직전 봉은 선택 주기의 바로 앞 봉입니다. 진행 중에는 충족 여부가 바뀔 수 있습니다.</p>
  </CandleSettings>;
}
