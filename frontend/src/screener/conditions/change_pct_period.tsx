import type { ChangePctPeriodOptions } from '../../api/screener';
import { unixMsToKSTDate } from '../../util/time';
import { candleSummary, CHANGE_REFERENCE_LABELS } from '../candleLabels';
import { ConditionChoice } from '../ConditionControls';
import { HistoryDateRangeFields } from '../HistoryDateRangeFields';
import { Num } from '../paramForms';
import { ChangePctForm } from './change_pctForm';
import type { CatalogEntry } from './types';

function ChangePctPeriodForm({ params, onChange }: {
  params: ChangePctPeriodOptions; onChange: (p: ChangePctPeriodOptions) => void;
}) {
  const historical = 'mode' in params;
  return <ChangePctForm params={params} onChange={next => onChange(next as ChangePctPeriodOptions)}
    rangeControl={<ConditionChoice label="등락률 검색 기간" caption="검색" value={historical ? 'date_range' : 'recent'}
      options={[[ 'recent', '최근 N봉' ], ['date_range', '날짜 범위']]}
      onChange={mode => {
        const { timeframe = 'D', include_open_bar = true, change_reference, op, pct, lo, hi } = params;
        const settings = { timeframe, include_open_bar, change_reference, op, pct, lo, hi };
        const today = unixMsToKSTDate(Date.now());
        const end = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
        onChange(mode === 'recent' ? { ...settings, lookback: 20 } : {
          ...settings, mode: 'date_range', start_date: `${end.slice(0, 8)}01`, end_date: end,
        });
      }} />}>
    {historical ? <HistoryDateRangeFields label="등락률" start={params.start_date} end={params.end_date}
      onChange={dates => onChange({ ...params, ...dates })} /> :
      <Num label="최근" ariaLabel="등락률 최근 기간(봉)" suffix={(params.timeframe ?? 'D') === 'D' ? '거래일 이내' : '봉 이내'}
        step={1} min={1} max={1000} value={params.lookback}
        onChange={lookback => onChange({ ...params, lookback: lookback ?? 1 })} />}
  </ChangePctForm>;
}

export const change_pct_period: CatalogEntry<'change_pct_period'> = {
  label: '기간내 등락률', defaultParams: { lookback: 20, op: 'gte', pct: 10 }, ParamForm: ChangePctPeriodForm,
  help: '기간 안의 개별 봉 중 한 번이라도 등락률 조건을 만족한 종목을 찾습니다. 각 봉의 종가를 그 봉 시점의 비교가격과 비교하며 기간 전체의 누적 수익률이 아닙니다. 진행 중 봉은 조회 시점에 따라 충족·해제될 수 있습니다.',
  summarize: p => {
    const range = 'mode' in p ? `${p.start_date}~${p.end_date} 내` : `최근 ${p.lookback}봉 이내`;
    const threshold = p.op === 'between' ? (p.lo != null && p.hi != null ? `${p.lo}~${p.hi}%` : '범위')
      : `${p.op === 'gte' ? '≥' : '≤'} ${p.pct ?? ''}%`;
    return candleSummary(p, `${range} · ${CHANGE_REFERENCE_LABELS[p.change_reference ?? 'previous_day']} ${threshold}`);
  },
};
