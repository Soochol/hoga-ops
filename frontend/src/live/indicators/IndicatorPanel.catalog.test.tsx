import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import IndicatorPanel from './IndicatorPanel';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { FACTORY_INDICATOR_SETTINGS, bucketsForScope, resolveIndicatorSettings } from '../../state/indicatorSettingsV2';
import { WindowViewContext, windowScopeKey, type WindowViewValue } from '../workspace/windowView';
import { readIndicatorEditor } from '../settings/editorSnapshots';
import { createCatalogDraft, catalogDraftPatch } from './indicatorCatalogDraft';

beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
  useChartPrefsStore.getState().resetToDefaults();
  useChartPrefsStore.setState({ indicatorModalByTimeframe: {}, indicatorModalByWindow: {}, indicatorModalTimeframe: '1m' });
});
const choose = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: '지표 추가' }));
  fireEvent.click(screen.getByRole('button', { name }));
};
const changeNumber = (name: string, value: string) => {
  const input = screen.getByRole('spinbutton', { name });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};
const add = () => fireEvent.click(screen.getByRole('button', { name: '설정대로 추가' }));

describe('configure before adding an indicator', () => {
  it('updates the preview, keeps separate drafts across selection, and discards them on close', () => {
    const view = render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    const before = readIndicatorEditor({ windowKey: null }, '1m', true);
    choose('볼린저 밴드');
    const original = document.querySelector('[data-preview-line="상단선"]')!.getAttribute('d');
    changeNumber('볼린저 기간', '35');
    fireEvent.click(screen.getByRole('switch', { name: '볼린저 하단선 표시' }));
    expect(document.querySelector('[data-preview-line="상단선"]')).not.toHaveAttribute('d', original!);
    fireEvent.click(screen.getByRole('button', { name: '슈퍼트렌드' }));
    changeNumber('슈퍼트렌드 ATR 배수', '4.5');
    fireEvent.click(screen.getByRole('button', { name: '볼린저 밴드' }));
    expect(screen.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue(35);
    expect(screen.getByRole('switch', { name: '볼린저 하단선 표시' })).toHaveAttribute('aria-checked', 'false');
    expect(readIndicatorEditor({ windowKey: null }, '1m', true)).toEqual(before);
    view.unmount();
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    choose('볼린저 밴드');
    expect(screen.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue(20);
  });

  it('adds only the selected prepared draft, keeps the catalog open, and undoes the entire addition', async () => {
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    choose('슈퍼트렌드');
    changeNumber('슈퍼트렌드 ATR 배수', '4.5');
    fireEvent.click(screen.getByRole('button', { name: '볼린저 밴드' }));
    changeNumber('볼린저 기간', '35');
    fireEvent.click(screen.getByRole('switch', { name: '볼린저 하단선 표시' }));
    add();
    expect(useLivePageStore.getState()).toMatchObject({ bollingerEnabled: true, bollingerPeriod: 35,
      indicatorLineVisibility: { bollingerLower: false }, supertrendEnabled: false, supertrendMultiplier: 3 });
    expect(screen.getByRole('button', { name: '지표 추가' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '추가됨' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(useLivePageStore.getState().bollingerEnabled).toBe(false));
    expect(useLivePageStore.getState().bollingerPeriod).toBe(20);
    expect(useLivePageStore.getState().indicatorLineVisibility).toEqual({});
    expect(screen.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue(35);
  });

  it('stages chartPrefs with indicator settings and restores both with one undo', async () => {
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    choose('체결강도');
    fireEvent.click(screen.getByRole('switch', { name: '당일 누적선 표시' }));
    expect(useChartPrefsStore.getState().fillStrengthCumulative).toBe(true);
    expect(useLivePageStore.getState().fillStrengthEnabled).toBe(false);
    add();
    expect(useLivePageStore.getState().fillStrengthEnabled).toBe(true);
    expect(useChartPrefsStore.getState().fillStrengthCumulative).toBe(false);
    await waitFor(() => expect(screen.getByRole('button', { name: '되돌리기' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(useLivePageStore.getState().fillStrengthEnabled).toBe(false));
    expect(useChartPrefsStore.getState().fillStrengthCumulative).toBe(true);
  });

  it('restores editable defaults after deleting all MA slots and allows adding them all hidden', () => {
    useLivePageStore.setState({ movingAverages: [] });
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    choose('이동평균선');
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(4);
    switches.forEach(toggle => fireEvent.click(toggle));
    expect(useLivePageStore.getState().movingAverages).toEqual([]);
    add();
    expect(useLivePageStore.getState().movingAverages.every(m => m.enabled && m.hidden)).toBe(true);
    expect(useLivePageStore.getState().movingAverages).toHaveLength(4);
  });

  it('keeps the peak-wall matrix shortcut inside the draft and prevents adding an empty selection', () => {
    render(<IndicatorPanel timeframe="1m" onClose={() => {}} />);
    choose('당일 최대벽');
    const before = readIndicatorEditor({ windowKey: null }, '1m', true);
    fireEvent.click(screen.getByRole('switch', { name: '매도 최대벽 표시' }));
    fireEvent.click(screen.getByRole('switch', { name: '매수 최대벽 표시' }));
    expect(screen.getByRole('button', { name: '설정대로 추가' })).toBeDisabled();
    expect(readIndicatorEditor({ windowKey: null }, '1m', true)).toEqual(before);
  });

  it('retargeting the timeframe discards old drafts and adding changes only that chart and timeframe', () => {
    const ctx: WindowViewValue = { windowId: 'catalog-w1', group: 1, code: '098460', timeframe: 'D', historicalFromDate: null };
    const content = (value: WindowViewValue) => <WindowViewContext.Provider value={value}><IndicatorPanel timeframe={value.timeframe} onClose={() => {}} /></WindowViewContext.Provider>;
    const view = render(content(ctx));
    choose('볼린저 밴드');
    changeNumber('볼린저 기간', '35');
    view.rerender(content({ ...ctx, timeframe: 'W' }));
    expect(screen.getByRole('spinbutton', { name: '볼린저 기간' })).toHaveValue(20);
    changeNumber('볼린저 기간', '55');
    add();
    const state = useLivePageStore.getState();
    const scope = { windowKey: windowScopeKey(ctx.windowId) };
    const buckets = bucketsForScope(state.indicatorsByTimeframe, state.indicatorsByWindow, scope);
    expect(resolveIndicatorSettings(buckets, 'W')).toMatchObject({ bollingerEnabled: true, bollingerPeriod: 55 });
    expect(resolveIndicatorSettings(buckets, 'D').bollingerEnabled).toBe(false);
    expect(resolveIndicatorSettings(state.indicatorsByTimeframe, 'W').bollingerEnabled).toBe(false);
  });

  it('commits staged chart preferences only to the target window even before it owns a saved set', () => {
    const ctx: WindowViewValue = { windowId: 'catalog-pref-w1', group: 1, code: '098460', timeframe: '1m', historicalFromDate: null };
    const scope = { windowKey: windowScopeKey(ctx.windowId) };
    const other = { windowKey: windowScopeKey('catalog-pref-w2') };
    const beforeOther = readIndicatorEditor(other, '1m', false);
    render(<WindowViewContext.Provider value={ctx}><IndicatorPanel timeframe="1m" onClose={() => {}} /></WindowViewContext.Provider>);
    choose('체결강도');
    fireEvent.click(screen.getByRole('switch', { name: '당일 누적선 표시' }));
    expect(readIndicatorEditor(scope, '1m', false)['pref:fillStrengthCumulative']).toBe(true);
    add();
    expect(readIndicatorEditor(scope, '1m', false)).toMatchObject({ 'indicator:fillStrengthEnabled': true, 'pref:fillStrengthCumulative': false });
    expect(readIndicatorEditor(other, '1m', false)).toEqual(beforeOther);
    expect(readIndicatorEditor(scope, 'D', false)['pref:fillStrengthCumulative']).toBe(true);
  });

  it('merges display masks without overwriting another indicator edited while the draft was open', () => {
    const draft = createCatalogDraft('bollinger', FACTORY_INDICATOR_SETTINGS, useChartPrefsStore.getState());
    draft.actions.setIndicatorLineVisible('bollingerUpper', false);
    act(() => useLivePageStore.getState().setIndicatorLineVisible('fillStrengthBuy', false));
    const patch = catalogDraftPatch(draft, readIndicatorEditor({ windowKey: null }, '1m', true));
    expect(patch['indicator:indicatorLineVisibility']).toEqual({ bollingerUpper: false, fillStrengthBuy: false });
  });
});
