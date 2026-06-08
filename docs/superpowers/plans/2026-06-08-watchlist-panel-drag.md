# 관심종목 패널 드래그 재정렬(폴더 인지) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관심종목 사이드패널에서 같은 그룹 내 종목을 마우스 드래그로 재정렬하고, 그룹(폴더)도 드래그로 재정렬할 수 있게 한다.

**Architecture:** `WatchlistDrawer`의 스크롤 영역을 단일 `<DndContext>`로 감싸고, 그 안에 폴더 순서용 바깥 `SortableContext` 1개와 그룹별 종목용 안쪽 `SortableContext` N개를 중첩한다. 각 sortable은 `data.type`(`'folder'|'entry'`)으로 태깅하고 `onDragEnd`에서 분기한다. 그룹 간 이동은 범위 밖(`resolveDrag`에 액티브 그룹만 넘겨 구조적으로 차단). `QuoteRow`의 기존 드래그 props·`resolveDrag`·낙관적 `reorderEntries`를 재사용하고, 폴더용 `resolveFolderDrag`/`applyFolderReorder`를 신설해 `useReorderFolders`를 낙관적으로 전환한다.

**Tech Stack:** React + TypeScript, `@dnd-kit/core` `@dnd-kit/sortable` `@dnd-kit/utilities`, `@tanstack/react-query`, Vitest(jsdom) + Playwright(e2e), Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-08-watchlist-panel-drag-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `frontend/src/watchlist/dragHandlers.ts` | 드래그 → 결과 codec(순수). `resolveDrag`(엔트리) + 신규 `resolveFolderDrag`(폴더) | 수정 |
| `frontend/src/watchlist/dragHandlers.test.ts` | 위 codec 단위 테스트 | 수정 |
| `frontend/src/watchlist/useWatchlist.ts` | react-query 훅 + 낙관적 reshape. `applyFolderReorder` 신설, `useReorderFolders` 낙관적 전환 | 수정 |
| `frontend/src/watchlist/useWatchlist.folders.optimistic.test.tsx` | 폴더 재정렬 낙관적+롤백 훅 테스트 | 생성 |
| `frontend/src/watchlist/WatchlistDrawer.tsx` | 패널 UI. DnD 배선 + `SortableGroup`/`SortableQuoteRow` 모듈 컴포넌트 + `GroupHeader` 드래그 핸들 | 수정 |
| `frontend/src/watchlist/WatchlistDrawer.drag.test.tsx` | onDragEnd wiring contract(dnd-kit passthrough 모킹, ADR-0057 철학) | 생성 |
| `frontend/src/rightrail/QuoteRow.tsx` | 공용 행. 기존 드래그 props 보유 | **무변경** |
| `frontend/tests/e2e/watchlist-panel-drag.spec.ts` | 실 포인터 드래그 e2e(행 재정렬 + 그룹 재정렬) | 생성 |
| `docs/adr/0066-watchlist-panel-drag-return.md` | 패널 드래그 복귀 결정 기록 | 생성 |
| `docs/adr/0057-watchlist-reorder-test-surface.md` | stale 서술 갱신 | 수정 |
| `CONTEXT.md` | Watchlist Panel 설명(155행) 갱신 | 수정 |

**테스트 실행:** vitest는 `package.json`에 `test` 스크립트가 없고 `vite.config.ts`에 설정됨 → `cd frontend && npx vitest run <path>`. e2e는 `cd frontend && npx playwright test <path>`.

---

## Task 0: 워크트리 의존성 설치

**Files:** 없음(환경 준비)

- [ ] **Step 1: node_modules 설치**

새 워크트리는 `node_modules`가 비어 있다(CLAUDE.md). 한 번만 설치:

Run: `cd frontend && npm install`
Expected: 설치 완료, `vite`/`vitest` 바이너리 사용 가능.

- [ ] **Step 2: 기준 테스트 통과 확인(baseline)**

Run: `cd frontend && npx vitest run src/watchlist/`
Expected: PASS (현재 watchlist 단위/통합 테스트 전부 통과 — 회귀 기준선).

---

## Task 1: `resolveFolderDrag` 순수 헬퍼

폴더를 임의 위치로 옮긴 전체 id 순서를 만든다. 기존 `swapFolderOrder`(grouping.ts, ⋯ 메뉴용 한 칸 swap)와 달리 드래그의 임의 거리 이동을 지원. `resolveDrag`와 같은 파일.

**Files:**
- Modify: `frontend/src/watchlist/dragHandlers.ts`
- Test: `frontend/src/watchlist/dragHandlers.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/watchlist/dragHandlers.test.ts` 상단 import에 `resolveFolderDrag`를 추가하고, 파일 끝에 describe 블록을 추가한다.

import 줄 수정:
```ts
import { resolveDrag, resolveFolderDrag } from './dragHandlers';
```

파일 끝에 추가:
```ts
describe('resolveFolderDrag', () => {
  const ids = ['f_a', 'f_b', 'f_c'];
  it('reorders the folder id list (arrayMove)', () => {
    expect(resolveFolderDrag(ids, 'f_c', 'f_a'))
      .toEqual({ kind: 'reorder', orderedIds: ['f_c', 'f_a', 'f_b'] });
  });
  it('moves a middle folder down', () => {
    expect(resolveFolderDrag(ids, 'f_a', 'f_c'))
      .toEqual({ kind: 'reorder', orderedIds: ['f_b', 'f_c', 'f_a'] });
  });
  it('no-op on self or unknown id', () => {
    expect(resolveFolderDrag(ids, 'f_a', 'f_a')).toEqual({ kind: 'none' });
    expect(resolveFolderDrag(ids, 'f_a', 'f_zzz')).toEqual({ kind: 'none' });
    expect(resolveFolderDrag(ids, 'f_zzz', 'f_a')).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/dragHandlers.test.ts`
Expected: FAIL — `resolveFolderDrag is not a function` (또는 import 에러).

- [ ] **Step 3: 구현**

