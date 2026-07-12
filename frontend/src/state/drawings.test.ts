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

describe('useDrawingsStore — undo/redo (ADR-0107)', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveCode(A);
  });

  it('undo reverts add; redo re-applies it', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    expect(s().drawingsFor(A)).toHaveLength(1);
    s().undo();
    expect(s().drawingsFor(A)).toHaveLength(0);
    s().redo();
    expect(s().drawingsFor(A)).toHaveLength(1);
    expect((s().drawingsFor(A)[0] as { price: number }).price).toBe(100);
  });

  it('undo reverts remove and clearAll', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    s().add(mkHline('h2', 200));
    s().remove('h1');
    expect(s().drawingsFor(A)).toHaveLength(1);
    s().undo();
    expect(s().drawingsFor(A)).toHaveLength(2);
    s().clearAll();
    expect(s().drawingsFor(A)).toHaveLength(0);
    s().undo();
    expect(s().drawingsFor(A)).toHaveLength(2);
  });

  it('a new mutation clears the redo stack', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    s().undo();
    expect(s().drawingsFor(A)).toHaveLength(0);
    s().add(mkHline('h2', 200)); // new mutation → redo dropped
    s().redo(); // no-op
    expect(s().drawingsFor(A)).toHaveLength(1);
    expect((s().drawingsFor(A)[0] as { id: string }).id).toBe('h2');
  });

  it('consecutive same-target updates collapse into one undo step', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    // Simulate a drag: many updates to the same id in quick succession.
    for (let p = 101; p <= 130; p++) s().update('h1', { price: p } as Partial<Drawing>);
    expect((s().drawingsFor(A)[0] as { price: number }).price).toBe(130);
    // One undo should return to the pre-drag price (the add), not step through
    // every intermediate frame.
    s().undo();
    expect((s().drawingsFor(A)[0] as { price: number }).price).toBe(100);
  });

  it('undo is per-code and a no-op with empty history', () => {
    const s = () => useDrawingsStore.getState();
    s().undo(); // empty → no throw, no change
    expect(s().drawingsFor(A)).toHaveLength(0);
    s().add(mkHline('a1', 1));
    s().setActiveCode(B);
    s().undo(); // B has no history → does not touch A
    expect(s().drawingsFor(A)).toHaveLength(1);
    expect(s().drawingsFor(B)).toHaveLength(0);
  });

  it('undo clears selection when the selected id disappears', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    s().setSelected('h1');
    s().undo(); // h1 removed by undo → selection must clear
    expect(s().selectedId).toBeNull();
  });

  it('undo/redo persist to localStorage', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    s().undo();
    s().flushPending();
    expect(JSON.parse(localStorage.getItem('replay.drawings.v1.005930') as string))
      .toEqual({ v: 1, items: [] });
  });
});

describe('useDrawingsStore — clearAll undo-toast', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveCode(A);
  });

  it('clearAll on an empty list is a no-op and shows no toast', () => {
    const s = () => useDrawingsStore.getState();
    s().clearAll();
    expect(s().clearToast).toBeNull();
  });

  it('clearAll surfaces a toast with the pre-clear snapshot', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    s().add(mkHline('h2', 200));
    s().clearAll();
    expect(s().clearToast).toMatchObject({ code: A, count: 2 });
    expect(s().clearToast?.snapshot).toHaveLength(2);
  });

  it('restore brings back the snapshot and is itself undoable', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    s().clearAll();
    const snap = s().clearToast!.snapshot;
    s().restore(A, snap);
    expect(s().drawingsFor(A)).toHaveLength(1);
    s().undo(); // undo the restore
    expect(s().drawingsFor(A)).toHaveLength(0);
  });

  it('restore targets the given code even after switching away', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    s().clearAll();
    const snap = s().clearToast!.snapshot;
    s().setActiveCode(B); // user navigates away while the toast is up
    s().restore(A, snap);
    expect(s().drawingsFor(A)).toHaveLength(1);
  });

  it('dismissClearToast clears the slot', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('h1', 100));
    s().clearAll();
    s().dismissClearToast();
    expect(s().clearToast).toBeNull();
  });
});

describe('useDrawingsStore — importDrawings', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveCode(A);
  });

  it('appends imported items with fresh ids as one undoable step', () => {
    const s = () => useDrawingsStore.getState();
    s().add(mkHline('existing', 100));
    const n = s().importDrawings([mkHline('existing', 200), mkHline('existing', 300)]);
    expect(n).toBe(2);
    const items = s().drawingsFor(A);
    expect(items).toHaveLength(3);
    // ids were reassigned — no collision with the pre-existing 'existing'.
    expect(new Set(items.map((d) => d.id)).size).toBe(3);
    // one undo removes the whole import
    s().undo();
    expect(s().drawingsFor(A)).toHaveLength(1);
  });

  it('is a no-op with an empty list', () => {
    const s = () => useDrawingsStore.getState();
    expect(s().importDrawings([])).toBe(0);
    expect(s().drawingsFor(A)).toHaveLength(0);
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
    expect(useDrawingsStore.getState().defaults).toMatchObject({
      color: '#10B981', width: 3, lineStyle: 'dashed',
    });
  });

  it('update(id, {fontSize}) syncs the text size into defaults (sticky)', () => {
    const s = useDrawingsStore.getState();
    s.setActiveCode('005930');
    s.add({
      id: 't', kind: 'text', at: { realMs: 1_700_000_000_000, price: 1000 },
      text: 'hi', fontSize: 13, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    });
    s.update('t', { fontSize: 20 } as Partial<Drawing>);
    expect(useDrawingsStore.getState().defaults.fontSize).toBe(20);
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
