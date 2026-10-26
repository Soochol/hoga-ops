// Initialize through the store entry point: its persistence module imports the
// registry back from chartPrefs and cannot be the first module in that cycle.
import './chartPrefs';
import { CHART_PREFS_KEY, mergePrefs, mergeIndicatorModalByTimeframe, mergeIndicatorModalByWindow } from './chartPrefsPersistence';
import { INDICATORS_V2_STORAGE_KEY, normalizeIndicatorsV2 } from './indicatorSettingsV2';
import { normalizeWorkspaceSnapshot, WORKSPACE_SCHEMA_VERSION } from './workspace';
import { WORKSPACE_STORAGE_KEY } from './workspaceKeys';
import { normalizeItems } from '../chart/drawing/persistence';
import { THEME_PREFERENCE_OPTIONS } from './themePrefs';
import { WINDOW_SETTINGS_KEY, normalizeWindowSettingsSnapshot } from './windowSettings';

export const SETTINGS_FILE_LIMIT = 4 * 1024 * 1024;
export interface SettingsArchive {
  format: 'hoga-user-settings'; version: 1; origin: string; appVersion: string;
  createdAt: string; entries: Record<string, unknown>;
}
const FIXED_KEYS = new Set([WORKSPACE_STORAGE_KEY, INDICATORS_V2_STORAGE_KEY, CHART_PREFS_KEY, WINDOW_SETTINGS_KEY, 'ui.themePreference.v1']);
const DRAWING_KEY = /^replay\.drawings\.v2\.[A-Za-z0-9._-]{1,80}\|(seconds|minute|D|W|M)$/;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function point(value: unknown): boolean { return object(value) && finite(value.realMs) && finite(value.price); }
function safeTree(value: unknown, depth = 0): void {
  if (depth > 24) throw new Error('설정 데이터가 너무 깊습니다.');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('허용되지 않은 설정 필드입니다.');
      safeTree(child, depth + 1);
    }
  }
}
function normalizeEntry(key: string, value: unknown, legacyChartPrefs?: unknown): unknown {
  if (!object(value)) throw new Error(`설정 형식이 올바르지 않습니다: ${key}`);
  if (key === WORKSPACE_STORAGE_KEY) {
    if (value.schema_version !== WORKSPACE_SCHEMA_VERSION || !Array.isArray(value.windows) || !value.windows.length || value.windows.length > 64 || !Array.isArray(value.zOrder)) {
      throw new Error('현재 버전의 창 배치만 가져올 수 있습니다. 원본 브라우저를 새로고침한 뒤 내보내세요.');
    }
    const normalized = normalizeWorkspaceSnapshot(value);
    if (normalized.windows.length !== value.windows.length) throw new Error('손상된 창 배치가 있습니다.');
    return { schema_version: WORKSPACE_SCHEMA_VERSION, ...normalized,
      windows: normalized.windows.map(({ order: _order, ...window }) => window), groupSymbols: {} };
  }
  if (key === INDICATORS_V2_STORAGE_KEY) return normalizeIndicatorsV2(value);
  if (key === WINDOW_SETTINGS_KEY) {
    if (value.schema_version !== 1) throw new Error('지원하지 않는 창 설정 버전입니다.');
    return normalizeWindowSettingsSnapshot(value, legacyChartPrefs);
  }
  if (key === CHART_PREFS_KEY) return { ...mergePrefs(value), indicatorModalByTimeframe: mergeIndicatorModalByTimeframe(value), indicatorModalByWindow: mergeIndicatorModalByWindow(value) };
  if (key === 'ui.themePreference.v1') {
    if (!THEME_PREFERENCE_OPTIONS.some(option => option === value.themePreference)) throw new Error('알 수 없는 테마입니다.');
    return { themePreference: value.themePreference };
  }
  if (!DRAWING_KEY.test(key) || value.v !== 1 || !Array.isArray(value.items) || value.items.length > 20000) throw new Error(`허용되지 않은 설정 키 또는 버전: ${key}`);
  const normalized = normalizeItems(value.items);
  if (normalized.length !== value.items.length) throw new Error('지원하지 않는 그리기 종류입니다.');
  for (const item of normalized) {
    if (typeof item.id !== 'string' || !item.id || !/^#[0-9a-f]{6}$/i.test(item.color) || !finite(item.width) || item.width <= 0 || item.width > 100
      || !['solid', 'dashed', 'dotted'].includes(item.lineStyle) || typeof item.paneId !== 'string') throw new Error('손상된 그리기 스타일입니다.');
    if ((item.kind === 'hline' && !finite(item.price)) || (item.kind === 'vline' && !finite(item.realMs))
      || (['trendline', 'rect', 'measure'].includes(item.kind) && (!point((item as unknown as Record<string, unknown>).a) || !point((item as unknown as Record<string, unknown>).b)))
      || (item.kind === 'rect' && (!finite(item.fillOpacity) || item.fillOpacity < 0 || item.fillOpacity > 1))
      || (item.kind === 'text' && (!point(item.at) || typeof item.text !== 'string' || !finite(item.fontSize) || item.fontSize <= 0 || item.fontSize > 200))
      || (item.kind === 'pencil' && (!Array.isArray(item.points) || item.points.length > 20000 || !item.points.every(point)))) throw new Error('손상된 그리기 좌표입니다.');
  }
  return { v: 1, items: normalized };
}

