/** Dependency-free catalog: settings hydration must never import live stores. */
export const MAJOR_INDICES = [
  { id: 'KOSPI', label: '코스피', color: 'var(--price-up)' },
  { id: 'KOSDAQ', label: '코스닥', color: 'var(--price-down)' },
  { id: 'KOSPI200', label: 'K200', color: 'var(--success)' },
] as const;

export type MajorIndexId = (typeof MAJOR_INDICES)[number]['id'];
export interface MajorIndicesSettings {
  indices: MajorIndexId[];
  showStock: boolean;
}

export const DEFAULT_MAJOR_INDICES_SETTINGS: MajorIndicesSettings = {
  indices: MAJOR_INDICES.map(index => index.id),
  showStock: true,
};

/** Canonical order, known IDs and at least one index, including older presets. */
export function normalizeMajorIndicesSettings(raw: unknown): MajorIndicesSettings {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const indices = MAJOR_INDICES.filter(index => Array.isArray(value.indices) && value.indices.includes(index.id))
    .map(index => index.id);
  return {
    indices: indices.length ? indices : [...DEFAULT_MAJOR_INDICES_SETTINGS.indices],
    showStock: typeof value.showStock === 'boolean' ? value.showStock : true,
  };
}
