import { describe, expect, it } from 'vitest';
import type { HeatmapResponse } from '../api/heatmap';
import { applyHeatmapTransfer, folderCodes, inverseHeatmapTransfer, planHeatmapTransfer } from './transferEntries';
const make = (): HeatmapResponse => ({
  folders: ['A', 'B', 'C'].map((id, order) => ({ id, name: id, order })),
  entries: Object.entries({ A: ['a', 'b'], B: ['c', 'a', 'd'], C: ['b'] }).flatMap(([folder_id, codes]) => codes.map((code, order) => ({ code, name: code, folder_id, order }))),
  capture_markers: { a: '20260907' }, next_run_at_ms: 0,
});
const sources = [{ folderId: 'A', code: 'a' }, { folderId: 'A', code: 'b' }];
describe('heatmap membership transfer', () => {
  it('inserts a block at the requested gap, merges duplicates, preserves unselected memberships', () => {
    const data = make();
    const result = applyHeatmapTransfer(data, planHeatmapTransfer(data, sources, 'B', 1));
    expect(folderCodes(result, 'A')).toEqual([]);
    expect(folderCodes(result, 'B')).toEqual(['c', 'a', 'b', 'd']);
    expect(folderCodes(result, 'C')).toEqual(['b']);
    expect(result.capture_markers).toEqual(data.capture_markers);
  });
  it('copy keeps source and existing target position', () => {
    const data = make();
    const result = applyHeatmapTransfer(data, planHeatmapTransfer(data, sources, 'B', 0, true));
    expect(folderCodes(result, 'A')).toEqual(['a', 'b']);
    expect(folderCodes(result, 'B')).toEqual(['b', 'c', 'a', 'd']);
  });
  it.each([false, true])('undo restores memberships and order (copy=%s)', (copy) => {
    const data = make();
    const changes = planHeatmapTransfer(data, sources, 'B', 0, copy);
    const restored = applyHeatmapTransfer(applyHeatmapTransfer(data, changes), inverseHeatmapTransfer(changes));
    for (const id of ['A', 'B', 'C']) expect(folderCodes(restored, id)).toEqual(folderCodes(data, id));
  });
  it('sorted target keeps stored order and appends only missing codes', () => {
    const data = make();
    const result = applyHeatmapTransfer(data, planHeatmapTransfer(data, sources, 'B', 0, false, true));
    expect(folderCodes(result, 'B')).toEqual(['c', 'a', 'd', 'b']);
  });
  it('duplicate-only move retains unchanged target for guarded undo', () => {
    const changes = planHeatmapTransfer(make(), sources.slice(0, 1), 'B', 0, false, true);
    expect(changes).toHaveLength(2);
    expect(changes[1].before).toEqual(changes[1].after);
  });
  it('same-group movement accounts for removal before insertion', () => {
    const data = make();
    expect(folderCodes(applyHeatmapTransfer(data, planHeatmapTransfer(data, sources.slice(0, 1), 'A', 2)), 'A')).toEqual(['b', 'a']);
    expect(planHeatmapTransfer(data, sources.slice(0, 1), 'A', 1)).toEqual([]);
  });
  it('copy to an existing registration is a no-op, including same group', () => {
    const data = make();
    expect(planHeatmapTransfer(data, sources.slice(0, 1), 'B', 0, true)).toEqual([]);
    expect(planHeatmapTransfer(data, sources, 'A', 0, true)).toEqual([]);
  });
});
