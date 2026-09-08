/** Insert selected ids as a stable block at a gap in the original list. */
export function insertStudyViewIds(ids: string[], selected: string[], at: number): string[] {
  const moving = new Set(selected);
  const block = ids.filter((id) => moving.has(id));
  const index = ids.slice(0, Math.max(0, at)).filter((id) => !moving.has(id)).length;
  const remaining = ids.filter((id) => !moving.has(id));
  remaining.splice(index, 0, ...block);
  return remaining;
}
