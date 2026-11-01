import { useState } from 'react';
import type {
  MaAverageOperand, MaCompareParams, MaCrossParams, MaGapParams, MaSlopeParams,
  MaConditionParams, MaOperand, MaThresholdParams, MaSource,
} from '../../api/screener';
import { unixMsToKSTDate } from '../../util/time';
import { CandleSettings } from '../CandleSettings';
import { candleSummary } from '../candleLabels';
import { ConditionChoice } from '../ConditionControls';
import { HistoryDateRangeFields } from '../HistoryDateRangeFields';
import { maOperandLabel, maThresholdLabel } from '../maLabels';
import { useNumericFieldValidation } from '../numericInputValidation';
import { Num, Select } from '../paramForms';
import { PRICE_COMPARE_SYMBOLS } from '../priceCompareLabels';
import type { CatalogEntry } from './types';

const PRICES: [MaSource, string][] = [['open', '시가'], ['high', '고가'], ['low', '저가'], ['close', '종가']];
const PRICE: MaOperand = { kind: 'price', offset: 0, source: 'close' };
const AVERAGE: MaAverageOperand = { kind: 'sma', offset: 0, period: 20, source: 'close' };
type Period = { lookback: number } | { mode: 'date_range'; start_date: string; end_date: string };
type FormParams = MaConditionParams | (MaConditionParams & Period);
type FormPatch = Partial<MaCompareParams & MaCrossParams & MaGapParams & MaSlopeParams & {
  lookback: number; mode: 'date_range'; start_date: string; end_date: string;
}>;

function OperandFields({ label, operand, averageOnly, onChange }: {
  label: string; operand: MaOperand; averageOnly?: boolean; onChange: (p: MaOperand) => void;
}) {
  return <>
    <Num label={label} ariaLabel={`${label} 봉 위치`} value={operand.offset} step={1} min={0} max={1000} suffix="봉 전"
      onChange={offset => onChange({ ...operand, offset: offset ?? 0 })} />
    {!averageOnly && <Select label={`${label} 대상`} caption="" value={operand.kind} options={[[ 'price', '주가' ], ['sma', 'SMA']]}
      onChange={kind => onChange(kind === 'sma' ? { ...operand, kind, period: 20 }
        : { kind, offset: operand.offset, source: operand.source })} />}
    {operand.kind === 'sma' && <Num label="SMA" ariaLabel={`${label} 이동평균 기간`} value={operand.period}
      step={1} min={1} max={1000} suffix="봉" onChange={period => onChange({ ...operand, period: period ?? 1 })} />}
    <Select label={`${label} 계산가격`} caption="" value={operand.source} options={PRICES}
      onChange={source => onChange({ ...operand, source })} />
  </>;
}

function ThresholdFields({ params, onChange }: { params: MaThresholdParams; onChange: (p: Partial<MaThresholdParams>) => void }) {
  return <>
    <ConditionChoice label="변화율 조건" caption="조건" value={params.op}
      options={[[ 'gte', '이상 ≥' ], ['lte', '이하 ≤'], ['between', '범위']]}
      onChange={op => onChange(op === 'between' ? { op, pct: undefined, lo: params.lo ?? -2, hi: params.hi ?? 2 }
        : { op, pct: params.pct ?? 1, lo: undefined, hi: undefined })} />
    {params.op === 'between' ? <>
      <Num label="하한" ariaLabel="변화율 하한(%)" value={params.lo} suffix="%" onChange={lo => onChange({ lo })} />
      <Num label="상한" ariaLabel="변화율 상한(%)" value={params.hi} suffix="%" onChange={hi => onChange({ hi })} />
    </> : <Num label="변화율" ariaLabel="변화율(%)" value={params.pct} suffix="%" onChange={pct => onChange({ pct })} />}
  </>;
}