`frontend/src/watchlist/dragHandlers.ts` 끝에 추가 (`arrayMove`는 1행에서 이미 import됨):
```ts
export type FolderDragResult = { kind: 'reorder'; orderedIds: string[] } | { kind: 'none' };

/** activeId 폴더를 overId 폴더 위치로 옮긴 전체 id 순서. arrayMove 기반(임의 위치 이동).
 *  기존 swapFolderOrder(grouping.ts)는 ⋯ 메뉴의 한 칸 swap 전용이라 드래그엔 부적합 —
 *  드래그는 임의 거리이므로 resolveDrag(엔트리)와 대칭인 arrayMove 헬퍼를 따로 둔다. */
export function resolveFolderDrag(
  orderedIds: string[],
  activeId: string,
  overId: string,
): FolderDragResult {
  const from = orderedIds.indexOf(activeId);
  const to = orderedIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return { kind: 'none' };
  return { kind: 'reorder', orderedIds: arrayMove(orderedIds, from, to) };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/watchlist/dragHandlers.test.ts`
Expected: PASS (resolveDrag 기존 케이스 + resolveFolderDrag 신규 케이스 전부).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/watchlist/dragHandlers.ts frontend/src/watchlist/dragHandlers.test.ts
git commit -m "feat(watchlist): resolveFolderDrag — 폴더 임의 위치 드래그 재정렬 codec"
```

---

## Task 2: 폴더 재정렬 낙관적 경로

`useReorderFolders`를 invalidate-only에서 낙관적+롤백으로 전환한다. 기존 제네릭 훅 `useOptimisticEntryMutation`을 `useOptimisticWatchlistMutation`으로 일반화(엔트리/폴더 공용)하고 `applyFolderReorder`를 추가한다. (useWatchlist.ts:141–143의 "folder-DnD 도입 시 병렬 path 필요" 연기 주석을 해소.)

**Files:**
- Modify: `frontend/src/watchlist/useWatchlist.ts`
- Test: `frontend/src/watchlist/useWatchlist.folders.optimistic.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/watchlist/useWatchlist.folders.optimistic.test.tsx` 생성:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WATCHLIST_KEY } from './watchlistKeys';
import { useReorderFolders } from './useWatchlist';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const seed = (qc: QueryClient) =>
  qc.setQueryData(WATCHLIST_KEY, {
    next_run_at_ms: 0, entries: [],
    folders: [
      { id: 'f_a', name: '스윙', order: 0 },
      { id: 'f_b', name: '장기', order: 1 },
      { id: 'f_c', name: '단타', order: 2 },
    ],
  });

const orderOf = (qc: QueryClient) => {
  const d = qc.getQueryData(WATCHLIST_KEY) as api.WatchlistResponse;
  return [...d.folders].sort((a, b) => a.order - b.order).map((f) => f.id);
};

describe('useReorderFolders (optimistic)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reorders the cached folders before the request resolves', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    let resolve!: () => void;
    vi.spyOn(api, 'reorderFolders').mockReturnValue(new Promise<void>((r) => { resolve = () => r(); }));
    const { result } = renderHook(() => useReorderFolders(), { wrapper: wrap(qc) });
    result.current.mutate(['f_c', 'f_a', 'f_b']);
    await waitFor(() => expect(orderOf(qc)).toEqual(['f_c', 'f_a', 'f_b']));
    resolve();
  });

  it('rolls back the optimistic cache when the request rejects', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    vi.spyOn(api, 'reorderFolders').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useReorderFolders(), { wrapper: wrap(qc) });
    result.current.mutate(['f_c', 'f_a', 'f_b']);
    // 낙관적으로 c,a,b 로 뒤집힌 뒤 onError가 ctx.prev(a,b,c)로 복원
    await waitFor(() => expect(orderOf(qc)).toEqual(['f_a', 'f_b', 'f_c']));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/useWatchlist.folders.optimistic.test.tsx`
Expected: FAIL — 현재 `useReorderFolders`는 invalidate-only라 낙관적 reshape이 일어나지 않음(첫 테스트 timeout/불일치).

- [ ] **Step 3: 구현 — `applyFolderReorder` 추가**

`frontend/src/watchlist/useWatchlist.ts`에서 `applyMove` 함수 정의 바로 다음(현재 112행 근처)에 추가:
```ts
function applyFolderReorder(data: WatchlistResponse, orderedIds: string[]): WatchlistResponse {
  const rank = new Map(orderedIds.map((id, i) => [id, i] as const));
  return {
    ...data,
    folders: data.folders.map((f) => (rank.has(f.id) ? { ...f, order: rank.get(f.id)! } : f)),
  };
}
```

- [ ] **Step 4: 구현 — 제네릭 훅 일반화 + `useReorderFolders` 전환**

같은 파일에서 제네릭 훅 이름을 일반화한다(엔트리 전용이 아니므로). `useOptimisticEntryMutation` 정의를 다음으로 교체:
```ts
function useOptimisticWatchlistMutation<V>(
  mutationFn: (v: V) => Promise<void>,
  apply: (d: WatchlistResponse, v: V) => WatchlistResponse,
) {
  const qc = useQueryClient();
  return useMutation<void, Error, V, { prev?: WatchlistResponse }>({
    mutationFn,
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: WATCHLIST_KEY });
      const prev = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY);
      if (prev) qc.setQueryData(WATCHLIST_KEY, apply(prev, v));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(WATCHLIST_KEY, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY }),
  });
}
```

두 기존 호출부(`useReorderEntries`, `useMoveEntries`)의 이름을 새 이름으로 갱신:
```ts
export function useReorderEntries() {
  return useOptimisticWatchlistMutation<ReorderVars>(
    (v) => reorderEntries(v.folderId, v.orderedCodes), applyReorder);
}
export function useMoveEntries() {
  return useOptimisticWatchlistMutation<MoveVars>(
    (v) => moveEntries(v.codes, v.folderId), applyMove);
}
```

