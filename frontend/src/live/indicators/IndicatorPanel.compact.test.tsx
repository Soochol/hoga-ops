import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import IndicatorPanel from './IndicatorPanel';
import { CATEGORIES } from './IndicatorPanelHelpers';
import { createCatalogDraft } from './indicatorCatalogDraft';
import { DEFAULT_PREFS, useChartPrefsStore } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS as factory } from '../../state/indicatorSettingsV2';
import { useLivePageStore } from '../../state/livePage';

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({ ...factory, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
  useChartPrefsStore.getState().resetToDefaults();
});
afterEach(cleanup);

it.each(CATEGORIES)('$label uses shared compact switches and opt-in help', category => {
  const timeframe = ['new-high-bearish', 'trade-value'].includes(category.id) ? 'D' : '1m';
  const settings = createCatalogDraft(category.id, factory, DEFAULT_PREFS).store.getState().settings;
  useLivePageStore.setState({ ...settings, indicatorTimeframe: timeframe });
  render(<IndicatorPanel timeframe={timeframe} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: category.label }));
  const editor = screen.getByTestId('indicator-panel-shell');
  expect(editor.querySelector('.settings-editor-description')).toBeNull();
  expect(editor.querySelector('.settings-editor-detail-heading')).not.toHaveTextContent('차트에 추가됨');
  expect(editor.querySelector('.indicator-instance-actions > span')).toBeNull();
  for (const toggle of within(editor).queryAllByRole('switch')) expect(toggle).toHaveClass('window-settings-switch');
  expect(within(editor).queryAllByRole('checkbox')).toHaveLength(0);
  expect(within(editor).getByRole('status')).toHaveTextContent('즉시 반영');
  const help = within(editor).getByRole('button', { name: `${category.label} 설명` });
  fireEvent.click(help);
  expect(help).toHaveAttribute('aria-expanded', 'true');
  expect(editor.querySelector('.settings-editor-description')).toHaveTextContent(category.description);
  fireEvent.click(help);
  expect(editor.querySelector('.settings-editor-description')).toBeNull();
  if (category.notice) expect(editor.querySelector('.indicator-config-notice')).toHaveTextContent(category.notice);
});

it('reveals detailed option help while retaining essential limits and input errors', () => {
  useLivePageStore.setState({ newHighBearishEnabled: true, indicatorTimeframe: 'D' });
  render(<IndicatorPanel timeframe="D" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '신고가 음봉 시가선' }));
  expect(screen.getByText('하락률은 양수로 입력합니다.', { exact: true })).toBeVisible();
  expect(screen.getByText(/마감된 국내 종목 일봉 전용/)).toBeVisible();
  expect(screen.queryByText(/5일선에는 해당 봉의 종가를 포함합니다/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '신고가 음봉 시가선 설명' }));
  expect(screen.getByText(/5일선에는 해당 봉의 종가를 포함합니다/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '신고가 음봉 시가선 설명' }));
  const input = screen.getByLabelText('신고가 기준 N거래일');
  fireEvent.change(input, { target: { value: '' } }); fireEvent.blur(input);
  expect(screen.getByRole('alert')).toBeVisible();
});

it('keeps scope, catalog commit state and the existing master/detail structure', () => {
  render(<IndicatorPanel targetLabel="고영" timeframe="1m" onClose={vi.fn()} />);
  expect(screen.getByTestId('indicator-panel-scope-badge')).toHaveTextContent('고영 · 분봉');
  expect(screen.queryByText('계산 · 선 스타일')).toBeNull();
  expect(within(screen.getByTestId('indicator-style-preview')).getByText('예시')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' }));
  fireEvent.click(screen.getByRole('button', { name: '볼린저 밴드' }));
  const before = useLivePageStore.getState().bollingerPeriod;
  fireEvent.change(screen.getByLabelText('볼린저 기간'), { target: { value: '35' } });
  fireEvent.blur(screen.getByLabelText('볼린저 기간'));
  expect(useLivePageStore.getState().bollingerPeriod).toBe(before);
  expect(screen.getByRole('status')).toHaveTextContent('추가 전');
  expect(screen.getByRole('button', { name: '설정대로 추가' })).toHaveTextContent('추가');
  expect(screen.getByRole('navigation', { name: '지표 추가' })).toBeVisible();
});