function Form<T extends FormParams>({ params, onChange }: { params: T; onChange: (p: T) => void }) {
  const [touched, setTouched] = useState(false);
  const invalidRange = 'op' in params && params.op === 'between' && params.lo != null && params.hi != null && params.lo > params.hi;
  const noAverage = 'left' in params && params.left.kind === 'price' && params.right.kind === 'price';
  const error = noAverage ? '이동평균 대상을 하나 이상 선택하세요.' : invalidRange ? '상한은 하한 이상으로 입력하세요.' : null;
  const errorId = useNumericFieldValidation(error !== null);
  const patch = (next: FormPatch) => { setTouched(false); onChange({ ...params, ...next } as T); };
  const historical = 'mode' in params;
  const hasPeriod = historical || 'lookback' in params;
  return <div onBlur={() => setTouched(true)}><CandleSettings params={params} onChange={patch}
    rangeControl={hasPeriod ? <ConditionChoice label="이동평균 검색 기간" caption="검색" value={historical ? 'date_range' : 'recent'}
      options={[[ 'recent', '최근 N봉' ], ['date_range', '날짜 범위']]}
      onChange={mode => {
        const { mode: _mode, start_date: _start, end_date: _end, lookback: _lookback, ...base } = params as T & {
          mode?: string; start_date?: string; end_date?: string; lookback?: number;
        };
        const day = unixMsToKSTDate(Date.now());
        const end = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
        onChange({ ...base, ...(mode === 'recent' ? { lookback: 20 }
          : { mode: 'date_range', start_date: `${end.slice(0, 8)}01`, end_date: end }) } as T);
      }} /> : undefined}>
    {historical ? <HistoryDateRangeFields label="이동평균" start={params.start_date} end={params.end_date}
      onChange={dates => patch(dates)} /> : 'lookback' in params ?
      <Num label="최근" ariaLabel="이동평균 최근 기간(봉)" value={params.lookback} step={1} min={1} max={1000}
        suffix={(params.timeframe ?? 'D') === 'D' ? '거래일 이내' : '봉 이내'}
        onChange={lookback => patch({ lookback: lookback ?? 1 })} /> : null}
    {'average' in params ? <>
      <OperandFields label="대상" operand={params.average} averageOnly onChange={average => { if (average.kind === 'sma') patch({ average }); }} />
      <Num label="비교" ariaLabel="기울기 비교 간격(봉)" value={params.lag} step={1} min={1} max={1000} suffix="봉 전보다"
        onChange={lag => patch({ lag: lag ?? 1 })} />
    </> : <>
      <OperandFields label="대상 A" operand={params.left} onChange={left => patch({ left })} />
      {'relation' in params && <ConditionChoice label="이동평균 비교 관계" caption="관계" value={params.relation}
        options={[[ 'gt', '초과 >' ], ['gte', '이상 ≥'], ['lt', '미만 <'], ['lte', '이하 ≤'], ['eq', '같음 =']]}
        onChange={relation => patch({ relation })} />}
      {'direction' in params && <ConditionChoice label="돌파·교차 방향" caption="방향" value={params.direction}
        options={[[ 'up', '상향 돌파·교차' ], ['down', '하향 돌파·교차']]}
        onChange={direction => patch({ direction })} />}
      <OperandFields label="대상 B" operand={params.right} onChange={right => patch({ right })} />
    </>}
    {'op' in params && <ThresholdFields params={params} onChange={patch} />}
  </CandleSettings>
    {touched && error && <p id={errorId} role="alert" className="condition-number-error">{error}</p>}
  </div>;
}

function summary(p: FormParams): string {
  const period = 'mode' in p ? `${p.start_date}~${p.end_date} 내` : 'lookback' in p ? `최근 ${p.lookback}봉 이내` : '최신';
  const text = 'average' in p ? `${maOperandLabel(p.average)} · ${p.lag}봉 전 대비 ${maThresholdLabel(p)}`
    : 'relation' in p ? `${maOperandLabel(p.left)} ${PRICE_COMPARE_SYMBOLS[p.relation]} ${maOperandLabel(p.right)}`
    : 'direction' in p ? `${maOperandLabel(p.left)} · ${maOperandLabel(p.right)} ${p.direction === 'up' ? '상향' : '하향'} 돌파·교차`
    : `${maOperandLabel(p.left)} / ${maOperandLabel(p.right)} · ${maThresholdLabel(p)}`;
  return candleSummary(p, `${period} · ${text}`);
}
const HELP = '선택 주기의 수정주가로 계산한 SMA입니다. 각 후보 시점의 전체 계산 이력이 필요하며 진행 중 봉의 종가는 마지막 가격이라 판정이 바뀔 수 있습니다.';
const COMPARE: MaCompareParams = { left: PRICE, right: AVERAGE, relation: 'gte' };
const CROSS: MaCrossParams = { left: PRICE, right: AVERAGE, direction: 'up' };
const GAP: MaGapParams = { left: PRICE, right: AVERAGE, op: 'between', lo: -2, hi: 2 };
const SLOPE: MaSlopeParams = { average: AVERAGE, lag: 5, op: 'gte', pct: 1 };

export const ma_compare: CatalogEntry<'ma_compare'> = { label: '이동평균 비교', defaultParams: COMPARE, ParamForm: Form, summarize: summary, help: HELP };
export const ma_compare_period: CatalogEntry<'ma_compare_period'> = { ...ma_compare, label: '기간내 이동평균 비교', defaultParams: { ...COMPARE, lookback: 20 }, ParamForm: Form };
export const ma_cross: CatalogEntry<'ma_cross'> = { label: '이동평균 돌파·교차', defaultParams: CROSS, ParamForm: Form, summarize: summary,
  help: `${HELP} 상향은 직전 A ≤ B에서 현재 A > B로, 하향은 직전 A ≥ B에서 현재 A < B로 바뀐 봉만 기록합니다.` };
export const ma_cross_period: CatalogEntry<'ma_cross_period'> = { ...ma_cross, label: '기간내 이동평균 돌파·교차', defaultParams: { ...CROSS, lookback: 20 }, ParamForm: Form };
export const ma_gap: CatalogEntry<'ma_gap'> = { label: '이동평균 이격률', defaultParams: GAP, ParamForm: Form, summarize: summary,
  help: `${HELP} (A / B − 1) × 100이며 두 값이 같으면 0%입니다.` };
export const ma_gap_period: CatalogEntry<'ma_gap_period'> = { ...ma_gap, label: '기간내 이동평균 이격률', defaultParams: { ...GAP, lookback: 20 }, ParamForm: Form };
export const ma_slope: CatalogEntry<'ma_slope'> = { label: '이동평균 기울기', defaultParams: SLOPE, ParamForm: Form, summarize: summary,
  help: `${HELP} (현재 SMA / N봉 전 SMA − 1) × 100인 기간 대비 변화율입니다. 각도가 아닙니다.` };
export const ma_slope_period: CatalogEntry<'ma_slope_period'> = { ...ma_slope, label: '기간내 이동평균 기울기', defaultParams: { ...SLOPE, lookback: 20 }, ParamForm: Form };
