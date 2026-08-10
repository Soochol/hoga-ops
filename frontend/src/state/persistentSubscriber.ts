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
 *  per-store save policy in `tabsPersistence.ts` / `replayLayout.ts`. */
export function attachPersistence<TState>(
  store: SubscribableStore<TState>,
  options: PersistenceOptions<TState>,
): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 직전에 실제로 쓴 문자열 — 같은 값의 재기록을 건너뛴다.
   *
   *  단순한 절약이 아니라 **크로스탭 에코를 끊는 장치**다. 다른 탭의 storage
   *  이벤트를 받아 재수화하면 그 setState 가 이 구독을 깨워 같은 값을 되쓰고,
   *  그 쓰기가 상대 탭에 다시 이벤트를 보낸다(브라우저는 값이 같아도 storage
   *  이벤트를 발생시킨다). 여기서 한 홉이 끊기면 왕복이 수렴한다. */
  let lastWritten: string | null = null;

  const unsubscribeStore = store.subscribe((state) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (typeof localStorage === 'undefined') return;
      try {
        const serialized = JSON.stringify(options.toSnapshot(state));
        if (serialized === lastWritten) return;
        lastWritten = serialized;
        localStorage.setItem(options.storageKey, serialized);
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
