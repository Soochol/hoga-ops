import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import type { ConditionLeaf } from '../api/screener';
import { separateVolumeBases } from './calculationPolicy';
import { useSaveAnchor } from './useSaveAnchor';

beforeEach(() => localStorage.clear());
it('normalizes each volume basis without changing the old leaf or price params', () => {
  const leaves: ConditionLeaf[] = [
    { id: 'daily', type: 'new_high_vol_today', params: { period: 3 } },
    { id: 'minute', type: 'new_high_vol_today', params: { period: 3, timeframe: '1m' } },
    { id: 'price', type: 'new_high_today', params: { period: 3 } },
  ];
  const before = JSON.stringify(leaves);
  expect(separateVolumeBases(leaves).map(leaf => leaf.params)).toEqual([
    { period: 3, volume_basis: 'share_adjusted' }, { period: 3, timeframe: '1m', volume_basis: 'raw' }, { period: 3 },
  ]);
  expect(JSON.stringify(leaves)).toBe(before);
});
it('copy detaches the original identity and persists the explicit new policy', () => {
  const { result, unmount } = renderHook(() => useSaveAnchor());
  const original = { id: 'old', name: 'old', conditions: [{ id: 'v', type: 'new_high_vol_today' as const,
    params: { period: 3 } }], universe: {}, created_at_ms: 1, updated_at_ms: 1 };
  act(() => result.current.loadSave(original));
  expect(result.current.calculationPolicy).toBe('legacy_v1');
  act(() => result.current.copyToNewPolicy());
  expect(result.current.anchorId).toBeNull();
  expect(result.current.dirty).toBe(true);
  expect(result.current.calculationPolicy).toBe('separate_bases_v2');
  expect(original.conditions[0].params).toEqual({ period: 3 });
  unmount();
  const restored = renderHook(() => useSaveAnchor());
  expect(restored.result.current.calculationPolicy).toBe('separate_bases_v2');
  expect(restored.result.current.conditions[0].params).toMatchObject({ volume_basis: 'share_adjusted' });
});
