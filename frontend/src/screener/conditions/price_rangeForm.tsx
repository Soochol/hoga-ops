import { useState } from 'react';
import type { PriceRangeParams } from '../../api/screener';
import { Num } from '../paramForms';
import { ConditionFields } from '../ConditionControls';
import { useNumericFieldValidation } from '../numericInputValidation';


export function PriceRangeForm({ params, onChange }: { params: PriceRangeParams; onChange: (p: PriceRangeParams) => void }) {
  const [touched, setTouched] = useState(false);
  const error = params.min == null && params.max == null ? '최저가 또는 최고가를 입력하세요.'
    : params.min != null && params.max != null && params.min > params.max ? '최고가는 최저가 이상으로 입력하세요.' : null;
  const errorId = useNumericFieldValidation(error !== null);
  const change = (next: PriceRangeParams) => { setTouched(false); onChange(next); };
  return <div className="condition-form" onBlur={() => setTouched(true)} onKeyDown={event => {
    if (event.key === 'Enter') setTouched(true);
  }}>
    <ConditionFields>
      <Num label="최저가" ariaLabel="최저가(원)" suffix="원" placeholder="제한 없음" min={0} step={1} required={false}
        value={params.min} onChange={n => change({ ...params, min: n })} />
      <Num label="최고가" ariaLabel="최고가(원)" suffix="원" placeholder="제한 없음" min={0} step={1} required={false}
        value={params.max} onChange={n => change({ ...params, max: n })} />
    </ConditionFields>
    {touched && error && <span id={errorId} role="alert" className="condition-number-error">{error}</span>}
  </div>;
}
