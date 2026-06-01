import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSaveAnchor } from './useSaveAnchor';
import type { SavedScreener } from '../api/savedScreeners';

const SAVE: SavedScreener = {
  id: 's1', name: '급등주',
  conditions: [{ id: 'c', type: 'new_high', params: { lookback: 200, period: 500 } }],
  universe: { markets: ['KOSPI'] }, created_at_ms: 1, updated_at_ms: 1,
};

describe('useSaveAnchor', () => {
  it('starts empty, unanchored, clean', () => {
    const { result } = renderHook(() => useSaveAnchor());
    expect(result.current.conditions).toEqual([]);
    expect(result.current.universe).toEqual({});
    expect(result.current.anchorId).toBeNull();
    expect(result.current.dirty).toBe(false);
  });

  it('loadSave anchors the row clean with the save\'s conditions/universe', () => {
    const { result } = renderHook(() => useSaveAnchor());
    act(() => result.current.loadSave(SAVE));
    expect(result.current.conditions).toEqual(SAVE.conditions);
    expect(result.current.universe).toEqual(SAVE.universe);
    expect(result.current.anchorId).toBe('s1');
    expect(result.current.dirty).toBe(false);
  });

  it('editConditions / editUniverse mark dirty', () => {
    const { result } = renderHook(() => useSaveAnchor());
    act(() => result.current.loadSave(SAVE));
    act(() => result.current.editConditions([]));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.loadSave(SAVE));     // reload → clean again
    act(() => result.current.editUniverse({ exclude_etf: true }));
    expect(result.current.dirty).toBe(true);
  });

  it('beginSave→settleAnchor with NO mid-flight edit marks clean', () => {
    const { result } = renderHook(() => useSaveAnchor());
    act(() => { result.current.beginSave(); result.current.settleAnchor('s-new'); });
    expect(result.current.anchorId).toBe('s-new');
    expect(result.current.dirty).toBe(false);
  });

  it('an edit landing BETWEEN beginSave and settleAnchor keeps it dirty (false-clean race guard)', () => {
    const { result } = renderHook(() => useSaveAnchor());
    act(() => result.current.beginSave());
    act(() => result.current.editConditions([{ id: 'x', type: 'trade_value', params: { min_eok: 1 } }]));
    act(() => result.current.settleAnchor('s-new'));
    expect(result.current.anchorId).toBe('s-new');
    expect(result.current.dirty).toBe(true);   // MUST stay dirty — the builder diverged from what was saved
  });

  it('settleAnchor(null) clears the anchor and marks clean', () => {
    const { result } = renderHook(() => useSaveAnchor());
    act(() => result.current.loadSave(SAVE));
    act(() => result.current.editConditions([]));   // dirty
    act(() => result.current.settleAnchor(null));
    expect(result.current.anchorId).toBeNull();
    expect(result.current.dirty).toBe(false);
  });

  it('newDraft clears conditions/universe/anchor and marks clean', () => {
    const { result } = renderHook(() => useSaveAnchor());
    act(() => result.current.loadSave(SAVE));
    act(() => result.current.editConditions(SAVE.conditions));   // anchored + dirty
    act(() => result.current.newDraft());
    expect(result.current.conditions).toEqual([]);
    expect(result.current.universe).toEqual({});
    expect(result.current.anchorId).toBeNull();
    expect(result.current.dirty).toBe(false);
  });
});
