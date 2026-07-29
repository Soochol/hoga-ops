import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';

/** 창 식별자. `null` = Provider 밖(= `/study`·단일 차트) — 유효한 스코프 키다. */
export type RegistryScopeId = string | null;

/** 스코프 미스에 돌려줄 **고정** 빈 Map. 매번 새 Map 을 만들면 셀렉터가 항상 새
 *  참조를 뱉어, 등록이 하나도 없는 창까지 매 스토어 변경에 재렌더된다. */
const EMPTY_SCOPE: ReadonlyMap<unknown, unknown> = new Map<unknown, unknown>();

export interface WindowScopedRegistry<K, V> {
  byScope: ReadonlyMap<RegistryScopeId, ReadonlyMap<K, V>>;
  register: (scope: RegistryScopeId, key: K, value: V) => void;
  unregister: (scope: RegistryScopeId, key: K) => void;
  /** 창 언마운트 정리 — 그 창의 등록을 통째로 버린다. */
  clearScope: (scope: RegistryScopeId) => void;
}

/**
 * 창별로 격리된 레지스트리 스토어를 만든다.
 *
 * **왜 필요한가**: MA·일봉MA·pane 레전드 레지스트리는 슬롯 id(`'ma-1'`, `'candle'` …)
 * 라는 **고정 문자열**을 키로 썼다. 그 키는 창마다 같으므로 차트 창이 둘 이상이면
 *  ① 창 B 의 마운트가 창 A 의 엔트리를 덮어써 A 의 레전드가 B 종목 값을 보여주고,
 *  ② 창 A 의 언마운트가 B 의 살아 있는 엔트리를 지워 B 의 레전드가 영구 공백이 된다
 *     (B 의 reconcile effect 는 config 가 바뀌기 전엔 다시 안 돈다).
 * 창 스코프를 키에 넣으면 두 경로가 함께 사라진다. `flagLegendValueRegistry` 가
 * 같은 문제를 먼저 이 형태로 풀었고(#706), 이 세 개만 누락돼 있었다.
 *
 * **재렌더 팬아웃도 같이 잡는다**: 등록은 해당 스코프의 안쪽 Map 만 새로 만들고 다른
 * 스코프의 참조는 그대로 둔다. 소비자가 `scopeEntries(s.byScope, myScope)` 로 자기
 * 스코프만 고르면, 남의 창에서 일어난 등록에는 **같은 참조**가 돌아와 zustand 가
 * 재렌더를 건너뛴다. 종전엔 어느 창의 series reconcile 이든 열린 모든 창의
 * PaneLegendOverlay 를 깨웠다(창 수 N 에 대해 O(N)).
 */
export function createWindowScopedRegistry<K, V>(): UseBoundStore<
  StoreApi<WindowScopedRegistry<K, V>>
> {
  return create<WindowScopedRegistry<K, V>>((set, get) => ({
    byScope: new Map(),

    register: (scope, key, value) => {
      const outer = get().byScope;
      const inner = new Map(outer.get(scope) ?? []);
      inner.set(key, value);
      const next = new Map(outer);
      next.set(scope, inner);
      set({ byScope: next });
    },

    unregister: (scope, key) => {
      const outer = get().byScope;
      const inner = outer.get(scope);
      if (!inner?.has(key)) return;
      const nextInner = new Map(inner);
      nextInner.delete(key);
      const next = new Map(outer);
      if (nextInner.size === 0) next.delete(scope);
      else next.set(scope, nextInner);
      set({ byScope: next });
    },

    clearScope: (scope) => {
      const outer = get().byScope;
      if (!outer.has(scope)) return;
      const next = new Map(outer);
      next.delete(scope);
      set({ byScope: next });
    },
  }));
}

/** 한 스코프의 등록만 고른다. 미스면 고정 빈 Map — 참조가 안정적이라 재렌더를 안 만든다. */
export function scopeEntries<K, V>(
  byScope: ReadonlyMap<RegistryScopeId, ReadonlyMap<K, V>>,
  scope: RegistryScopeId,
): ReadonlyMap<K, V> {
  return byScope.get(scope) ?? (EMPTY_SCOPE as unknown as ReadonlyMap<K, V>);
}
