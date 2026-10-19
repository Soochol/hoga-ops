import type { PriceRangeParams } from '../../api/screener';
import { Num } from '../paramForms';
import { ConditionFields } from '../ConditionControls';


export function PriceRangeForm({ params, onChange }: { params: PriceRangeParams; onChange: (p: PriceRangeParams) => void }) {
  return <div className="condition-form">
    <ConditionFields>
      <Num label="최저가" ariaLabel="최저가(원)" suffix="원" placeholder="제한 없음" min={0}
        value={params.min} onChange={n => onChange({ ...params, min: n })} />
      <Num label="최고가" ariaLabel="최고가(원)" suffix="원" placeholder="제한 없음" min={0}
        value={params.max} onChange={n => onChange({ ...params, max: n })} />
    </ConditionFields>
    <p className="condition-help">한쪽을 비우면 하한 또는 상한 없이 검색합니다. 현재 조회 기준의 최신 종가에 적용합니다.</p>
  </div>;
}
