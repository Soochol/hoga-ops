import type { TradeValueParams } from '../../api/screener';
import { Num } from '../paramForms';
import { CandleSettings } from '../CandleSettings';


export function TradeValueForm({ params, onChange }: { params: TradeValueParams; onChange: (p: TradeValueParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <div className="flex items-center gap-2"><span className="text-sm text-fg-dim">최신 봉 ≥</span>
    <Num ariaLabel="최소 거래대금(억)" min={0}
      value={params.min_eok} onChange={(n) => onChange({ ...params, min_eok: n ?? 0 })} /><span className="text-sm text-fg-dim">억</span></div>
    <p className="text-2xs text-fg-dim">거래대금 추정치 · 분·일봉은 OHLC 평균가 × 거래량, 주·월봉은 일별 추정치 합계입니다.</p>
  </CandleSettings>;
}
