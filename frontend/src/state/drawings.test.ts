// frontend/src/state/drawings.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from '../chart/drawing/types';
import { useDrawingsStore } from './drawings';

const A = '005930';
const B = '003490';

function mkHline(id: string, price: number): Drawing {
  return { id, kind: 'hline', price, color: '#FFD60A', width: 1.5 };
}

beforeEach(() => {
  localStorage.clear();
  useDrawingsStore.getState().__resetForTests();
});

describe('useDrawingsStore — Code partitioning', () => {
  it('starts empty with no activeCode', () => {
    const s = useDrawingsStore.getState();
    expect(s.activeCode).toBeNull();
    expect(s.activeTool).toBe('select');
    expect(s.selectedId).toBeNull();
    expect(s.drawingsFor(A)).toEqual([]);
  });

  it('add appends to the active Code only', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('h1', 100));
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(0);
  });

  it('switching activeCode does not move drawings', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().setActiveCode(B);
    useDrawingsStore.getState().add(mkHline('h2', 200));
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(1);
  });

  it('setActiveCode resets selectedId', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().setSelected('h1');
    expect(useDrawingsStore.getState().selectedId).toBe('h1');
    useDrawingsStore.getState().setActiveCode(B);
    expect(useDrawingsStore.getState().selectedId).toBeNull();
  });
});

describe('useDrawingsStore — mutations', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveCode(A);
  });

  it('update patches a drawing by id', () => {
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().update('h1', { price: 150 } as Partial<Drawing>);
    const found = useDrawingsStore.getState().drawingsFor(A)[0];
    expect((found as { price: number }).price).toBe(150);
  });

  it('remove deletes by id and clears selection if it matched', () => {
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().setSelected('h1');
    useDrawingsStore.getState().remove('h1');
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(0);
    expect(useDrawingsStore.getState().selectedId).toBeNull();
  });

  it('clearAll empties the active Code list only', () => {
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().setActiveCode(B);
    useDrawingsStore.getState().add(mkHline('h2', 200));
    useDrawingsStore.getState().clearAll();
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(0);
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
  });
});

describe('useDrawingsStore — persistence integration', () => {
  it('setActiveCode hydrates from localStorage', () => {
    localStorage.setItem(
      'replay.drawings.v1.005930',
      JSON.stringify({ v: 1, items: [mkHline('h1', 100)] }),
    );
    useDrawingsStore.getState().setActiveCode(A);
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
  });

  it('flushPending writes the active Code to localStorage', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().flushPending();
    const raw = localStorage.getItem('replay.drawings.v1.005930');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ v: 1, items: [mkHline('h1', 100)] });
  });
});
