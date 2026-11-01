import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ConditionType } from '../../api/screener';
import { screenerRequestKey } from '../../api/screenerRequest';
import { ConditionRow } from '../ConditionRow';
import { CONDITION_CATALOG, makeLeaf } from '../catalog';
import { MA_CONDITION_TYPES } from '../maLabels';
import { BarMatchEvidence } from '../BarMatchEvidence';
import { occurrenceTimeLabel } from '../occurrenceTime';

function Editor({ type }: { type: ConditionType }) {
  const [condition, setCondition] = useState(() => makeLeaf(type));
  return <><ConditionRow leaf={condition} onChange={setCondition} onRemove={() => {}} />
    <output>{JSON.stringify(condition.params)}</output></>;
}
const current = () => JSON.parse(screen.getByRole('status').textContent!);

it.each([...MA_CONDITION_TYPES])('%s retains operands and parameters across edits and date mode switches', type => {
  render(<Editor type={type} />);
  const slope = type.includes('slope');
  if (slope) {
    fireEvent.change(screen.getByLabelText('대상 이동평균 기간'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('기울기 비교 간격(봉)'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('대상 계산가격'), { target: { value: 'open' } });
  } else {
    fireEvent.change(screen.getByLabelText('대상 A 대상'), { target: { value: 'sma' } });
    fireEvent.change(screen.getByLabelText('대상 A 이동평균 기간'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('대상 B 이동평균 기간'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('대상 B 계산가격'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('대상 A 봉 위치'), { target: { value: '2' } });
  }
  fireEvent.change(screen.getByLabelText('봉 주기'), { target: { value: 'W' } });
  if (type.includes('gap') || slope) {
    fireEvent.change(screen.getByLabelText('변화율 조건'), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText('변화율 하한(%)'), { target: { value: '-5' } });
    fireEvent.change(screen.getByLabelText('변화율 상한(%)'), { target: { value: '5' } });
  } else if (type.includes('cross')) {
    fireEvent.change(screen.getByLabelText('돌파·교차 방향'), { target: { value: 'down' } });
  } else {
    fireEvent.change(screen.getByLabelText('이동평균 비교 관계'), { target: { value: 'lte' } });
  }
  const before = current();
  if (type.endsWith('_period')) {
    fireEvent.change(screen.getByLabelText('이동평균 검색 기간'), { target: { value: 'date_range' } });
    fireEvent.change(screen.getByLabelText('이동평균 발생 시작일'), { target: { value: '2026-07-01' } });
    const { lookback: _lookback, ...settings } = before;
    expect(current()).toMatchObject({ ...settings, mode: 'date_range', start_date: '2026-07-01' });
    expect(current()).not.toHaveProperty('lookback');
    fireEvent.change(screen.getByLabelText('이동평균 검색 기간'), { target: { value: 'recent' } });
    expect(current()).toEqual(before);
  } else {
    expect(screen.queryByLabelText('이동평균 검색 기간')).not.toBeInTheDocument();
  }
  expect(slope ? current().average.period : current().right.period).toBe(60);
  expect(current().timeframe).toBe('W');
});

it('rejects price-only pairs and inverted percentage ranges without hiding inputs', () => {
  const { unmount } = render(<Editor type="ma_compare" />);
  fireEvent.change(screen.getByLabelText('대상 B 대상'), { target: { value: 'price' } });
  fireEvent.blur(screen.getByLabelText('대상 B 대상'));
  expect(screen.getByRole('alert')).toHaveTextContent('이동평균 대상을 하나 이상 선택하세요.');
  fireEvent.change(screen.getByLabelText('대상 A 대상'), { target: { value: 'sma' } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount();
  render(<Editor type="ma_gap" />);
  fireEvent.change(screen.getByLabelText('변화율 하한(%)'), { target: { value: '5' } });
  fireEvent.blur(screen.getByLabelText('변화율 하한(%)'));
  expect(screen.getByRole('alert')).toHaveTextContent('상한은 하한 이상으로 입력하세요.');
  expect(screen.getByLabelText('대상 B 이동평균 기간')).toBeVisible();
});

it('normalizes candle defaults while keeping operands and thresholds distinct', () => {
  const condition = makeLeaf('ma_slope_period');
  const req = { universe: {}, conditions: [condition] };
  expect(screenerRequestKey(req)).toBe(screenerRequestKey({ ...req,
    conditions: [{ ...condition, params: { ...condition.params, timeframe: 'D', include_open_bar: true } } as typeof condition] }));
  expect(CONDITION_CATALOG.ma_gap.summarize(CONDITION_CATALOG.ma_gap.defaultParams)).toContain('-2~2%');
  expect(CONDITION_CATALOG.ma_slope.summarize(CONDITION_CATALOG.ma_slope.defaultParams)).toContain('5봉 전 대비 ≥ 1%');
});

it('shows SMA values, signed percentages and the prior crossing evidence', () => {
  const value = { kind: 'sma' as const, offset: 0, source: 'close' as const, period: 20,
    value: 100, bar_start_ms: Date.parse('2026-07-28T10:00:00+09:00'),
    window_start_ms: Date.parse('2026-07-28T09:00:00+09:00'), is_open: true };
  const event = { condition_id: 'ma', condition_key: 'ma', date: '2026-07-28', bar_start_ms: value.bar_start_ms,
    bar_ma_match: { kind: 'cross' as const, timeframe: '5m' as const, direction: 'up' as const, relation: null,
      left: { ...value, value: 110 }, right: value, previous_left: { ...value, value: 90 }, previous_right: value,
      value_pct: null, is_open: true, fetched_at_ms: 1 } };
  expect(occurrenceTimeLabel(event)).toBe('2026-07-28 10:00');
  const { rerender } = render(<BarMatchEvidence event={event} />);
  expect(screen.getByText(/직전 A 90원/)).toHaveTextContent('상향 돌파·교차');
  expect(screen.getByText(/계산 시작/)).toHaveTextContent('2026-07-28 09:00');
  rerender(<BarMatchEvidence event={{ ...event, bar_ma_match: { ...event.bar_ma_match,
    kind: 'gap', previous_left: null, previous_right: null, value_pct: -2 } }} />);
  expect(screen.getByText('이격률 -2%')).toBeVisible();
});
