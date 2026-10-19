import type { TradeValueParams } from '../../api/screener';
import { Num } from '../paramForms';
import { CandleSettings } from '../CandleSettings';
import { QuickValues } from '../ConditionControls';


export function TradeValueForm({ params, onChange }: { params: TradeValueParams; onChange: (p: TradeValueParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <Num label="최신 봉 최소 거래대금" ariaLabel="최소 거래대금(억)" suffix="억 원" min={0}
      value={params.min_eok} onChange={n => onChange({ ...params, min_eok: n ?? 0 })} />
    <QuickValues values={[100, 500, 1000]} unit="억" onChange={min_eok => onChange({ ...params, min_eok })} />
    <p className="condition-help">거래대금 추정치 · 분·일봉은 OHLC 평균가 × 거래량, 주·월봉은 일별 추정치 합계입니다.</p>
  </CandleSettings>;
}
