import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_CHART_DISPLAY_PREFS, normalizeChartDisplayPrefs } from './chartDisplayPrefs';
import { useWindowSettingsStore, normalizeWindowSettingsSnapshot, subscribeToWindowSettingsStorage, WINDOW_SETTINGS_KEY } from './windowSettings';
import { seedSettingsForWindow, restoreSettingsFromPayload } from './windowSettingsLifecycle';
import { useActivePrefs, useChartPrefActions, useChartPrefsStore } from './chartPrefs';
import { useWorkspaceStore, type WorkspaceWindow } from './workspace';
import { capturePresetPayload, applyPresetPayload } from '../live/presets/layoutPresetSnapshot';
import { WindowViewContext } from '../live/workspace/windowViewContext';

const chart = (id: string): WorkspaceWindow => ({ id, kind: 'chart', group: 1, chart: { timeframe: '1m' }, rect: { x: 0, y: 0, w: .4, h: .6 } });
beforeEach(() => {
  localStorage.clear();
  useWindowSettingsStore.setState({ byWindow: {} });
  useChartPrefsStore.getState().resetToDefaults();
  useWorkspaceStore.setState({ windows: [chart('a'), chart('b')], zOrder: ['b', 'a'], groupSymbols: {}, chartRuntime: {} });
});

