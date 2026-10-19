import type { ScreenerTimeframe, VolumeParams } from '../api/screener';
import { HistoryDateRangeFields } from './HistoryDateRangeFields';
import { Num } from './paramForms';

const SELECT_CLASS = 'bg-bg-input border border-border rounded-md px-2 py-1 text-sm text-fg';
export const volumeTimeframeLabel = (timeframe: ScreenerTimeframe) =>
  timeframe.endsWith('m') ? `${timeframe.slice(0, -1)}분` : ({ D: '일', W: '주', M: '월' }[timeframe as 'D' | 'W' | 'M']);

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
  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-fg-dim">주기</span>
      <select aria-label="거래량 주기" value={minute ? 'minute' : timeframe} className={SELECT_CLASS}
        onChange={e => changeTimeframe(e.target.value === 'minute' ? '5m' : e.target.value as ScreenerTimeframe)}>
        <option value="minute">분</option><option value="D">일</option><option value="W">주</option><option value="M">월</option>
      </select>
      {minute && <select aria-label="분봉 간격" value={timeframe} className={SELECT_CLASS}
        onChange={e => changeTimeframe(e.target.value as ScreenerTimeframe)}>
        {[1, 3, 5, 10, 15, 30, 60].map(value => <option key={value} value={`${value}m`}>{value}분</option>)}
      </select>}
      <select aria-label="거래량 검색 기간" value={historical ? 'date_range' : 'recent'} className={SELECT_CLASS}
        onChange={e => onChange(e.target.value === 'recent' ? { lookback: 60,
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
          })}>
        <option value="recent">최근 N봉</option><option value="date_range">날짜 범위</option>
      </select>
    </div>
    {historical ? <div className="flex flex-wrap items-center gap-2">
      <HistoryDateRangeFields label="거래량" start={params.start_date} end={params.end_date}
        onChange={dates => onChange({ ...params, ...dates })} />
      <Num ariaLabel="거래량 비교 기간" min={1} max={params.record_period.unit === 'years' ? 20 : 1000}
        value={params.record_period.value} onChange={value => onChange({ ...params,
          record_period: { ...params.record_period, value: value ?? 1 } } as VolumeParams)} />
      {legacyHistory ? <select aria-label="거래량 비교 단위" value={params.record_period.unit} className={SELECT_CLASS}
        onChange={e => onChange(e.target.value === 'bars' ? {
          mode: 'date_range', start_date: params.start_date, end_date: params.end_date,
          timeframe: 'D', include_open_bar: true, record_period: { unit: 'bars', value: 250 },
        } : { mode: 'date_range', start_date: params.start_date, end_date: params.end_date,
          record_period: { unit: e.target.value === 'years' ? 'years' : 'trading_days',
            value: e.target.value === 'years' ? 2 : 500 } })}>
        <option value="years">년</option><option value="trading_days">거래일</option>
        <option value="bars">봉</option>
      </select> : <span className="text-sm">봉</span>}
      <span className="text-sm">최대거래량</span>
    </div> : <div className="flex flex-wrap items-center gap-2 text-sm text-fg-dim">
      최근 <Num ariaLabel="최근 기간(봉)" w="w-16" min={1} max={1000} value={params.lookback}
        onChange={value => onChange({ ...params, lookback: value ?? 1 })} />봉 내
      <Num ariaLabel="신고 기준 기간(봉)" w="w-16" min={1} max={1000} value={params.period}
        onChange={value => onChange({ ...params, period: value ?? 1 })} />봉 신고
    </div>}
    <p className="text-2xs text-fg-dim">{legacyHistory
      ? '기간 중 한 번 이상 · 동률 포함 · 보정 거래량 기준. 년 단위는 당일까지 달력 기준이며 시작 경계일은 제외합니다.'
      : `선택 주기의 봉수 기준 · 동률 포함 · ${minute ? 'KRX 정규장 · 원본 거래량' : 'KRX 일봉 코퍼스 · 보정 거래량'}. 진행 중 봉은 조회 시점까지 반영합니다.`}
      {' '}각 조건은 자기 주기와 평가 범위로 판정하며, 충족 종목을 AND로 결합합니다.
    </p>
  </div>;
}
