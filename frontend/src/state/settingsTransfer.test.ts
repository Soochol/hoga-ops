import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySettings, exportSettings, parseSettingsArchive, type SettingsArchive } from './settingsTransfer';
import { snapshotWorkspace, WORKSPACE_SCHEMA_VERSION } from './workspace';
import { INDICATORS_V2_STORAGE_KEY, normalizeIndicatorsV2 } from './indicatorSettingsV2';
import { WINDOW_SETTINGS_KEY } from './windowSettings';
import { DEFAULT_CHART_DISPLAY_PREFS } from './chartDisplayPrefs';

function archive(entries: Record<string, unknown>): SettingsArchive {
  return { format: 'hoga-user-settings', version: 1, origin: 'http://old-server:8000', appVersion: '0.16.6.0', createdAt: new Date().toISOString(), entries };
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });
describe('settings transfer boundary', () => {
  it('imports old window sections using the archive globals for missing high/low fields', () => {
    const input = archive({
      [WINDOW_SETTINGS_KEY]: { schema_version: 1, byWindow: { a: { chart: { candleLogScale: true } } } },
      'hoga.chart.prefs.v1': { highLowLabelsEnabled: false, highLowPriorHighLineColor: '#123456', highLowPriorHighLineWidth: 3 },
    });
    applySettings(localStorage, input);
    const imported = JSON.parse(localStorage.getItem(WINDOW_SETTINGS_KEY)!);
    expect(imported.byWindow.a.chart).toMatchObject({ candleLogScale: true, highLowLabelsEnabled: false,
      highLowPriorHighLineColor: '#123456', highLowPriorHighLineWidth: 3 });
    expect(exportSettings(localStorage, 'http://new-server:8000', '0.16.6.0').entries[WINDOW_SETTINGS_KEY]).toEqual(imported);
  });
  it('roundtrips window settings while preserving explicitly disabled options', () => {
    const entry = { schema_version: 1, byWindow: { a: { chart: { ...DEFAULT_CHART_DISPLAY_PREFS, auctionWindowMask: false } } } };
    applySettings(localStorage, archive({ [WINDOW_SETTINGS_KEY]: entry }));
    expect(exportSettings(localStorage, 'http://new-server:8000', '0.16.6.0').entries[WINDOW_SETTINGS_KEY]).toEqual(entry);
  });
  it.each(['obsidian-pro', 'ledger-studio'])('roundtrips the %s theme', (themePreference) => {
    const input = archive({ 'ui.themePreference.v1': { themePreference } });
    applySettings(localStorage, parseSettingsArchive(JSON.stringify(input)));
    expect(exportSettings(localStorage, 'http://new-server:8000', '0.16.6.0').entries['ui.themePreference.v1'])
      .toEqual({ themePreference });
  });
  it('roundtrips workspace, per-window indicators, chart preferences, theme and drawings without server data', () => {
    const drawing = { v: 1, items: [{ id: 'a', kind: 'hline', price: 123, color: '#f0b429', width: 1, lineStyle: 'solid', paneId: 'candle' }] };
    const input = archive({
      'live.workspace.v1': { schema_version: WORKSPACE_SCHEMA_VERSION, ...snapshotWorkspace() },
      [INDICATORS_V2_STORAGE_KEY]: normalizeIndicatorsV2({}),
      'hoga.chart.prefs.v1': {},
      'ui.themePreference.v1': { themePreference: 'obsidian' },
      'replay.drawings.v2.005930|minute': drawing,
    });
    applySettings(localStorage, input);
    localStorage.setItem('live.workspace.transfer.secret', 'temporary');
    localStorage.setItem('broker-token', 'secret');
    const exported = exportSettings(localStorage, 'http://new-server:8000', '0.16.6.0');
    expect(Object.keys(exported.entries)).toHaveLength(5);
    expect(exported.entries['broker-token']).toBeUndefined();
    expect(exported.entries['live.workspace.transfer.secret']).toBeUndefined();
    const parsed = parseSettingsArchive(JSON.stringify(exported));
    expect(parsed.entries['replay.drawings.v2.005930|minute']).toEqual(drawing);
    const workspace = parsed.entries['live.workspace.v1'] as { windows: Record<string, unknown>[]; groupSymbols: unknown };
    expect(workspace.groupSymbols).toEqual({});
    expect(workspace.windows.every(w => !('pinned' in w) && !('order' in w))).toBe(true);
  });
  it('rejects unknown version, secret keys, malformed drawing coordinates and prototype keys before writes', () => {
    const valid = archive({ 'ui.themePreference.v1': { themePreference: 'obsidian' } });
    expect(() => parseSettingsArchive(JSON.stringify({ ...valid, version: 2 }))).toThrow();
    expect(() => applySettings(localStorage, archive({ token: 'oops' }))).toThrow();
    expect(() => parseSettingsArchive(JSON.stringify(archive({ 'replay.drawings.v2.005930|D': { v: 1, items: [{ kind: 'trendline', id: 'a', color: '#123456', width: 1 }] } })))).toThrow();
    expect(() => parseSettingsArchive(JSON.stringify(valid).replace('"themePreference":"obsidian"', '"__proto__":{}'))).toThrow();
    expect(localStorage.length).toBe(0);
  });
  it('restores original bytes when one write exceeds quota', () => {
    localStorage.setItem('ui.themePreference.v1', '{"themePreference":"ledger"}');
    const original = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      writes++;
      if (writes === 2) throw new DOMException('quota', 'QuotaExceededError');
      original.call(this, key, value);
    });
    expect(() => applySettings(localStorage, archive({
      'ui.themePreference.v1': { themePreference: 'obsidian' }, 'hoga.chart.prefs.v1': {},
    }))).toThrow(/복원/);
    expect(localStorage.getItem('ui.themePreference.v1')).toBe('{"themePreference":"ledger"}');
    expect(localStorage.getItem('hoga.chart.prefs.v1')).toBeNull();
  });
  it('rejects oversized archives', () => {
    expect(() => parseSettingsArchive(' '.repeat(4 * 1024 * 1024 + 1))).toThrow(/4MB/);
  });
});
