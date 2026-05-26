# Watchlist Manual Catch-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-row `↻` and header `↻ 지금 전체 수집` buttons to `/watchlist`, both invoking the same per-entry catch-up logic the startup `_catchup_run` already does.

**Architecture:** Extract a `catchup_one_entry(entry, *, data_dir, now) -> EnqueueResponse` helper that collapses the existing two-phase `_catchup_run` loop body. Three callers consume it — `_catchup_run` (startup), `POST /api/watchlist/{code}/catchup` (per-row), `POST /api/watchlist/catchup` (run-all). The frontend generalizes the existing `justAdded` state into a `RecentAction` union covering `added`, `caught_up_one`, `caught_up_all`, keeping the single 5s-timer pattern.

**Tech Stack:** Python (FastAPI, Pydantic v2, asyncio); React + TypeScript + @tanstack/react-query.

**Spec:** `docs/superpowers/specs/2026-05-27-watchlist-manual-catchup-design.md`
**CONTEXT term:** Catch-up Run (rewritten 2026-05-27 to cover all three trigger surfaces).

---

## File Structure

### Modified

- `hoga/api/scheduler.py` — extract `catchup_one_entry`, simplify `_catchup_run`.
- `hoga/api/models.py` — add `ManualCatchupAllEntryResult`, `ManualCatchupAllResponse`.
- `hoga/api/watchlist_routes.py` — add 2 new POST endpoints.
- `frontend/src/api/watchlist.ts` — add `catchupNow(code)`, `catchupAll()` REST functions + result types.
- `frontend/src/watchlist/useWatchlist.ts` — add `useCatchupOne`, `useCatchupAll` mutation hooks.
- `frontend/src/watchlist/WatchlistRow.tsx` — add `↻` button, `catchingUp` prop.
- `frontend/src/watchlist/WatchlistPanel.tsx` — `justAdded` → `recentAction`, header button, expanded banner cases.

### Tests modified

- `tests/test_api_scheduler.py` — new `catchup_one_entry` tests, existing `_catchup_run` tests adjusted.
- `tests/test_api_watchlist_routes.py` — new POST endpoint tests.
- `frontend/src/api/watchlist.test.ts` — new REST function tests.
- `frontend/src/watchlist/WatchlistPanel.test.tsx` — new mutation tests.

---

## Phase 1 — Backend refactor

### Task 1: Extract `catchup_one_entry`, simplify `_catchup_run`

**Files:**
- Modify: `hoga/api/scheduler.py:70-120` (the existing `_catchup_run` two-phase body)
- Modify: `tests/test_api_scheduler.py` (extend with `catchup_one_entry` tests)

This task is behavior-preserving. The existing catch-up tests must stay green; the new helper just relocates the per-iteration logic.

- [ ] **Step 1: Write failing tests for `catchup_one_entry`**

Append to `tests/test_api_scheduler.py`:

```python
@pytest.mark.asyncio
async def test_catchup_one_entry_returns_empty_when_no_gap(tmp_path: Path):
    """When last_success >= today, returns empty EnqueueResponse without calling enqueue."""
    from hoga.api import scheduler
    from hoga.api.models import WatchlistEntry, EnqueueResponse
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260526",
        last_success_date="20260526",
    )
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)
    with patch("hoga.api.scheduler.latest_complete_date", return_value=None), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        result = await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    assert isinstance(result, EnqueueResponse)
    assert result.enqueued == [] and result.deduped == []
    assert enq.await_count == 0


@pytest.mark.asyncio
async def test_catchup_one_entry_reconciles_then_backfills(tmp_path: Path):
    """If disk has newer COMPLETE date, marker advances first, then backfill uses new floor."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import WatchlistEntry, EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    # Persisted entry has last_success_date=None.
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260520",
        last_success_date=None,
    )
    fake_now = dt.datetime(2026, 5, 27, 19, 0, 0, tzinfo=KST)
    with patch("hoga.api.scheduler.latest_complete_date",
               return_value="20260524"), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260525", "20260526", "20260527"]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        result = await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    # bump_last_success was called with date=20260524
    entries = watchlist.load_watchlist(tmp_path)
    assert entries[0].last_success_date == "20260524"
    # trading_days_in_range called from next_day(20260524) = 20260525.
    enq.assert_awaited_once()
    call_req = enq.await_args.kwargs.get("req") or enq.await_args.args[0]
    assert call_req.dates == ["20260525", "20260526", "20260527"]
    assert isinstance(result, EnqueueResponse)


@pytest.mark.asyncio
async def test_catchup_one_entry_q14_trim(tmp_path: Path):
    """Today is pre-trimmed via find_ineligible_dates."""
    from hoga.api import scheduler
    from hoga.api.models import WatchlistEntry, EnqueueResponse
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260520",
        last_success_date="20260524",
    )
    fake_now = dt.datetime(2026, 5, 27, 10, 0, 0, tzinfo=KST)  # before 18
    with patch("hoga.api.scheduler.latest_complete_date", return_value=None), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260525", "20260526", "20260527"]), \
         patch("hoga.api.scheduler.find_ineligible_dates",
               return_value=["20260527"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    call_req = enq.await_args.kwargs.get("req") or enq.await_args.args[0]
    assert call_req.dates == ["20260525", "20260526"]


@pytest.mark.asyncio
async def test_catchup_one_entry_returns_empty_on_krx_unavailable(tmp_path: Path):
    """KrxUnavailableError → empty response, no enqueue."""
    from hoga.api import scheduler
    from hoga.api.models import WatchlistEntry, EnqueueResponse
    from hoga.api.calendar import KrxUnavailableError
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260520",
        last_success_date=None,
    )
    fake_now = dt.datetime(2026, 5, 27, 19, 0, 0, tzinfo=KST)
    def boom(*args, **kwargs):
        raise KrxUnavailableError("krx_credentials_missing")
    with patch("hoga.api.scheduler.latest_complete_date", return_value=None), \
         patch("hoga.api.scheduler.trading_days_in_range", side_effect=boom), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        result = await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    assert result.enqueued == [] and result.deduped == []
    assert enq.await_count == 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_scheduler.py -k catchup_one_entry -v
```