describe('typed window settings lifecycle', () => {
  it('persists independent major index choices and restores them with layout presets', () => {
    const a = useWorkspaceStore.getState().addWindow('market-indices');
    const b = useWorkspaceStore.getState().addWindow('market-indices');
    const choices = { indices: ['KOSDAQ'] as const, showStock: false };
    useWindowSettingsStore.getState().patch(a, 'majorIndices', { ...choices, indices: [...choices.indices] });
    const payload = capturePresetPayload();
    expect(useWindowSettingsStore.getState().byWindow[b].majorIndices).toEqual({ indices: ['KOSPI', 'KOSDAQ', 'KOSPI200'], showStock: true });
    const persisted = normalizeWindowSettingsSnapshot(JSON.parse(localStorage.getItem(WINDOW_SETTINGS_KEY)!));
    expect(persisted.byWindow[a].majorIndices).toEqual(choices);
    useWindowSettingsStore.getState().patch(a, 'majorIndices', { indices: ['KOSPI'], showStock: true });
    applyPresetPayload(payload, null);
    expect(useWindowSettingsStore.getState().byWindow[a].majorIndices).toEqual(choices);
    expect(useWindowSettingsStore.getState().byWindow[b].majorIndices?.showStock).toBe(true);
  });
  it('hydrates major index selections across tabs without dropping chart settings', () => {
    seedSettingsForWindow(chart('a'));
    const stop = subscribeToWindowSettingsStorage();
    const saved = { schema_version: 1, byWindow: {
      a: useWindowSettingsStore.getState().byWindow.a,
      indices: { majorIndices: { indices: ['KOSPI200'], showStock: false } },
    } };
    localStorage.setItem(WINDOW_SETTINGS_KEY, JSON.stringify(saved));
    window.dispatchEvent(new StorageEvent('storage', { key: WINDOW_SETTINGS_KEY }));
    expect(useWindowSettingsStore.getState().byWindow.indices.majorIndices).toEqual(saved.byWindow.indices.majorIndices);
    expect(useWindowSettingsStore.getState().byWindow.a.chart).toBeDefined();
    stop();
  });
  it('migrates missing high/low settings once while preserving existing chart and explicit line choices', () => {
    const legacy = { highLowLabelsEnabled: false, highLowHighLineEnabled: true,
      highLowHighLineColor: '#abcdef', highLowHighLineWidth: 4 };
    const migrated = normalizeWindowSettingsSnapshot({ schema_version: 1, byWindow: {
      a: { chart: { candleLogScale: true } },
      b: { chart: { highLowLabelsEnabled: true, highLowHighLineEnabled: false,
        highLowHighLineColor: '', highLowHighLineWidth: 2 } },
    } }, legacy);
    expect(migrated.byWindow.a.chart).toMatchObject({ candleLogScale: true, highLowLabelsEnabled: false,
      highLowHighLineEnabled: true, highLowHighLineColor: '#ABCDEF', highLowHighLineWidth: 4 });
    expect(migrated.byWindow.b.chart).toMatchObject({ highLowLabelsEnabled: true,
      highLowHighLineEnabled: false, highLowHighLineColor: '', highLowHighLineWidth: 2 });
    expect(normalizeWindowSettingsSnapshot(migrated, { highLowLabelsEnabled: true }).byWindow).toEqual(migrated.byWindow);
    expect(normalizeChartDisplayPrefs({ highLowHighLineColor: 'red', highLowHighLineWidth: 8 })).toMatchObject({
      highLowHighLineColor: '', highLowHighLineWidth: 1,
    });
  });

  it('clones and restores high/low toggles, colors and widths through the existing window preset', () => {
    const prefs = { highLowLabelsEnabled: false, highLowLowLineEnabled: true,
      highLowLowLineColor: '#123456', highLowLowLineWidth: 3 as const };
    seedSettingsForWindow(chart('a'));
    useWindowSettingsStore.getState().patch('a', 'chart', prefs);
    const added = useWorkspaceStore.getState().addWindow('chart');
    expect(useWindowSettingsStore.getState().byWindow[added].chart).toMatchObject(prefs);
    const payload = capturePresetPayload();
    useWindowSettingsStore.getState().patch('a', 'chart', { highLowLowLineWidth: 1 });
    expect(useWindowSettingsStore.getState().byWindow[added].chart!.highLowLowLineWidth).toBe(3);
    applyPresetPayload(payload, null);
    expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject(prefs);
  });
  it('validates overlay styles and transports them through persistence, cloning and presets', () => {
    expect(normalizeChartDisplayPrefs({ volumeOverlayHeight: 0, volumeOverlayTransparency: 101,
      volumeOverlayUpColor: 'red', volumeOverlayDownColor: '#12345678' })).toMatchObject({
      volumeOverlayEnabled: false, volumeOverlayHeight: 25, volumeOverlayTransparency: 65,
      volumeOverlayUpColor: '', volumeOverlayDownColor: '',
    });
    const style = { volumeOverlayEnabled: true, volumeOverlayHeight: 40, volumeOverlayTransparency: 0,
      volumeOverlayUpColor: '#ABCDEF', volumeOverlayDownColor: '#123456' };
    seedSettingsForWindow(chart('a'));
    useWindowSettingsStore.getState().patch('a', 'chart', style);
    const payload = capturePresetPayload();
    const added = useWorkspaceStore.getState().addWindow('chart');
    expect(useWindowSettingsStore.getState().byWindow[added].chart).toMatchObject(style);
    useWindowSettingsStore.getState().patch('a', 'chart', { volumeOverlayEnabled: false, volumeOverlayHeight: 10 });
    expect(useWindowSettingsStore.getState().byWindow[added].chart).toMatchObject(style);
    applyPresetPayload(payload, null);
    expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject(style);
    const saved = JSON.parse(localStorage.getItem(WINDOW_SETTINGS_KEY)!);
    expect(normalizeWindowSettingsSnapshot(saved).byWindow.a.chart).toMatchObject(style);
  });
  it('defaults old heatmap layer settings to off and restores explicit choices through presets', () => {
    expect(normalizeChartDisplayPrefs({}).depthHeatmapAboveCandles).toBe(false);
    expect(normalizeChartDisplayPrefs({ depthHeatmapAboveCandles: 'true' }).depthHeatmapAboveCandles).toBe(false);
    seedSettingsForWindow(chart('a'));
    seedSettingsForWindow(chart('b'));
    useWindowSettingsStore.getState().patch('a', 'chart', { depthHeatmapAboveCandles: true });
    const payload = capturePresetPayload();
    useWindowSettingsStore.getState().patch('a', 'chart', { depthHeatmapAboveCandles: false });
    applyPresetPayload(payload, null);
    expect(useWindowSettingsStore.getState().byWindow.a.chart?.depthHeatmapAboveCandles).toBe(true);
    expect(useWindowSettingsStore.getState().byWindow.b.chart?.depthHeatmapAboveCandles).toBe(false);
  });
  it('migrates missing color-swap settings to on and preserves an explicit off setting through presets', () => {
    expect(normalizeChartDisplayPrefs({ candleInvertScale: true }).candleInvertColors).toBe(true);
    expect(normalizeChartDisplayPrefs({ candleInvertColors: 'invalid' }).candleInvertColors).toBe(true);
    useWindowSettingsStore.getState().patch('a', 'chart', { candleInvertScale: true, candleInvertColors: false });
    const payload = capturePresetPayload();
    useWindowSettingsStore.getState().patch('a', 'chart', { candleInvertColors: true });
    applyPresetPayload(payload, null);
    expect(useWindowSettingsStore.getState().byWindow.a.chart?.candleInvertColors).toBe(false);
  });
  it('defaults old and invalid scale settings to off, preserving explicit choices in presets', () => {
    expect(normalizeChartDisplayPrefs({ candleTooltipEnabled: true })).toMatchObject({
      candleLogScale: false, candleInvertScale: false,
    });
    expect(normalizeChartDisplayPrefs({ candleLogScale: 'true', candleInvertScale: 1 })).toMatchObject({
      candleLogScale: false, candleInvertScale: false,
    });
    seedSettingsForWindow(chart('a'));
    useWindowSettingsStore.getState().patch('a', 'chart', { candleLogScale: true, candleInvertScale: true });
    const payload = capturePresetPayload();
    useWindowSettingsStore.getState().patch('a', 'chart', { candleLogScale: false, candleInvertScale: false });
    applyPresetPayload(payload, null);
    expect(useWindowSettingsStore.getState().byWindow.a.chart).toMatchObject({
      candleLogScale: true, candleInvertScale: true,
    });
    expect(useWindowSettingsStore.getState().byWindow.b.chart).toMatchObject({
      candleLogScale: false, candleInvertScale: false,
    });
  });
  it('migrates legacy values once, clones them per window and persists immediately', () => {
    useChartPrefsStore.getState().setToggle('horizontalGridLinesEnabled', false);
    seedSettingsForWindow(chart('a'));
    seedSettingsForWindow(chart('b'));
    const s = useWindowSettingsStore.getState();
    expect(s.byWindow.a.chart!.horizontalGridLinesEnabled).toBe(false);
    expect(s.byWindow.a.chart).not.toBe(s.byWindow.b.chart);
    s.patch('a', 'chart', { horizontalGridLinesEnabled: true });
    useChartPrefsStore.getState().setToggle('horizontalGridLinesEnabled', true);
    seedSettingsForWindow(chart('b'));
    expect(useWindowSettingsStore.getState().byWindow.b.chart!.horizontalGridLinesEnabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(WINDOW_SETTINGS_KEY)!).byWindow.a.chart.horizontalGridLinesEnabled).toBe(true);
  });

  it('new charts copy the focused chart and remain independent across timeframe and symbol changes', () => {
    seedSettingsForWindow(chart('a'));
    useWindowSettingsStore.getState().patch('a', 'chart', { candleTooltipEnabled: true });
    const id = useWorkspaceStore.getState().addWindow('chart');
    expect(useWindowSettingsStore.getState().byWindow[id].chart!.candleTooltipEnabled).toBe(true);
    useWindowSettingsStore.getState().patch(id, 'chart', { candleTooltipEnabled: false });
    useWorkspaceStore.getState().setChartTimeframe(id, 'D');
    useWorkspaceStore.getState().setChartTimeframe(id, '5m');
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.candleTooltipEnabled).toBe(true);
    expect(useWindowSettingsStore.getState().byWindow[id].chart!.candleTooltipEnabled).toBe(false);
  });

  it('preset A → B → A restores every saved boolean, even after window cleanup', () => {
    useWindowSettingsStore.getState().patch('a', 'chart', { candlePaneCandleOnlyScale: true, auctionWindowMask: false });
    useWindowSettingsStore.getState().patch('b', 'chart', { candleTooltipEnabled: true });
    const presetA = capturePresetPayload();
    expect((presetA.windows[0] as { windowSettings: unknown }).windowSettings).toEqual({ chart: normalizeChartDisplayPrefs({ candlePaneCandleOnlyScale: true, auctionWindowMask: false }) });
    applyPresetPayload({ windows: [chart('c')], zOrder: ['c'], groupSymbols: {} }, 'B');
    expect(useWindowSettingsStore.getState().byWindow.a).toBeUndefined();
    applyPresetPayload(presetA, 'A');
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.auctionWindowMask).toBe(false);
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.candlePaneCandleOnlyScale).toBe(true);
    expect(useWindowSettingsStore.getState().byWindow.b.chart!.candleTooltipEnabled).toBe(true);
    useWindowSettingsStore.getState().patch('a', 'chart', { candlePaneCandleOnlyScale: false });
    applyPresetPayload(presetA, 'A');
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.candlePaneCandleOnlyScale).toBe(true);
  });

  it('preset capture makes independent copies and legacy presets keep surviving settings', () => {
    useWindowSettingsStore.getState().patch('a', 'chart', { candleTooltipEnabled: true });
    const payload = capturePresetPayload();
    useWindowSettingsStore.getState().patch('a', 'chart', { candleTooltipEnabled: false });
    expect((payload.windows[0] as { windowSettings: { chart: typeof DEFAULT_CHART_DISPLAY_PREFS } }).windowSettings.chart.candleTooltipEnabled).toBe(true);
    applyPresetPayload({ windows: [chart('a'), chart('new')], zOrder: ['a', 'new'], groupSymbols: {} }, null);
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.candleTooltipEnabled).toBe(false);
    expect(useWindowSettingsStore.getState().byWindow.new.chart).toEqual(DEFAULT_CHART_DISPLAY_PREFS);
  });

  it('restores only validated windows and settings sections allowed for their kind', () => {
    restoreSettingsFromPayload([{ id: 'book', kind: 'book' }, chart('a')], [
      { id: 'ghost', windowSettings: { chart: { candleTooltipEnabled: true } } },
      { id: 'book', windowSettings: { chart: { candleTooltipEnabled: true } } },
      { id: 'a', windowSettings: { chart: { candleTooltipEnabled: true, horizontalGridLinesEnabled: 'invalid', unknown: true }, unknownSection: {} } },
    ]);
    expect(useWindowSettingsStore.getState().byWindow.ghost).toBeUndefined();
    expect(useWindowSettingsStore.getState().byWindow.book).toEqual({});
    expect(useWindowSettingsStore.getState().byWindow.a).toEqual({ chart: normalizeChartDisplayPrefs({ candleTooltipEnabled: true }) });
  });

  it('close removes only that window; page unmounts are not cleanup events', () => {
    seedSettingsForWindow(chart('a'));
    seedSettingsForWindow(chart('b'));
    useWorkspaceStore.getState().closeWindow('a');
    expect(useWindowSettingsStore.getState().byWindow.a).toBeUndefined();
    expect(useWindowSettingsStore.getState().byWindow.b.chart).toBeDefined();
  });

  it('hydrates persisted settings and receives updates for the same window from another tab', () => {
    const stop = subscribeToWindowSettingsStorage();
    const snapshot = { schema_version: 1, byWindow: { a: { chart: { ...DEFAULT_CHART_DISPLAY_PREFS, candleTooltipEnabled: true } } } };
    localStorage.setItem(WINDOW_SETTINGS_KEY, JSON.stringify(snapshot));
    window.dispatchEvent(new StorageEvent('storage', { key: WINDOW_SETTINGS_KEY }));
    expect(useWindowSettingsStore.getState().byWindow.a.chart!.candleTooltipEnabled).toBe(true);
    expect(normalizeWindowSettingsSnapshot(snapshot).byWindow).toEqual(useWindowSettingsStore.getState().byWindow);
    expect(normalizeWindowSettingsSnapshot({ schema_version: 999, byWindow: snapshot.byWindow }).byWindow).toEqual({});
    stop();
  });
});