기존 비낙관적 `useReorderFolders`(현재 144–150행, 위의 141–143 주석 포함)를 다음으로 교체:
```ts
// folder reorder: optimistic + rollback (folder-DnD 부드러움). 엔트리와 같은 제네릭 경로.
export function useReorderFolders() {
  return useOptimisticWatchlistMutation<string[]>(
    (orderedIds) => reorderFolders(orderedIds), applyFolderReorder);
}
```

- [ ] **Step 5: 통과 확인 + 회귀**

Run: `cd frontend && npx vitest run src/watchlist/useWatchlist.folders.optimistic.test.tsx src/watchlist/useWatchlist.optimistic.test.tsx`
Expected: PASS (신규 폴더 낙관적 2건 + 기존 엔트리 낙관적 2건 — 이름 변경 후에도 동작).

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/watchlist/useWatchlist.ts frontend/src/watchlist/useWatchlist.folders.optimistic.test.tsx
git commit -m "feat(watchlist): useReorderFolders 낙관적 전환 + applyFolderReorder"
```

---

## Task 3: 패널 종목 행 드래그(그룹 내 재정렬)

`WatchlistDrawer`에 `DndContext` + 그룹별 `SortableContext`를 도입하고, `SortableQuoteRow`(행 전체 드래그)와 `onDragEnd`의 엔트리 분기를 배선한다. wiring contract는 dnd-kit passthrough 모킹으로 검증(ADR-0057).

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.drag.test.tsx` (생성)

- [ ] **Step 1: 실패하는 wiring 테스트 작성**

`frontend/src/watchlist/WatchlistDrawer.drag.test.tsx` 생성:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';
import { useLivePageStore } from '../state/livePage';

// ADR-0057: 패널 드래그의 wiring contract만 검증 — 실제 dnd-kit 포인터/충돌은 e2e가 담당.
// DndContext를 passthrough로 모킹해 주입된 onDragEnd를 캡처하고, useSortable은 no-op으로 둔다.
const h = vi.hoisted(() => ({ onDragEnd: null as null | ((e: unknown) => void) }));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (e: unknown) => void }) => {
      h.onDragEnd = onDragEnd;
      return <>{children}</>;
    },
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
  };
});
vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
      setNodeRef: () => {}, listeners: {}, attributes: {},
      transform: null, transition: undefined, isDragging: false,
    }),
  };
});

import { WatchlistDrawer } from './WatchlistDrawer';