Expected: FAIL — `catchup_one_entry` not defined.

- [ ] **Step 3: Implement `catchup_one_entry` and rewrite `_catchup_run`**

In `hoga/api/scheduler.py`, replace the existing `_catchup_run` body (lines 70-120) with the following structure. Keep all existing imports; no new imports needed.

```python
async def catchup_one_entry(
    entry: WatchlistEntry,
    *,
    data_dir: Path,
    now: dt.datetime,
) -> EnqueueResponse:
    """Backfill one Watchlist entry. Used by:
    - _catchup_run (startup)
    - POST /api/watchlist/{code}/catchup (per-row)
    - POST /api/watchlist/catchup (run-all)

    Reconciles last_success_date with the disk first (idempotent), then
    enqueues the trading-day gap up to today (Q14-trimmed). Returns
    EnqueueResponse(enqueued=[], deduped=[]) on no-gap, KrxUnavailable,
    or fully-Q14-trimmed cases.
    """
    today = now.strftime("%Y%m%d")

    # Step 1: reconcile last_success_date from disk.
    latest = latest_complete_date(data_dir, entry.code)
    if latest is not None and (
        entry.last_success_date is None or latest > entry.last_success_date
    ):
        await bump_last_success(data_dir, code=entry.code, date=latest)
        floor = latest
    else:
        floor = entry.last_success_date or entry.registered_at_kst_date

    # Step 2: compute candidate dates.
    start = _next_kst_day(floor)
    if start > today:
        return EnqueueResponse(enqueued=[], deduped=[])
    try:
        candidates = trading_days_in_range(start, today)
    except Exception:  # noqa: BLE001 — KrxUnavailableError or worse
        log.warning("catch-up: trading-day list unavailable for %s", entry.code)
        return EnqueueResponse(enqueued=[], deduped=[])

    # Step 3: Q14 pre-trim.
    too_early = set(find_ineligible_dates(candidate_dates=candidates, now=now))
    candidates = [d for d in candidates if d not in too_early]
    if not candidates:
        return EnqueueResponse(enqueued=[], deduped=[])

    # Step 4: enqueue.
    return await enqueue_items_core(
        EnqueueRequest(code=entry.code, dates=candidates),
        data_dir=data_dir,
        now=now,
    )


async def _catchup_run(data_dir: Path) -> None:
    """Backfill every Watchlist entry on startup. Each entry is handled
    by catchup_one_entry; per-entry exceptions are logged. The startup
    sweep never aborts because one entry failed.
    """
    now = now_kst()
    for entry in load_watchlist(data_dir):
        try:
            await catchup_one_entry(entry, data_dir=data_dir, now=now)
        except Exception:  # noqa: BLE001
            log.exception("catch-up failed for %s", entry.code)
```

- [ ] **Step 4: Run all scheduler tests**

```bash
uv run pytest tests/test_api_scheduler.py -v
```

Expected: all PASS (4 new `catchup_one_entry` tests + the existing 12 tests). The existing tests patch `latest_complete_date`, `trading_days_in_range`, `find_ineligible_dates`, `enqueue_items_core` — they continue to work because the helper preserves the same patch surface.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/scheduler.py tests/test_api_scheduler.py
git commit -m "refactor(scheduler): extract catchup_one_entry helper

The previous two-phase _catchup_run (reconcile-all then backfill-all)
collapses into a single loop calling a per-entry helper. Behavior
preserved (bump_last_success is idempotent + monotonic). The new
helper is the seam the upcoming POST /api/watchlist/.../catchup
endpoints will use — see spec 2026-05-27."
```

---

## Phase 2 — Backend endpoints

### Task 2: Pydantic models for the all-rows response

**Files:**
- Modify: `hoga/api/models.py` (append)
- Modify: `tests/test_models.py` (append)

- [ ] **Step 1: Write failing tests**

Append to `tests/test_models.py`:

```python
def test_manual_catchup_all_entry_result_fields():
    from hoga.api.models import ManualCatchupAllEntryResult
    r = ManualCatchupAllEntryResult(
        code="003490", name="대한항공",
        enqueued_count=3, deduped_count=2, error=None,
    )
    assert r.code == "003490"
    assert r.enqueued_count == 3
    assert r.deduped_count == 2
    assert r.error is None


def test_manual_catchup_all_entry_result_with_error():
    from hoga.api.models import ManualCatchupAllEntryResult
    r = ManualCatchupAllEntryResult(
        code="003490", name="대한항공",
        enqueued_count=0, deduped_count=0,
        error="krx_credentials_missing",
    )
    assert r.error == "krx_credentials_missing"


def test_manual_catchup_all_response_aggregates():
    from hoga.api.models import (
        ManualCatchupAllResponse, ManualCatchupAllEntryResult,
    )
    resp = ManualCatchupAllResponse(results=[
        ManualCatchupAllEntryResult(code="003490", name="대한항공",
                                     enqueued_count=3, deduped_count=2),
        ManualCatchupAllEntryResult(code="005930", name="삼성전자",
                                     enqueued_count=0, deduped_count=5),
    ])
    assert len(resp.results) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_models.py -k manual_catchup -v
```

Expected: FAIL — models don't exist.

- [ ] **Step 3: Add models to `hoga/api/models.py`**

Append at the end of `hoga/api/models.py`:

```python
# --- Watchlist manual catch-up (see spec 2026-05-27) -----------------------


class ManualCatchupAllEntryResult(BaseModel):
    """One row in the ManualCatchupAllResponse.results list.

    ``error`` is a short string (KRX upstream code like
    ``krx_credentials_missing``, or an exception message) for the panel
    to surface in the banner's per-entry failure list. ``None`` when the
    entry succeeded.
    """
    code: str = Field(pattern=r"^\d{6}$")
    name: str
    enqueued_count: int
    deduped_count: int
    error: str | None = None


