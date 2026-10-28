import { persistJson, readJsonObject } from './persist';

type Kind = 'chart' | 'trade' | 'news';
const KEYS: Record<Kind, string> = {
  chart: 'hoga.chart.settings.last.v1',
  trade: 'hoga.trade.settings.last.v1',
  news: 'hoga.news.settings.last.v1',
};

/** New-window seeds only. Existing windows and explicit presets remain independent.
 * Each kind has its own key; reading at creation also sees edits from other tabs. */
export function readLastWindowPreferences(kind: Kind): Record<string, unknown> | null {
  const value = readJsonObject(KEYS[kind]);
  return value.schema_version === 1 && value.settings && typeof value.settings === 'object'
    && !Array.isArray(value.settings) ? value.settings as Record<string, unknown> : null;
}

export function rememberWindowPreferences(kind: Kind, settings: Record<string, unknown>): void {
  persistJson(KEYS[kind], { schema_version: 1, settings });
}

type ChartEdit = { windowId: string } | { windowKey: string | null };
const listeners = new Set<(edit: ChartEdit) => void>();

/** Explicit edits only: hydration, seeding, cross-tab sync and preset restoration
 * must not replace the latest user edit. This leaf avoids store import cycles. */
export function notifyChartPreferenceEdit(edit: ChartEdit): void {
  for (const listener of listeners) listener(edit);
}

export function subscribeToChartPreferenceEdits(listener: (edit: ChartEdit) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
