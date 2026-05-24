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

describe('attachPersistence — unsubscribe + silent failure', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('unsubscribe cancels a pending write', () => {
    const store = makeFakeStore({ a: 0 });
    const unsub = attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
    });
    store.setState({ a: 1 });
    unsub();
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem('test.k')).toBeNull();
  });

  it('unsubscribe is idempotent', () => {
    const store = makeFakeStore({ a: 0 });
    const unsub = attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
    });
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });

  it('unsubscribe detaches the listener (no further writes)', () => {
    const store = makeFakeStore({ a: 0 });
    const unsub = attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
    });
    unsub();
    store.setState({ a: 99 });
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem('test.k')).toBeNull();
  });

  it('silently swallows setItem throw (quota / private mode)', () => {
    const store = makeFakeStore({ a: 0 });
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    attachPersistence(store, { storageKey: 'test.k', toSnapshot: (s) => s });
    store.setState({ a: 1 });
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(setItemSpy).toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('silently swallows toSnapshot throw', () => {
    const store = makeFakeStore({ a: 0 });
    attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: () => { throw new Error('boom'); },
    });
    store.setState({ a: 1 });
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(localStorage.getItem('test.k')).toBeNull();
  });

  it('silently no-ops when localStorage is undefined (SSR)', () => {
    const store = makeFakeStore({ a: 0 });
    const orig = globalThis.localStorage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).localStorage;
    try {
      expect(() => {
        attachPersistence(store, { storageKey: 'test.k', toSnapshot: (s) => s });
        store.setState({ a: 1 });
        vi.advanceTimersByTime(250);
      }).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true });
    }
  });
});
