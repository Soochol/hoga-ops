import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BollingerBreakoutPeriodParams } from '../../api/screener';
import { CONDITION_CATALOG, makeLeaf } from '../catalog';
import { bollinger_breakout } from './bollinger';

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
    fireEvent.click(screen.getByRole('button', { name: '하단 하향돌파' }));
    fireEvent.change(screen.getByLabelText('볼린저 최근 기간'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('표준편차 배수'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('밴드 계산가격'), { target: { value: 'low' } });
    const result = JSON.parse(screen.getByRole('status').textContent!);
    expect(result).toMatchObject({ source: 'high', band_source: 'low', band: 'lower', lookback: 7, multiplier: 2.5, period: 20 });
    expect(CONDITION_CATALOG.bollinger_breakout.summarize(result)).toBe('일봉 · 7봉내 · 고가 · 하단 하향돌파 · BB(20, 2.5, 저가)');
    expect(makeLeaf('bollinger_breakout_today').params).toEqual({ period: 20, multiplier: 2, source: 'close', band_source: 'close', band: 'upper' });
  });
});