class ManualCatchupAllResponse(BaseModel):
    """Response shape for POST /api/watchlist/catchup."""
    results: list[ManualCatchupAllEntryResult]
```

- [ ] **Step 4: Run tests**

```bash
uv run pytest tests/test_models.py -k manual_catchup -v
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/test_models.py
git commit -m "feat(watchlist): add Pydantic models for manual catch-up responses"
```

---

### Task 3: `POST /api/watchlist/{code}/catchup` (per-row endpoint)

**Files:**
- Modify: `hoga/api/watchlist_routes.py`
- Modify: `tests/test_api_watchlist_routes.py` (append)

- [ ] **Step 1: Write failing tests**

Append to `tests/test_api_watchlist_routes.py`:

```python
def test_catchup_one_not_in_watchlist_returns_404(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/003490/catchup")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_in_watchlist"


@pytest.mark.asyncio
async def test_catchup_one_returns_enqueue_response(tmp_path: Path):
    from hoga.api import watchlist
    from hoga.api.models import EnqueueResponse, QueueItem
    from unittest.mock import AsyncMock
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)
    fake_resp = EnqueueResponse(
        enqueued=[QueueItem(
            item_id="003490-20260526", code="003490", date="20260526",
            phase="queued", attempt=1, force_retry=False,
            enqueued_at_ms=0, started_at_ms=None, finished_at_ms=None,
            progress=None, error=None, skip_reason=None,
        )],
        deduped=[],
    )
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.catchup_one_entry",
               new_callable=AsyncMock, return_value=fake_resp):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/003490/catchup")
    assert r.status_code == 200
    body = r.json()
    assert len(body["enqueued"]) == 1
    assert body["enqueued"][0]["code"] == "003490"
    assert body["deduped"] == []
```

**Note:** Confirm the `QueueItem` model's required fields before pasting — the test fixture must match. Read `hoga/api/models.py:152` (the `QueueItem` definition) and adjust kwargs as needed.

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_watchlist_routes.py -k catchup_one -v
```

Expected: FAIL — endpoint not registered (404 method-not-allowed or similar).

- [ ] **Step 3: Add the endpoint**

Edit `hoga/api/watchlist_routes.py`. Add to the existing imports near the top:

```python
from hoga.api.models import EnqueueResponse
from hoga.api.scheduler import catchup_one_entry
```

Inside `build_router` (after the DELETE handler), add:

```python
    @router.post("/{code}/catchup", response_model=EnqueueResponse)
    async def catchup_one(code: str) -> EnqueueResponse:
        if not code.isdigit() or len(code) != 6:
            raise HTTPException(status_code=400, detail={
                "code": "invalid_code", "message": "Code must be 6 digits.",
            })
        entries = load_watchlist(data_dir)
        match = next((e for e in entries if e.code == code), None)
        if match is None:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_watchlist",
                "message": f"Code {code} is not in the Watchlist.",
            })
        return await catchup_one_entry(
            match, data_dir=data_dir, now=now_kst(),
        )
```

- [ ] **Step 4: Run tests**

```bash
uv run pytest tests/test_api_watchlist_routes.py -v
```

Expected: all PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist_routes.py tests/test_api_watchlist_routes.py
git commit -m "feat(watchlist): POST /api/watchlist/{code}/catchup per-row endpoint"
```

---

### Task 4: `POST /api/watchlist/catchup` (run-all endpoint)

**Files:**
- Modify: `hoga/api/watchlist_routes.py`
- Modify: `tests/test_api_watchlist_routes.py` (append)

- [ ] **Step 1: Write failing tests**

Append to `tests/test_api_watchlist_routes.py`:

```python
@pytest.mark.asyncio
async def test_catchup_all_aggregates_results(tmp_path: Path):
    from hoga.api import watchlist
    from hoga.api.models import EnqueueResponse, QueueItem
    from unittest.mock import AsyncMock
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)

    def fake_helper(entry, *, data_dir, now):
        if entry.code == "003490":
            return EnqueueResponse(
                enqueued=[QueueItem(
                    item_id="003490-20260526", code="003490", date="20260526",
                    phase="queued", attempt=1, force_retry=False,
                    enqueued_at_ms=0, started_at_ms=None, finished_at_ms=None,
                    progress=None, error=None, skip_reason=None,
                )],
                deduped=[],
            )
        return EnqueueResponse(enqueued=[], deduped=[])

    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.catchup_one_entry",
               new_callable=AsyncMock, side_effect=fake_helper):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/catchup")
    assert r.status_code == 200
    body = r.json()
    results = {row["code"]: row for row in body["results"]}
    assert results["003490"]["enqueued_count"] == 1
    assert results["003490"]["deduped_count"] == 0
    assert results["003490"]["error"] is None
    assert results["005930"]["enqueued_count"] == 0


@pytest.mark.asyncio
async def test_catchup_all_per_entry_failure_does_not_abort(tmp_path: Path):
    from hoga.api import watchlist
    from hoga.api.models import EnqueueResponse
    from unittest.mock import AsyncMock
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)

    def fake_helper(entry, *, data_dir, now):
        if entry.code == "003490":
            raise RuntimeError("krx_credentials_missing")
        return EnqueueResponse(enqueued=[], deduped=[])

    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.catchup_one_entry",
               new_callable=AsyncMock, side_effect=fake_helper):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/catchup")
    assert r.status_code == 200
    body = r.json()
    results = {row["code"]: row for row in body["results"]}
    assert results["003490"]["error"] is not None
    assert "krx_credentials_missing" in results["003490"]["error"]
    assert results["005930"]["error"] is None


