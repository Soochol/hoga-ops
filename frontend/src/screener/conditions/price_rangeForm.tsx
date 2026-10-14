import type { PriceRangeParams } from '../../api/screener';
import { Num } from '../paramForms';


export function PriceRangeForm({ params, onChange }: { params: PriceRangeParams; onChange: (p: PriceRangeParams) => void }) {
  return <div className="flex items-center gap-2">
    <Num ariaLabel="최저가(원)" min={0} value={params.min} onChange={(n) => onChange({ ...params, min: n })} w="w-24" />
    <span className="text-sm text-fg-dim">~</span>
    <Num ariaLabel="최고가(원)" min={0} value={params.max} onChange={(n) => onChange({ ...params, max: n })} w="w-24" />
    <span className="text-sm text-fg-dim">원</span></div>;
}
