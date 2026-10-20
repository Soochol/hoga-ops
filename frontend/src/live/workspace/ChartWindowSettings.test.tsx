import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ChartWindowSettings } from './ChartWindowSettings';
import { useWindowSettingsStore } from '../../state/windowSettings';
import { useChartPrefsStore } from '../../state/chartPrefs';

beforeEach(() => {
  useWindowSettingsStore.setState({ byWindow: {} });
  useChartPrefsStore.getState().resetToDefaults();
});

describe('chart title-bar scale status', () => {
  it('explains whether candle/volume colors are swapped only while inverted', () => {
    render(<ChartWindowSettings windowId="a" />);
    const settings = screen.getByRole('button', { name: '차트 설정' });
    act(() => useWindowSettingsStore.getState().patch('a', 'chart', { candleInvertScale: true }));
    expect(settings.title).toContain('캔들/거래량 색상 교환 켜짐');
    act(() => useWindowSettingsStore.getState().patch('a', 'chart', { candleInvertColors: false }));
    expect(settings.title).toContain('캔들/거래량 색상 교환 꺼짐');
    act(() => useWindowSettingsStore.getState().patch('a', 'chart', { candleInvertScale: false }));
    expect(settings.title).toBe('차트 설정');
  });
  it('keeps the normal header free of inactive badges', () => {
    render(<ChartWindowSettings windowId="a" />);
    expect(screen.queryByRole('button', { name: /차트 축 상태/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '차트 설정' })).toHaveAttribute('title', '차트 설정');
  });

  it.each([[true, false], [false, true], [true, true]])('shows only the active window settings (log=%s, inverted=%s)', (log, inverted) => {
    const { container } = render(<><ChartWindowSettings windowId="a" /><ChartWindowSettings windowId="b" /></>);
    act(() => useWindowSettingsStore.getState().patch('a', 'chart', { candleLogScale: log, candleInvertScale: inverted }));
    const [a, b] = Array.from(container.querySelectorAll('.live-chart-header-settings')) as HTMLElement[];
    expect(within(a).queryAllByText('로그')).toHaveLength(log ? 1 : 0);
    expect(within(a).queryAllByText('반전')).toHaveLength(inverted ? 1 : 0);
    expect(a).toHaveAttribute('data-active');
    expect(b).not.toHaveAttribute('data-active');
    expect(within(b).queryByRole('button', { name: /차트 축 상태/ })).not.toBeInTheDocument();
    const title = within(a).getByRole('button', { name: '차트 설정' }).title;
    expect(title.includes('로그 스케일 켜짐')).toBe(log);
    expect(title.includes('가격축 반전 켜짐')).toBe(inverted);
  });

  it('opens its own settings without dragging and updates badges immediately, including undo', async () => {
    const onPointerDown = vi.fn();
    render(<div onPointerDown={onPointerDown}><ChartWindowSettings windowId="a" /></div>);
    act(() => useWindowSettingsStore.getState().patch('a', 'chart', { candleLogScale: true }));
    const badge = screen.getByRole('button', { name: /차트 축 상태/ });
    fireEvent.pointerDown(badge);
    expect(onPointerDown).not.toHaveBeenCalled();
    fireEvent.click(badge);
    const dialog = screen.getByRole('dialog', { name: '차트 설정' });
    fireEvent.click(within(dialog).getByRole('switch', { name: '차트 거꾸로 보기' }));
    expect(within(badge).getByText('반전')).toBeVisible();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(within(badge).queryByText('반전')).not.toBeInTheDocument());
    expect(within(badge).getByText('로그')).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '차트 설정' })).toHaveFocus();
    act(() => useWindowSettingsStore.getState().patch('a', 'chart', { candleLogScale: false }));
    expect(screen.queryByRole('button', { name: /차트 축 상태/ })).not.toBeInTheDocument();
  });
});
