import type { ScreenerTimeframe, VolumeParams } from '../api/screener';
import { ConditionChoice, ConditionFields, ConditionTimeframe } from './ConditionControls';
import { HistoryDateRangeFields } from './HistoryDateRangeFields';
import { Num, Select } from './paramForms';

export function HistoryVolumeForm({ params, onChange }: {
  params: VolumeParams; onChange: (value: VolumeParams) => void;
}) {
  const historical = 'mode' in params;
  const timeframe = ('timeframe' in params ? params.timeframe : undefined) ?? 'D';
  const minute = timeframe.endsWith('m');
  const legacyHistory = historical && params.record_period.unit !== 'bars';
  const includeOpenBar = ('include_open_bar' in params ? params.include_open_bar : undefined) ?? true;
  const changeTimeframe = (next: ScreenerTimeframe) => {
    if (!historical) onChange({ ...params, timeframe: next });
    else onChange({ mode: 'date_range', start_date: params.start_date, end_date: params.end_date,
      timeframe: next, include_open_bar: 'include_open_bar' in params ? params.include_open_bar : true,
      record_period: { unit: 'bars', value: params.record_period.unit === 'bars' ? params.record_period.value : 250 } });
  };
  return <div className="condition-form">
    <ConditionTimeframe label="거래량 주기" value={timeframe} onChange={changeTimeframe} />
    <ConditionChoice label="거래량 검색 기간" value={historical ? 'date_range' : 'recent'}
      onChange={value => onChange(value === 'recent' ? { lookback: 60,
        period: historical && params.record_period.unit === 'bars' ? params.record_period.value : 250,
        timeframe, include_open_bar: includeOpenBar }
        : timeframe === 'D' ? {
          mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31',
          record_period: { unit: 'years', value: 2 },
        } : {
          mode: 'date_range', start_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }),
          end_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }),
          timeframe, include_open_bar: includeOpenBar,
          record_period: { unit: 'bars', value: !historical ? params.period : 250 },
        })}
      options={[[ 'recent', '최근 N봉' ], ['date_range', '날짜 범위']]} />
    {historical ? <>
      <ConditionFields>
        <HistoryDateRangeFields label="거래량" start={params.start_date} end={params.end_date}
          onChange={dates => onChange({ ...params, ...dates })} />
      </ConditionFields>
      <ConditionFields>
        <Num label="신고 비교 기간" ariaLabel="거래량 비교 기간" suffix={legacyHistory ? undefined : '봉'}
          min={1} max={params.record_period.unit === 'years' ? 20 : 1000}
          value={params.record_period.value} onChange={value => onChange({ ...params,
            record_period: { ...params.record_period, value: value ?? 1 } } as VolumeParams)} />
        {legacyHistory && <Select label="거래량 비교 단위" caption="비교 단위" value={params.record_period.unit}
          onChange={value => onChange(value === 'bars' ? {
            mode: 'date_range', start_date: params.start_date, end_date: params.end_date,
            timeframe: 'D', include_open_bar: true, record_period: { unit: 'bars', value: 250 },
          } : { mode: 'date_range', start_date: params.start_date, end_date: params.end_date,
            record_period: { unit: value === 'years' ? 'years' : 'trading_days',
              value: value === 'years' ? 2 : 500 } })}
          options={[[ 'years', '년' ], ['trading_days', '거래일'], ['bars', '봉']]} />}
      </ConditionFields>
    </> : <ConditionFields>
      <Num label="발생 검색 범위" ariaLabel="최근 기간(봉)" suffix="봉 이내" min={1} max={1000} value={params.lookback}
        onChange={value => onChange({ ...params, lookback: value ?? 1 })} />
      <Num label="신고 비교 기간" ariaLabel="신고 기준 기간(봉)" suffix="봉" min={1} max={1000} value={params.period}
        onChange={value => onChange({ ...params, period: value ?? 1 })} />
    </ConditionFields>}
    <p className="condition-help">{legacyHistory
      ? '기간 중 한 번 이상 · 동률 포함 · 보정 거래량 기준. 년 단위는 당일까지 달력 기준이며 시작 경계일은 제외합니다.'
      : `선택 주기의 봉수 기준 · 동률 포함 · ${minute ? 'KRX 정규장 · 원본 거래량' : 'KRX 일봉 코퍼스 · 보정 거래량'}. 진행 중 봉은 조회 시점까지 반영합니다.`}
      {' '}각 조건은 자기 주기와 평가 범위로 판정하며, 충족 종목을 AND로 결합합니다.
    </p>
  </div>;
}