function Probe({ id, timeframe = '1m', index = false }: { id: string; timeframe?: '1m' | 'D'; index?: boolean }) {
  return <WindowViewContext.Provider value={{ windowId: id, group: 1, code: '005930', timeframe, historicalFromDate: null, instrumentKind: index ? 'index' : 'stock' }}>
    <ProbeContent id={id} />
  </WindowViewContext.Provider>;
}
function ProbeContent({ id }: { id: string }) {
  const enabled = useActivePrefs(p => p.candleTooltipEnabled);
  const { setToggle } = useChartPrefActions();
  return <button onClick={() => setToggle('candleTooltipEnabled', !enabled)}>{id}:{String(enabled)}</button>;
}
it('chart readers and controls react to their own window, across timeframe and instrument switches', () => {
  seedSettingsForWindow(chart('a')); seedSettingsForWindow(chart('b'));
  const { rerender } = render(<><Probe id="a" /><Probe id="b" /></>);
  fireEvent.click(screen.getByRole('button', { name: 'a:false' }));
  expect(screen.getByRole('button', { name: 'a:true' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'b:false' })).toBeVisible();
  expect(useChartPrefsStore.getState().candleTooltipEnabled).toBe(false);
  rerender(<><Probe id="a" timeframe="D" index /><Probe id="b" /></>);
  expect(screen.getByRole('button', { name: 'a:true' })).toBeVisible();
  act(() => useWindowSettingsStore.getState().patch('b', 'chart', { candleTooltipEnabled: true }));
  expect(screen.getByRole('button', { name: 'b:true' })).toBeVisible();
});
