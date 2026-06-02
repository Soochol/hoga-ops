# 관심종목 드래그 재정렬 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 우측 레일 관심종목 패널(`WatchlistDrawer`)의 행을 마우스 드래그로 재정렬하고, 새 순서를 서버에 영속한다.

**Architecture:** 순서는 이미 `watchlist.json`의 리스트 순서로 서버에 산다. 신규 `PUT /api/watchlist/order`가 코드 배열을 받아 `_lock` 안에서 재배치(모르는 코드 drop·미언급 항목 append)한다. 프론트는 `@dnd-kit`(행 전체 드래그, 8px 활성화)으로 순서를 잡고, optimistic 캐시 갱신 후 영속 요청을 보낸다. 공유 부품 `QuoteRow`는 *선택적* drag props만 받아 스크리너는 무영향.

**Tech Stack:** Python/FastAPI/Pydantic v2, pytest; React/TypeScript, @tanstack/react-query, @dnd-kit/core·sortable·utilities, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-02-watchlist-drag-reorder-design.md`

---

## File Structure

| File | 책임 | 변경 |
|------|------|------|
| `hoga/api/watchlist.py` | watchlist 영속·뮤테이션. `reorder_entries` 추가 | Modify |
| `hoga/api/models.py` | API 모델. `WatchlistReorderRequest` 추가 | Modify |
| `hoga/api/watchlist_routes.py` | `/api/watchlist` 라우터. `PUT /order` 추가 | Modify |
| `tests/test_api_watchlist.py` | `reorder_entries` 단위 테스트 | Modify |
| `tests/test_api_watchlist_routes.py` | `PUT /order` 라우트 테스트 | Modify |
| `frontend/src/api/watchlist.ts` | API 클라이언트. `reorderWatchlist` 추가 | Modify |
| `frontend/src/api/watchlist.test.ts` | API 클라이언트 테스트 | Modify |
| `frontend/src/watchlist/reorderCodes.ts` | onDragEnd 재배치 순수 함수 | Create |
| `frontend/src/watchlist/reorderCodes.test.ts` | 순수 함수 테스트 | Create |
| `frontend/src/watchlist/useWatchlist.ts` | react-query 훅. `useReorderWatchlist` 추가 | Modify |
| `frontend/src/watchlist/useReorderWatchlist.test.tsx` | optimistic + 롤백 테스트 | Create |
| `frontend/src/rightrail/QuoteRow.tsx` | 공유 행. 선택적 drag props + `QuoteRowProps` export | Modify |
| `frontend/src/watchlist/SortableQuoteRow.tsx` | `useSortable` 캡슐화 래퍼 | Create |
| `frontend/src/watchlist/WatchlistDrawer.tsx` | DnD 컨텍스트 배선 | Modify |
| `frontend/src/watchlist/WatchlistDrawer.test.tsx` | onDragEnd → mutate 검증 (기존 8 테스트에 추가) | Modify |

---

## Task 1: Backend — `reorder_entries` 영속 함수

**Files:**
- Modify: `hoga/api/watchlist.py` (after `remove_entry`, around line 117)
- Test: `tests/test_api_watchlist.py`

- [ ] **Step 1: Write the failing tests**

`tests/test_api_watchlist.py` 끝에 추가:

```python
@pytest.mark.asyncio
async def test_reorder_entries_reorders(tmp_path: Path):
    from hoga.api.watchlist import add_entry, reorder_entries, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    await add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260526")
    await add_entry(tmp_path, code="000660", name="SK하이닉스", today_kst_date="20260526")
    out = await reorder_entries(tmp_path, codes=["000660", "003490", "005930"])
    assert [e.code for e in out] == ["000660", "003490", "005930"]
    assert [e.code for e in load_watchlist(tmp_path)] == ["000660", "003490", "005930"]


