/** Subscribe-side persistence helper. Owns the debounce timer, the
 *  `localStorage.setItem` call, and silent-failure semantics. Load is the
 *  caller's responsibility — each store's snapshot shape differs and
 *  validation lives next to its schema. */

export type SubscribableStore<TState> = {
  subscribe(listener: (state: TState) => void): () => void;
};

export type PersistenceOptions<TState> = {
  /** localStorage key. Versioning lives in the key (e.g. `replay.tabs.v1`). */
  storageKey: string;
  /** Pure projection from store state to a JSON-serializable snapshot. */
  toSnapshot: (state: TState) => unknown;
  /** Debounce window for coalescing rapid writes. Default 250 ms. */
  debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 250;

/** Subscribes to `store`; debounce-writes `toSnapshot(state)` to
 *  `localStorage[storageKey]` on every state change. Returns the
 *  unsubscribe function. Callers wire HMR dispose:
 *
 *  ```ts
 *  const unsubscribe = attachPersistence(useFooStore, { ... });
 *  if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
 *  ```
 *
 *  Silent on quota / SSR / serialization throw — matches the previous
 *  `savePersisted` policy in `tabsPersistence.ts` / `replayLayout.ts`. */
export function attachPersistence<TState>(
  store: SubscribableStore<TState>,
  options: PersistenceOptions<TState>,
): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const unsubscribeStore = store.subscribe((state) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (typeof localStorage === 'undefined') return;
      try {
        const snapshot = options.toSnapshot(state);
        localStorage.setItem(options.storageKey, JSON.stringify(snapshot));
      } catch {
        /* quota / private mode / serialization — silently ignore */
      }
    }, debounceMs);
  });

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribeStore();
  };
}
