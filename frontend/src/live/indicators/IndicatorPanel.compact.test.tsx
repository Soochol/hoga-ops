import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
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
  expect(editor.querySelector('.settings-property-group-label')).not.toBeNull();
  expect(editor.querySelector('.settings-property-group-body')).not.toBeNull();
  expect(editor.querySelector('.settings-dependent > summary')).toBeNull();
  expect(editor.querySelector('.settings-editor-description')).toBeNull();
  expect(editor.querySelector('.settings-editor-detail-heading')).not.toHaveTextContent('차트에 추가됨');
  expect(editor.querySelector('.indicator-instance-actions > span')).toBeNull();
  for (const toggle of within(editor).queryAllByRole('switch')) expect(toggle).toHaveClass('window-settings-switch');
  expect(within(editor).queryAllByRole('checkbox')).toHaveLength(0);
  expect(within(editor.querySelector('.settings-editor-footer') as HTMLElement).getByRole('status')).toHaveTextContent('즉시 반영');
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
  expect(screen.getByText(/마감된 일봉 전용/)).toBeVisible();
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
  expect(within(screen.getByTestId('indicator-panel-shell').querySelector('.settings-editor-footer') as HTMLElement).getByRole('status')).toHaveTextContent('추가 전');
  expect(screen.getByRole('button', { name: '설정대로 추가' })).toHaveTextContent('추가');
  expect(screen.getByRole('navigation', { name: '지표 추가' })).toBeVisible();
});

it.each([
  ['볼린저 밴드', '볼린저', 'bollingerLineWidth'],
  ['엔벨로프', '엔벨로프', 'envelopeLineWidth'],
  ['슈퍼트렌드', '슈퍼트렌드', 'supertrendLineWidth'],
] as const)('%s edits its shared width once and undoes it without changing line colors', async (category, label, key) => {
  useLivePageStore.setState({ bollingerEnabled: true, envelopeEnabled: true, supertrendEnabled: true, [key]: 2 });
  render(<IndicatorPanel timeframe="1m" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: category }));
  const before = useLivePageStore.getState();
  const input = screen.getByRole('combobox', { name: `${label} 공통 선 두께` });
  expect(screen.getAllByRole('combobox', { name: `${label} 공통 선 두께` })).toHaveLength(1);
  fireEvent.change(input, { target: { value: '4' } });
  expect(useLivePageStore.getState()[key]).toBe(4);
  for (const color of ['bollingerUpperColor', 'envelopeUpperColor', 'supertrendUpColor'] as const) {
    expect(useLivePageStore.getState()[color]).toBe(before[color]);
  }
  await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  await waitFor(() => expect(input).toHaveValue('2'));
});
