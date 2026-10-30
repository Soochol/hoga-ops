import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import IndicatorPanel from './IndicatorPanel';
import { CATEGORIES } from './IndicatorPanelHelpers';
import { createCatalogDraft, indicatorIsPresent } from './indicatorCatalogDraft';
import { DEFAULT_PREFS, useChartPrefsStore } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS as factory } from '../../state/indicatorSettingsV2';
import { useLivePageStore } from '../../state/livePage';
import { makeIndicatorInstance } from '../../state/indicatorInstances';

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({ ...factory, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: 'D' });
  useChartPrefsStore.getState().resetToDefaults();
});
afterEach(cleanup);
it.each(CATEGORIES)('$label has reset immediately after copy and retains its presence', async category => {
  const tf = ['trade-value', 'new-high-bearish'].includes(category.id) ? 'D' : '1m';
  const state = createCatalogDraft(category.id, factory, DEFAULT_PREFS).store.getState().settings;
  useLivePageStore.setState({ ...state, indicatorTimeframe: tf });
  render(<IndicatorPanel timeframe={tf} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: category.label }));
  const reset = screen.getByRole('button', { name: `${category.label} 초기화` });
  expect(reset.previousElementSibling).toHaveTextContent('복사해서 추가');
  fireEvent.click(reset);
  expect(indicatorIsPresent(category.id, useLivePageStore.getState())).toBe(true);
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));
});
it('resets a selected repeated item and restores it through the existing footer undo', async () => {
  const settings = { ...factory, newHighBearishEnabled: true, newHighBearishLookback: 50, newHighBearishMonths: 3 };
  const row = { ...makeIndicatorInstance('new-high-bearish', settings, DEFAULT_PREFS), hidden: true };
  useLivePageStore.setState({ ...settings, indicatorInstances: [row] });
  render(<IndicatorPanel timeframe="D" onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '신고가 음봉 시가선 2 설정' }));
  fireEvent.click(screen.getByRole('button', { name: '신고가 음봉 시가선 초기화' }));
  expect(screen.getByLabelText('신고가 기준 N거래일')).toHaveValue(200);
  expect(useLivePageStore.getState().indicatorInstances![0]).toMatchObject({ id: row.id, hidden: true, settings: { newHighBearishLookback: 200, newHighBearishMonths: 6 } });
  expect(useLivePageStore.getState().newHighBearishLookback).toBe(50);
  await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  await waitFor(() => expect(screen.getByLabelText('신고가 기준 N거래일')).toHaveValue(50));
  expect(useLivePageStore.getState().indicatorInstances![0]).toEqual(row);
});
it('clears uncommitted invalid inputs even if the saved values are already defaults', () => {
  useLivePageStore.setState({ newHighBearishEnabled: true });
  render(<IndicatorPanel timeframe="D" onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '신고가 음봉 시가선' }));
  const input = screen.getByLabelText('신고가 기준 N거래일');
  fireEvent.change(input, { target: { value: '' } }); fireEvent.blur(input);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '신고가 음봉 시가선 초기화' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('신고가 기준 N거래일')).toHaveValue(200);
});