export function parseSettingsArchive(text: string): SettingsArchive {
  if (new Blob([text]).size > SETTINGS_FILE_LIMIT) throw new Error('설정 파일은 4MB 이하여야 합니다.');
  const raw: unknown = JSON.parse(text);
  safeTree(raw);
  if (!object(raw) || raw.format !== 'hoga-user-settings' || raw.version !== 1 || !object(raw.entries)
    || typeof raw.origin !== 'string' || typeof raw.appVersion !== 'string' || typeof raw.createdAt !== 'string') throw new Error('지원하지 않는 설정 파일입니다.');
  const origin = new URL(raw.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== raw.origin) throw new Error('원본 서버 주소가 올바르지 않습니다.');
  const entries: Record<string, unknown> = {};
  const keys = Object.keys(raw.entries);
  if (!keys.length || keys.length > 1000) throw new Error('설정 항목 수가 올바르지 않습니다.');
  for (const key of keys) {
    if (!FIXED_KEYS.has(key) && !DRAWING_KEY.test(key)) throw new Error(`이전할 수 없는 설정입니다: ${key}`);
    entries[key] = normalizeEntry(key, raw.entries[key], raw.entries[CHART_PREFS_KEY]);
  }
  return { format: 'hoga-user-settings', version: 1, origin: raw.origin, appVersion: raw.appVersion, createdAt: raw.createdAt, entries };
}

export function exportSettings(storage: Storage, origin: string, appVersion: string): SettingsArchive {
  const entries: Record<string, unknown> = {};
  for (const key of Object.keys(storage)) {
    if (!FIXED_KEYS.has(key) && !DRAWING_KEY.test(key)) continue;
    const raw = storage.getItem(key);
    if (raw !== null) entries[key] = normalizeEntry(key, JSON.parse(raw), JSON.parse(storage.getItem(CHART_PREFS_KEY) ?? 'null'));
  }
  if (!Object.keys(entries).length) throw new Error('내보낼 화면 설정이 없습니다.');
  return { format: 'hoga-user-settings', version: 1, origin, appVersion, createdAt: new Date().toISOString(), entries };
}

/** Validate everything before touching storage; restore exact original bytes on a failed write. */
export function applySettings(storage: Storage, archive: SettingsArchive): void {
  const valid = parseSettingsArchive(JSON.stringify(archive));
  const originals = new Map(Object.keys(valid.entries).map(key => [key, storage.getItem(key)]));
  try {
    for (const [key, value] of Object.entries(valid.entries)) storage.setItem(key, JSON.stringify(value));
  } catch {
    try {
      for (const [key, value] of originals) { if (value === null) storage.removeItem(key); else storage.setItem(key, value); }
    } catch { throw new Error('설정 복구도 실패했습니다. 다운로드한 백업 파일을 보관하고 저장 공간을 확인하세요.'); }
    throw new Error('설정을 쓰지 못해 원래 상태로 복원했습니다. 저장 공간을 확인하세요.');
  }
}
