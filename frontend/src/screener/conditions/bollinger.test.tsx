import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BollingerBreakoutParams, BollingerBreakoutPeriodParams } from '../../api/screener';
import { CONDITION_CATALOG, makeLeaf } from '../catalog';
import { bollinger_breakout, bollinger_position } from './bollinger';

describe('Bollinger breakout settings', () => {
  it('keeps comparison and band prices separate and persists fractional multipliers', () => {
    const initial = makeLeaf('bollinger_breakout').params as BollingerBreakoutPeriodParams;
    function Editor() {
      const [params, setParams] = useState(initial);
      const Form = bollinger_breakout.ParamForm;
      return <><Form params={params} onChange={setParams} /><output>{JSON.stringify(params)}</output></>;
    }
    render(<Editor />);
    fireEvent.change(screen.getByLabelText('돌파 비교가격'), { target: { value: 'high' } });
    fireEvent.change(screen.getByRole('combobox', { name: '돌파 밴드' }), { target: { value: 'lower' } });
    fireEvent.change(screen.getByLabelText('볼린저 최근 기간'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('표준편차 배수'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('밴드 계산가격'), { target: { value: 'low' } });
    const result = JSON.parse(screen.getByRole('status').textContent!);
    expect(result).toMatchObject({ source: 'high', band_source: 'low', band: 'lower', lookback: 7, multiplier: 2.5, period: 20 });
    expect(CONDITION_CATALOG.bollinger_breakout.summarize(result)).toBe('일봉 · 7봉내 · 고가 · 하단 하향돌파 · BB(20, 2.5, 저가)');
    expect(makeLeaf('bollinger_breakout_today').params).toEqual({ period: 20, multiplier: 2, source: 'close', band_source: 'close', band: 'upper' });
  });
});


describe('Bollinger position settings', () => {
  it('edits position, independent OHLC prices, candle scope and recent range', () => {
    const initial = makeLeaf('bollinger_position').params as BollingerBreakoutPeriodParams;
    function Editor() {
      const [params, setParams] = useState(initial);
      const Form = bollinger_position.ParamForm;
      return <><Form params={params} onChange={setParams} /><output>{JSON.stringify(params)}</output></>;
    }
    render(<Editor />);
    fireEvent.change(screen.getByLabelText('비교가격', { exact: true }), { target: { value: 'low' } });
    fireEvent.change(screen.getByRole('combobox', { name: '위치' }), { target: { value: 'lower' } });
    fireEvent.change(screen.getByLabelText('볼린저 최근 기간'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('볼린저 기간', { exact: true }), { target: { value: '35' } });
    fireEvent.change(screen.getByLabelText('표준편차 배수'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('밴드 계산가격'), { target: { value: 'high' } });
    const result = JSON.parse(screen.getByRole('status').textContent!);
    expect(result).toMatchObject({ source: 'low', band_source: 'high', band: 'lower', lookback: 7, multiplier: 2.5, period: 35 });
    expect(bollinger_position.summarize(result)).toBe('일봉 · 7봉내 · 저가 · 하단 밴드 아래 · BB(35, 2.5, 고가)');
    expect(bollinger_position.help).toContain('직전 봉의 위치는 보지 않습니다');
    expect(screen.queryByLabelText('돌파 비교가격')).not.toBeInTheDocument();
  });

  it('defaults both variants to close above the upper band, keeping independent copies', () => {
    const params = { period: 20, multiplier: 2, source: 'close', band_source: 'close', band: 'upper' };
    expect(makeLeaf('bollinger_position_today').params).toEqual(params);
    expect(makeLeaf('bollinger_position').params).toEqual({ ...params, lookback: 5 });
    expect(CONDITION_CATALOG.bollinger_position_today.summarize(params as BollingerBreakoutParams))
      .toBe('일봉 · 최신 · 종가 · 상단 밴드 위 · BB(20, 2, 종가)');
    const first = makeLeaf('bollinger_position').params as BollingerBreakoutPeriodParams;
    first.period = 99;
    expect((makeLeaf('bollinger_position').params as BollingerBreakoutPeriodParams).period).toBe(20);
  });
});
