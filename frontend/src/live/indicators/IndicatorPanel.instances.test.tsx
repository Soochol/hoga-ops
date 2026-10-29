import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import IndicatorPanel from './IndicatorPanel';
import { CATEGORIES } from './IndicatorPanelHelpers';
import { createCatalogDraft } from './indicatorCatalogDraft';
import { useLivePageStore } from '../../state/livePage';
import { DEFAULT_PREFS, useChartPrefsStore } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS, diffIndicatorSettingsFromFactory, normalizeBucketMap, resolveIndicatorSettings } from '../../state/indicatorSettingsV2';
import { instanceSettings, makeIndicatorInstance, indicatorDemandSettings } from '../../state/indicatorInstances';
import { indicatorInstancePanes } from './indicatorInstancePanes';

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
  useChartPrefsStore.getState().resetToDefaults();
});
const select = (label: string) => { fireEvent.click(screen.getByRole('button', { name: '지표 추가' })); fireEvent.click(screen.getByRole('button', { name: label })); };
const add = () => fireEvent.click(screen.getByRole('button', { name: '설정대로 추가' }));
const number = (label: string, value: string) => { const input = screen.getByRole('spinbutton', { name: label }); fireEvent.change(input, { target: { value } }); fireEvent.blur(input); };

describe('all indicator instances', () => {
  it.each(CATEGORIES)('$label supports independent repeated additions and persistence', category => {
    const draft = createCatalogDraft(category.id, FACTORY_INDICATOR_SETTINGS, DEFAULT_PREFS).store.getState();
    const first = makeIndicatorInstance(category.id, draft.settings, draft.prefs);
    const second = makeIndicatorInstance(category.id, draft.settings, draft.prefs);
    expect(first.id).not.toBe(second.id);
    const settings = { ...FACTORY_INDICATOR_SETTINGS, indicatorInstances: [first, second] };
    const buckets = normalizeBucketMap({ minute: diffIndicatorSettingsFromFactory(settings) });
    const restored = resolveIndicatorSettings(buckets, '1m');
    expect(restored.indicatorInstances).toEqual([first, second]);
    // All original fields survive as the original instance; array membership never changes their flags.
    expect(restored.bollingerEnabled).toBe(false);
    expect(restored.movingAverages).toEqual(FACTORY_INDICATOR_SETTINGS.movingAverages);
  });

  it.each(CATEGORIES)('$label can be added twice from the catalog', async category => {
    const tf = ['trade-value', 'new-high-bearish'].includes(category.id) ? 'D' : '1m';
    useLivePageStore.setState({ movingAverages: [], volumeEnabled: false, indicatorTimeframe: tf });
    render(<IndicatorPanel timeframe={tf} onClose={() => {}} />);
    select(category.label); add();
    fireEvent.click(screen.getByRole('button', { name: '하나 더 추가' })); add();
    expect(useLivePageStore.getState().indicatorInstances).toHaveLength(1);
    expect(useLivePageStore.getState().indicatorInstances![0].category).toBe(category.id);
    fireEvent.click(screen.getByRole('button', { name: '내 지표' }));
    expect(screen.getByRole('button', { name: `${category.label} 1 설정` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${category.label} 2 설정` })).toBeInTheDocument();
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  });

  it('adds two Bollingers with separate parameters, masks, edit targets, hiding, deletion and undo', async () => {
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    select('볼린저 밴드'); number('볼린저 기간', '20'); add();
    fireEvent.click(screen.getByRole('button', { name: '하나 더 추가' }));
    number('볼린저 기간', '60');
    fireEvent.click(screen.getByRole('switch', { name: '볼린저 하단선 표시' }));
    expect(useLivePageStore.getState().indicatorInstances).toEqual([]);
    add();
    expect(useLivePageStore.getState().bollingerPeriod).toBe(20);
    const row = useLivePageStore.getState().indicatorInstances![0];
    expect(row.settings).toMatchObject({ bollingerPeriod: 60, indicatorLineVisibility: { bollingerLower: false } });
    number('볼린저 기간', '80');
    expect(useLivePageStore.getState().indicatorInstances![0].settings.bollingerPeriod).toBe(80);
    expect(useLivePageStore.getState().bollingerPeriod).toBe(20);
    fireEvent.click(screen.getByRole('button', { name: '내 지표' }));
    fireEvent.click(screen.getByRole('button', { name: '볼린저 밴드 1 설정' }));
    expect(screen.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue(20);
    fireEvent.click(screen.getByRole('button', { name: '볼린저 밴드 2 숨기기' }));
    expect(useLivePageStore.getState().indicatorInstances![0].hidden).toBe(true);
    expect(useLivePageStore.getState().bollingerHidden).toBe(false);
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
    fireEvent.click(screen.getByRole('button', { name: '볼린저 밴드 1 삭제' }));
    expect(useLivePageStore.getState().bollingerEnabled).toBe(false);
    expect(useLivePageStore.getState().indicatorInstances![0].id).toBe(row.id);
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(useLivePageStore.getState().bollingerEnabled).toBe(true));
    expect(useLivePageStore.getState().indicatorInstances![0].id).toBe(row.id);
  });

  it('keeps cumulative lines and side preferences local to the added instance', () => {
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    select('체결강도'); add();
    fireEvent.click(screen.getByRole('button', { name: '하나 더 추가' }));
    fireEvent.click(screen.getByRole('switch', { name: '당일 누적선 표시' })); add();
    expect(useChartPrefsStore.getState().fillStrengthCumulative).toBe(true);
    const row = useLivePageStore.getState().indicatorInstances![0];
    expect(row.prefs.fillStrengthCumulative).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: '당일 누적선 표시' }));
    expect(useLivePageStore.getState().indicatorInstances![0].prefs.fillStrengthCumulative).toBe(true);
    expect(useChartPrefsStore.getState().fillStrengthCumulative).toBe(true);
  });

  it('isolates panes and demand after the original indicator is deleted', () => {
    const draft = createCatalogDraft('quote-totals', FACTORY_INDICATOR_SETTINGS, DEFAULT_PREFS).store.getState();
    const row = makeIndicatorInstance('quote-totals', draft.settings, draft.prefs);
    const base = { ...FACTORY_INDICATOR_SETTINGS, indicatorInstances: [row] };
    expect(indicatorDemandSettings(base).quoteTotalsEnabled).toBe(true);
    expect(base.quoteTotalsEnabled).toBe(false);
    const specs = indicatorInstancePanes(base, row, '1m', true);
    expect(specs.map(spec => spec.name)).toEqual([`indicator:${row.id}:quote-totals`]);
    expect(indicatorInstancePanes(base, { ...row, hidden: true }, '1m', true)).toEqual([]);
    expect(indicatorInstancePanes(base, row, 'D', true)).toEqual([]);
    expect(indicatorInstancePanes(base, row, '1m', false)).toEqual([]);
  });

  it('a new visible line does not inherit a sibling hidden mask', () => {
    const prepared = createCatalogDraft('bollinger', FACTORY_INDICATOR_SETTINGS, DEFAULT_PREFS).store.getState();
    const row = makeIndicatorInstance('bollinger', prepared.settings, prepared.prefs);
    const base = { ...FACTORY_INDICATOR_SETTINGS, indicatorLineVisibility: { bollingerLower: false as const } };
    expect(instanceSettings(base, row).indicatorLineVisibility.bollingerLower).toBeUndefined();
  });

  it('copying edits a draft and closing it leaves live instances untouched', () => {
    const view = render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    select('슈퍼트렌드'); number('슈퍼트렌드 ATR 배수', '5'); add();
    fireEvent.click(screen.getByRole('button', { name: '설정 복사해서 추가' }));
    expect(screen.getByRole('spinbutton', { name: '슈퍼트렌드 ATR 배수' })).toHaveValue(5);
    number('슈퍼트렌드 ATR 배수', '7');
    view.unmount();
    expect(useLivePageStore.getState().supertrendMultiplier).toBe(5);
    expect(useLivePageStore.getState().indicatorInstances).toEqual([]);
  });
  it('legend deletion undo restores one id without replacing later sibling edits', () => {
    const draft = createCatalogDraft('bollinger', FACTORY_INDICATOR_SETTINGS, DEFAULT_PREFS).store.getState();
    const a = makeIndicatorInstance('bollinger', draft.settings, draft.prefs);
    const b = makeIndicatorInstance('bollinger', draft.settings, draft.prefs);
    const scope = { windowKey: 'live:undo-instances' };
    const store = useLivePageStore.getState();
    store.patchIndicatorsScoped(scope, '1m', { indicatorInstances: [a, b] });
    store.patchIndicatorsScoped(scope, '1m', { indicatorInstances: [b] });
    store.setIndicatorUndoToast({ label: '삭제됨', scope, timeframe: '1m', patch: {}, removedInstance: { row: a, index: 0 } });
    store.patchIndicatorsScoped(scope, '1m', { indicatorInstances: [{ ...b, settings: { ...b.settings, bollingerPeriod: 90 } }] });
    store.restoreIndicatorUndoToast();
    const restored = resolveIndicatorSettings(useLivePageStore.getState().indicatorsByWindow[scope.windowKey], '1m');
    expect(restored.indicatorInstances?.map(row => row.id)).toEqual([a.id, b.id]);
    expect(restored.indicatorInstances?.[1].settings.bollingerPeriod).toBe(90);
  });

  it('owns total-quantity surge marker controls and keeps copied preferences independent', () => {
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    select('총잔량'); add();
    fireEvent.click(screen.getByRole('button', { name: '하나 더 추가' }));
    fireEvent.click(within(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).getByRole('switch'));
    expect(useChartPrefsStore.getState().surgeMarkerEnabled).toBe(true);
    add();
    expect(useLivePageStore.getState().indicatorInstances![0].prefs.surgeMarkerEnabled).toBe(false);
    fireEvent.click(within(screen.getByTestId('settings-toggle-surgeMarkerEnabled')).getByRole('switch'));
    expect(useLivePageStore.getState().indicatorInstances![0].prefs.surgeMarkerEnabled).toBe(true);
    expect(useChartPrefsStore.getState().surgeMarkerEnabled).toBe(true);
  });

  it('showing a group also clears its legacy chart-legend hide flag', () => {
    useLivePageStore.setState({ bollingerEnabled: true, bollingerHidden: true });
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '볼린저 밴드' }));
    fireEvent.click(screen.getByRole('button', { name: '표시' }));
    expect(useLivePageStore.getState().bollingerHidden).toBe(false);
    expect(useLivePageStore.getState().indicatorPrimaryHidden).not.toContain('bollinger');
  });

});
