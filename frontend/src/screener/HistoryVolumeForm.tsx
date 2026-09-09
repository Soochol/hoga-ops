import type { BreakoutParams, HistoryVolumeParams } from '../api/screener';
import { HistoryDateRangeFields } from './HistoryDateRangeFields';
import { BreakoutForm, Num } from './paramForms';

export function HistoryVolumeForm({ params, onChange }: {
  params: BreakoutParams | HistoryVolumeParams;
  onChange: (value: BreakoutParams | HistoryVolumeParams) => void;
}) {
  const historical = 'mode' in params;
  return <div className="flex flex-col gap-2">
    <select aria-label="거래량 검색 기간" value={historical ? 'date_range' : 'recent'}
      className="bg-bg-input border border-border rounded-md px-2 py-1 text-sm text-fg"
      onChange={e => onChange(e.target.value === 'recent' ? { lookback: 60, period: 250 } : {
        mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31',
        record_period: { unit: 'years', value: 2 },
      })}>
      <option value="recent">최근 N거래일</option><option value="date_range">날짜 범위</option>
    </select>
    {historical ? <>
      <div className="flex flex-wrap items-center gap-2">
        <HistoryDateRangeFields label="거래량" start={params.start_date} end={params.end_date}
          onChange={dates => onChange({ ...params, ...dates })} />
        <Num ariaLabel="거래량 비교 기간" min={1} max={params.record_period.unit === 'years' ? 20 : 1000}
          value={params.record_period.value} onChange={value => onChange({ ...params,
            record_period: { ...params.record_period, value: value ?? 1 } })} />
        <select aria-label="거래량 비교 단위" value={params.record_period.unit}
          className="bg-bg-input border border-border rounded-md px-2 py-1 text-sm"
          onChange={e => onChange({ ...params, record_period: {
            unit: e.target.value === 'years' ? 'years' : 'trading_days',
            value: e.target.value === 'years' ? 2 : 500,
          } })}>
          <option value="years">년</option><option value="trading_days">거래일</option>
        </select><span className="text-sm">최대거래량</span>
      </div>
      <p className="text-2xs text-fg-dim">기간 중 한 번 이상 · 동률 포함 · 보정 거래량 기준.
        년 단위는 당일까지 달력 기준이며 2년 전 같은 날짜는 제외합니다.
        다른 현재가·이동평균 조건은 최신일 기준으로 함께 적용됩니다.</p>
    </> : <BreakoutForm params={params} onChange={onChange} />}
  </div>;
}
