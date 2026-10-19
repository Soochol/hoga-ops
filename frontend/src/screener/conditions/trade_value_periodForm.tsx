import type { CandleOptions, TradeValuePeriodOptions } from '../../api/screener';
import { CandleSettings } from '../CandleSettings';
import { HistoryDateRangeFields } from '../HistoryDateRangeFields';
import { Num, Select } from '../paramForms';

export function TradeValuePeriodForm({ params, onChange }: {
  params: TradeValuePeriodOptions; onChange: (p: TradeValuePeriodOptions) => void;
}) {
  const historical = 'mode' in params;
  const options: CandleOptions = {
    timeframe: ('timeframe' in params ? params.timeframe : undefined) ?? 'D',
    include_open_bar: ('include_open_bar' in params ? params.include_open_bar : undefined) ?? true,
  };
  return <CandleSettings params={options} onChange={patch => onChange({ ...params, ...options, ...patch,
    ...(historical ? { timeframe: patch.timeframe ?? options.timeframe! } : {}) })}>
    <Select label="거래대금 검색 기간" value={historical ? 'date_range' : 'recent'}
      options={[[ 'recent', '최근 N봉' ], ['date_range', '날짜 범위']]}
      onChange={mode => onChange(mode === 'recent' ? { lookback: 60, min_eok: params.min_eok, ...options } : {
        mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31', min_eok: params.min_eok,
        // Keep legacy daily collection until candle settings are explicitly changed.
        ...(options.timeframe !== 'D' || options.include_open_bar === false
          ? { ...options, timeframe: options.timeframe! } : {}),
      })} />
    <div className="flex items-center gap-2 flex-wrap">
      {historical ? <HistoryDateRangeFields label="거래대금" start={params.start_date} end={params.end_date}
        onChange={dates => onChange({ ...params, ...dates })} /> : <>
        <span className="text-sm text-fg-dim">최근</span>
        <Num ariaLabel="최근 기간(봉)" w="w-16" min={1} max={1000}
          value={params.lookback} onChange={n => onChange({ ...params, lookback: n ?? 1 })} />
        <span className="text-sm text-fg-dim">봉 내</span>
      </>}
      <span className="text-sm text-fg-dim">≥</span>
      <Num ariaLabel="최소 거래대금(억)" min={0}
        value={params.min_eok} onChange={n => onChange({ ...params, min_eok: n ?? 0 })} />
      <span className="text-sm text-fg-dim">억</span>
    </div>
    <p className="text-2xs text-fg-dim">기간 중 개별 봉 하나라도 기준금액 이상 · 기간 전체 합계 조건이 아닙니다.
      거래대금 추정치 · 주·월봉은 일별 추정치 합계, 분·일봉은 OHLC 평균가 × 거래량입니다.
      {historical && !('timeframe' in params) && ' 기존 일봉 날짜 조건은 과거 일봉 보충 수집을 지원합니다.'}</p>
  </CandleSettings>;
}
