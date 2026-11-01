import type { ReactNode } from 'react';
import type { MaSource, PriceCompareOperand, PriceCompareParams, PriceComparePeriodOptions } from '../../api/screener';
import { unixMsToKSTDate } from '../../util/time';
import { CandleSettings } from '../CandleSettings';
import { candleSummary } from '../candleLabels';
import { ConditionChoice } from '../ConditionControls';
import { HistoryDateRangeFields } from '../HistoryDateRangeFields';
import { Num, Select } from '../paramForms';
import { operandLabel, PRICE_COMPARE_SYMBOLS } from '../priceCompareLabels';
import type { CatalogEntry } from './types';

const PRICES: [MaSource, string][] = [['open', '시가'], ['high', '고가'], ['low', '저가'], ['close', '종가']];
const DEFAULTS: PriceCompareParams = { left: { offset: 0, source: 'close' }, right: { offset: 1, source: 'high' }, relation: 'gt' };

function OperandFields({ label, operand, onChange }: {
  label: string; operand: PriceCompareOperand; onChange: (p: PriceCompareOperand) => void;
}) {
  return <>
    <Num label={label} ariaLabel={`${label} 봉 위치`} suffix="봉 전" step={1} min={0} max={1000}
      value={operand.offset} onChange={offset => onChange({ ...operand, offset: offset ?? 0 })} />
    <Select label={`${label} 종류`} caption="" value={operand.source} options={PRICES}
      onChange={source => onChange({ ...operand, source })} />
  </>;
}

function CompareForm<T extends PriceCompareParams>({ params, onChange, rangeControl, children }: {
  params: T; onChange: (p: T) => void; rangeControl?: ReactNode; children?: ReactNode;
}) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })} rangeControl={rangeControl}>
    {children}
    <OperandFields label="가격 A" operand={params.left} onChange={left => onChange({ ...params, left })} />
    <ConditionChoice label="주가 비교 관계" caption="관계" value={params.relation}
      options={[[ 'gt', '초과 >' ], ['gte', '이상 ≥'], ['lt', '미만 <'], ['lte', '이하 ≤'], ['eq', '같음 =']]}
      onChange={relation => onChange({ ...params, relation })} />
    <OperandFields label="가격 B" operand={params.right} onChange={right => onChange({ ...params, right })} />
  </CandleSettings>;
}

function PeriodForm({ params, onChange }: {
  params: PriceComparePeriodOptions; onChange: (p: PriceComparePeriodOptions) => void;
}) {
  const historical = 'mode' in params;
  return <CompareForm params={params} onChange={onChange}
    rangeControl={<ConditionChoice label="주가 비교 검색 기간" caption="검색" value={historical ? 'date_range' : 'recent'}
      options={[[ 'recent', '최근 N봉' ], ['date_range', '날짜 범위']]}
      onChange={mode => {
        const { left, right, relation, timeframe = 'D', include_open_bar = true } = params;
        const settings = { left, right, relation, timeframe, include_open_bar };
        const day = unixMsToKSTDate(Date.now());
        const end = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
        onChange(mode === 'recent' ? { ...settings, lookback: 20 }
          : { ...settings, mode: 'date_range', start_date: `${end.slice(0, 8)}01`, end_date: end });
      }} />}>
    {historical ? <HistoryDateRangeFields label="주가 비교" start={params.start_date} end={params.end_date}
      onChange={dates => onChange({ ...params, ...dates })} />
      : <Num label="최근" ariaLabel="주가 비교 최근 기간(봉)" suffix={(params.timeframe ?? 'D') === 'D' ? '거래일 이내' : '봉 이내'}
        step={1} min={1} max={1000} value={params.lookback}
        onChange={lookback => onChange({ ...params, lookback: lookback ?? 1 })} />}
  </CompareForm>;
}

const comparison = (p: PriceCompareParams) => `${operandLabel(p.left)} ${PRICE_COMPARE_SYMBOLS[p.relation]} ${operandLabel(p.right)}`;
const HELP = '가격 A와 B의 시가·고가·저가·종가를 같은 주기로 비교합니다. 0봉 전은 평가하는 봉, 1봉 전은 직전 봉입니다. 가격의 위치 관계를 판정하며 순간적인 돌파를 뜻하지 않습니다. 진행 중 봉의 종가는 조회 시점의 마지막 가격입니다.';

export const price_compare: CatalogEntry<'price_compare'> = {
  label: '주가 비교', defaultParams: DEFAULTS, ParamForm: CompareForm, help: HELP,
  summarize: p => candleSummary(p, `최신 · ${comparison(p)}`),
};
export const price_compare_period: CatalogEntry<'price_compare_period'> = {
  label: '기간내 주가 비교', defaultParams: { ...DEFAULTS, lookback: 20 }, ParamForm: PeriodForm,
  help: `${HELP} 기간 안에서 한 번이라도 충족하면 검색되며, 봉 위치는 각 후보 봉을 기준으로 이동합니다.`,
  summarize: p => candleSummary(p, `${'mode' in p ? `${p.start_date}~${p.end_date} 내` : `최근 ${p.lookback}봉 이내`} · ${comparison(p)}`),
};
