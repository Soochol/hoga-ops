import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { CalculationPolicy, ConditionType } from '../../api/screener';
import { screenerRequestKey } from '../../api/screenerRequest';
import { BarMatchEvidence } from '../BarMatchEvidence';
import { ConditionRow } from '../ConditionRow';
import { CONDITION_CATALOG, makeLeaf } from '../catalog';
import { separateVolumeBases } from '../calculationPolicy';
import { occurrenceTimeLabel } from '../occurrenceTime';
import { VOLUME_CONDITION_TYPES, volumeValueLabel } from '../volumeLabels';

function Editor({ type, policy }: { type: ConditionType; policy?: CalculationPolicy }) {
  const [condition, setCondition] = useState(() => makeLeaf(type));
  return <><ConditionRow leaf={condition} calculationPolicy={policy} onChange={setCondition} onRemove={() => {}} />
    <output>{JSON.stringify(condition.params)}</output></>;
}
const current = () => JSON.parse(screen.getByRole('status').textContent!);

it.each([...VOLUME_CONDITION_TYPES])('%s preserves settings and timeframe through date switches', type => {
  render(<Editor type={type} />);
  const compare = type.includes('compare');
  fireEvent.change(screen.getByLabelText(compare ? '거래량 A 봉 위치' : '거래량 대상 봉 위치'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('봉 주기'), { target: { value: 'W' } });
  if (compare) {
    fireEvent.change(screen.getByLabelText('거래량 B 봉 위치'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('거래량 비교 관계'), { target: { value: 'lte' } });
  } else if (type.includes('ratio')) {
    fireEvent.change(screen.getByLabelText('거래량 평균 기간(봉)'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('평균 대비 거래량 관계'), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText('거래량 비율 하한(%)'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('거래량 비율 상한(%)'), { target: { value: '80' } });
  } else {
    fireEvent.change(screen.getByLabelText('거래량 하한(주)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('거래량 상한(주)'), { target: { value: '500' } });
  }
  const before = current();
  if (type.endsWith('_period')) {
    fireEvent.change(screen.getByLabelText('거래량 검색 기간'), { target: { value: 'date_range' } });
    fireEvent.change(screen.getByLabelText('거래량 발생 시작일'), { target: { value: '2026-07-01' } });
    const { lookback: _lookback, ...settings } = before;
    expect(current()).toMatchObject({ ...settings, mode: 'date_range', start_date: '2026-07-01' });
    expect(current()).not.toHaveProperty('lookback');
    fireEvent.change(screen.getByLabelText('거래량 검색 기간'), { target: { value: 'recent' } });
    expect(current()).toEqual(before);
  }
  expect(current().timeframe).toBe('W');
});

it('permits one optional volume bound and rejects empty or inverted bounds', () => {
  render(<Editor type="volume_range" />);
  expect(screen.getByLabelText('거래량 상한(주)')).toHaveAttribute('aria-required', 'false');
  fireEvent.change(screen.getByLabelText('거래량 하한(주)'), { target: { value: '' } });
  fireEvent.blur(screen.getByLabelText('거래량 하한(주)'));
  expect(screen.getByRole('alert')).toHaveTextContent('거래량 하한 또는 상한');
  fireEvent.change(screen.getByLabelText('거래량 상한(주)'), { target: { value: '0' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(current().max_volume).toBe(0);
  fireEvent.change(screen.getByLabelText('거래량 하한(주)'), { target: { value: '1' } });
  fireEvent.blur(screen.getByLabelText('거래량 하한(주)'));
  expect(screen.getByRole('alert')).toHaveTextContent('상한을 하한 이상');
});

it.each([...VOLUME_CONDITION_TYPES])('%s retains volume basis and uses raw volume for minute edits', type => {
  render(<Editor type={type} policy="separate_bases_v2" />);
  fireEvent.change(screen.getByLabelText('거래량 기준'), { target: { value: 'raw' } });
  expect(current().volume_basis).toBe('raw');
  fireEvent.change(screen.getByLabelText('거래량 기준'), { target: { value: 'share_adjusted' } });
  fireEvent.change(screen.getByLabelText('봉 주기'), { target: { value: '5m' } });
  expect(current().volume_basis).toBe('raw');
  expect(screen.queryByLabelText('거래량 기준')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('봉 주기'), { target: { value: 'D' } });
  expect(current().volume_basis).toBe('raw');
  expect(separateVolumeBases([makeLeaf(type)])[0].params).toHaveProperty('volume_basis', 'share_adjusted');
});

it('keeps quantity precision and labels ratio, prior average window, basis and minute time', () => {
  expect(volumeValueLabel('18014398509481985')).toBe('18,014,398,509,481,985');
  expect(volumeValueLabel('151/2')).toBe('151/2');
  const start = Date.parse('2026-07-28T10:00:00+09:00');
  const event = { condition_id: 'volume', condition_key: 'key', date: '2026-07-28', bar_start_ms: start,
    bar_volume_condition_match: { kind: 'ratio' as const, timeframe: '5m' as const, basis: 'raw' as const,
      left: { offset: 0, value: '300', bar_start_ms: start, is_open: true }, right: null, relation: null,
      average: '100', period: 20, window_start_ms: start - 6000000, window_end_ms: start - 300000,
      ratio_pct: 300, is_open: true, fetched_at_ms: 1 } };
  render(<BarMatchEvidence event={event} />);
  expect(occurrenceTimeLabel(event)).toBe('2026-07-28 10:00');
  expect(screen.getByText(/직전 20봉 평균/)).toHaveTextContent('직전 20봉 평균 100주 · 평균의 300%');
  expect(screen.getByText(/평균 구간/)).toHaveTextContent('09:55');
  expect(screen.getByText(/실제 거래량/)).toHaveTextContent('발생 봉 진행 중');
});

it('normalizes candle defaults without merging different offsets or quantity bases', () => {
  const condition = { id: 'volume', type: 'volume_ratio' as const, params: CONDITION_CATALOG.volume_ratio.defaultParams };
  const req = { conditions: [condition], universe: {} };
  expect(screenerRequestKey(req)).toBe(screenerRequestKey({ ...req,
    conditions: [{ ...condition, params: { ...condition.params, timeframe: 'D', include_open_bar: true } }] }));
  expect(screenerRequestKey(req)).not.toBe(screenerRequestKey({ ...req,
    conditions: [{ ...condition, params: { ...condition.params, offset: 1 } }] }));
  expect(CONDITION_CATALOG.volume_ratio.summarize(CONDITION_CATALOG.volume_ratio.defaultParams)).toContain('직전 20봉 평균의 ≥ 200%');
});
