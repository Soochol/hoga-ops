import { useChartPrefsStore } from './chartPrefs';
import { normalizeChartDisplayPrefs } from './chartDisplayPrefs';
import { normalizeWindowSettings, useWindowSettingsStore, type WindowSettings } from './windowSettings';

type WindowIdentity = { id: string; kind: string };

/** Legacy global values are a one-time seed, never a link between live windows. */
export function seedSettingsForWindow(win: WindowIdentity, sourceId: string | null = null): void {
  const defaults = normalizeWindowSettings({ chart: normalizeChartDisplayPrefs(useChartPrefsStore.getState()) }, win.kind, true);
  useWindowSettingsStore.getState().seed(win.id, defaults, sourceId);
}

export function captureSettingsForWindow(win: WindowIdentity): WindowSettings {
  seedSettingsForWindow(win);
  return normalizeWindowSettings(useWindowSettingsStore.getState().byWindow[win.id], win.kind);
}

/** Restore only windows accepted by the workspace parser. Missing sections in an
 * older preset preserve existing values; new windows have already been seeded. */
export function restoreSettingsFromPayload(windows: readonly WindowIdentity[], rawWindows: readonly unknown[]): void {
  const byId = new Map<string, unknown>();
  for (const raw of rawWindows) {
    if (!raw || typeof raw !== 'object') continue;
    const win = raw as Record<string, unknown>;
    if (typeof win.id === 'string' && Object.hasOwn(win, 'windowSettings')) byId.set(win.id, win.windowSettings);
  }
  useWindowSettingsStore.getState().restore(windows.filter(win => byId.has(win.id))
    .map(win => ({ id: win.id, settings: normalizeWindowSettings(byId.get(win.id), win.kind) })));
}
