import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [] })),
  createSave: vi.fn(() => Promise.resolve({ id: 's-new', name: '새이름', conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2 })),
  updateSave: vi.fn(() => Promise.resolve({})),
  deleteSave: vi.fn(() => Promise.resolve()),
}));
import * as api from '../api/savedScreeners';
import type { SavedScreener } from '../api/savedScreeners';
import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import { useSavedScreenerEditor } from './useSavedScreenerEditor';

const SAVE: SavedScreener = {
  id: 's1', name: '급등주',
  conditions: [{ id: 'c', type: 'new_high', params: { lookback: 200, period: 500 } }],
  universe: { markets: ['KOSPI'] }, created_at_ms: 1, updated_at_ms: 1,
};
const BUILDER_CONDS: ConditionLeaf[] = [{ id: 'b', type: 'trade_value', params: { min_eok: 99 } }];
const BUILDER_UNIVERSE: ScreenerUniverse = { exclude_etf: true };

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, children);

// useSaveAnchor 가 빌더 draft 를 localStorage(screenerDraft.v1)에 영속하므로, 앞
// 테스트의 anchorId/조건이 다음 테스트의 마운트 시드로 새지 않게 매번 비운다.
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('useSavedScreenerEditor', () => {
  it('saveAsNew with no mid-flight edit re-anchors to the created id and goes clean', async () => {
    vi.mocked(api.createSave).mockResolvedValueOnce(
      { id: 's-new', name: '새이름', conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2 });
    const { result } = renderHook(() => useSavedScreenerEditor(), { wrapper });
    act(() => result.current.editConditions(BUILDER_CONDS));
    act(() => result.current.editUniverse(BUILDER_UNIVERSE));
    act(() => result.current.saveAsNew('새이름'));
    await waitFor(() => expect(api.createSave).toHaveBeenCalledWith(
      { name: '새이름', conditions: BUILDER_CONDS, universe: BUILDER_UNIVERSE }));
    await waitFor(() => expect(result.current.anchorId).toBe('s-new'));
    expect(result.current.dirty).toBe(false);
  });

  it('an editConditions landing BETWEEN saveAsNew dispatch and its success stays dirty (race guard)', async () => {
    let resolveCreate!: (v: SavedScreener) => void;
    const created: SavedScreener = { id: 'new1', name: '레이스', conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2 };
    vi.mocked(api.createSave).mockImplementationOnce(() => new Promise<SavedScreener>((r) => { resolveCreate = r; }));
    const { result } = renderHook(() => useSavedScreenerEditor(), { wrapper });
    act(() => result.current.editConditions(BUILDER_CONDS));
    act(() => result.current.saveAsNew('레이스'));            // snapshots pendingSaveGen
    await waitFor(() => expect(api.createSave).toHaveBeenCalled());
    act(() => result.current.editConditions([]));            // edit DURING in-flight create (bumps editGen)
    await act(async () => { resolveCreate(created); });       // settleAnchor sees mismatch
    expect(result.current.anchorId).toBe('new1');
    expect(result.current.dirty).toBe(true);                 // MUST stay dirty
  });

  it('overwrite saves the live builder onto the save (keeps name), re-anchors clean', async () => {
    const { result } = renderHook(() => useSavedScreenerEditor(), { wrapper });
    act(() => result.current.editConditions(BUILDER_CONDS));
    act(() => result.current.editUniverse(BUILDER_UNIVERSE));
    act(() => result.current.overwrite(SAVE));
    await waitFor(() => expect(api.updateSave).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updateSave).mock.calls[0];
    expect(id).toBe('s1');
    expect(body.name).toBe('급등주');
    expect(body.conditions).toEqual(BUILDER_CONDS);
    expect(body.universe).toEqual(BUILDER_UNIVERSE);
    await waitFor(() => expect(result.current.anchorId).toBe('s1'));
    expect(result.current.dirty).toBe(false);
  });

  it('rename carries the SAVE\'s own conditions/universe and does NOT re-anchor', async () => {
    const { result } = renderHook(() => useSavedScreenerEditor(), { wrapper });
    act(() => result.current.editConditions(BUILDER_CONDS));   // live builder differs from the save
    act(() => result.current.rename(SAVE, '새이름'));
    await waitFor(() => expect(api.updateSave).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updateSave).mock.calls[0];
    expect(id).toBe('s1');
    expect(body.name).toBe('새이름');
    expect(body.conditions).toEqual(SAVE.conditions);
    expect(body.universe).toEqual(SAVE.universe);
    expect(result.current.anchorId).toBeNull();               // unchanged (never anchored, no re-anchor)
  });

  it('remove clears the anchor when the deleted save WAS the anchor', async () => {
    const { result } = renderHook(() => useSavedScreenerEditor(), { wrapper });
    act(() => result.current.load(SAVE));                     // anchor on s1
    expect(result.current.anchorId).toBe('s1');
    act(() => result.current.remove(SAVE));
    await waitFor(() => expect(api.deleteSave).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(result.current.anchorId).toBeNull());
  });

  it('remove keeps the anchor when a different save is deleted', async () => {
    const other: SavedScreener = { ...SAVE, id: 's2', name: '눌림목' };
    const { result } = renderHook(() => useSavedScreenerEditor(), { wrapper });
    act(() => result.current.load(SAVE));                     // anchor on s1
    act(() => result.current.remove(other));
    await waitFor(() => expect(api.deleteSave).toHaveBeenCalledWith('s2'));
    expect(result.current.anchorId).toBe('s1');              // unchanged
  });
});
