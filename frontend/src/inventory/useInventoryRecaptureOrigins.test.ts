import { describe, expect, it, beforeEach } from 'vitest';
import { useInventoryRecaptureOrigins } from './useInventoryRecaptureOrigins';

beforeEach(() => {
  useInventoryRecaptureOrigins.getState().clear();
});

describe('useInventoryRecaptureOrigins', () => {
  it('starts empty', () => {
    expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(0);
  });

  it('add() inserts ids into the set', () => {
    useInventoryRecaptureOrigins.getState().add(['a', 'b']);
    const { ids, has } = useInventoryRecaptureOrigins.getState();
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
    expect(has('a')).toBe(true);
    expect(has('c')).toBe(false);
  });

  it('add() preserves prior ids (accumulates)', () => {
    useInventoryRecaptureOrigins.getState().add(['a']);
    useInventoryRecaptureOrigins.getState().add(['b']);
    expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(2);
  });

  it('add() is idempotent for duplicate ids', () => {
    useInventoryRecaptureOrigins.getState().add(['a', 'a', 'b']);
    expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(2);
  });

  it('clear() empties the set', () => {
    useInventoryRecaptureOrigins.getState().add(['a', 'b']);
    useInventoryRecaptureOrigins.getState().clear();
    expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(0);
  });

  it('add() with empty array is a no-op (does not create a new ids reference)', () => {
    const before = useInventoryRecaptureOrigins.getState().ids;
    useInventoryRecaptureOrigins.getState().add([]);
    const after = useInventoryRecaptureOrigins.getState().ids;
    expect(after).toBe(before);
  });
});
