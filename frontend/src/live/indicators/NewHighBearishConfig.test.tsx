import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { useLivePageStore } from '../../state/livePage';
import NewHighBearishConfig from './NewHighBearishConfig';

beforeEach(() => { localStorage.clear(); useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: 'D' }); });
afterEach(cleanup);
it('edits N, threshold, count and duration, with the requested factory defaults', () => {
  render(<NewHighBearishConfig />);
  const n = screen.getByLabelText('신고가 기준 N거래일');
  const pct = screen.getByLabelText('전일 종가 대비 저가 하락률 (%)');
  const months = screen.getByLabelText('우측 확장 기간 (개월)');
  expect(n).toHaveValue(200); expect(pct).toHaveValue(7); expect(months).toHaveValue(6);
  fireEvent.change(n, { target: { value: '55' } }); fireEvent.keyDown(n, { key: 'Enter' });
  fireEvent.change(pct, { target: { value: '8.5' } }); fireEvent.blur(pct);
  fireEvent.change(months, { target: { value: '3' } }); fireEvent.keyDown(months, { key: 'Enter' });
  fireEvent.change(screen.getByLabelText('신고가 이후 찾을 음봉 수'), { target: { value: '2' } });
  expect(useLivePageStore.getState()).toMatchObject({ newHighBearishLookback: 55, newHighBearishDropPct: 8.5, newHighBearishMaxCount: 2, newHighBearishMonths: 3 });
});
it('retains invalid drafts with an error and leaves saved settings intact until corrected', () => {
  render(<NewHighBearishConfig />);
  const n = screen.getByLabelText('신고가 기준 N거래일');
  fireEvent.change(n, { target: { value: '' } }); fireEvent.blur(n);
  expect(n).toHaveValue(null); expect(n).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(useLivePageStore.getState().newHighBearishLookback).toBe(200);
  fireEvent.change(n, { target: { value: '30' } }); fireEvent.blur(n);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(useLivePageStore.getState().newHighBearishLookback).toBe(30);
});
