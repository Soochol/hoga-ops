import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { WindowViewContext, useIndicatorActions, useWindowIndicators, useWindowPaneStretch, type WindowViewValue } from './windowView';
import { useWorkspaceStore } from '../../state/workspace';
import { useLivePageStore, type LiveTimeframe } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS, normalizeIndicatorsV2, resolveIndicatorSettings } from '../../state/indicatorSettingsV2';
import { useChartPrefActions, useActivePrefs, useChartPrefsStore } from '../../state/chartPrefs';
import { sanitizeIndicatorModalBucketMap } from '../../state/chartPrefsPersistence';
import { profileKeyForTimeframe } from '../indicators/indicatorPaneProfiles';
import { indicatorInstanceApplicable } from '../indicators/indicatorInstancePanes';

beforeEach(() => {
  useWorkspaceStore.setState({ windows: [{ id: 'seconds-test', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, chart: { timeframe: '5s' } }] });
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {},
    paneStretch: {}, paneStretchByTimeframe: {}, paneGroupStretchByTimeframe: {}, indicatorTimeframe: '1m' });
  useChartPrefsStore.getState().resetToDefaults();
  useChartPrefsStore.setState({ indicatorModalByWindow: {} });
});
const scope = { windowKey: 'live:seconds-test' };
const provider = (tf: LiveTimeframe) => ({ children }: { children: ReactNode }) => {
  const value: WindowViewValue = { windowId: 'seconds-test', group: 1, code: '005930', timeframe: tf, historicalFromDate: null };
  return <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>;
};
function useProbe() {
  return { indicators: useWindowIndicators(), actions: useIndicatorActions(), prefs: useChartPrefActions(),
    cumulative: useActivePrefs(p => p.fillStrengthCumulative), stretch: useWindowPaneStretch() };
}
it('writes a separate seconds bucket, shares it across seconds intervals, and round-trips persistence', () => {
  const seconds = renderHook(useProbe, { wrapper: provider('5s') });
  const minute = renderHook(useProbe, { wrapper: provider('1m') });
  act(() => {
    seconds.result.current.actions.setBollingerEnabled(true);
    seconds.result.current.actions.setPanePrefForTimeframe('5s', 'volumeEnabled', false);
    seconds.result.current.actions.setPaneStretch({ volume: 0.8 });
    seconds.result.current.prefs.setToggle('fillStrengthCumulative', false);
  });
  expect(seconds.result.current.indicators.bollingerEnabled).toBe(true);
  expect(seconds.result.current.indicators.volumeEnabled).toBe(false);
  expect(minute.result.current.indicators.bollingerEnabled).toBe(false);
  expect(minute.result.current.indicators.volumeEnabled).toBe(true);
  expect(minute.result.current.cumulative).toBe(true);
  expect(minute.result.current.stretch.volume).toBeUndefined();
  const state = useLivePageStore.getState();
  const restored = normalizeIndicatorsV2(JSON.parse(JSON.stringify({ byWindow: state.indicatorsByWindow,
    paneStretchByTimeframe: state.paneStretchByTimeframe })));
  expect(resolveIndicatorSettings(restored.byWindow[scope.windowKey], '30s').bollingerEnabled).toBe(true);
  expect(resolveIndicatorSettings(restored.byWindow[scope.windowKey], '1m').bollingerEnabled).toBe(false);
  expect(restored.paneStretchByTimeframe.seconds?.volume).toBe(0.8);
  const prefs = sanitizeIndicatorModalBucketMap(JSON.parse(JSON.stringify(useChartPrefsStore.getState().indicatorModalByWindow[scope.windowKey])));
  expect(prefs.seconds?.fillStrengthCumulative).toBe(false);
  expect(prefs.minute?.fillStrengthCumulative).toBeUndefined();
  for (const tf of ['1s', '5s', '10s', '30s'] as const) expect(profileKeyForTimeframe(tf)).toBe('seconds');
  seconds.unmount(); minute.unmount();
});

it('resetting seconds preserves minute settings and seconds pane layout', () => {
  const seconds = renderHook(useProbe, { wrapper: provider('10s') });
  const minute = renderHook(useProbe, { wrapper: provider('3m') });
  act(() => {
    useLivePageStore.getState().patchIndicatorsScoped(scope, '3m', { envelopeEnabled: true });
    seconds.result.current.actions.setBollingerEnabled(true);
    seconds.result.current.actions.setPaneStretch({ volume: 0.8 });
    seconds.result.current.actions.resetIndicators();
  });
  expect(seconds.result.current.indicators.bollingerEnabled).toBe(false);
  expect(minute.result.current.indicators.envelopeEnabled).toBe(true);
  expect(seconds.result.current.stretch.volume).toBe(0.8);
  seconds.unmount(); minute.unmount();
});

it('allows price and volume instances on seconds without admitting minute-resolution sources', () => {
  for (const category of ['moving-average', 'bollinger', 'envelope', 'supertrend', 'volume', 'fill-strength'] as const)
    expect(indicatorInstanceApplicable(category, '1s', true)).toBe(true);
  for (const category of ['ratio', 'program-trade', 'daily-moving-average', 'peak-walls', 'foreign-net'] as const)
    expect(indicatorInstanceApplicable(category, '1s', true)).toBe(false);
});