def test_catchup_all_empty_watchlist_returns_empty_results(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/catchup")
    assert r.status_code == 200
    assert r.json()["results"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_watchlist_routes.py -k catchup_all -v
```

Expected: FAIL — endpoint not registered.

- [ ] **Step 3: Add the endpoint**

Add to imports in `hoga/api/watchlist_routes.py`:

```python
from hoga.api.models import ManualCatchupAllEntryResult, ManualCatchupAllResponse
```

Inside `build_router` (after the per-row `catchup_one` handler), add:

```python
    @router.post("/catchup", response_model=ManualCatchupAllResponse)
    async def catchup_all() -> ManualCatchupAllResponse:
        now = now_kst()
        results: list[ManualCatchupAllEntryResult] = []
        for entry in load_watchlist(data_dir):
            try:
                resp = await catchup_one_entry(
                    entry, data_dir=data_dir, now=now,
                )
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=len(resp.enqueued),
                    deduped_count=len(resp.deduped),
                    error=None,
                ))
            except Exception as e:  # noqa: BLE001 — one bad entry mustn't kill the run
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=0, deduped_count=0,
                    error=str(e) or e.__class__.__name__,
                ))
        return ManualCatchupAllResponse(results=results)
```

**Route order:** Make sure `/catchup` is registered *before* `/{code}` patterns in the router. FastAPI uses path-order matching; if `/{code}` matched literal `"catchup"` first, it'd hit the per-row handler with `code="catchup"` and 400 with `invalid_code`. The cleanest way: add `catchup_all` *immediately after* the GET handler (which has no path param), before any `{code}`-pattern routes.

- [ ] **Step 4: Run tests**

```bash
uv run pytest tests/test_api_watchlist_routes.py -v
```

Expected: all PASS (3 new + existing).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist_routes.py tests/test_api_watchlist_routes.py
git commit -m "feat(watchlist): POST /api/watchlist/catchup run-all endpoint"
```

---

## Phase 3 — Frontend REST client + hooks

### Task 5: REST client (`catchupNow`, `catchupAll`)

**Files:**
- Modify: `frontend/src/api/watchlist.ts`
- Modify: `frontend/src/api/watchlist.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `frontend/src/api/watchlist.test.ts`:

```typescript
import {
  catchupNow,
  catchupAll,
  type EnqueueResponse,
  type ManualCatchupAllResponse,
} from './watchlist';

