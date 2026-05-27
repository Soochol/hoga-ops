// frontend/src/state/drawings.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from '../chart/drawing/types';
import { INITIAL_DEFAULTS } from '../chart/drawing/types';
import { DEFAULTS_KEY } from '../chart/drawing/persistence';
import { useDrawingsStore } from './drawings';

const A = '005930';
const B = '003490';

function mkHline(id: string, price: number): Drawing {
  return { id, kind: 'hline', price, color: '#FFD60A', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
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

  // /review audit: per-code debounce isolation. Editing A then switching to
  // B and editing within the debounce window must NOT lose A's edit.
  // Pre-fix, a single shared timer was cancelled by B's edit → A never
  // reached saveDrawings → on reload A's edit was silently lost.
  it('flushPending writes ALL pending codes, not just the most recent', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('a1', 111));
    // Switch to B and edit while A's debounce timer is still armed.
    useDrawingsStore.getState().setActiveCode(B);
    useDrawingsStore.getState().add(mkHline('b1', 222));
    useDrawingsStore.getState().flushPending();
    expect(JSON.parse(localStorage.getItem('replay.drawings.v1.005930') as string))
      .toEqual({ v: 1, items: [mkHline('a1', 111)] });
    expect(JSON.parse(localStorage.getItem('replay.drawings.v1.003490') as string))
      .toEqual({ v: 1, items: [mkHline('b1', 222)] });
  });
});

describe('useDrawingsStore — defaults', () => {
  beforeEach(() => {
    localStorage.clear();
    useDrawingsStore.getState().__resetForTests();
  });

  it('exposes INITIAL_DEFAULTS when no persisted defaults exist', () => {
    expect(useDrawingsStore.getState().defaults).toEqual(INITIAL_DEFAULTS);
  });

  it('setDefaults patches and persists', () => {
    useDrawingsStore.getState().setDefaults({ color: '#F43F5E' });
    expect(useDrawingsStore.getState().defaults.color).toBe('#F43F5E');
    useDrawingsStore.getState().flushPending();
    const raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY)!);
    expect(raw.value.color).toBe('#F43F5E');
  });

  it('update(id, patch) syncs color/width/lineStyle into defaults', () => {
    const s = useDrawingsStore.getState();
    s.setActiveCode('005930');
    const d: Drawing = {
      id: 'a', kind: 'hline', price: 1000,
      color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    };
    s.add(d);
    s.update('a', { color: '#10B981', width: 3, lineStyle: 'dashed' });
    expect(useDrawingsStore.getState().defaults).toEqual({
      color: '#10B981', width: 3, lineStyle: 'dashed',
    });
  });

  it('update with no style fields does not touch defaults', () => {
    const s = useDrawingsStore.getState();
    s.setActiveCode('005930');
    s.add({ id: 'a', kind: 'hline', price: 1000,
            color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle' });
    const before = { ...useDrawingsStore.getState().defaults };
    s.update('a', { price: 1500 });
    expect(useDrawingsStore.getState().defaults).toEqual(before);
  });
});
