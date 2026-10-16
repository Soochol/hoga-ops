import { beforeEach, describe, expect, it } from 'vitest';
import { INDICATOR_LINE_KEYS, lineVisible } from './indicatorLineVisibility';
import { mergeLiveIndicatorPrefs } from './liveIndicatorsPersistence';
import { useLivePageStore } from './livePage';
import { INDICATOR_OPS } from './indicatorOps';
import { FACTORY_INDICATOR_SETTINGS, bucketsForScope, normalizeIndicatorsV2, resolveIndicatorSettings } from './indicatorSettingsV2';
import { readIndicatorEditor, restoreIndicatorEditor } from '../live/settings/editorSnapshots';

const scope = { windowKey: 'line-toggles-w1' };
const read = (windowKey = scope.windowKey, tf: '1m' | 'D' = '1m') => {
  const s = useLivePageStore.getState();
  return resolveIndicatorSettings(bucketsForScope(s.indicatorsByTimeframe, s.indicatorsByWindow, { windowKey }), tf);
};
beforeEach(() => {
  localStorage.clear();
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
});

describe('individual line visibility', () => {
  it('old settings keep all lines visible and malformed entries are discarded', () => {
    const old = mergeLiveIndicatorPrefs({});
    expect(INDICATOR_LINE_KEYS.every(key => lineVisible(old.indicatorLineVisibility, key))).toBe(true);
    expect(mergeLiveIndicatorPrefs({ indicatorLineVisibility: { bollingerUpper: false, bollingerMiddle: 'false', unexpected: false } }).indicatorLineVisibility)
      .toEqual({ bollingerUpper: false });
    const slot = { ...FACTORY_INDICATOR_SETTINGS.movingAverages[0], hidden: 'false' };
    expect(mergeLiveIndicatorPrefs({ movingAverages: [slot] }).movingAverages[0].hidden).toBeUndefined();
  });

  it('all hidden MA slots retain membership, values and styles through normalization', () => {
    const cur = { ...FACTORY_INDICATOR_SETTINGS, movingAverages: [FACTORY_INDICATOR_SETTINGS.movingAverages[0]] };
    const hidden = { ...cur, ...INDICATOR_OPS.setAllMovingAveragesVisible(cur, false) };
    expect(hidden.movingAverages[0]).toEqual({ ...cur.movingAverages[0], hidden: true });
    expect(mergeLiveIndicatorPrefs(hidden).movingAverages).toEqual(hidden.movingAverages);
    expect({ ...hidden, ...INDICATOR_OPS.setAllMovingAveragesVisible(hidden, true) }.movingAverages[0])
      .toEqual({ ...cur.movingAverages[0], hidden: false });
  });

  it('persists each chart/timeframe independently and editor undo restores both kinds of visibility', () => {
    const before = readIndicatorEditor(scope, '1m', false);
    const current = read();
    const patch = INDICATOR_OPS.setIndicatorLineVisible(current, 'bollingerUpper', false)!;
    useLivePageStore.getState().patchIndicatorsScoped(scope, '1m', {
      ...patch, ...INDICATOR_OPS.setAllMovingAveragesVisible(current, false),
    });
    expect(read().indicatorLineVisibility).toEqual({ bollingerUpper: false });
    expect(read('line-toggles-w2').indicatorLineVisibility).toEqual({});
    expect(read(scope.windowKey, 'D').indicatorLineVisibility).toEqual({});
    const persisted = normalizeIndicatorsV2(JSON.parse(localStorage.getItem('live.indicators.v2')!));
    const restored = resolveIndicatorSettings(bucketsForScope(persisted.byTimeframe, persisted.byWindow, scope), '1m');
    expect(restored.indicatorLineVisibility).toEqual({ bollingerUpper: false });
    expect(restored.movingAverages.every(m => m.hidden && m.enabled)).toBe(true);
    restoreIndicatorEditor(scope, '1m', before);
    expect(read().indicatorLineVisibility).toEqual({});
    expect(read().movingAverages).toEqual(current.movingAverages);
  });
});
