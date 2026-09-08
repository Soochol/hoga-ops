import type { HeatmapResponse, HeatmapFolderEntriesChange } from '../api/heatmap';
export interface HeatmapTransferSource { folderId: string; code: string }
export const folderCodes = (data: HeatmapResponse, id: string) => data.entries
  .filter((e) => e.folder_id === id).sort((a, b) => a.order - b.order).map((e) => e.code);

/** at is a gap in the full stored target list, even when searching. */
export function planHeatmapTransfer(data: HeatmapResponse, sources: HeatmapTransferSource[], target: string,
  at: number, copy = false, preserveTargetOrder = false): HeatmapFolderEntriesChange[] {
  if (!data.folders.some((f) => f.id === target)) return [];
  const valid = sources.filter((s) => data.entries.some((e) => e.folder_id === s.folderId && e.code === s.code));
  const codes = [...new Set(valid.map((s) => s.code))];
  if (!codes.length) return [];
  const changes = [...new Set([...valid.map((s) => s.folderId), target])].map((folder_id) => {
    const before = folderCodes(data, folder_id);
    let after = before;
    if (folder_id === target) {
      // Copies never reposition registrations already in the target.
      const inserting = copy || preserveTargetOrder ? codes.filter((c) => !before.includes(c)) : codes;
      const moved = new Set(inserting);
      const index = preserveTargetOrder ? before.length : before.slice(0, Math.max(0, at)).filter((c) => !moved.has(c)).length;
      after = before.filter((c) => !moved.has(c));
      after.splice(index, 0, ...inserting);
    } else if (!copy) {
      const removed = new Set(valid.filter((s) => s.folderId === folder_id).map((s) => s.code));
      after = before.filter((c) => !removed.has(c));
    }
    return { folder_id, before, after };
  });
  // Unchanged source/target snapshots are essential for copy, duplicate merge and undo.
  return changes.some((c) => JSON.stringify(c.before) !== JSON.stringify(c.after)) ? changes : [];
}
export const inverseHeatmapTransfer = (changes: HeatmapFolderEntriesChange[]) => changes.map((c) => ({
  folder_id: c.folder_id, before: c.after, after: c.before,
}));
export function applyHeatmapTransfer(data: HeatmapResponse, changes: HeatmapFolderEntriesChange[]): HeatmapResponse {
  const affected = new Set(changes.map((c) => c.folder_id));
  const entries = data.entries.filter((e) => !affected.has(e.folder_id));
  for (const c of changes) c.after.forEach((code, order) => {
    const entry = data.entries.find((e) => e.folder_id === c.folder_id && e.code === code) ?? data.entries.find((e) => e.code === code);
    if (entry) entries.push({ ...entry, folder_id: c.folder_id, order });
  });
  return { ...data, entries };
}
