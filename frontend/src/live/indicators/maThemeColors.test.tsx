import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import type { LiveMAConfig } from '../../state/liveIndicatorsPersistence';
import { useThemePrefsStore } from '../../state/themePrefs';
import MovingAverageOverlay from './MovingAverageOverlay';
import DailyMovingAverageOverlay from './DailyMovingAverageOverlay';
import MovingAverageRow from './MovingAverageRow';
import IndicatorStylePreview from './IndicatorStylePreview';
import { IndicatorInstanceLegend } from './IndicatorInstanceLegend';

vi.mock('./useResolvedDailyCandles', () => ({ useResolvedDailyCandles: () => ({ candles: [], dataWarnings: [] }) }));
const candles = Array.from({ length: 125 }, (_, i) => ({ ts_ms: 1000 * (i + 1), open: 100, close: 100, high: 100, low: 100, vol_a: 0, vol_b: 0 }));
const bundle = { candles } as never;
const axis = { findByReal: () => 0, segments: [{ date: '20261018' }], classifyAndProject: (m: number) => ({ contained: true, virtual: m }) } as never;
const configs: LiveMAConfig[] = [
  { id: 'auto', enabled: true, period: 120, color: '#6B7280', colorMode: 'auto', lineWidth: 2, source: 'close' },
  { id: 'manual', enabled: true, period: 5, color: '#EC4899', colorMode: 'manual', lineWidth: 1, source: 'close' },
];

beforeEach(() => {
  useThemePrefsStore.getState().setThemePreference('toss-light');
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
});
afterEach(() => {
  cleanup();
  useThemePrefsStore.getState().setThemePreference('toss-light');
});

describe.each(['moving-average', 'daily-moving-average'] as const)('%s theme colors', category => {
  it('updates series, instance legend, SVG and picker together without recoloring manual lines or rewriting settings', () => {
    const slice = category === 'moving-average' ? 'movingAverages' : 'dailyMovingAverages';
    useLivePageStore.setState({ [slice]: configs, indicatorInstances: [{ id: 'extra', category, settings: { [slice]: configs }, prefs: {} }] });
    const settings = { ...FACTORY_INDICATOR_SETTINGS, [slice]: configs };
    const makeSeries = () => ({ applyOptions: vi.fn(), setData: vi.fn(), update: vi.fn() });
    const series = [makeSeries(), makeSeries()];
    const addSeries = vi.fn().mockReturnValueOnce(series[0]).mockReturnValueOnce(series[1]);
    const chart = { addSeries, removeSeries: vi.fn() } as never;
    const { container } = render(<>
      {category === 'moving-average' ? <MovingAverageOverlay chart={chart} bundle={bundle} axis={axis} />
        : <DailyMovingAverageOverlay chart={chart} bundle={bundle} axis={axis} code="005930" timeframe="1m" todayKst="20261018" />}
      <IndicatorInstanceLegend id="extra" />
      <IndicatorStylePreview category={category} settings={settings} />
      <MovingAverageRow index={0} config={configs[0]} canRemove={false} onChange={() => {}} onRemove={() => {}} />
    </>);
    expect(addSeries.mock.calls[0][1].color).toBe('#374151');
    expect(addSeries.mock.calls[1][1].color).toBe('#EC4899');
    const path = container.querySelector('[data-preview-line="120' + (category === 'moving-average' ? '봉' : '일') + '"]');
    expect(path).toHaveAttribute('stroke', '#374151');
    const chip = screen.getByLabelText('120 ' + (category === 'moving-average' ? '현재봉' : '일봉') + ' 이평선 색상');
    expect(chip).toHaveStyle({ background: '#374151' });
    const dataWrites = series[0].setData.mock.calls.length;
    act(() => useThemePrefsStore.getState().setThemePreference('toss-dark'));
    expect(series[0].applyOptions).toHaveBeenCalledWith(expect.objectContaining({ color: '#CBD5E1' }));
    expect(series[1].applyOptions).toHaveBeenCalledWith(expect.objectContaining({ color: '#EC4899' }));
    expect(addSeries).toHaveBeenCalledTimes(2);
    expect(series[0].setData).toHaveBeenCalledTimes(dataWrites);
    expect(path).toHaveAttribute('stroke', '#CBD5E1');
    expect(chip).toHaveStyle({ background: '#CBD5E1' });
    const dot = screen.getByRole('button', { name: 'MA 스타일 선택' }).querySelector('span');
    expect(dot).toHaveStyle({ backgroundColor: '#CBD5E1' });
    expect(useLivePageStore.getState()[slice]).toEqual(configs);
    act(() => useThemePrefsStore.getState().setThemePreference('ledger'));
    expect(path).toHaveAttribute('stroke', '#374151');
    expect(chip).toHaveStyle({ background: '#374151' });
  });
});

it('allows explicit palette colors, preserves them across themes, and offers automatic color again', () => {
  const onChange = vi.fn();
  const props = { index: 0, canRemove: false, onChange, onRemove: () => {} };
  const { rerender } = render(<MovingAverageRow {...props} config={configs[0]} />);
  fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
  expect(screen.getByRole('button', { name: 'MA 자동 색상' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'MA 색상 #374151' }));
  expect(onChange).toHaveBeenLastCalledWith({ color: '#374151', colorMode: 'manual' });
  rerender(<MovingAverageRow {...props} config={{ ...configs[0], color: '#374151', colorMode: 'manual' }} />);
  act(() => useThemePrefsStore.getState().setThemePreference('toss-dark'));
  expect(screen.getByRole('button', { name: 'MA 스타일 선택' }).querySelector('span')).toHaveStyle({ backgroundColor: '#374151' });
  fireEvent.click(screen.getByRole('button', { name: 'MA 스타일 선택' }));
  expect(screen.getByRole('button', { name: 'MA 자동 색상' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'MA 자동 색상' }));
  expect(onChange).toHaveBeenLastCalledWith({ colorMode: 'auto' });
});
