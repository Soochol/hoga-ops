import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachPersistence } from './persistentSubscriber';
import type { SubscribableStore } from './persistentSubscriber';

describe('persistentSubscriber — module scaffold', () => {
  it('exports attachPersistence as a function', () => {
    expect(typeof attachPersistence).toBe('function');
  });
});

function makeFakeStore<T>(initial: T): SubscribableStore<T> & { setState(next: T): void } {
  let state = initial;
  const listeners = new Set<(s: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState(next) {
      state = next;
      listeners.forEach((l) => l(state));
    },
  };
}

describe('attachPersistence — debounce + write', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('writes a JSON snapshot after the default 250 ms debounce', () => {
    const store = makeFakeStore({ a: 1 });
    attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => ({ a: s.a }),
    });
    store.setState({ a: 2 });
    expect(localStorage.getItem('test.k')).toBeNull();
    vi.advanceTimersByTime(249);
    expect(localStorage.getItem('test.k')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(JSON.parse(localStorage.getItem('test.k')!)).toEqual({ a: 2 });
  });

  it('respects custom debounceMs', () => {
    const store = makeFakeStore({ a: 0 });
    attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
      debounceMs: 50,
    });
    store.setState({ a: 1 });
    vi.advanceTimersByTime(50);
    expect(JSON.parse(localStorage.getItem('test.k')!)).toEqual({ a: 1 });
  });

  it('coalesces bursts into a single write with the latest state', () => {
    const store = makeFakeStore({ a: 0 });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
    });
    store.setState({ a: 1 });
    vi.advanceTimersByTime(100);
    store.setState({ a: 2 });
    vi.advanceTimersByTime(100);
    store.setState({ a: 3 });
    expect(setItemSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('test.k')!)).toEqual({ a: 3 });
    setItemSpy.mockRestore();
  });
});
