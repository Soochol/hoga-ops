import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChartDisplaySettings } from './ChartDisplaySettings';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { CHART_DISPLAY_TOGGLES } from '../../state/chartDisplayPrefs';
import { useWindowSettingsStore } from '../../state/windowSettings';

const initial = useChartPrefsStore.getState();
beforeEach(() => useWindowSettingsStore.setState({ byWindow: {} }));
afterEach(() => useChartPrefsStore.setState(initial, true));

describe('chart display settings', () => {
  it('uses shared label tooltips and edits price-line styles inline', () => {
    render(<ChartDisplaySettings windowId="a" />);
    const definition = CHART_DISPLAY_TOGGLES.find(def => def.key === 'candleLogScale')!;
    expect(screen.queryByText(definition.description)).toBeNull();
    const label = screen.getByText(definition.label, { exact: true });
    expect(label).toHaveAttribute('data-tooltip', definition.description);
    expect(label.tagName).toBe('LABEL');
    expect(label).not.toHaveAttribute('title');
    fireEvent.click(screen.getByLabelText('고저 극값 라벨 세부 설정'));
    fireEvent.click(screen.getByRole('checkbox', { name: '고가 가격선' }));
    expect(screen.getByLabelText('고가 가격선 색상')).toHaveAttribute('type', 'color');
    expect(screen.getByRole('combobox', { name: '고가 가격선 두께' })).toHaveValue('1');
    expect(document.querySelector('.chart-display-settings .settings-row-description')).toBeNull();
  });
  it('owns high/low line styles and their undo in the edited chart only', async () => {
    useWindowSettingsStore.getState().patch('b', 'chart', { highLowHighLineColor: '#123456', highLowHighLineWidth: 2 });
    render(<ChartDisplaySettings windowId="a" />);
    const details = screen.getByLabelText('고저 극값 라벨 세부 설정');
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    expect(screen.getByRole('checkbox', { name: '고가 가격선' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: '고가 가격선' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('고가 가격선 색상'), { target: { value: '#22C55E' } });
    await waitFor(() => expect(useWindowSettingsStore.getState().byWindow.a.chart!.highLowHighLineColor).toBe('#22C55E'));
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.change(screen.getByRole('combobox', { name: '고가 가격선 두께' }), { target: { value: '4' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.highLowHighLineWidth).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(useWindowSettingsStore.getState().byWindow.a.chart!.highLowHighLineWidth).toBe(1));
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.highLowHighLineColor).toBe('#22C55E');
    expect(useWindowSettingsStore.getState().byWindow.b.chart).toMatchObject({ highLowHighLineColor: '#123456', highLowHighLineWidth: 2 });
    expect(useChartPrefsStore.getState()).toMatchObject({ highLowHighLineEnabled: false, highLowHighLineColor: '', highLowHighLineWidth: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '고가 가격선 자동 색상' }));
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.highLowHighLineColor).toBe('');
    expect(screen.getByRole('button', { name: '고가 가격선 자동 색상' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('leaves saved volume placement values intact without exposing their controls', () => {
    useWindowSettingsStore.getState().patch('a', 'chart', { volumeOverlayEnabled: true, volumeOverlayHeight: 35 });
    render(<ChartDisplaySettings windowId="a" />);
    expect(screen.queryByRole('switch', { name: '거래량을 캔들에 겹쳐 표시' })).toBeNull();
    expect(screen.queryByLabelText('거래량을 캔들에 겹쳐 표시 세부 설정')).toBeNull();
    expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject({ volumeOverlayEnabled: true, volumeOverlayHeight: 35 });
  });
  it('defaults color swapping on, gates it by inversion and preserves the choice when inversion is off', async () => {
    render(<ChartDisplaySettings windowId="a" />);
    fireEvent.click(screen.getByLabelText('차트 거꾸로 보기 세부 설정'));
    const swap = screen.getByRole('switch', { name: '반전 시 캔들·거래량 색상 교환' });
    const invert = screen.getByRole('switch', { name: '차트 거꾸로 보기' });
    expect(swap).toBeDisabled();
    expect(swap).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(invert);
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    expect(swap).toBeEnabled();
    fireEvent.click(swap);
    expect(swap).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(swap).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(invert);
    expect(swap).toBeDisabled();
    expect(swap).toHaveAttribute('aria-checked', 'true');
  });
  it('edits window prefs without changing global values and undoes only the last changed field', async () => {
    render(<ChartDisplaySettings windowId="a" />);
    fireEvent.click(screen.getByLabelText('차트 거꾸로 보기 세부 설정'));
    fireEvent.click(screen.getByLabelText('고저 극값 라벨 세부 설정'));
    // Edit dependent lines while the master is on, then test turning it off.
    const definitions = [...CHART_DISPLAY_TOGGLES.filter(def => def.key !== 'highLowLabelsEnabled' && def.key !== 'volumeOverlayEnabled'),
      ...CHART_DISPLAY_TOGGLES.filter(def => def.key === 'highLowLabelsEnabled')];
    expect([...screen.getAllByRole('switch'), ...screen.getAllByRole('checkbox')]).toHaveLength(definitions.length);
    for (const def of definitions) {
      const original = useWindowSettingsStore.getState().byWindow.a.chart![def.key];
      fireEvent.click(screen.getByRole(def.key.startsWith('highLow') && def.key !== 'highLowLabelsEnabled' ? 'checkbox' : 'switch', { name: def.label }));
      expect(useWindowSettingsStore.getState().byWindow.a.chart![def.key]).toBe(!original);
      expect(useChartPrefsStore.getState()[def.key]).toBe(initial[def.key]);
      await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    }
    const last = definitions.at(-1)!;
    const changed = useWindowSettingsStore.getState().byWindow.a.chart![last.key];
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(useWindowSettingsStore.getState().byWindow.a.chart![last.key]).toBe(!changed));
    expect(useWindowSettingsStore.getState().byWindow.a.chart![definitions[0].key]).toBe(!initial[definitions[0].key]);
  });

  it('invalidates undo when another editor changes the same preference', async () => {
    render(<ChartDisplaySettings windowId="a" />);
    fireEvent.click(screen.getByRole('switch', { name: '캔들 기준 Y축' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    act(() => useWindowSettingsStore.getState().patch('a', 'chart', { candlePaneCandleOnlyScale: initial.candlePaneCandleOnlyScale }));
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeDisabled());
  });

  it('combines log and inverted scales and undoes only the last scale edit', async () => {
    render(<ChartDisplaySettings windowId="a" />);
    const log = screen.getByRole('switch', { name: '로그 스케일' });
    const invert = screen.getByRole('switch', { name: '차트 거꾸로 보기' });
    expect(log).toHaveAttribute('aria-checked', 'false');
    expect(invert).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(log);
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.click(invert);
    expect(log).toHaveAttribute('aria-checked', 'true');
    expect(invert).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(invert).toHaveAttribute('aria-checked', 'false'));
    expect(log).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps undo local to the edited window and discards history when the target changes', async () => {
    const { rerender } = render(<ChartDisplaySettings windowId="a" />);
    fireEvent.click(screen.getByRole('switch', { name: '캔들 정보 툴팁' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    act(() => useWindowSettingsStore.getState().patch('b', 'chart', { candleTooltipEnabled: true }));
    expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(useWindowSettingsStore.getState().byWindow.a.chart!.candleTooltipEnabled).toBe(false));
    expect(useWindowSettingsStore.getState().byWindow.b.chart!.candleTooltipEnabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: '캔들 정보 툴팁' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    rerender(<ChartDisplaySettings windowId="b" />);
    expect(screen.getByRole('button', { name: '되돌리기' })).toBeDisabled();
  });
});