const FOLDERS = [
  { id: 'f_0000000a', name: '스윙', order: 0 },
  { id: 'f_0000000b', name: '장기', order: 1 },
];
const ENTRIES = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
];
const DATA = { folders: FOLDERS, entries: ENTRIES, next_run_at_ms: 0 };

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('WatchlistDrawer drag wiring', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    h.onDragEnd = null;
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
  });

  it('entry-drag onDragEnd → reorderEntries(folderId, orderedCodes)', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    h.onDragEnd!({
      active: { id: '005930', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
      over: { id: '000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('f_0000000a', ['000660', '005930']));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.drag.test.tsx`
Expected: FAIL — `h.onDragEnd` 가 null(아직 DndContext 미배선) → `h.onDragEnd!(...)` 호출에서 TypeError.

- [ ] **Step 3: 구현 — imports 추가**

`frontend/src/watchlist/WatchlistDrawer.tsx` 상단 import 블록에 추가:
```ts
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WatchlistEntry } from '../api/watchlist';
```
그리고 기존 `useWatchlist` import 목록(5–8행)에 `useReorderEntries`를 추가:
```ts
import {
  useWatchlist, useCatchupAll, useRemoveFromWatchlist,
  useCreateFolder, useRenameFolder, useDeleteFolder, useReorderFolders, useMoveEntries,
  useReorderEntries,
} from './useWatchlist';
```
그리고 `resolveDrag`를 import:
```ts
import { resolveDrag } from './dragHandlers';
```

- [ ] **Step 4: 구현 — `SortableQuoteRow` 모듈 컴포넌트 추가**

`WatchlistDrawer` 함수 정의 바로 위(모듈 스코프)에 추가:
```tsx
/** 패널 종목 행 — 행 전체가 드래그 표면(listeners on <li>). PointerSensor distance:5
 *  임계가 클릭(차트 이동)과 드래그를 구분한다. data.type='entry' + folderId 태깅으로
 *  onDragEnd가 폴더 드래그와 구분한다. */
function SortableQuoteRow(props: {
  entry: WatchlistEntry;
  price: number | null; pct: number | null; changeWon: number | null;
  active: boolean;
  onPick: () => void;
  onContextMenu: (e: React.MouseEvent<HTMLLIElement>) => void;
  onDelete: () => void;
}) {
  const { entry } = props;
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: entry.code, data: { type: 'entry', folderId: entry.folder_id } });
  return (
    <QuoteRow
      name={entry.name}
      price={props.price}
      pct={props.pct}
      changeWon={props.changeWon}
      active={props.active}
      ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
      testId={`watchlist-row-${entry.code}`}
      onClick={props.onPick}
      onContextMenu={props.onContextMenu}
      onDelete={props.onDelete}
      indented
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragListeners={listeners}
      dragging={isDragging}
    />
  );
}
```

- [ ] **Step 5: 구현 — sensors + onDragEnd(엔트리) 추가**

`WatchlistDrawer` 본문에서 `moveFolder` 정의(현재 190–193행) 바로 다음에 추가:
```tsx
  const reorderEntriesM = useReorderEntries();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Task 4에서 폴더 분기가 앞에 추가된다.
  const onDragEnd = (ev: DragEndEvent) => {
    if (!ev.over) return;
    const folderId = (ev.active.data.current?.folderId ?? null) as string | null;
    // 액티브 행이 속한 그룹의 종목만 넘긴다 — over가 다른 그룹 행이면 resolveDrag가
    // findIndex=-1 → {kind:'none'}을 반환해 그룹 간 이동이 구조적으로 차단된다.
    const group = (data?.entries ?? [])
      .filter((e) => e.folder_id === folderId)
      .sort((a, b) => a.order - b.order);
    const r = resolveDrag(group, folderId, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder') reorderEntriesM.mutate({ folderId: r.folderId, orderedCodes: r.orderedCodes });
  };
```

- [ ] **Step 6: 구현 — 스크롤 영역을 DndContext로 감싸고 행을 SortableContext로**

현재 스크롤 컨테이너 내부의 `{groups.map(...)}` 블록을 `<DndContext>`로 감싼다. 현재 구조(229행 `<div data-testid="watchlist-scroll" ...>` 내부):
- `{isLoading && ...}` `{error && ...}` `{빈 메시지}` 는 그대로 두고,
- `{groups.map((g, gi) => { ... })}` 만 `<DndContext>` 로 감싼다.

`{groups.map(...)}` 를 다음으로 교체:
```tsx
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          {groups.map((g, gi) => {
            const key = g.folder?.id ?? '__uncat__';
            const label = g.folder?.name ?? '미분류';
            if (g.entries.length === 0 && g.folder === null) return null; // 빈 미분류는 숨김
            const isCollapsed = collapsed.has(key);
            const folder = g.folder;
            return (
              <div key={key}>
                <GroupHeader label={label} count={g.entries.length} collapsed={isCollapsed}
                  onToggle={() => toggle(key)}
                  onRename={folder ? () => setRenameTarget({ id: folder.id, name: folder.name }) : undefined}
                  onDelete={folder ? () => deleteM.mutate(folder.id) : undefined}
                  onMoveUp={folder ? () => moveFolder(folder.id, -1) : undefined}
                  onMoveDown={folder ? () => moveFolder(folder.id, +1) : undefined}
                  canMoveUp={gi > 0}
                  canMoveDown={gi < folderCount - 1} />
                {!isCollapsed && (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    <SortableContext items={g.entries.map((e) => e.code)} strategy={verticalListSortingStrategy}>
                      {g.entries.map((entry) => {
                        const q = quoteByCode.get(entry.code);
                        return (
                          <SortableQuoteRow
                            key={entry.code}
                            entry={entry}
                            price={q?.price ?? null}
                            pct={q?.change_pct ?? null}
                            changeWon={q?.change_won ?? null}
                            active={entry.code === activeCode}
                            onPick={() => onPick(entry.code)}
                            onContextMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)}
                            onDelete={() => removeM.mutate(entry.code)}
                          />
                        );
                      })}
                    </SortableContext>
                  </ul>
                )}
              </div>
            );
          })}
        </DndContext>
```

(기존 `QuoteRow` import는 그대로 둔다 — `SortableQuoteRow`가 내부에서 사용.)

- [ ] **Step 7: wiring 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.drag.test.tsx`
Expected: PASS — entry-drag onDragEnd가 `reorderEntries('f_0000000a', ['000660','005930'])` 호출.

- [ ] **Step 8: 기존 패널 테스트 회귀 확인**

기존 `WatchlistDrawer.test.tsx`는 dnd-kit을 모킹하지 않고 실제 provider로 렌더한다 — 클릭/우클릭/Delete/접기 등 비-드래그 동작이 그대로여야 한다.

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: PASS (기존 전체 통과). 실패 시 `onClick`/`onContextMenu`가 `QuoteRow`에 정상 전달되는지(드래그 props 스프레드 순서) 점검.

- [ ] **Step 9: 타입체크 + 커밋**

Run: `cd frontend && npx tsc -b`
Expected: 타입 에러 없음.
```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.drag.test.tsx
git commit -m "feat(watchlist): 패널 그룹 내 종목 드래그 재정렬"
```

---

## Task 4: 패널 그룹(폴더) 드래그 재정렬

폴더 순서용 바깥 `SortableContext` + `SortableGroup`(그룹 블록 전체가 sortable 노드) + `GroupHeader`의 ⠿ 드래그 핸들을 추가하고, `onDragEnd`에 폴더 분기를 더한다. 미분류는 핸들/SortableContext 대상에서 제외(항상 맨 끝 불변식).

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.drag.test.tsx`

- [ ] **Step 1: 실패하는 폴더 wiring 테스트 추가**

`WatchlistDrawer.drag.test.tsx`의 describe 블록 안, 엔트리 테스트 다음에 추가:
```tsx
  it('folder-drag onDragEnd → reorderFolders(orderedIds)', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderFolders').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    h.onDragEnd!({
      active: { id: 'f_0000000a', data: { current: { type: 'folder' } } },
      over: { id: 'f_0000000b', data: { current: { type: 'folder' } } },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(['f_0000000b', 'f_0000000a']));
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.drag.test.tsx`
Expected: FAIL — onDragEnd에 folder 분기가 없어 `reorderFolders`가 호출되지 않음(엔트리 테스트는 계속 PASS).

- [ ] **Step 3: 구현 — imports 보강**

`WatchlistDrawer.tsx`의 dragHandlers import에 `resolveFolderDrag`를 추가하고, `@dnd-kit/core` import에서 `DraggableSyntheticListeners` 타입을 가져온다:
```ts
import { resolveDrag, resolveFolderDrag } from './dragHandlers';
```
`@dnd-kit/core` import 블록에 타입 추가:
```ts
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
  type DragEndEvent, type DraggableSyntheticListeners,
} from '@dnd-kit/core';
```

- [ ] **Step 4: 구현 — `SortableGroup` 모듈 컴포넌트 + 핸들 타입**

`SortableQuoteRow` 위(모듈 스코프)에 추가:
```tsx
/** 그룹 헤더에 부착할 드래그 핸들 — listeners만(포인터 전용; KeyboardSensor 미도입,
 *  편집 모달 ⠿ 핸들과 동일 계약). */
type GroupDragHandle = { listeners: DraggableSyntheticListeners };

/** 폴더(그룹)의 sortable 단위 = 그룹 블록 전체(헤더 + 종목들). setNodeRef/transform은
 *  컨테이너 div에, listeners는 children render-prop으로 헤더 ⠿ 핸들에 전달한다 —
 *  핸들을 잡으면 그룹이 통째로 움직인다. data.type='folder'로 태깅. */
function SortableGroup({ folderId, children }: {
  folderId: string;
  children: (handle: GroupDragHandle) => React.ReactNode;
}) {
  const { setNodeRef, transform, transition, listeners, isDragging } =
    useSortable({ id: folderId, data: { type: 'folder' } });
  return (
    <div ref={setNodeRef} data-testid={`watchlist-group-${folderId}`}
      style={{
        transform: CSS.Transform.toString(transform), transition,
        ...(isDragging ? { opacity: 0.6, position: 'relative', zIndex: 1 } : {}),
      }}>
      {children({ listeners })}
    </div>
  );
}
```

- [ ] **Step 5: 구현 — `GroupHeader`에 드래그 핸들 prop 추가**

`GroupHeader`의 props 타입에 `dragHandle?: GroupDragHandle;` 을 추가하고, 헤더 `<div>`의 **첫 자식**(chevron 버튼 앞)에 핸들 span을 렌더한다. 현재 헤더 컨테이너 div(72행) 바로 안쪽, chevron 버튼(73행) 앞에 추가:
```tsx
      {props.dragHandle && (
        // 그룹 드래그 핸들 — hover/focus 시 노출(⋯ 메뉴와 같은 관용구), 포인터 전용.
        // aria-hidden + listeners-only(편집 모달 ⠿ 행 핸들과 동일). 헤더 클릭(토글)과
        // 충돌하지 않게 핸들에만 listeners를 건다.
        <span {...props.dragHandle.listeners} aria-hidden data-testid="group-drag-handle"
          className="cursor-grab select-none touch-none px-1 leading-none text-fg-dimmer opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          ⠿
        </span>
      )}
```
props 타입 선언부에 추가(52–61행 props 객체 타입 안):
```tsx
  dragHandle?: GroupDragHandle;
```

- [ ] **Step 6: 구현 — onDragEnd 폴더 분기 + realFolderIds**

`WatchlistDrawer` 본문에서 `groups`/`folderCount` 정의(187–188행) 다음에 추가:
```tsx
  const realFolderIds = groups.filter((g) => g.folder).map((g) => g.folder!.id);
```
`onDragEnd`를 폴더 분기 포함으로 교체:
```tsx
  const onDragEnd = (ev: DragEndEvent) => {
    if (!ev.over) return;
    if (ev.active.data.current?.type === 'folder') {
      // over가 폴더 노드면 그 id, 대상 그룹의 *행*이면 행의 folderId로 정규화한다 —
      // closestCenter가 폴더 드래그 중 행을 최근접으로 고를 수 있어 over.id가 code일 수
      // 있다(그대로 두면 indexOf=-1 → no-op). 미분류(null) 위면 폴더 순서 변경 없음.
      const over = ev.over.data.current;
      const overFolderId = over?.type === 'folder'
        ? String(ev.over.id)
        : ((over?.folderId ?? null) as string | null);
      if (overFolderId == null) return;
      const fr = resolveFolderDrag(realFolderIds, String(ev.active.id), overFolderId);
      if (fr.kind === 'reorder') reorderFoldersM.mutate(fr.orderedIds);
      return;
    }
    const folderId = (ev.active.data.current?.folderId ?? null) as string | null;
    const group = (data?.entries ?? [])
      .filter((e) => e.folder_id === folderId)
      .sort((a, b) => a.order - b.order);
    const r = resolveDrag(group, folderId, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder') reorderEntriesM.mutate({ folderId: r.folderId, orderedCodes: r.orderedCodes });
  };
```
(`reorderFoldersM`은 이미 본문에 `const reorderFoldersM = useReorderFolders();`로 존재 — 147행.)

- [ ] **Step 7: 구현 — 폴더 그룹을 SortableGroup으로, 바깥 SortableContext로 감싸기**

Task 3에서 만든 `<DndContext>` 내부의 `{groups.map(...)}` 를 바깥 `SortableContext`로 감싸고, 실폴더 그룹은 `SortableGroup`으로 렌더한다. `<DndContext>` 내부를 다음으로 교체:
```tsx
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={realFolderIds} strategy={verticalListSortingStrategy}>
            {groups.map((g, gi) => {
              const key = g.folder?.id ?? '__uncat__';
              const label = g.folder?.name ?? '미분류';
              if (g.entries.length === 0 && g.folder === null) return null; // 빈 미분류는 숨김
              const isCollapsed = collapsed.has(key);
              const folder = g.folder;
              const entriesList = !isCollapsed && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  <SortableContext items={g.entries.map((e) => e.code)} strategy={verticalListSortingStrategy}>
                    {g.entries.map((entry) => {
                      const q = quoteByCode.get(entry.code);
                      return (
                        <SortableQuoteRow
                          key={entry.code}
                          entry={entry}
                          price={q?.price ?? null}
                          pct={q?.change_pct ?? null}
                          changeWon={q?.change_won ?? null}
                          active={entry.code === activeCode}
                          onPick={() => onPick(entry.code)}
                          onContextMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)}
                          onDelete={() => removeM.mutate(entry.code)}
                        />
                      );
                    })}
                  </SortableContext>
                </ul>
              );
              const renderHeader = (dragHandle?: GroupDragHandle) => (
                <GroupHeader label={label} count={g.entries.length} collapsed={isCollapsed}
                  onToggle={() => toggle(key)}
                  onRename={folder ? () => setRenameTarget({ id: folder.id, name: folder.name }) : undefined}
                  onDelete={folder ? () => deleteM.mutate(folder.id) : undefined}
                  onMoveUp={folder ? () => moveFolder(folder.id, -1) : undefined}
                  onMoveDown={folder ? () => moveFolder(folder.id, +1) : undefined}
                  canMoveUp={gi > 0}
                  canMoveDown={gi < folderCount - 1}
                  dragHandle={dragHandle} />
              );
              return folder ? (
                <SortableGroup key={key} folderId={folder.id}>
                  {(dragHandle) => (<>{renderHeader(dragHandle)}{entriesList}</>)}
                </SortableGroup>
              ) : (
                <div key={key}>{renderHeader()}{entriesList}</div>
              );
            })}
          </SortableContext>
        </DndContext>
```

- [ ] **Step 8: 폴더 wiring 테스트 통과 + 전체 drag 테스트**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.drag.test.tsx`
Expected: PASS (entry + folder 두 wiring 테스트).

- [ ] **Step 9: 기존 패널 테스트 회귀 + 타입체크**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx && npx tsc -b`
Expected: PASS + 타입 에러 없음. (특히 "그룹 헤더 ⋯ → 아래로 이동" 폴더 reorder 테스트가 낙관적 전환 후에도 `reorderFolders` 호출을 그대로 관측해야 함.)

- [ ] **Step 10: 커밋**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.drag.test.tsx
git commit -m "feat(watchlist): 패널 그룹(폴더) 드래그 재정렬 + ⠿ 핸들"
```

---

## Task 5: e2e — 실 포인터 드래그(행 + 그룹)

시스템 Chrome에서 실제 dnd-kit 드래그를 구동하고 `PUT` 바디 + 낙관적 DOM 재배치를 검증한다. 기존 `watchlist-edit-reorder.spec.ts` 패턴(stateful `page.route` mock).

**Files:**
- Create: `frontend/tests/e2e/watchlist-panel-drag.spec.ts`

- [ ] **Step 1: e2e 스펙 작성**

`frontend/tests/e2e/watchlist-panel-drag.spec.ts` 생성:
```ts
// 관심종목 패널 실 포인터 드래그 e2e — 행(그룹 내 재정렬) + 그룹(폴더 재정렬).
// 단위/통합(jsdom)이 의도적으로 모킹으로 비껴가는 실제 dnd-kit PointerSensor(5px
// activation) + closestCenter 층을 시스템 Chrome에서 구동한다. GET /api/watchlist mock은
// STATEFUL — PUT이 갱신한 순서를 echo해 invalidate-refetch가 스냅백하지 않는다.

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.use({ channel: 'chrome' });

const API = 'http://localhost:8000';

interface Entry {
  code: string; name: string; registered_at_kst_date: string;
  last_success_date: string | null; folder_id: string | null; order: number;
}
const NAMES: Record<string, string> = { '005930': '삼성전자', '000660': 'SK하이닉스' };

const json = (route: import('@playwright/test').Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function openPanel(page: import('@playwright/test').Page) {
  await page.goto('/live');
  const editMenuBtn = page.getByRole('button', { name: '관심종목 편집 메뉴' });
  if (!(await editMenuBtn.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  }
  await expect(editMenuBtn).toBeVisible();
}

test.describe('Watchlist panel drag', () => {
  test('그룹 내 행 드래그가 reorder를 PUT하고 낙관적으로 재배치된다', async ({ page }) => {
    await installLiveMocks(page);
    // 스윙(f_a)에 005930, 000660 — 그룹 내 2행.
    let order = ['005930', '000660'];
    let lastPut: { folder_id: string | null; ordered_codes: string[] } | null = null;
    const entries = (): Entry[] => [
      ...order.map((code, i) => ({
        code, name: NAMES[code], registered_at_kst_date: '20260527',
        last_success_date: null, folder_id: 'f_a', order: i,
      })),
    ];
    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    await page.route(`${API}/api/watchlist/reorder`, async (route) => {
      lastPut = JSON.parse(route.request().postData() || '{}');
      order = lastPut!.ordered_codes;
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(`${API}/api/watchlist`, (r) =>
      json(r, { folders: [{ id: 'f_a', name: '스윙', order: 0 }], entries: entries(), next_run_at_ms: 0 }));

    await openPanel(page);
    const codesInDom = () =>
      page.locator('[data-testid^="watchlist-row-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('watchlist-row-', '')));
    await expect.poll(codesInDom).toEqual(['005930', '000660']);

    // 첫 행(005930)을 둘째 행(000660) 위로 — 행 전체가 드래그 표면(핸들 없음).
    const from = await page.getByTestId('watchlist-row-005930').boundingBox();
    const to = await page.getByTestId('watchlist-row-000660').boundingBox();
    if (!from || !to) throw new Error('row has no bounding box');
    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;
    const ty = to.y + to.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });   // 5px activation 통과
    await page.mouse.move(fx, ty, { steps: 15 });
    await page.mouse.move(fx, ty + 2, { steps: 2 });
    await page.mouse.up();

    await expect.poll(() => lastPut?.ordered_codes ?? null).toEqual(['000660', '005930']);
    expect(lastPut!.folder_id).toBe('f_a');
    await expect.poll(codesInDom).toEqual(['000660', '005930']);
  });

  test('그룹 헤더 ⠿ 드래그가 folders/order를 PUT하고 그룹을 재배치한다', async ({ page }) => {
    await installLiveMocks(page);
    let folderOrder = ['f_a', 'f_b'];
    const FNAMES: Record<string, string> = { f_a: '스윙', f_b: '장기' };
    let lastPut: { ordered_ids: string[] } | null = null;
    const folders = () => folderOrder.map((id, i) => ({ id, name: FNAMES[id], order: i }));
    const entries: Entry[] = [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_a', order: 0 },
      { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_b', order: 0 },
    ];
    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    await page.route(`${API}/api/watchlist/folders/order`, async (route) => {
      lastPut = JSON.parse(route.request().postData() || '{}');
      folderOrder = lastPut!.ordered_ids;
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(`${API}/api/watchlist`, (r) =>
      json(r, { folders: folders(), entries, next_run_at_ms: 0 }));

    await openPanel(page);
    const groupsInDom = () =>
      page.locator('[data-testid^="watchlist-group-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('watchlist-group-', '')));
    await expect.poll(groupsInDom).toEqual(['f_a', 'f_b']);

    // 스윙(f_a) 그룹 핸들을 장기(f_b) 그룹 위로 드래그.
    const handle = await page.getByTestId('watchlist-group-f_a').getByTestId('group-drag-handle').boundingBox();
    const target = await page.getByTestId('watchlist-group-f_b').boundingBox();
    if (!handle || !target) throw new Error('handle/target has no bounding box');
    const fx = handle.x + handle.width / 2;
    const fy = handle.y + handle.height / 2;
    const ty = target.y + target.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });
    await page.mouse.move(fx, ty, { steps: 15 });
    await page.mouse.move(fx, ty + 2, { steps: 2 });
    await page.mouse.up();

    await expect.poll(() => lastPut?.ordered_ids ?? null).toEqual(['f_b', 'f_a']);
    await expect.poll(groupsInDom).toEqual(['f_b', 'f_a']);
  });
});
```

- [ ] **Step 2: e2e 실행**

Run: `cd frontend && npx playwright test tests/e2e/watchlist-panel-drag.spec.ts`
Expected: PASS (2 tests). 그룹 드래그가 불안정하면(핸들이 hover-노출 opacity-0) Risks의 정규화 로직과 핸들 boundingBox 확보를 점검. sticky 헤더 transform 이슈가 보이면 spec Risks 항목대로 후속.

- [ ] **Step 3: 커밋**

```bash
git add frontend/tests/e2e/watchlist-panel-drag.spec.ts
git commit -m "test(watchlist): 패널 드래그 e2e — 행/그룹 실 포인터 재정렬"
```

---

## Task 6: 문서 — 신규 ADR + ADR-0057 갱신 + 도메인 문서

**Files:**
- Create: `docs/adr/0066-watchlist-panel-drag-return.md`
- Modify: `docs/adr/0057-watchlist-reorder-test-surface.md`
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx` (도크스트링)
- Modify: `CONTEXT.md`

- [ ] **Step 1: 신규 ADR 작성**

`docs/adr/0066-watchlist-panel-drag-return.md` 생성:
```markdown
# 관심종목 패널 드래그 재정렬 복귀 (폴더 인지)

v0.5.5.0에서 폴더 도입과 함께 제거됐던 패널 드래그(평면 `PUT /api/watchlist/order`)를,
폴더를 인지하는 형태로 사이드패널에 되돌린다. 패널에서 ① 같은 그룹 내 종목 드래그
재정렬(`PUT /api/watchlist/reorder`), ② 그룹(폴더) 드래그 재정렬(`PUT
/api/watchlist/folders/order`)을 지원한다. 그룹 *간* 이동은 의도적으로 범위 밖 —
우클릭 "그룹으로 이동"과 편집 모달이 담당한다.

## 구조

단일 `DndContext`(편집 모달과 동일 패턴, 컨텍스트 중첩 회피) 안에 폴더 순서용 바깥
`SortableContext` 1개 + 그룹별 종목용 안쪽 `SortableContext` N개를 중첩한다. 각
sortable은 `useSortable({ data: { type: 'folder' | 'entry', folderId } })`로 태깅하고
`onDragEnd`가 `active.data.type`으로 분기한다. "그룹 내 한정"은 가드 코드가 아니라
`resolveDrag`에 *액티브 그룹의 종목만* 넘겨 구조적으로 보장한다(다른 그룹 over →
`findIndex=-1` → no-op). 폴더의 sortable 단위는 헤더가 아니라 **그룹 블록 전체**이고,
드래그 핸들(⠿)만 헤더에 둬 헤더 클릭(접기 토글)과 충돌하지 않는다.

## Consequences

- 종목 행은 행 전체가 드래그 표면(PointerSensor `distance:5`로 클릭=차트이동 보존),
  그룹 헤더는 hover-노출 ⠿ 핸들. 비대칭은 헤더가 버튼 클러스터라는 구조적 차이에서 정당.
- `useReorderFolders`는 낙관적+롤백으로 전환(엔트리와 같은 제네릭 경로) — 드롭 즉시 반영.
- 편집 모달의 드래그/구조 편집은 그대로 공존(패널 드래그는 빠른 재정렬용 추가).
- 미분류는 폴더 sortable 대상이 아님(핸들 없음, 항상 맨 끝) — ADR-0004 불변식 유지.
- 테스트 표면은 ADR-0057 계승: 순수 codec(`resolveFolderDrag`)·낙관적 훅은 jsdom 단위,
  onDragEnd wiring은 dnd-kit passthrough 모킹, 실 포인터 드래그는 Playwright e2e.
```

- [ ] **Step 2: ADR-0057 stale 서술 갱신**

`docs/adr/0057-watchlist-reorder-test-surface.md`는 *제거된* 평면 패널 드래그를 서술한다(엔드포인트 `/api/watchlist/order`, `reorderCodes`/`reorderWatchlist`/`watchlist-reorder.spec.ts` 등 현존하지 않는 이름). 문서 상단에 갱신 노트를 추가한다(본문은 역사적 기록으로 보존):

3행(첫 문단) 바로 앞에 삽입:
```markdown
> **갱신 노트 (2026-06-08, ADR-0066):** 아래 본문은 v0.5.5.0에서 *제거된* 평면 패널
> 드래그(`PUT /api/watchlist/order`, `reorderCodes`/`reorderWatchlist`,
> `watchlist-reorder.spec.ts`)를 서술한 역사적 기록이다. 현재 패널 드래그는 폴더 인지
> 형태로 복귀했다(ADR-0066): 엔트리 재정렬은 `PUT /api/watchlist/reorder`, 폴더
> 재정렬은 `PUT /api/watchlist/folders/order`이며, wiring 테스트는
> `WatchlistDrawer.drag.test.tsx`(dnd-kit passthrough 모킹), 실 포인터 e2e는
> `watchlist-panel-drag.spec.ts`다. 테스트를 *층으로 분리*한다는 이 ADR의 핵심 결정은
> 그대로 유효하다.

```

- [ ] **Step 3: WatchlistDrawer 도크스트링 갱신**

`frontend/src/watchlist/WatchlistDrawer.tsx`의 `WatchlistDrawer` 도크스트링(현재 129–137행)에서 "Entry add/multi-delete/drag-reorder live in the edit modal." 문장을 다음으로 교체:
```
 * Entry add/multi-delete and cross-folder move live in the edit modal; quick
 * within-group reorder (drag a row) and folder reorder (drag a group via its ⠿
 * handle) happen in-panel via dnd-kit (ADR-0066). Collapse state persists via localStorage.
```

- [ ] **Step 4: CONTEXT.md Watchlist Panel 설명 갱신**

`CONTEXT.md` 155행의 Watchlist Panel 문단에서 "The only in-drawer mutation is a per-row **quick-remove** ... **all other editing — ... reorder within a folder — lives in the **Watchlist Edit Modal****" 부분을 패널 내 드래그 재정렬을 반영하도록 수정한다. 해당 문장을 다음으로 교체:
```
In-drawer mutations are a per-row **quick-remove** (right-click context menu / `Delete` key → `DELETE /api/watchlist/{code}`) and **drag-reorder** — drag a row to reorder **within its group** (`PUT /api/watchlist/reorder`), drag a group by its ⠿ header handle to reorder folders (`PUT /api/watchlist/folders/order`); both optimistic (ADR-0066). **Add, folder create/rename/delete, and cross-folder move** still live in the **Watchlist Edit Modal** opened from the header `편집` control.
```
그리고 같은 문단 끝의 "(Supersedes the earlier flat drag-reorder drawer ... reorder is now folder-internal, in the Modal.)" 괄호 문장에서 "in the Modal" 을 "in-panel (drag) or the Modal (ADR-0066)" 로 수정.

- [ ] **Step 5: 타입체크 + 커밋**

Run: `cd frontend && npx tsc -b`
Expected: 타입 에러 없음(도크스트링만 변경).
```bash
git add docs/adr/0066-watchlist-panel-drag-return.md docs/adr/0057-watchlist-reorder-test-surface.md frontend/src/watchlist/WatchlistDrawer.tsx CONTEXT.md
git commit -m "docs(watchlist): 패널 드래그 복귀 ADR-0066 + ADR-0057/CONTEXT 갱신"
```

---

## Task 7: 전체 검증 + 수동 확인

**Files:** 없음(검증)

- [ ] **Step 1: 전체 frontend 테스트 + 타입 + 린트**

Run: `cd frontend && npx vitest run && npx tsc -b && npx eslint .`
Expected: 단위/통합 전부 PASS, 타입 에러 없음, 린트 클린.

- [ ] **Step 2: 전체 e2e**

Run: `cd frontend && npx playwright test tests/e2e/watchlist-panel-drag.spec.ts tests/e2e/watchlist-edit-reorder.spec.ts`
Expected: PASS — 패널 드래그(신규) + 편집 모달 드래그(공존) 모두 통과.

- [ ] **Step 3: 수동 확인 (`/browse` 헤드리스 — CLAUDE.md)**

dev 서버(백엔드+프론트) 기동 후 `/live` 우측 관심종목 패널에서:
- ① 그룹 내 종목을 끌어 순서 변경 → 드롭 즉시 반영, 무튐.
- ② 그룹 헤더에 hover → ⠿ 노출 → 끌어 그룹 순서 변경.
- ③ 행을 그냥 클릭 → 차트 이동(드래그 오발동 없음).
- ④ 우클릭 메뉴 / Delete / 접기 토글 / ⋯ 메뉴 정상.
- ⑤ sticky 헤더가 폴더 드래그 중 깨지지 않는지(spec Risks) 눈으로 확인.

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B console --errors
```

---

## Self-Review

**1. Spec coverage:**
- 그룹 내 종목 드래그 재정렬 → Task 3 ✓
- 그룹(폴더) 드래그 재정렬 → Task 4 ✓
- `resolveFolderDrag` 신설 → Task 1 ✓
- `applyFolderReorder` + `useReorderFolders` 낙관적 전환 → Task 2 ✓
- 그룹 간 이동 차단(Non-Goal, 구조적) → Task 3 onDragEnd 엔트리 분기(액티브 그룹만 전달) ✓
- 미분류 핸들 제외/항상 끝 → Task 4 Step 7(미분류 plain div) ✓
- 드래그 affordance(행 전체 / 헤더 ⠿) → Task 3 SortableQuoteRow + Task 4 GroupHeader 핸들 ✓
- onDragEnd over 정규화 → Task 4 Step 6 ✓
- 테스트(단위/jsdom wiring/e2e) → Task 1·2·3·4·5 ✓
- 문서(ADR-0066/0057, 도크스트링, CONTEXT) → Task 6 ✓

**2. Placeholder scan:** TBD/TODO 없음. 모든 코드 스텝에 완전한 코드 포함.

**3. Type consistency:**
- `resolveFolderDrag(orderedIds, activeId, overId) → FolderDragResult{kind:'reorder',orderedIds}|{kind:'none'}` — Task 1 정의, Task 4 Step 6 사용 일치 ✓
- `applyFolderReorder(data, orderedIds)` — Task 2 정의, `useReorderFolders`에서 사용 ✓
- `useOptimisticWatchlistMutation` 이름 변경 — Task 2에서 3개 호출부(Reorder/Move/Folders) 일괄 갱신 ✓
- `GroupDragHandle{listeners}` — Task 4 정의, `SortableGroup` children 인자 + `GroupHeader.dragHandle` + 렌더 일치 ✓
- `SortableQuoteRow` props(entry/price/pct/changeWon/active/onPick/onContextMenu/onDelete) — Task 3 정의, Task 3·4 map 호출 인자 일치 ✓
- `data.type` 값 `'entry'|'folder'` — useSortable 태깅(SortableQuoteRow/SortableGroup)과 onDragEnd 분기 일치 ✓
- e2e testid: `watchlist-row-<code>`(QuoteRow 기존), `watchlist-group-<id>`/`group-drag-handle`(Task 4 신설) — e2e 셀렉터와 일치 ✓
