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
  it('edits the six window prefs without changing global values and undoes only the last changed field', async () => {
    render(<ChartDisplaySettings windowId="a" />);
    const definitions = CHART_DISPLAY_TOGGLES;
    expect(screen.getAllByRole('switch')).toHaveLength(6);
    for (const def of definitions) {
      const original = useWindowSettingsStore.getState().byWindow.a.chart![def.key];
      fireEvent.click(screen.getByRole('switch', { name: def.label }));
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
