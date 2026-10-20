import type { TradeValueParams } from '../../api/screener';
import { Num } from '../paramForms';
import { CandleSettings } from '../CandleSettings';


export function TradeValueForm({ params, onChange }: { params: TradeValueParams; onChange: (p: TradeValueParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <Num label="최소" ariaLabel="최소 거래대금(억)" suffix="억 원" min={0}
      value={params.min_eok} onChange={n => onChange({ ...params, min_eok: n ?? 0 })} />
  </CandleSettings>;
}
