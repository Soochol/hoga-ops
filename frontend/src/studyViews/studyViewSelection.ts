import type { ParquetStudyView } from '../api/studyViews';

export function latestStudyViewForCode(
  saves: readonly ParquetStudyView[],
  code: string,
): ParquetStudyView | null {
  const matches = saves.filter((save) => save.code === code);
  if (matches.length === 0) return null;
  return matches.slice().sort((a, b) => {
    const updated = b.updated_at_ms - a.updated_at_ms;
    if (updated !== 0) return updated;
    return b.created_at_ms - a.created_at_ms;
  })[0] ?? null;
}

export function formatStudyTabLabel(
  save: Pick<ParquetStudyView, 'label' | 'name' | 'timeframe'>,
): string {
  return `${save.label} · ${save.name} · ${save.timeframe}`;
}
