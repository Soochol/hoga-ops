import type { HistoryTradeValueParams, TradeValuePeriodParams } from '../../api/screener';
import type { CatalogEntry } from './types';
import { HistoryDateRangeFields } from '../HistoryDateRangeFields';
import { Num } from '../paramForms';

type Params = TradeValuePeriodParams | HistoryTradeValueParams;

function TradeValuePeriodForm({ params, onChange }: { params: Params; onChange: (p: Params) => void }) {
  const historical = 'mode' in params;
  return <div className="flex flex-col gap-2">
    <select aria-label="거래대금 검색 기간" value={historical ? 'date_range' : 'recent'}
      className="bg-bg-input border border-border rounded-md px-2 py-1 text-sm text-fg"
      onChange={e => onChange(e.target.value === 'recent' ? { lookback: 60, min_eok: params.min_eok } : {
        mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31', min_eok: params.min_eok,
      })}>
      <option value="recent">최근 N거래일</option><option value="date_range">날짜 범위</option>
    </select>
    <div className="flex items-center gap-2 flex-wrap">
      {historical ? <HistoryDateRangeFields label="거래대금" start={params.start_date} end={params.end_date}
        onChange={dates => onChange({ ...params, ...dates })} /> : <>
        <span className="text-sm text-fg-dim">최근</span>
        <Num ariaLabel="최근 기간(일)" w="w-16" min={1} max={1000}
          value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
        <span className="text-sm text-fg-dim">일 내</span>
      </>}
      <span className="text-sm text-fg-dim">≥</span>
      <Num ariaLabel="최소 거래대금(억)" min={0}
        value={params.min_eok} onChange={(n) => onChange({ ...params, min_eok: n ?? 0 })} />
      <span className="text-sm text-fg-dim">억</span>
    </div>
    {historical && <p className="text-2xs text-fg-dim">시작일·종료일 포함 · 기간 중 하루라도 기준금액 이상.
      거래대금은 OHLC 평균가 × 거래량 추정치이며, 다른 현재가·이동평균 조건은 최신일 기준입니다.</p>}
  </div>;
}

export const trade_value_period: CatalogEntry = {
  label: '기간내 거래대금', defaultParams: { lookback: 60, min_eok: 1000 }, ParamForm: TradeValuePeriodForm,
  summarize: (p) => 'mode' in p ? `${p.start_date}~${p.end_date} 내 ≥${p.min_eok}억` : `${p.lookback}일내 ≥${p.min_eok}억`,
};
