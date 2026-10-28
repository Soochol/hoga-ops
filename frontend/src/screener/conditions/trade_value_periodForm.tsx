import type { CandleOptions, TradeValuePeriodOptions } from '../../api/screener';
import { CandleSettings } from '../CandleSettings';
import { HistoryDateRangeFields } from '../HistoryDateRangeFields';
import { Num } from '../paramForms';
import { ConditionChoice, ConditionFields } from '../ConditionControls';

export function TradeValuePeriodForm({ params, onChange }: {
  params: TradeValuePeriodOptions; onChange: (p: TradeValuePeriodOptions) => void;
}) {
  const historical = 'mode' in params;
  const options: CandleOptions = {
    timeframe: ('timeframe' in params ? params.timeframe : undefined) ?? 'D',
    include_open_bar: ('include_open_bar' in params ? params.include_open_bar : undefined) ?? true,
  };
  return <CandleSettings params={options} onChange={patch => onChange({ ...params, ...options, ...patch,
    ...(historical ? { timeframe: patch.timeframe ?? options.timeframe! } : {}) })}
    rangeControl={<ConditionChoice label="거래대금 검색 기간" caption="검색" value={historical ? 'date_range' : 'recent'}
      options={[[ 'recent', '최근 N봉' ], ['date_range', '날짜 범위']]}
      onChange={mode => onChange(mode === 'recent' ? { lookback: 60, min_eok: params.min_eok, ...options } : {
        mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31', min_eok: params.min_eok,
        // Keep legacy daily collection until candle settings are explicitly changed.
        ...(options.timeframe !== 'D' || options.include_open_bar === false
          ? { ...options, timeframe: options.timeframe! } : {}),
      })} />}>
    <ConditionFields>
      {historical ? <HistoryDateRangeFields label="거래대금" start={params.start_date} end={params.end_date}
        onChange={dates => onChange({ ...params, ...dates })} /> : <>
        <Num label="최근" ariaLabel="최근 기간(봉)" suffix="봉 이내" step={1} min={1} max={1000}
          value={params.lookback} onChange={n => onChange({ ...params, lookback: n ?? 1 })} />
      </>}
      {!historical && <Num label="최소" ariaLabel="최소 거래대금(억)" suffix="억 원" min={0}
        value={params.min_eok} onChange={n => onChange({ ...params, min_eok: n ?? 0 })} />
      }
    </ConditionFields>
    {historical && <Num label="최소" ariaLabel="최소 거래대금(억)" suffix="억 원" min={0}
      value={params.min_eok} onChange={n => onChange({ ...params, min_eok: n ?? 0 })} />}
  </CandleSettings>;
}