describe('watchlist manual catch-up', () => {
  it('catchupNow POSTs to /api/watchlist/{code}/catchup', async () => {
    const fake: EnqueueResponse = { enqueued: [], deduped: [] };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await catchupNow('003490');
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/watchlist/003490/catchup');
    expect(init?.method).toBe('POST');
    expect(r).toEqual(fake);
  });

  it('catchupAll POSTs to /api/watchlist/catchup', async () => {
    const fake: ManualCatchupAllResponse = { results: [] };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await catchupAll();
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/watchlist/catchup');
    expect(init?.method).toBe('POST');
    expect(r).toEqual(fake);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest --run src/api/watchlist.test.ts
```

Expected: FAIL — functions not exported.

- [ ] **Step 3: Add the functions + types**

In `frontend/src/api/watchlist.ts`, add at the bottom (after existing exports):

```typescript
// --- Manual catch-up (spec 2026-05-27) ------------------------------------

/** Minimal QueueItem shape — only the fields the frontend currently reads
 * from EnqueueResponse.enqueued. Mirrors backend hoga/api/models.py:QueueItem.
 * The frontend just counts items for the banner, so a thin shape is fine. */
export interface EnqueueQueueItem {
  item_id: string;
  code: string;
  date: string;
  phase: string;
}

export interface EnqueueDedupedRow {
  code: string;
  date: string;
  reason: string;
}

export interface EnqueueResponse {
  enqueued: EnqueueQueueItem[];
  deduped: EnqueueDedupedRow[];
}

export interface ManualCatchupAllEntryResult {
  code: string;
  name: string;
  enqueued_count: number;
  deduped_count: number;
  error: string | null;
}

export interface ManualCatchupAllResponse {
  results: ManualCatchupAllEntryResult[];
}

export function catchupNow(code: string): Promise<EnqueueResponse> {
  return apiCall<EnqueueResponse>(`/api/watchlist/${code}/catchup`, {
    method: 'POST',
  });
}

export function catchupAll(): Promise<ManualCatchupAllResponse> {
  return apiCall<ManualCatchupAllResponse>('/api/watchlist/catchup', {
    method: 'POST',
  });
}
```

- [ ] **Step 4: Run tests**

```bash
cd frontend && npx vitest --run src/api/watchlist.test.ts
```

Expected: 5 tests PASS (3 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/watchlist.ts frontend/src/api/watchlist.test.ts
git commit -m "feat(frontend): catchupNow + catchupAll REST client"
```

---

### Task 6: react-query mutation hooks (`useCatchupOne`, `useCatchupAll`)

**Files:**
- Modify: `frontend/src/watchlist/useWatchlist.ts`

No separate test — coverage comes from the Panel test in Task 9.

- [ ] **Step 1: Add the hooks**

Edit `frontend/src/watchlist/useWatchlist.ts`. Update the imports at the top:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  catchupNow,
  catchupAll,
  type WatchlistResponse,
  type EnqueueResponse,
  type ManualCatchupAllResponse,
} from '../api/watchlist';
```

Append to the same file (after `useRemoveFromWatchlist`):

```typescript
export function useCatchupOne() {
  const qc = useQueryClient();
  return useMutation<EnqueueResponse, Error, string>({
    mutationKey: ['watchlist', 'catchup-one'],
    mutationFn: (code: string) => catchupNow(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCatchupAll() {
  const qc = useQueryClient();
  return useMutation<ManualCatchupAllResponse, Error, void>({
    mutationKey: ['watchlist', 'catchup-all'],
    mutationFn: () => catchupAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
```

The `mutationKey` lets the Panel call `useIsMutating({ mutationKey: ['watchlist'] })` to detect any in-flight catch-up — see Task 9.

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors related to this file.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/watchlist/useWatchlist.ts
git commit -m "feat(frontend): useCatchupOne + useCatchupAll mutation hooks"
```

---

## Phase 4 — Frontend UI

### Task 7: Generalize Panel state from `justAdded` to `recentAction`

**Files:**
- Modify: `frontend/src/watchlist/WatchlistPanel.tsx`
- Modify: `frontend/src/watchlist/WatchlistPanel.test.tsx`

This is the state-shape change. Banner content for the new cases lands in Task 9. The existing `added` case still works after this task.

- [ ] **Step 1: Modify the Panel to use `recentAction`**

Replace the existing state declaration:

```typescript
const [justAdded, setJustAdded] = useState<{ code: string; name: string } | null>(null);
```

with:

```typescript
import type { ManualCatchupAllResponse } from '../api/watchlist';

type RecentAction =
  | { kind: 'added';         code: string; name: string }
  | { kind: 'caught_up_one'; code: string; name: string;
                             enqueued: number; deduped: number;
                             error?: string }
  | { kind: 'caught_up_all'; summary: ManualCatchupAllResponse['results'] };

const [recentAction, setRecentAction] = useState<RecentAction | null>(null);
```

Update the timer effect:

```typescript
useEffect(() => {
  if (!recentAction) return;
  const id = setTimeout(() => setRecentAction(null), JUST_ADDED_MS);
  return () => clearTimeout(id);
}, [recentAction]);
```

Update the `submit` handler's success branch:

```typescript
await addM.mutateAsync(picked.code);
setRecentAction({ kind: 'added', code: picked.code, name: picked.name });
```

Update the banner JSX (existing block that renders `justAdded`):

```tsx
{recentAction?.kind === 'added' && (
  <div className="mx-6 mt-3 px-3 py-2 rounded border text-sm"
       style={{
         background: 'rgba(34,197,94,0.10)',
         borderColor: 'rgba(34,197,94,0.30)',
         color: 'var(--success)',
       }}>
    ✓ {recentAction.name} ({recentAction.code}) 추가됨. 내일 18:00부터 자동 수집됩니다.
  </div>
)}
```

Update each `WatchlistRow`'s `justAdded` prop derivation:

```tsx
<WatchlistRow
  key={e.code}
  entry={e}
  onRemove={(c) => removeM.mutate(c)}
  removing={removeM.isPending && removeM.variables === e.code}
  justAdded={
    (recentAction?.kind === 'added' && recentAction.code === e.code) ||
    (recentAction?.kind === 'caught_up_one' && recentAction.code === e.code) ||
    recentAction?.kind === 'caught_up_all'
  }
/>
```

Note the `justAdded` prop on `WatchlistRow` keeps its name — the test seam (`data-just-added` attribute) stays for backward compatibility per the spec.

- [ ] **Step 2: Run existing Panel tests**

```bash
cd frontend && npx vitest --run src/watchlist/WatchlistPanel.test.tsx
```

Expected: 8 existing tests still PASS. The state rename is internal; banner output for `added` and the `data-just-added` attribute behavior are unchanged.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/watchlist/WatchlistPanel.tsx
git commit -m "refactor(watchlist): justAdded state → RecentAction union

No behavior change. Generalized state shape so the upcoming catch-up
banner cases (caught_up_one, caught_up_all) can reuse the same
5-second timer + row-highlight machinery. data-just-added attribute
stays as the load-bearing test seam."
```

---

### Task 8: `WatchlistRow` ↻ button

**Files:**
- Modify: `frontend/src/watchlist/WatchlistRow.tsx`

No separate test — coverage from Panel test in Task 9.

- [ ] **Step 1: Update `WatchlistRow.tsx`**

Replace the existing component with:

```typescript
import type { WatchlistEntry } from '../api/watchlist';

function fmtDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

export interface WatchlistRowProps {
  entry: WatchlistEntry;
  onRemove: (code: string) => void;
  onCatchup: (code: string) => void;
  removing: boolean;
  catchingUp: boolean;
  buttonsDisabled: boolean;
  justAdded?: boolean;
}

export function WatchlistRow({
  entry, onRemove, onCatchup,
  removing, catchingUp, buttonsDisabled,
  justAdded,
}: WatchlistRowProps) {
  return (
    <div
      data-testid={`row-${entry.code}`}
      data-just-added={justAdded ? 'true' : undefined}
      className="grid grid-cols-[6ch_1fr_8ch_8ch_2.5ch_2.5ch] items-center gap-3 px-6 py-2 border-b border-border text-sm hover:bg-bg-input"
      style={{
        background: justAdded ? 'var(--selection-tint)' : undefined,
        transition: 'background 800ms ease-out',
      }}
    >
      <span className="font-mono text-fg-dim">{entry.code}</span>
      <span className="truncate">{entry.name}</span>
      <span className="font-mono text-xs text-fg-dim">{fmtDate(entry.registered_at_kst_date)}</span>
      <span className="font-mono text-xs">
        {entry.last_success_date
          ? <span className="text-success">{fmtDate(entry.last_success_date)}</span>
          : <span className="text-fg-dimmer italic">아직 없음</span>}
      </span>
      <button
        type="button"
        aria-label={`Update ${entry.name}`}
        onClick={() => onCatchup(entry.code)}
        disabled={buttonsDisabled}
        className="text-fg-dimmer hover:text-accent disabled:opacity-40"
        style={catchingUp ? { animation: 'spin 1s linear infinite' } : undefined}
      >
        ↻
      </button>
      <button
        type="button"
        aria-label={`Remove ${entry.name}`}
        onClick={() => onRemove(entry.code)}
        disabled={buttonsDisabled}
        className="text-fg-dimmer hover:text-error disabled:opacity-40"
      >
        🗑
      </button>
    </div>
  );
}
```

The grid changes from 5 to 6 columns. Both buttons accept the unified `buttonsDisabled` so any in-flight mutation disables every ↻ and 🗑 on the page — matches the concurrency policy in the spec.

`@keyframes spin` should already be available via Tailwind's `animate-spin` infrastructure; using inline `animation: 'spin 1s linear infinite'` works because Tailwind's preflight registers the keyframes globally. If you find spin isn't registered, swap the inline style for `className={`text-fg-dimmer hover:text-accent disabled:opacity-40 ${catchingUp ? 'animate-spin' : ''}`}`.

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

The Panel still passes the old prop set — this will produce TS errors on missing `onCatchup`, `catchingUp`, `buttonsDisabled`. **That's expected** — Task 9 wires them up. Skip to the next task and don't commit yet.

- [ ] **Step 3: Defer the commit**

Don't commit this task alone — the Panel will fail to typecheck. Combine the commit with Task 9.

---

### Task 9: Header `↻ 지금 전체 수집` button + banner cases for catch-up

**Files:**
- Modify: `frontend/src/watchlist/WatchlistPanel.tsx`
- Modify: `frontend/src/watchlist/WatchlistPanel.test.tsx` (append)

- [ ] **Step 1: Write failing tests for the new behaviors**

Append to `frontend/src/watchlist/WatchlistPanel.test.tsx`:

```typescript
describe('WatchlistPanel manual catch-up', () => {
  it('per-row ↻ click triggers catchupNow and shows banner with counts', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [{
        code: '003490', name: '대한항공',
        registered_at_kst_date: '20260520', last_success_date: '20260524',
      }],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.catchupNow).mockResolvedValueOnce({
      enqueued: [
        { item_id: '003490-20260526', code: '003490', date: '20260526', phase: 'queued' },
        { item_id: '003490-20260527', code: '003490', date: '20260527', phase: 'queued' },
      ],
      deduped: [
        { code: '003490', date: '20260525', reason: 'already_complete' },
      ],
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByText('대한항공'));
    const updateBtn = screen.getByLabelText(/Update 대한항공/);
    await userEvent.click(updateBtn);
    await waitFor(() =>
      expect(api.catchupNow).toHaveBeenCalledWith('003490'));
    await waitFor(() =>
      expect(screen.getByText(/2건 추가/)).toBeInTheDocument());
    expect(screen.getByText(/1건 이미 완료/)).toBeInTheDocument();
  });

  it('per-row ↻ with empty result shows "수집할 거래일 없음"', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [{
        code: '003490', name: '대한항공',
        registered_at_kst_date: '20260520', last_success_date: '20260527',
      }],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.catchupNow).mockResolvedValueOnce({
      enqueued: [], deduped: [],
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByText('대한항공'));
    await userEvent.click(screen.getByLabelText(/Update 대한항공/));
    await waitFor(() =>
      expect(screen.getByText(/수집할 거래일 없음/)).toBeInTheDocument());
  });

  it('per-row ↻ with only deduped shows "이미 모두 수집됨"', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [{
        code: '003490', name: '대한항공',
        registered_at_kst_date: '20260520', last_success_date: '20260524',
      }],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.catchupNow).mockResolvedValueOnce({
      enqueued: [],
      deduped: [
        { code: '003490', date: '20260525', reason: 'already_complete' },
        { code: '003490', date: '20260526', reason: 'already_complete' },
      ],
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByText('대한항공'));
    await userEvent.click(screen.getByLabelText(/Update 대한항공/));
    await waitFor(() =>
      expect(screen.getByText(/이미 모두 수집됨/)).toBeInTheDocument());
  });

  it('header ↻ 지금 전체 수집 click triggers catchupAll and shows summary banner', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [
        { code: '003490', name: '대한항공',
          registered_at_kst_date: '20260520', last_success_date: '20260524' },
        { code: '005930', name: '삼성전자',
          registered_at_kst_date: '20260520', last_success_date: '20260524' },
      ],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.catchupAll).mockResolvedValueOnce({
      results: [
        { code: '003490', name: '대한항공',
          enqueued_count: 2, deduped_count: 1, error: null },
        { code: '005930', name: '삼성전자',
          enqueued_count: 0, deduped_count: 3, error: null },
      ],
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByText('대한항공'));
    const runAllBtn = screen.getByRole('button', { name: /지금 전체 수집/ });
    await userEvent.click(runAllBtn);
    await waitFor(() =>
      expect(api.catchupAll).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText(/2종목/)).toBeInTheDocument();
      expect(screen.getByText(/2건 추가/)).toBeInTheDocument();
      expect(screen.getByText(/4건 이미 완료/)).toBeInTheDocument();
    });
  });

  it('catchupAll with per-entry failure lists the failed code', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [
        { code: '003490', name: '대한항공',
          registered_at_kst_date: '20260520', last_success_date: null },
      ],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.catchupAll).mockResolvedValueOnce({
      results: [
        { code: '003490', name: '대한항공',
          enqueued_count: 0, deduped_count: 0,
          error: 'krx_credentials_missing' },
      ],
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByText('대한항공'));
    await userEvent.click(screen.getByRole('button', { name: /지금 전체 수집/ }));
    await waitFor(() =>
      expect(screen.getByText(/1종목 실패/)).toBeInTheDocument());
    expect(screen.getByText(/krx_credentials_missing/)).toBeInTheDocument();
  });
});
```

Also add to the existing `vi.mock('../api/watchlist')` setup the new function names so the mock module exposes them. Since `vi.mock` hoists and auto-mocks the entire module, `catchupNow` and `catchupAll` will be auto-mocked on top of the named exports — no manual stub needed. But verify the `vi.mocked(api.catchupNow)` lookups work; if vitest complains, add explicit `vi.fn()` entries to the mock factory.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest --run src/watchlist/WatchlistPanel.test.tsx
```

Expected: 5 new tests FAIL. Existing 8 tests should still PASS (Task 7's state rename was internal).

- [ ] **Step 3: Wire the Panel**

Edit `frontend/src/watchlist/WatchlistPanel.tsx`. Update imports:

```typescript
import { useEffect, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import type { ManualCatchupAllResponse } from '../api/watchlist';
import { Countdown } from './Countdown';
import { WatchlistRow } from './WatchlistRow';
import {
  useWatchlist,
  useAddToWatchlist,
  useRemoveFromWatchlist,
  useCatchupOne,
  useCatchupAll,
} from './useWatchlist';
```

Add the new hooks and the isMutating count near the existing mutation declarations:

```typescript
const addM = useAddToWatchlist();
const removeM = useRemoveFromWatchlist();
const catchupOneM = useCatchupOne();
const catchupAllM = useCatchupAll();
const inFlightCount = useIsMutating({ mutationKey: ['watchlist'] });
const anyInFlight = inFlightCount > 0;
```

Add per-row catchup and run-all handlers:

```typescript
const handleCatchupOne = (code: string) => {
  const entry = data?.entries.find((e) => e.code === code);
  if (!entry) return;
  catchupOneM.mutate(code, {
    onSuccess: (resp) => {
      setRecentAction({
        kind: 'caught_up_one',
        code, name: entry.name,
        enqueued: resp.enqueued.length,
        deduped: resp.deduped.length,
      });
    },
    onError: (err) => {
      setRecentAction({
        kind: 'caught_up_one',
        code, name: entry.name,
        enqueued: 0, deduped: 0,
        error: (err as Error).message,
      });
    },
  });
};

const handleCatchupAll = () => {
  catchupAllM.mutate(undefined, {
    onSuccess: (resp) => {
      setRecentAction({ kind: 'caught_up_all', summary: resp.results });
    },
  });
};
```

Update the header to add the run-all button next to the count badge:

```tsx
<div className="flex items-baseline justify-between">
  <h1 className="text-lg font-semibold">Watchlist</h1>
  <div className="flex items-center gap-2">
    <span className="font-mono tabular-nums text-xs text-fg-dimmer px-2 py-0.5 rounded bg-bg-input">
      {data.entries.length}종목
    </span>
    <button
      type="button"
      onClick={handleCatchupAll}
      disabled={anyInFlight || data.entries.length === 0}
      title="모든 종목을 지금 수집"
      className="px-2 py-0.5 rounded border border-border text-xs text-fg-dim hover:text-accent hover:border-accent disabled:opacity-40"
      style={catchupAllM.isPending ? { animation: 'spin 1s linear infinite' } : undefined}
    >
      ↻ 지금 전체 수집
    </button>
  </div>
</div>
```

Add the new banner blocks below the existing `added` banner:

```tsx
{recentAction?.kind === 'caught_up_one' && (
  <div className="mx-6 mt-3 px-3 py-2 rounded border text-sm"
       style={recentAction.error
         ? { background: 'rgba(244,63,94,0.10)',
             borderColor: 'rgba(244,63,94,0.30)',
             color: 'var(--error)' }
         : { background: 'rgba(34,197,94,0.10)',
             borderColor: 'rgba(34,197,94,0.30)',
             color: 'var(--success)' }}>
    {recentAction.error
      ? `${recentAction.name} (${recentAction.code}) 수집 실패: ${recentAction.error}`
      : recentAction.enqueued === 0 && recentAction.deduped === 0
        ? `${recentAction.name} (${recentAction.code}) 수집할 거래일 없음`
        : recentAction.enqueued === 0
          ? `✓ ${recentAction.name} (${recentAction.code}) 이미 모두 수집됨 (${recentAction.deduped}건)`
          : recentAction.deduped > 0
            ? `✓ ${recentAction.name} (${recentAction.code}) 수집 대기 중 — ${recentAction.enqueued}건 추가, ${recentAction.deduped}건 이미 완료`
            : `✓ ${recentAction.name} (${recentAction.code}) 수집 대기 중 — ${recentAction.enqueued}건 추가`}
  </div>
)}

{recentAction?.kind === 'caught_up_all' && (() => {
  const total = recentAction.summary;
  const enqueuedTotal = total.reduce((s, r) => s + r.enqueued_count, 0);
  const dedupedTotal = total.reduce((s, r) => s + r.deduped_count, 0);
  const failed = total.filter((r) => r.error != null);
  return (
    <div className="mx-6 mt-3 px-3 py-2 rounded border text-sm"
         style={{
           background: 'rgba(34,197,94,0.10)',
           borderColor: 'rgba(34,197,94,0.30)',
           color: 'var(--success)',
         }}>
      <div>
        ✓ 전체 catch-up: {total.length}종목, {enqueuedTotal}건 추가, {dedupedTotal}건 이미 완료
        {failed.length > 0 ? `, ${failed.length}종목 실패` : ''}
      </div>
      {failed.length > 0 && (
        <ul className="mt-1 text-xs text-error">
          {failed.map((r) => (
            <li key={r.code}>{r.code} ({r.name}): {r.error}</li>
          ))}
        </ul>
      )}
    </div>
  );
})()}
```

Update the row mapping to pass the new props:

```tsx
{data.entries.map((e) => (
  <WatchlistRow
    key={e.code}
    entry={e}
    onRemove={(c) => removeM.mutate(c)}
    onCatchup={handleCatchupOne}
    removing={removeM.isPending && removeM.variables === e.code}
    catchingUp={catchupOneM.isPending && catchupOneM.variables === e.code}
    buttonsDisabled={anyInFlight}
    justAdded={
      (recentAction?.kind === 'added' && recentAction.code === e.code) ||
      (recentAction?.kind === 'caught_up_one' && recentAction.code === e.code) ||
      recentAction?.kind === 'caught_up_all'
    }
  />
))}
```

- [ ] **Step 4: Update the test mock factory**

In `frontend/src/watchlist/WatchlistPanel.test.tsx`, update the existing `vi.mock('../api/watchlist')` block to explicitly include the new functions if vitest auto-mock isn't picking them up:

```typescript
vi.mock('../api/watchlist', () => ({
  getWatchlist: vi.fn(),
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
  catchupNow: vi.fn(),
  catchupAll: vi.fn(),
}));
```

And update the `beforeEach` to reset them:

```typescript
beforeEach(() => {
  vi.mocked(api.getWatchlist).mockReset();
  vi.mocked(api.addToWatchlist).mockReset();
  vi.mocked(api.removeFromWatchlist).mockReset();
  vi.mocked(api.catchupNow).mockReset();
  vi.mocked(api.catchupAll).mockReset();
});
```

- [ ] **Step 5: Run tests**

```bash
cd frontend && npx vitest --run src/watchlist/WatchlistPanel.test.tsx
```

Expected: all PASS (8 existing + 5 new = 13).

- [ ] **Step 6: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Commit (both Task 8 and Task 9 together)**

```bash
git add frontend/src/watchlist/WatchlistRow.tsx \
        frontend/src/watchlist/WatchlistPanel.tsx \
        frontend/src/watchlist/WatchlistPanel.test.tsx
git commit -m "feat(watchlist): per-row ↻ and header 지금 전체 수집 buttons

Row gains a ↻ button before 🗑 (grid widens to 6 columns). Header gains
a ↻ 지금 전체 수집 button next to the count badge. Both share the
single-mutation-at-a-time concurrency policy via useIsMutating with
mutationKey: ['watchlist'].

Banners cover five cases: added, caught_up_one (4 sub-cases by enqueued
× deduped × error), caught_up_all (with a per-entry failure list).
All cases share the existing 5-second auto-dismiss timer and the
data-just-added row tint."
```

---

## Phase 5 — Final verification

### Task 10: Integration smoke + invariant checks

**Files:** None modified — verification only.

- [ ] **Step 1: Run the full backend suite**

```bash
uv run pytest -q
```

Expected: same passing count as before the plan started, plus the new tests. Any pre-existing failures (e.g. `test_e2e_completeness`) are unrelated.

- [ ] **Step 2: Run the full frontend suite**

```bash
cd frontend && npx vitest --run && npx tsc --noEmit
```

Expected: green.

- [ ] **Step 3: Verify ADR-0034 invariant still holds**

```bash
grep -nE "_queue|_active|_done|_inflight_paths" hoga/api/scheduler.py
```

Expected: matches ONLY in docstring text (lines 8-9 from the existing module header). No code references.

- [ ] **Step 4: Verify the new endpoints go through `catchup_one_entry`, not `enqueue_items_core` directly**

```bash
grep -nE "enqueue_items_core" hoga/api/watchlist_routes.py
```

Expected: **no matches**. The routes call `catchup_one_entry` which internally calls `enqueue_items_core` — preserves the layered design.

- [ ] **Step 5: Manual smoke test in browser**

1. Start the backend (`uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga`) and frontend (`cd frontend && npm run dev`).
2. Navigate to http://localhost:5173/watchlist.
3. Click `↻` on a row that has `last_success_date` from a few days ago. Confirm:
   - Spinner appears on the row
   - Other ↻ and 🗑 buttons become disabled
   - After response, success banner appears with the correct counts
   - The row is teal-tinted for ~5 seconds
   - Banner auto-dismisses after 5 seconds
4. Click the header `↻ 지금 전체 수집`. Confirm:
   - Header button spinner
   - All buttons on the page disable
   - Summary banner appears showing per-entry counts
   - All rows highlight teal briefly
5. Open Capture tab — confirm new queue items appeared.

- [ ] **Step 6: Commit (empty)**

```bash
git commit --allow-empty -m "test(watchlist): manual catch-up smoke verified"
```

---

## Notes for the implementer

- **Test commands**: Backend uses `uv run pytest`. Frontend uses `npx vitest --run` (no `npm test` script in `frontend/package.json`).
- **Concurrent-agent caution** (per `memory/feedback_no_concurrent_agents_in_worktree.md`): run `git status --porcelain` before each commit and stage only your task's files. The worktree may have unrelated foreign changes from parallel agents.
- **Korean text**: the codebase uses Korean for user-visible strings. Match the surrounding voice; the banner Korean strings in this plan are the canonical templates.
- **Route order** (Task 4): `POST /catchup` MUST be registered before `POST /{code}/catchup` to avoid FastAPI matching `/catchup` against the `{code}` pattern.
- **`useIsMutating` mutationKey**: both hook mutations declare `mutationKey: ['watchlist', 'catchup-one' | 'catchup-all']`. The `useIsMutating({ mutationKey: ['watchlist'] })` call in the Panel matches by prefix. Add/remove mutations (existing) also need `mutationKey: ['watchlist', 'add' | 'remove']` to participate in the disable-all-buttons policy — update them in Task 6 if not already done.

---

## Plan self-review

**Spec coverage check:**
- §"Refactor: extract `catchup_one_entry`" → Task 1 ✓
- §"New endpoints" (per-row + all-rows) → Tasks 3, 4 ✓
- §`WatchlistRow.tsx` (↻ button, 6 columns) → Task 8 ✓
- §`WatchlistPanel.tsx` (header button, RecentAction state, 5 banner cases) → Tasks 7, 9 ✓
- §"Concurrency policy" (useIsMutating + buttonsDisabled) → Task 9 ✓
- §"Error handling" (404, 503, all-rows per-entry error) → Tasks 3, 4 ✓
- §"Testing" coverage matrix → matched task-by-task ✓

**Placeholder scan:** 0 matches for TBD/TODO/etc.

**Type consistency:** `EnqueueResponse`, `ManualCatchupAllResponse`, `WatchlistEntry`, `RecentAction`, `useCatchupOne`, `useCatchupAll`, `catchup_one_entry` all named consistently across tasks.

**One gap acknowledged:** the `mutationKey` for existing add/remove mutations isn't already set — if Task 6 inherits the existing hook file without `mutationKey: ['watchlist', 'add' | 'remove']`, the `useIsMutating({mutationKey: ['watchlist']})` count will undercount. Implementer should add those keys when touching `useWatchlist.ts` in Task 6 (noted in the implementation notes).
