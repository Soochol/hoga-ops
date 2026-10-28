import { useState } from 'react';
import type { ChangePctParams } from '../../api/screener';
import { CandleSettings } from '../CandleSettings';
import { ConditionChoice, ConditionFields } from '../ConditionControls';
import { Num, Select } from '../paramForms';
import { useNumericFieldValidation } from '../numericInputValidation';

export function ChangePctForm({ params, onChange }: { params: ChangePctParams; onChange: (p: ChangePctParams) => void }) {
  const [touched, setTouched] = useState(false);
  const invalidRange = params.op === 'between' && params.lo != null && params.hi != null && params.lo > params.hi;
  const errorId = useNumericFieldValidation(invalidRange);
  const change = (next: ChangePctParams) => { setTouched(false); onChange(next); };
  return <div onBlur={() => setTouched(true)} onKeyDown={event => { if (event.key === 'Enter') setTouched(true); }}>
    <ChangePctFields params={params} onChange={change} />
    {touched && invalidRange && <p id={errorId} role="alert" className="condition-number-error">상한은 하한 이상으로 입력하세요.</p>}
  </div>;
}

function ChangePctFields({ params, onChange }: { params: ChangePctParams; onChange: (p: ChangePctParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <Select label="등락률 비교 기준" caption="대비" value={params.change_reference ?? 'previous_day'}
      options={[[ 'previous_day', '전일 종가 대비' ], ['previous_bar', '직전 봉 종가 대비'], ['bar_open', '해당 봉 시가 대비']]}
      onChange={change_reference => onChange({ ...params, change_reference })} />
    <ConditionChoice label="등락률 연산" caption="조건" value={params.op}
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
  </CandleSettings>;
}
