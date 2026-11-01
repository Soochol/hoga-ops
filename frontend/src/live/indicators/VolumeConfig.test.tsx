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
  expect(screen.queryByText('세부 설정')).toBeNull();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toHaveValue('58');
  expect(screen.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('35');
  expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject(saved);
  fireEvent.change(screen.getByRole('slider', { name: '거래량 표시 높이' }), { target: { value: '40' } });
  await undo();
  expect(screen.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('35');
  fireEvent.change(screen.getByRole('slider', { name: '거래량 불투명도' }), { target: { value: '10' } });
  expect(useWindowSettingsStore.getState().byWindow.a.chart!.volumeOverlayTransparency).toBe(90);
  await undo();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toHaveValue('58');
  fireEvent.click(screen.getByRole('button', { name: '상승봉 거래량 색상 선택' }));
  fireEvent.click(screen.getByRole('button', { name: '상승봉 거래량 색상 #22C55E' }));
  expect(useWindowSettingsStore.getState().byWindow.a.chart!.volumeOverlayUpColor).toBe('#22C55E');
  await undo();
  expect(useWindowSettingsStore.getState().byWindow.a.chart!.volumeOverlayUpColor).toBe('#123456');
  fireEvent.click(overlay());
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toBeVisible();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toBeDisabled();
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

it('keeps the same placement form for catalog and repeated volumes without editing the primary window', () => {
  render(content());
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' })); selectVolume();
  expect(overlay()).toBeDisabled();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toBeVisible();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '설정대로 추가' }));
  expect(overlay()).toBeDisabled();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toBeVisible();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '내 지표' }));
  fireEvent.click(screen.getByRole('button', { name: '거래량 1 설정' }));
  expect(overlay()).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '거래량 2 설정' }));
  expect(overlay()).toBeDisabled();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toBeVisible();
  expect(screen.getByRole('slider', { name: '거래량 불투명도' })).toBeDisabled();
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

it('stages first-volume placement until Add, retains it between categories, and undoes the complete addition', async () => {
  useLivePageStore.getState().patchIndicatorsScoped({ windowKey: 'live:a' }, '1m', { volumeEnabled: false });
  const saved = { volumeOverlayEnabled: false, volumeOverlayHeight: 25, volumeOverlayTransparency: 65 };
  useWindowSettingsStore.getState().patch('a', 'chart', saved);
  useWindowSettingsStore.getState().patch('b', 'chart', { volumeOverlayHeight: 20 });
  render(content());
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' })); selectVolume();
  expect(overlay()).toBeEnabled();
  expect(screen.getByRole('slider', { name: '거래량 표시 높이' })).toBeDisabled();
  fireEvent.click(overlay());
  fireEvent.change(screen.getByRole('slider', { name: '거래량 표시 높이' }), { target: { value: '40' } });
  fireEvent.click(screen.getByRole('button', { name: '상승봉 거래량 색상 선택' }));
  fireEvent.click(screen.getByRole('button', { name: '상승봉 거래량 색상 #22C55E' }));
  fireEvent.click(screen.getByRole('button', { name: '볼린저 밴드' })); selectVolume();
  expect(screen.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('40');
  expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject(saved);
  expect(screen.getByRole('button', { name: '되돌리기' })).toBeDisabled();
  // Let the preceding navigation event finish before a background update.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  // Preserve unrelated live edits made while the catalog draft is open.
  act(() => useWindowSettingsStore.getState().patch('a', 'chart', { candleLogScale: true, volumeOverlayTransparency: 30 }));
  fireEvent.click(screen.getByRole('button', { name: '설정대로 추가' }));
  expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject({
    volumeOverlayEnabled: true, volumeOverlayHeight: 40, volumeOverlayUpColor: '#22C55E',
    candleLogScale: true, volumeOverlayTransparency: 30,
  });
  expect(screen.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('40');
  await undo();
  expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject({ ...saved, candleLogScale: true, volumeOverlayTransparency: 30 });
  expect(useWindowSettingsStore.getState().byWindow.b.chart).toMatchObject({ volumeOverlayHeight: 20 });
  expect(screen.getByRole('button', { name: '설정대로 추가' })).toBeEnabled();
});

it('discards unadded placement edits when the editor closes', () => {
  useLivePageStore.getState().patchIndicatorsScoped({ windowKey: 'live:a' }, '1m', { volumeEnabled: false });
  const view = render(content());
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' })); selectVolume();
  fireEvent.click(overlay());
  fireEvent.change(screen.getByRole('slider', { name: '거래량 표시 높이' }), { target: { value: '40' } });
  view.unmount(); render(content());
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' })); selectVolume();
  expect(overlay()).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('slider', { name: '거래량 표시 높이' })).toHaveValue('25');
  expect(useWindowSettingsStore.getState().byWindow).toEqual({});
});

it('enables first-volume placement after deleting the last volume even with a cached catalog draft', () => {
  render(content());
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' })); selectVolume();
  expect(overlay()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '내 지표' })); selectVolume();
  fireEvent.click(screen.getByRole('button', { name: /^삭제$/ }));
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' })); selectVolume();
  expect(overlay()).toBeEnabled();
  fireEvent.click(overlay());
  expect(useWindowSettingsStore.getState().byWindow).toEqual({});
  fireEvent.click(screen.getByRole('button', { name: '설정대로 추가' }));
  expect(useWindowSettingsStore.getState().byWindow.a.chart!.volumeOverlayEnabled).toBe(true);
});