@pytest.mark.asyncio
async def test_reorder_ignores_unknown_codes(tmp_path: Path):
    from hoga.api.watchlist import add_entry, reorder_entries
    await add_entry(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    await add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260526")
    # "999999" is not present → ignored, no crash.
    out = await reorder_entries(tmp_path, codes=["999999", "005930", "003490"])
    assert [e.code for e in out] == ["005930", "003490"]


@pytest.mark.asyncio
async def test_reorder_appends_unmentioned_in_existing_order(tmp_path: Path):
    from hoga.api.watchlist import add_entry, reorder_entries
    await add_entry(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    await add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260526")
    await add_entry(tmp_path, code="000660", name="SK하이닉스", today_kst_date="20260526")
    # Only mention the last one → it moves first, the rest keep their order.
    out = await reorder_entries(tmp_path, codes=["000660"])
    assert [e.code for e in out] == ["000660", "003490", "005930"]


@pytest.mark.asyncio
async def test_reorder_preserves_entry_fields(tmp_path: Path):
    from hoga.api.watchlist import add_entry, reorder_entries
    await add_entry(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    out = await reorder_entries(tmp_path, codes=["003490"])
    assert out[0].name == "대한항공"
    assert out[0].registered_at_kst_date == "20260526"
    assert out[0].last_success_date is None


@pytest.mark.asyncio
async def test_reorder_no_change_does_not_rewrite_file(tmp_path: Path):
    from hoga.api.watchlist import add_entry, reorder_entries
    await add_entry(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    await add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260526")
    p = tmp_path / "watchlist.json"
    mtime_before = p.stat().st_mtime_ns
    await reorder_entries(tmp_path, codes=["003490", "005930"])  # same order
    assert p.stat().st_mtime_ns == mtime_before  # untouched
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --extra dev pytest tests/test_api_watchlist.py -k reorder -v`
Expected: FAIL — `ImportError: cannot import name 'reorder_entries'`

- [ ] **Step 3: Implement `reorder_entries`**

`hoga/api/watchlist.py`, `remove_entry` 함수 바로 뒤(약 117행 다음)에 추가:

```python
async def reorder_entries(
    data_dir: Path,
    *,
    codes: list[str],
) -> list[WatchlistEntry]:
    """Rewrite watchlist order to match ``codes``.

    Tolerant of a stale ``codes`` list (a concurrent add/remove means the
    caller's view may differ from disk): codes not currently present are
    ignored; entries not mentioned in ``codes`` are appended in their
    existing relative order. Shares ``_lock`` with add/remove/bump so a
    concurrent mutation cannot interleave a half-applied state. No-op write:
    if the resulting order equals the current order, the file is not touched.

    Only the order changes — ``last_success_date`` / ``registered_at_kst_date``
    are preserved by re-using the existing entry objects.
    """
    async with _lock:
        entries = load_watchlist(data_dir)
        by_code = {e.code: e for e in entries}
        seen: set[str] = set()
        ordered: list[WatchlistEntry] = []
        for c in codes:
            e = by_code.get(c)
            if e is not None and c not in seen:
                ordered.append(e)
                seen.add(c)
        for e in entries:
            if e.code not in seen:
                ordered.append(e)
        if [e.code for e in ordered] != [e.code for e in entries]:
            save_watchlist(data_dir, entries=ordered)
        return ordered
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/test_api_watchlist.py -k reorder -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist.py tests/test_api_watchlist.py
git commit -m "feat(watchlist): reorder_entries 영속 함수 (stale 코드 관용)"
```

---

## Task 2: Backend — `WatchlistReorderRequest` 모델 + `PUT /order` 라우트

**Files:**
- Modify: `hoga/api/models.py:559` (after `WatchlistAddRequest`)
- Modify: `hoga/api/watchlist_routes.py` (import + new route before `return router`)
- Test: `tests/test_api_watchlist_routes.py`

- [ ] **Step 1: Write the failing route tests**

`tests/test_api_watchlist_routes.py` 끝에 추가:

```python
@pytest.mark.asyncio
async def test_put_order_reorders(tmp_path: Path):
    from hoga.api import watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260526")
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.put("/api/watchlist/order", json={"codes": ["005930", "003490"]})
    assert r.status_code == 200
    body = r.json()
    assert [e["code"] for e in body["entries"]] == ["005930", "003490"]
    assert [e.code for e in watchlist.load_watchlist(tmp_path)] == ["005930", "003490"]


def test_put_order_rejects_non_6_digit_code(tmp_path: Path):
    client = TestClient(_app(tmp_path))
    r = client.put("/api/watchlist/order", json={"codes": ["12345"]})  # 5 digits
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_put_order_does_not_collide_with_delete_route(tmp_path: Path):
    """`/order` is a literal segment, not a {code} path param. The DELETE
    /{code} route (pattern ^\\d{6}$) must not shadow it."""
    from hoga.api import watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.put("/api/watchlist/order", json={"codes": ["003490"]})
    assert r.status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --extra dev pytest tests/test_api_watchlist_routes.py -k order -v`
Expected: FAIL — 404/405 (route absent) or import error.

- [ ] **Step 3a: Add the model**

`hoga/api/models.py`, `WatchlistAddRequest`(약 559-560행) 바로 뒤에 추가 (`Annotated`/`Field`는 이미 import됨):

```python
class WatchlistReorderRequest(BaseModel):
    """New display order for the Watchlist. Each element is a 6-digit KRX
    code. Tolerant server-side: unknown codes are ignored and unmentioned
    entries are appended (see watchlist.reorder_entries)."""

    codes: list[Annotated[str, Field(pattern=r"^\d{6}$")]]
```

- [ ] **Step 3b: Add the route**

`hoga/api/watchlist_routes.py` — import에 `reorder_entries`와 `WatchlistReorderRequest` 추가:

```python
from hoga.api.models import (
    EnqueueResponse,
    ManualCatchupAllEntryResult,
    ManualCatchupAllResponse,
    ManualCatchupError,
    WatchlistAddRequest,
    WatchlistEntry,
    WatchlistReorderRequest,   # 추가
    WatchlistResponse,
)
from hoga.api.watchlist import (
    AlreadyInWatchlistError,
    NotInWatchlistError,
    add_entry,
    load_watchlist,
    remove_entry,
    reorder_entries,           # 추가
)
```

`return router` 바로 위에 라우트 추가:

```python
    @router.put("/order", response_model=WatchlistResponse)
    async def reorder_watchlist(req: WatchlistReorderRequest) -> WatchlistResponse:
        entries = await reorder_entries(data_dir, codes=req.codes)
        return WatchlistResponse(
            entries=entries,
            next_run_at_ms=_next_run_at_ms(now_kst()),
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/test_api_watchlist_routes.py -k order -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full watchlist backend suite (no regressions)**

Run: `uv run --extra dev pytest tests/test_api_watchlist.py tests/test_api_watchlist_routes.py -q`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py hoga/api/watchlist_routes.py tests/test_api_watchlist_routes.py
git commit -m "feat(api): PUT /api/watchlist/order 재정렬 엔드포인트"
```

---

## Task 3: Frontend — `reorderWatchlist` API 클라이언트

**Files:**
- Modify: `frontend/src/api/watchlist.ts:32` (after `removeFromWatchlist`)
- Test: `frontend/src/api/watchlist.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/api/watchlist.test.ts`의 첫 import 블록에 `reorderWatchlist`를 추가하고, `describe('watchlist api client', ...)` 안에 케이스 추가:

```ts
  it('reorderWatchlist PUTs the codes array to /api/watchlist/order', async () => {
    const fake: WatchlistResponse = { entries: [], next_run_at_ms: 0 };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await reorderWatchlist(['005930', '003490']);
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/watchlist/order');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ codes: ['005930', '003490'] });
    expect(r).toEqual(fake);
  });
```

상단 import에 추가:

```ts
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  reorderWatchlist,         // 추가
  type WatchlistResponse,
} from './watchlist';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api/watchlist.test.ts -t reorderWatchlist`
Expected: FAIL — `reorderWatchlist is not a function` / import error.

- [ ] **Step 3: Implement `reorderWatchlist`**

`frontend/src/api/watchlist.ts`, `removeFromWatchlist`(약 30-32행) 바로 뒤에 추가:

```ts
export function reorderWatchlist(codes: string[]): Promise<WatchlistResponse> {
  return apiCall<WatchlistResponse>('/api/watchlist/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/api/watchlist.test.ts -t reorderWatchlist`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/watchlist.ts frontend/src/api/watchlist.test.ts
git commit -m "feat(watchlist): reorderWatchlist API 클라이언트"
```

---

## Task 4: Frontend — `reorderCodes` 순수 함수

**Files:**
- Create: `frontend/src/watchlist/reorderCodes.ts`
- Test: `frontend/src/watchlist/reorderCodes.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/watchlist/reorderCodes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reorderCodes } from './reorderCodes';

describe('reorderCodes', () => {
  const codes = ['003490', '005930', '000660'];

  it('moves active before/after over via arrayMove', () => {
    // drag last (000660) onto first (003490) → 000660 takes index 0
    expect(reorderCodes(codes, '000660', '003490')).toEqual(['000660', '003490', '005930']);
  });

  it('returns null when active === over (dropped in place)', () => {
    expect(reorderCodes(codes, '005930', '005930')).toBeNull();
  });

  it('returns null when over is null/undefined (dropped outside)', () => {
    expect(reorderCodes(codes, '005930', null)).toBeNull();
    expect(reorderCodes(codes, '005930', undefined)).toBeNull();
  });

  it('returns null when a code is not in the list (stale)', () => {
    expect(reorderCodes(codes, '999999', '003490')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/watchlist/reorderCodes.test.ts`
Expected: FAIL — cannot find module `./reorderCodes`.

- [ ] **Step 3: Implement `reorderCodes`**

`frontend/src/watchlist/reorderCodes.ts`:

```ts
import { arrayMove } from '@dnd-kit/sortable';

/**
 * onDragEnd 재배치 로직(순수). dnd-kit의 active/over id를 받아 새 코드 순서를
 * 돌려준다. 같은 슬롯/리스트 밖/미존재 코드면 null(=뮤테이션 스킵).
 */
export function reorderCodes(
  codes: string[],
  activeId: string,
  overId: string | null | undefined,
): string[] | null {
  if (overId == null || activeId === overId) return null;
  const from = codes.indexOf(activeId);
  const to = codes.indexOf(overId);
  if (from < 0 || to < 0) return null;
  return arrayMove(codes, from, to);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/watchlist/reorderCodes.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/watchlist/reorderCodes.ts frontend/src/watchlist/reorderCodes.test.ts
git commit -m "feat(watchlist): reorderCodes onDragEnd 순수 함수"
```

---

## Task 5: Frontend — `useReorderWatchlist` optimistic 훅

**Files:**
- Modify: `frontend/src/watchlist/useWatchlist.ts` (import + new hook at end)
- Test: `frontend/src/watchlist/useReorderWatchlist.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/src/watchlist/useReorderWatchlist.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReorderWatchlist } from './useWatchlist';
import * as api from '../api/watchlist';
import type { WatchlistResponse } from '../api/watchlist';

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const initial: WatchlistResponse = {
    next_run_at_ms: 0,
    entries: [
      { code: '003490', name: '대한항공', registered_at_kst_date: '20260526', last_success_date: null },
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260526', last_success_date: null },
    ],
  };
  qc.setQueryData(['watchlist'], initial);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const codesOf = (qc: QueryClient) =>
  (qc.getQueryData<WatchlistResponse>(['watchlist'])?.entries ?? []).map((e) => e.code);

describe('useReorderWatchlist', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('optimistically reorders the cache before the request resolves', async () => {
    // request never resolves → we observe the optimistic state only
    vi.spyOn(api, 'reorderWatchlist').mockReturnValue(new Promise<never>(() => {}));
    const { qc, wrapper } = seeded();
    const { result } = renderHook(() => useReorderWatchlist(), { wrapper });
    act(() => { result.current.mutate(['005930', '003490']); });
    await waitFor(() => expect(codesOf(qc)).toEqual(['005930', '003490']));
  });

  it('rolls back to the previous order on error', async () => {
    vi.spyOn(api, 'reorderWatchlist').mockRejectedValue(new Error('boom'));
    const { qc, wrapper } = seeded();
    const { result } = renderHook(() => useReorderWatchlist(), { wrapper });
    act(() => { result.current.mutate(['005930', '003490']); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(codesOf(qc)).toEqual(['003490', '005930']); // restored
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/watchlist/useReorderWatchlist.test.tsx`
Expected: FAIL — `useReorderWatchlist` is not exported.

- [ ] **Step 3: Implement the hook**

`frontend/src/watchlist/useWatchlist.ts` — import 블록에 `reorderWatchlist`와 `WatchlistEntry` 타입 추가:

```ts
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  reorderWatchlist,
  catchupNow,
  catchupAll,
  type WatchlistResponse,
  type WatchlistEntry,
  type EnqueueResponse,
  type ManualCatchupAllResponse,
} from '../api/watchlist';
```

> `WatchlistEntry`는 `api/watchlist.ts`에서 이미 export됨(인터페이스 선언). 파일 끝에 추가:

```ts
export function useReorderWatchlist() {
  const qc = useQueryClient();
  return useMutation<WatchlistResponse, Error, string[], { prev?: WatchlistResponse }>({
    mutationKey: ['watchlist', 'reorder'],
    mutationFn: (codes: string[]) => reorderWatchlist(codes),
    onMutate: async (codes: string[]) => {
      await qc.cancelQueries({ queryKey: KEY });
      const prev = qc.getQueryData<WatchlistResponse>(KEY);
      if (prev) {
        const byCode = new Map(prev.entries.map((e) => [e.code, e]));
        const reordered = codes
          .map((c) => byCode.get(c))
          .filter((e): e is WatchlistEntry => e !== undefined);
        const rest = prev.entries.filter((e) => !codes.includes(e.code));
        qc.setQueryData<WatchlistResponse>(KEY, { ...prev, entries: [...reordered, ...rest] });
      }
      return { prev };
    },
    onError: (_err, _codes, ctx) => {
      if (ctx?.prev) qc.setQueryData(KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/watchlist/useReorderWatchlist.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/watchlist/useWatchlist.ts frontend/src/watchlist/useReorderWatchlist.test.tsx
git commit -m "feat(watchlist): useReorderWatchlist optimistic 훅 + 롤백"
```

---

## Task 6: Frontend — `QuoteRow` 선택적 drag props

**Files:**
- Modify: `frontend/src/rightrail/QuoteRow.tsx`

이 변경은 *순수 가산적*이다. 새 props는 전부 선택적이고 미전달 시 현행 렌더가 동일하므로, 기존 `WatchlistDrawer`/`ScreenerDrawer` 사용처와 그 테스트가 그대로 통과한다(회귀 가드 = 기존 테스트).

- [ ] **Step 1: Extract & export `QuoteRowProps`, add optional drag props**

`frontend/src/rightrail/QuoteRow.tsx` 상단에 import 추가 (두 타입 모두 `@dnd-kit/core` root에서 공개 export됨 — 설치된 v6에서 확인; deep `dist/` 경로 불필요):

```ts
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
```

> `DraggableSyntheticListeners`는 `SyntheticListenerMap | undefined`의 공개 별칭이고, `useSortable().listeners`의 타입과 정확히 일치한다(Task 7에서 그대로 전달). `DraggableAttributes`도 `useSortable().attributes`와 일치.

인라인 props 타입을 명명·export 인터페이스로 추출하고 drag 필드 추가:

```ts
export interface QuoteRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  changeWon: number | null;
  active: boolean;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
  trailingAction?: React.ReactNode;
  // --- drag (관심종목 패널 전용; 미전달 시 비-드래그 동작) ---
  sortableRef?: (node: HTMLElement | null) => void;
  sortableStyle?: React.CSSProperties;
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
  dragging?: boolean;
}

export function QuoteRow({
  name, price, pct, changeWon, active, ariaLabel, testId, onClick, trailingAction,
  sortableRef, sortableStyle, dragListeners, dragAttributes, dragging,
}: QuoteRowProps) {
```

- [ ] **Step 2: Wire props onto the `<li>`**

기존 `<li ...>`의 `style`과 spread를 다음으로 교체 (onClick/onKeyDown/className 유지):

```tsx
    <li
      ref={sortableRef}
      data-testid={testId}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="group cursor-pointer px-md py-sm flex items-center gap-2 border-b outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
      style={{
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        ...sortableStyle,
        ...(dragging ? { opacity: 0.6, cursor: 'grabbing', zIndex: 1, position: 'relative' } : {}),
      }}
      {...dragAttributes}
      {...dragListeners}
    >
```

> 주: `dragListeners`가 `onPointerDown` 등을 주입하지만 `onClick`은 보존된다. 8px 활성화 거리(Task 8 sensor 설정) 미만 움직임은 dnd-kit이 드래그로 승격하지 않으므로 클릭이 정상 발화한다.

- [ ] **Step 3: Type-check (no test change; existing tests are the regression gate)**

Run: `cd frontend && npx tsc -b`
Expected: PASS (no type errors)

Run: `cd frontend && npx vitest run src/rightrail/QuoteRow.test.tsx src/watchlist/WatchlistDrawer.test.tsx src/screener`
Expected: PASS — 기존 사용처(QuoteRow·WatchlistDrawer·ScreenerDrawer)가 새 선택적 props 없이도 동일하게 렌더(회귀 가드).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/rightrail/QuoteRow.tsx
git commit -m "feat(rightrail): QuoteRow 선택적 drag props + QuoteRowProps export"
```

---

## Task 7: Frontend — `SortableQuoteRow` 래퍼

**Files:**
- Create: `frontend/src/watchlist/SortableQuoteRow.tsx`

- [ ] **Step 1: Implement the wrapper**

`frontend/src/watchlist/SortableQuoteRow.tsx`:

```tsx
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { QuoteRow, type QuoteRowProps } from '../rightrail/QuoteRow';

/**
 * `useSortable`를 캡슐화해 `QuoteRow`에 drag props만 주입한다. 스크리너 드로어는
 * bare `QuoteRow`를 그대로 쓰므로, 정렬 가능 여부는 이 래퍼를 쓰는지로 결정된다.
 * `id`는 안정적인 종목 코드(=SortableContext items와 일치).
 */
export function SortableQuoteRow(
  { code, ...rowProps }: { code: string } & QuoteRowProps,
) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: code });
  return (
    <QuoteRow
      {...rowProps}
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragListeners={listeners}
      dragAttributes={attributes}
      dragging={isDragging}
    />
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/watchlist/SortableQuoteRow.tsx
git commit -m "feat(watchlist): SortableQuoteRow — useSortable 캡슐화 래퍼"
```

---

## Task 8: Frontend — `WatchlistDrawer` DnD 배선

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx` (**기존 파일** — 8 테스트 존재; 모듈 mock 2개 + describe 블록 추가)

> 이 파일은 이미 `wrap(qc, initial)`(MemoryRouter+QueryClient+LocationProbe), `ENTRIES`(`005930` 삼성전자, `000660` SK하이닉스), `beforeEach`에서 `client.apiCall`을 quotes로 spy하는 하니스를 갖고 있다. 그 하니스를 재사용한다. DnD 배선 후에도 기존 8 테스트는 그대로 통과해야 한다(PointerSensor는 `fireEvent.click`(포인터 이동 없음)에 드래그를 걸지 않으므로 onClick·trash 동작 유지).

- [ ] **Step 1: Add module mocks + drag tests to the existing file**

파일 **상단**(기존 import 바로 아래)에 추가. `vi.mock` 팩토리는 hoisting되므로 외부 `let`을 클로저로 못 잡는다 → `vi.hoisted`로 캡처 슬롯을 만든다:

```tsx
import type { DragEndEvent } from '@dnd-kit/core';

// vi.mock 팩토리는 호이스팅됨 → 캡처 슬롯도 vi.hoisted 로 만들어야 안전.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as undefined | ((e: DragEndEvent) => void) }));

// DndContext 를 패스스루로 모킹하고 주입된 onDragEnd 를 캡처. SortableContext 도
// 패스스루(실제 DndContext provider 가 없으니). useSortable 은 default context 로
// graceful 하게 동작(setNodeRef noop) → 행은 정상 렌더.
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: { onDragEnd?: (e: DragEndEvent) => void; children: React.ReactNode }) => {
      dnd.onDragEnd = props.onDragEnd;
      return props.children;
    },
  };
});
vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return { ...actual, SortableContext: (props: { children: React.ReactNode }) => props.children };
});
```

파일 **끝**(마지막 `});` 뒤)에 새 describe 추가. 기존 `wrap`/`ENTRIES`/`watchlistApi`/`client` 심볼을 재사용:

```tsx
describe('WatchlistDrawer drag reorder', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' } as any);
    vi.restoreAllMocks();
    dnd.onDragEnd = undefined;
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
  });

  it('calls reorderWatchlist with the new code order on drag end', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderWatchlist')
      .mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    await waitFor(() => expect(dnd.onDragEnd).toBeTypeOf('function'));
    // drag 005930(삼성전자) onto 000660(SK하이닉스) → 새 순서 [000660, 005930]
    dnd.onDragEnd!({ active: { id: '005930' }, over: { id: '000660' } } as DragEndEvent);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(['000660', '005930']));
  });

  it('does not call reorderWatchlist when dropped in place', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderWatchlist')
      .mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(dnd.onDragEnd).toBeTypeOf('function'));
    dnd.onDragEnd!({ active: { id: '005930' }, over: { id: '005930' } } as DragEndEvent);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx -t "drag reorder"`
Expected: FAIL — 드로어가 아직 `DndContext`/`onDragEnd`를 배선하지 않아 `dnd.onDragEnd`가 undefined.

- [ ] **Step 3: Wire DnD into `WatchlistDrawer`**

`frontend/src/watchlist/WatchlistDrawer.tsx` — import 추가:

```ts
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableQuoteRow } from './SortableQuoteRow';
import { reorderCodes } from './reorderCodes';
import { useReorderWatchlist } from './useWatchlist';
```

컴포넌트 본문 상단(기존 `removeM` 선언 부근)에 추가:

```ts
  const reorderM = useReorderWatchlist();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const next = reorderCodes(codes, String(e.active.id), e.over ? String(e.over.id) : null);
    if (next) reorderM.mutate(next);
  };
```

> `codes`는 이미 존재한다: `const codes = useMemo(() => data?.entries.map((e) => e.code) ?? [], [data]);` (라이브 시세용). 그대로 재사용.

기존 `<ul>...</ul>` 블록을 DnD 컨텍스트로 감싸고 행을 `SortableQuoteRow`로 교체:

```tsx
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={codes} strategy={verticalListSortingStrategy}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data?.entries.map((entry) => {
              const q = quoteByCode.get(entry.code);
              return (
                <SortableQuoteRow
                  key={entry.code}
                  code={entry.code}
                  name={entry.name}
                  price={q?.price ?? null}
                  pct={q?.change_pct ?? null}
                  changeWon={q?.change_won ?? null}
                  active={entry.code === activeCode}
                  ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
                  testId={`watchlist-row-${entry.code}`}
                  onClick={() => onPick(entry.code)}
                  trailingAction={
                    <button
                      type="button"
                      aria-label={`${entry.name} 관심종목 해제`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => { e.stopPropagation(); removeM.mutate(entry.code); }}
                      className="leading-none text-fg-dimmer opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-error focus-visible:text-error transition-[opacity,color] duration-[80ms]"
                    >
                      <TrashIcon className="w-[1em] h-[1em]" />
                    </button>
                  }
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
```

> `SortableQuoteRow`는 `QuoteRowProps`를 그대로 받으므로 props 목록은 기존 `QuoteRow` 호출과 동일(+`code`). 빈/로딩/에러 분기와 헤더는 변경하지 않는다.

- [ ] **Step 4: Run the whole drawer test file (new 2 pass + existing 8 still green)**

Run: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: PASS (10 tests) — 기존 8 + 신규 2. 기존 click/trash 테스트가 DnD 배선 후에도 통과해야 함.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat(watchlist): WatchlistDrawer 드래그 재정렬 배선 (dnd-kit)"
```

---

## Task 9: 통합 게이트 + 수동 검증

**Files:** 없음 (검증 전용)

- [ ] **Step 1: Frontend type-check**

Run: `cd frontend && npx tsc -b`
Expected: PASS (0 errors)

- [ ] **Step 2: Frontend scoped eslint (변경 파일만 — 레포 전체 lint는 기존 부채로 실패)**

Run:
```bash
cd frontend && npx eslint \
  src/api/watchlist.ts \
  src/watchlist/reorderCodes.ts \
  src/watchlist/useWatchlist.ts \
  src/watchlist/SortableQuoteRow.tsx \
  src/watchlist/WatchlistDrawer.tsx \
  src/rightrail/QuoteRow.tsx
```
Expected: 0 errors

- [ ] **Step 3: Frontend full test suite (no regressions)**

Run: `cd frontend && npx vitest run`
Expected: PASS (all)

- [ ] **Step 4: Backend test suite**

Run: `uv run --extra dev pytest tests/test_api_watchlist.py tests/test_api_watchlist_routes.py tests/test_models.py -q`
Expected: PASS (all)

- [ ] **Step 5: Manual smoke test (dev servers)**

백엔드+프론트 dev 서버 기동(CLAUDE.md "Dev servers" 참고) 후 `/browse`로 확인:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B console --errors            # JS 에러 0 기대
```

수동 확인 항목:
1. 우측 레일에서 `관심` 클릭 → 관심종목 패널 오픈, 2개 이상 종목 존재(없으면 추가).
2. 한 행을 잡고 8px 이상 끌어 다른 행 위로 드롭 → 순서가 즉시 바뀌고 유지됨.
3. 행을 그냥 클릭(드래그 없이) → 차트가 해당 종목으로 전환(기존 동작 유지).
4. hover 시 휴지통 클릭 → 해제 동작 정상(드래그로 가로채지 않음).
5. 브라우저 새로고침 → 바뀐 순서 유지(서버 영속 확인).
6. 전체 페이지 `/watchlist`(좌측 네비) → 같은 새 순서로 표시(전역 순서 확인).

- [ ] **Step 6: Final commit (if any uncommitted verification fixes)**

```bash
git add -A && git commit -m "test(watchlist): 드래그 재정렬 통합 검증" --allow-empty
```

---

## Notes for the implementer

- **`uv run --extra dev pytest`** — bare `uv run pytest`는 "No module named pytest"로 죽는다(dev deps는 optional group).
- **Read 후 같은 배치에서 같은 파일 Edit 금지** — 순차로 편집하고, 커밋 전 항상 `npx tsc -b` / `pytest` 확인.
- **워크트리 동시 커밋 주의** — `git add <정확한 경로>` 후 커밋(`git commit --only`는 훅에 막힘). 서브에이전트 디스패치 전 `git status --porcelain` 확인.
- **dnd-kit 타입** — `DraggableAttributes`·`DraggableSyntheticListeners`는 `@dnd-kit/core` root에서 공개 export됨(설치된 v6 확인). deep `dist/` 경로를 쓰지 말 것. 둘은 각각 `useSortable().attributes`·`.listeners` 타입과 일치한다.
- **spread 순서** — `<li>`에 `onClick`/`onKeyDown`을 명시적으로 두고 그 뒤에 `{...dragAttributes} {...dragListeners}`를 spread해도, PointerSensor-only(키보드 미사용)라 listeners엔 `onPointerDown`만 들어가 핸들러 충돌이 없다. `dragAttributes`의 `role='button'`·`tabIndex=0`은 기존 값과 동일하고 `aria-roledescription`/`aria-describedby`만 a11y로 추가된다.
- **시각 토큰** — 드래그 중 스타일은 DESIGN.md 토큰만(opacity/elevation). 하드코딩 색 금지.
