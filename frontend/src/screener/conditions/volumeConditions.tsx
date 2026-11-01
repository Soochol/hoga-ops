import { useState } from 'react';
import type { VolumeRangeParams, VolumeCompareParams, VolumeRatioParams } from '../../api/screener';
import { unixMsToKSTDate } from '../../util/time';
import { CandleSettings } from '../CandleSettings';
import { candleSummary } from '../candleLabels';
import { ConditionChoice } from '../ConditionControls';
import { HistoryDateRangeFields } from '../HistoryDateRangeFields';
import { useNumericFieldValidation } from '../numericInputValidation';
import { Num } from '../paramForms';
import { PRICE_COMPARE_SYMBOLS } from '../priceCompareLabels';
import type { CatalogEntry } from './types';

type Params = VolumeRangeParams | VolumeCompareParams | VolumeRatioParams;
type Period = { lookback: number } | { mode: 'date_range'; start_date: string; end_date: string };
type FormParams = Params | (Params & Period);
type Patch = Partial<VolumeRangeParams & VolumeCompareParams & VolumeRatioParams>;
const MAX_VOLUME = Number.MAX_SAFE_INTEGER;

function Form<T extends FormParams>({ params, onChange }: { params: T; onChange: (p: T) => void }) {
  const [touched, setTouched] = useState(false);
  const range = 'min_volume' in params || 'max_volume' in params;
  const invalidBounds = range && (params.min_volume == null && params.max_volume == null ||
    params.min_volume != null && params.max_volume != null && params.min_volume > params.max_volume);
  const invalidRatio = 'op' in params && params.op === 'between' && params.lo != null && params.hi != null && params.lo > params.hi;
  const error = invalidBounds ? '거래량 하한 또는 상한을 입력하고 상한을 하한 이상으로 설정하세요.'
    : invalidRatio ? '비율 상한은 하한 이상으로 입력하세요.' : null;
  const errorId = useNumericFieldValidation(error !== null);
  const patch = (next: Patch) => { setTouched(false); onChange({ ...params, ...next } as T); };
  const historical = 'mode' in params;
  const hasPeriod = historical || 'lookback' in params;
  return <div onBlur={() => setTouched(true)}><CandleSettings params={params} onChange={patch}
    rangeControl={hasPeriod ? <ConditionChoice label="거래량 검색 기간" caption="검색" value={historical ? 'date_range' : 'recent'}
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
    {historical ? <HistoryDateRangeFields label="거래량" start={params.start_date} end={params.end_date}
      onChange={dates => onChange({ ...params, ...dates })} /> : 'lookback' in params ?
      <Num label="최근" ariaLabel="거래량 최근 기간(봉)" value={params.lookback} min={1} max={1000} step={1}
        suffix={(params.timeframe ?? 'D') === 'D' ? '거래일 이내' : '봉 이내'}
        onChange={lookback => onChange({ ...params, lookback: lookback ?? 1 })} /> : null}
    {'left_offset' in params ? <>
      <Num label="거래량 A" ariaLabel="거래량 A 봉 위치" value={params.left_offset} min={0} max={1000} step={1} suffix="봉 전"
        onChange={left_offset => patch({ left_offset: left_offset ?? 0 })} />
      <ConditionChoice label="거래량 비교 관계" caption="관계" value={params.relation}
        options={[[ 'gt', '초과 >' ], ['gte', '이상 ≥'], ['lt', '미만 <'], ['lte', '이하 ≤'], ['eq', '같음 =']]}
        onChange={relation => patch({ relation })} />
      <Num label="거래량 B" ariaLabel="거래량 B 봉 위치" value={params.right_offset} min={0} max={1000} step={1} suffix="봉 전"
        onChange={right_offset => patch({ right_offset: right_offset ?? 0 })} />
    </> : <Num label="대상" ariaLabel="거래량 대상 봉 위치" value={params.offset} min={0} max={1000} step={1} suffix="봉 전"
      onChange={offset => patch({ offset: offset ?? 0 })} />}
    {range && <>
      <Num label="하한" ariaLabel="거래량 하한(주)" required={false} value={params.min_volume ?? undefined} min={0} max={MAX_VOLUME} step={1}
        suffix="주 이상" onChange={min_volume => patch({ min_volume })} />
      <Num label="상한" ariaLabel="거래량 상한(주)" required={false} value={params.max_volume ?? undefined} min={0} max={MAX_VOLUME} step={1}
        suffix="주 이하" onChange={max_volume => patch({ max_volume })} />
    </>}
    {'op' in params && <>
      <Num label="직전" ariaLabel="거래량 평균 기간(봉)" value={params.period} min={1} max={1000} step={1} suffix="봉 평균 대비"
        onChange={period => patch({ period: period ?? 1 })} />
      <ConditionChoice label="평균 대비 거래량 관계" caption="비율" value={params.op}
        options={[[ 'gte', '이상 ≥' ], ['lte', '이하 ≤'], ['between', '범위']]}
        onChange={op => patch(op === 'between' ? { op, pct: undefined, lo: params.lo ?? 50, hi: params.hi ?? 200 }
          : { op, pct: params.pct ?? 200, lo: undefined, hi: undefined })} />
      {params.op === 'between' ? <>
        <Num label="하한" ariaLabel="거래량 비율 하한(%)" value={params.lo} min={0} suffix="%" onChange={lo => patch({ lo })} />
        <Num label="상한" ariaLabel="거래량 비율 상한(%)" value={params.hi} min={0} suffix="%" onChange={hi => patch({ hi })} />
      </> : <Num label="평균의" ariaLabel="평균 대비 거래량 비율(%)" value={params.pct} min={0} suffix="%"
        onChange={pct => patch({ pct })} />}
    </>}
  </CandleSettings>{touched && error && <p id={errorId} role="alert" className="condition-number-error">{error}</p>}</div>;
}

function summarize(p: FormParams): string {
  const interval = 'mode' in p ? `${p.start_date}~${p.end_date} 내` : 'lookback' in p ? `최근 ${p.lookback}봉 이내` : '최신';
  const text = 'left_offset' in p ? `${p.left_offset}봉 전 거래량 ${PRICE_COMPARE_SYMBOLS[p.relation]} ${p.right_offset}봉 전 거래량`
    : 'op' in p ? `${p.offset}봉 전 거래량 · 직전 ${p.period}봉 평균의 ${p.op === 'between' ? `${p.lo ?? ''}~${p.hi ?? ''}%`
      : `${p.op === 'gte' ? '≥' : '≤'} ${p.pct ?? ''}%`}`
    : `${p.offset}봉 전 거래량 · ${p.min_volume != null ? `${p.min_volume.toLocaleString('ko-KR')}주 이상` : ''}${p.min_volume != null && p.max_volume != null ? ' · ' : ''}${p.max_volume != null ? `${p.max_volume.toLocaleString('ko-KR')}주 이하` : ''}`;
  return candleSummary(p, `${interval} · ${text}`);
}
const HELP = '선택 주기의 봉별 거래량을 비교합니다. 진행 중 봉은 조회 시점까지의 누적값이며 시간 비례 환산은 하지 않습니다. 확인되지 않은 이력은 판정하지 않습니다.';
export const volume_range: CatalogEntry<'volume_range'> = { label: '거래량 범위', defaultParams: { offset: 0, min_volume: 100000 }, ParamForm: Form, summarize, help: HELP };
export const volume_range_period: CatalogEntry<'volume_range_period'> = { ...volume_range, label: '기간내 거래량 범위', defaultParams: { ...volume_range.defaultParams, lookback: 20 }, ParamForm: Form };
export const volume_compare: CatalogEntry<'volume_compare'> = { label: '거래량 비교', defaultParams: { left_offset: 0, right_offset: 1, relation: 'gt' }, ParamForm: Form, summarize, help: HELP };
export const volume_compare_period: CatalogEntry<'volume_compare_period'> = { ...volume_compare, label: '기간내 거래량 비교', defaultParams: { ...volume_compare.defaultParams, lookback: 20 }, ParamForm: Form };
export const volume_ratio: CatalogEntry<'volume_ratio'> = { label: '평균 대비 거래량', defaultParams: { offset: 0, period: 20, op: 'gte', pct: 200 }, ParamForm: Form, summarize,
  help: `${HELP} 대상 봉을 제외한 직전 N봉 평균으로 나눈 비율입니다. 100%는 평균과 같음, 200%는 두 배입니다. 평균이 0이거나 전체 이력이 없으면 판정 불가입니다.` };
export const volume_ratio_period: CatalogEntry<'volume_ratio_period'> = { ...volume_ratio, label: '기간내 평균 대비 거래량', defaultParams: { ...volume_ratio.defaultParams, lookback: 20 }, ParamForm: Form };
