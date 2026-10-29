import { beforeEach, it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import IndicatorPanel from './IndicatorPanel';
import { WindowViewContext, type WindowViewValue } from '../workspace/windowView';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { useWindowSettingsStore, WINDOW_SETTINGS_KEY } from '../../state/windowSettings';

const context: WindowViewValue = { windowId: 'a', group: 1, code: '098460', timeframe: '1m', historicalFromDate: null };
const content = (value = context) => <WindowViewContext.Provider value={value}>
  <IndicatorPanel timeframe={value.timeframe} onClose={() => {}} />
</WindowViewContext.Provider>;
const overlay = () => screen.getByRole('switch', { name: '거래량을 캔들에 겹쳐 표시' });
const undo = async () => {
  const button = screen.getByRole('button', { name: '되돌리기' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeDisabled());
};
const selectVolume = () => fireEvent.click(screen.getByRole('button', { name: /^거래량$/ }));

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
  useChartPrefsStore.getState().resetToDefaults();
  useWindowSettingsStore.setState({ byWindow: {} });
});

it('edits existing window placement and styles, persists and undoes only the last edit including portal colors', async () => {
  const saved = { volumeOverlayEnabled: true, volumeOverlayTransparency: 42, volumeOverlayHeight: 35,
    volumeOverlayUpColor: '#123456', volumeOverlayDownColor: '#654321' };
  useWindowSettingsStore.getState().patch('a', 'chart', saved);
  useWindowSettingsStore.getState().patch('b', 'chart', { volumeOverlayHeight: 20 });
  render(content()); selectVolume();
  expect(overlay()).toHaveAttribute('aria-checked', 'true');
  const details = screen.getByLabelText('거래량을 캔들에 겹쳐 표시 세부 설정');
  expect(details.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(details);
  expect(screen.getByRole('slider', { name: '거래량 투명도' })).toHaveValue('42');
  expect(screen.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('35');
  expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject(saved);
  fireEvent.change(screen.getByRole('slider', { name: '거래량 표시 높이' }), { target: { value: '40' } });
  await undo();
  expect(screen.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('35');
  fireEvent.change(screen.getByRole('slider', { name: '거래량 투명도' }), { target: { value: '10' } });
  await undo();
  expect(screen.getByRole('slider', { name: '거래량 투명도' })).toHaveValue('42');
  fireEvent.click(screen.getByRole('button', { name: '상승봉 거래량 색상 선택' }));
  fireEvent.click(screen.getByRole('button', { name: '상승봉 거래량 색상 #22C55E' }));
  expect(useWindowSettingsStore.getState().byWindow.a.chart!.volumeOverlayUpColor).toBe('#22C55E');
  await undo();
  expect(useWindowSettingsStore.getState().byWindow.a.chart!.volumeOverlayUpColor).toBe('#123456');
  fireEvent.click(overlay());
  expect(screen.queryByLabelText('거래량을 캔들에 겹쳐 표시 세부 설정')).toBeNull();
  await undo();
  expect(overlay()).toHaveAttribute('aria-checked', 'true');
  expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject(saved);
  expect(JSON.parse(localStorage.getItem(WINDOW_SETTINGS_KEY)!).byWindow.a.chart).toMatchObject(saved);
  expect(useWindowSettingsStore.getState().byWindow.b.chart!.volumeOverlayHeight).toBe(20);
  expect(useChartPrefsStore.getState().volumeOverlayEnabled).toBe(false);
});

it('keeps placement across timeframe changes and invalidates undo only for conflicting external edits', async () => {
  useWindowSettingsStore.getState().patch('a', 'chart', { volumeOverlayEnabled: false });
  const view = render(content()); selectVolume(); fireEvent.click(overlay());
  await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
  act(() => useWindowSettingsStore.getState().patch('b', 'chart', { volumeOverlayEnabled: true }));
  expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled();
  act(() => useWindowSettingsStore.getState().patch('a', 'chart', { volumeOverlayEnabled: false }));
  await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeDisabled());
  fireEvent.click(overlay());
  await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
  view.rerender(content({ ...context, timeframe: 'D' }));
  expect(overlay()).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('button', { name: '되돌리기' })).toBeDisabled();
  view.rerender(content({ ...context, windowId: 'c' }));
  expect(overlay()).toHaveAttribute('aria-checked', 'false');
});

it('does not expose window placement in catalog drafts or repeated volume instances', () => {
  render(content());
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' })); selectVolume();
  expect(screen.queryByRole('switch', { name: '거래량을 캔들에 겹쳐 표시' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '설정대로 추가' }));
  expect(screen.queryByRole('switch', { name: '거래량을 캔들에 겹쳐 표시' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '내 지표' }));
  fireEvent.click(screen.getByRole('button', { name: '거래량 1 설정' }));
  expect(overlay()).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '거래량 2 설정' }));
  expect(screen.queryByRole('switch', { name: '거래량을 캔들에 겹쳐 표시' })).toBeNull();
  expect(useWindowSettingsStore.getState().byWindow).toEqual({});
});

it('resets only primary volume settings and placement in its window, and undoes the complete reset', async () => {
  const saved = { volumeOverlayEnabled: true, volumeOverlayTransparency: 42, volumeOverlayHeight: 35,
    volumeOverlayUpColor: '#123456', volumeOverlayDownColor: '#654321' };
  useWindowSettingsStore.getState().patch('a', 'chart', { ...saved, candleLogScale: true });
  useWindowSettingsStore.getState().patch('b', 'chart', { volumeOverlayEnabled: true, volumeOverlayHeight: 40 });
  useLivePageStore.getState().patchIndicatorsScoped({ windowKey: 'live:a' }, '1m', { volumeEnabled: true, volumeColorMode: 'previous-volume' });
  render(content()); selectVolume();
  fireEvent.click(screen.getByRole('button', { name: '거래량 초기화' }));
  expect(overlay()).toHaveAttribute('aria-checked', 'false');
  expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject({ volumeOverlayEnabled: false, volumeOverlayTransparency: 65, volumeOverlayHeight: 25,
    volumeOverlayUpColor: '', volumeOverlayDownColor: '', candleLogScale: true });
  expect(useWindowSettingsStore.getState().byWindow.b.chart).toMatchObject({ volumeOverlayEnabled: true, volumeOverlayHeight: 40 });
  expect(screen.getByLabelText('캔들 색상과 동일')).toBeChecked();
  await undo();
  expect(overlay()).toHaveAttribute('aria-checked', 'true');
  expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject(saved);
  expect(screen.getByLabelText('이전 거래량과 비교')).toBeChecked();
});
