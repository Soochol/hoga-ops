# Watchlist + Daily Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Watchlist of Codes that hoga-ops captures automatically at KST 18:00 each trading day, plus a startup catch-up that backfills missed trading days since each entry's last successful capture.

**Architecture:** A `Daily Scheduler` and `Catch-up Run` (both asyncio tasks in the same uvicorn process as the existing capture pool) act as in-process *clients* of the Capture Queue — they call a new module-level `captures.enqueue_items_core()` (extracted from the current router inner closure) so ADR-0033 dedupe, ADR-0019 persist, ADR-0031 retry, and cookie-pause are all inherited. The Q14 18:00 guard is the one carve-out: the Scheduler pre-trims today via `eligibility.find_ineligible_dates` before calling core, because core rejects on Q14 rather than trimming. See ADR-0034 for the invariant.

**Tech Stack:** Python (asyncio, FastAPI, Pydantic v2), `_atomic_write.py` for JSON persistence; React + TypeScript + @tanstack/react-query for the UI; existing `SymbolSearch` component reused for the add input.

**Spec:** `docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md`
**ADR:** `docs/adr/0034-scheduler-as-queue-client.md`
**CONTEXT terms:** Watchlist, WatchlistEntry, Daily Scheduler, Catch-up Run (all in `CONTEXT.md`)

---

## File Structure

### Created

- `hoga/api/watchlist.py` — domain model, persistence, async-safe mutations
- `hoga/api/watchlist_routes.py` — FastAPI router for `/api/watchlist`
- `hoga/api/scheduler.py` — `_daily_loop`, `_catchup_run`, `start_scheduler`, `seconds_until_next_18_kst`
- `tests/test_api_watchlist.py` — domain + persistence + lock tests
- `tests/test_api_watchlist_routes.py` — route tests
- `tests/test_api_scheduler.py` — time helper + fake-clock scheduler tests
- `frontend/src/api/watchlist.ts` — REST client + types
- `frontend/src/watchlist/useWatchlist.ts` — react-query hook
- `frontend/src/watchlist/WatchlistPanel.tsx` — main panel
- `frontend/src/watchlist/WatchlistRow.tsx` — single row
- `frontend/src/watchlist/Countdown.tsx` — "next run in HH:MM:SS" component
- `frontend/src/pages/Watchlist.tsx` — route page wrapper
- `frontend/src/api/watchlist.test.ts`, `frontend/src/watchlist/*.test.tsx`

### Modified

- `hoga/api/captures.py` — extract `enqueue_items_core`; add `bump_last_success` call in `_finalize_item`
- `hoga/api/models.py` — `WatchlistEntry`, `WatchlistResponse`, `WatchlistAddRequest` Pydantic models
- `hoga/api/app.py` — mount watchlist router, start scheduler in lifespan
- `frontend/src/main.tsx` — add `/watchlist` route
- `frontend/src/nav/LeftNav.tsx` — add "Watchlist" nav item

---

## Phase 1 — Refactor enabler (ADR-0034)

### Task 1: Extract `enqueue_items_core` from router inner function

**Files:**
- Modify: `hoga/api/captures.py:970-1108` (the `enqueue_items` inner function inside `build_router`)
- Test: `tests/test_api_captures_queue.py` (extend with module-level call test)

This task moves the existing `enqueue_items` handler body to a module-level coroutine without changing behavior. The router becomes a thin wrapper. No new tests for changed behavior — the existing route tests cover the wrapper; the new test verifies the module-level function is callable directly.

- [ ] **Step 1: Write a failing test for the module-level entry point**

Append to `tests/test_api_captures_queue.py`:

```python
def test_enqueue_items_core_is_module_level_and_callable():
    """ADR-0034: scheduler.py must be able to import enqueue_items_core
    without going through the router."""
    from hoga.api import captures as caps
    assert hasattr(caps, "enqueue_items_core"), \
        "enqueue_items_core must be module-level for ADR-0034"
    import asyncio
    assert asyncio.iscoroutinefunction(caps.enqueue_items_core)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run pytest tests/test_api_captures_queue.py::test_enqueue_items_core_is_module_level_and_callable -v
```

Expected: FAIL with `AttributeError` or `assert hasattr(...)` failure.

- [ ] **Step 3: Extract the inner function**

In `hoga/api/captures.py`, before `def build_router(...)` (around line 950 — after the `_retry_items` helpers), insert:

```python
async def enqueue_items_core(
    req: EnqueueRequest,
    *,
    data_dir: Path,
    now: dt.datetime,
) -> EnqueueResponse:
    """Module-level enqueue logic. The router handler is a thin wrapper.

    ADR-0034: this is the single entry point both the REST route and the
    Daily Scheduler use. Behavior is unchanged from the original inner
    function — see git history for the move.

    The ``data_dir`` and ``now`` parameters were previously read via
    ``_require_data_dir()`` and ``_now_kst()`` at the top of the handler.
    Callers now pass them explicitly; the route wrapper injects them.
    """
    # ── BODY MOVED VERBATIM FROM enqueue_items ──
    # 1. Expand to a flat list of candidate dates.
    if req.dates is not None:
        candidate_dates = list(req.dates)
    elif req.start_date and req.end_date:
        try:
            loop = asyncio.get_running_loop()
            candidate_dates = await loop.run_in_executor(
                None,
                _expand_to_trading_days,
                req.start_date,
                req.end_date,
            )
        except KrxUnavailableError as e:
            raise HTTPException(status_code=503, detail={
                "code": e.code,
                "message": (
                    "KRX trading-day list unavailable. Configure KRX_ID / KRX_PW "
                    "in repo-root .env and try again."
                ),
            }) from e
    else:
        raise HTTPException(status_code=400, detail={
            "code": CaptureErrorCode.MISSING_RANGE,
            "message": "Provide either dates=[...] or start_date+end_date.",
        })

    # 2. Q14 today-too-early guard.
    too_early = find_ineligible_dates(candidate_dates=candidate_dates, now=now)
    if too_early:
        raise HTTPException(status_code=400, detail={
            "code": CaptureErrorCode.TODAY_TOO_EARLY,
            "message": (
                f"Dates {too_early} are today (KST) and now.hour={now.hour} < 18."
            ),
            "dates": too_early,
        })

    # 3. Q15 Layer 1 dedupe + ADR-0033 phase-aware _done dedupe.
    # ... (KEEP THE REST OF THE EXISTING BODY UNCHANGED, including
    # _publish_queue_mutations calls at the bottom) ...
```

**Important:** Copy the *entire* current body lines 980-1108 verbatim into the new function. Replace all references to the route's local `data_dir` / `now` variables — but they were already named `data_dir` / `now` in the original, so the body works as-is. Do NOT modify dedupe logic, response construction, or event publishing.

Then replace the inner function with a 5-line wrapper:

```python
    @router.post("/items", status_code=201)
    async def enqueue_items(req: EnqueueRequest) -> EnqueueResponse:
        """Thin wrapper around ``enqueue_items_core`` (ADR-0034)."""
        return await enqueue_items_core(
            req,
            data_dir=_require_data_dir(),
            now=_now_kst(),
        )
```

- [ ] **Step 4: Run the new test and the full queue test suite**

```bash
uv run pytest tests/test_api_captures_queue.py tests/test_api.py -v
```

Expected: all pass. The existing route tests confirm the wrapper preserves behavior.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "refactor(captures): extract enqueue_items_core for ADR-0034

Move the body of enqueue_items (the router inner function) to a module-
level coroutine that takes data_dir and now as explicit parameters.
The route handler becomes a 5-line wrapper injecting them. No behavior
change. Scheduler can now import enqueue_items_core directly."
```

---

## Phase 2 — Watchlist domain & persistence

### Task 2: Pydantic models for the Watchlist API

**Files:**
- Modify: `hoga/api/models.py` (append after existing models)
- Test: `tests/test_models.py` (append)

- [ ] **Step 1: Write failing tests for the models**

Append to `tests/test_models.py`:

```python
def test_watchlist_entry_validates_code_format():
    from hoga.api.models import WatchlistEntry
    import pytest
    from pydantic import ValidationError
    # Valid
    WatchlistEntry(
        code="003490",
        name="대한항공",
        registered_at_kst_date="20260526",
        last_success_date=None,
    )
    # Bad code (5 digits)
    with pytest.raises(ValidationError):
        WatchlistEntry(
            code="00349",
            name="대한항공",
            registered_at_kst_date="20260526",
            last_success_date=None,
        )
    # Bad date format
    with pytest.raises(ValidationError):
        WatchlistEntry(
            code="003490",
            name="대한항공",
            registered_at_kst_date="2026-05-26",  # has hyphens
            last_success_date=None,
        )


def test_watchlist_response_carries_next_run_ms():
    from hoga.api.models import WatchlistResponse
    resp = WatchlistResponse(entries=[], next_run_at_ms=1716714000000)
    assert resp.next_run_at_ms == 1716714000000


def test_watchlist_add_request_validates_code():
    from hoga.api.models import WatchlistAddRequest
    import pytest
    from pydantic import ValidationError
    WatchlistAddRequest(code="003490")
    with pytest.raises(ValidationError):
        WatchlistAddRequest(code="ABCDEF")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_models.py -k watchlist -v
```

Expected: FAIL (ImportError on `WatchlistEntry`).

- [ ] **Step 3: Add models to `hoga/api/models.py`**

Append at the end of `hoga/api/models.py`:

```python
# --- Watchlist (see spec 2026-05-26 and ADR-0034) --------------------------


class WatchlistEntry(BaseModel):
    """One Code in the Watchlist. See CONTEXT.md WatchlistEntry."""

    code: str = Field(pattern=r"^\d{6}$")
    name: str
    registered_at_kst_date: str = Field(pattern=r"^\d{8}$")
    last_success_date: str | None = Field(default=None, pattern=r"^\d{8}$")


class WatchlistResponse(BaseModel):
    entries: list[WatchlistEntry]
    next_run_at_ms: int  # Unix-ms of next KST 18:00 boundary (ADR-0003)


class WatchlistAddRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_models.py -k watchlist -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/test_models.py
git commit -m "feat(watchlist): add Pydantic models for Watchlist API"
```

---

### Task 3: `watchlist.py` — load / save / corrupted recovery

**Files:**
- Create: `hoga/api/watchlist.py`
- Create: `tests/test_api_watchlist.py`

- [ ] **Step 1: Write failing tests for load/save round-trip and missing-file handling**

Create `tests/test_api_watchlist.py`:

```python
"""Watchlist persistence + mutation tests. See spec 2026-05-26."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest


def test_load_returns_empty_when_file_missing(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist
    wl = load_watchlist(tmp_path)
    assert wl.entries == []


def test_save_then_load_round_trip(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist, save_watchlist
    from hoga.api.models import WatchlistEntry
    entry = WatchlistEntry(
        code="003490",
        name="대한항공",
        registered_at_kst_date="20260526",
        last_success_date=None,
    )
    save_watchlist(tmp_path, entries=[entry])
    wl = load_watchlist(tmp_path)
    assert len(wl.entries) == 1
    assert wl.entries[0].code == "003490"
    assert wl.entries[0].name == "대한항공"


def test_corrupted_json_is_backed_up_and_returns_empty(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist
    (tmp_path / "watchlist.json").write_text("not valid json at all")
    wl = load_watchlist(tmp_path)
    assert wl.entries == []
    # Original is moved aside.
    assert not (tmp_path / "watchlist.json").exists()
    backups = list(tmp_path.glob("watchlist.json.corrupt-*"))
    assert len(backups) == 1


def test_corrupted_pydantic_validation_is_also_backed_up(tmp_path: Path):
    from hoga.api.watchlist import load_watchlist
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [{"code": "BAD", "name": "x",
                     "registered_at_kst_date": "20260526",
                     "last_success_date": None}],
    }))
    wl = load_watchlist(tmp_path)
    assert wl.entries == []
    assert list(tmp_path.glob("watchlist.json.corrupt-*"))
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_watchlist.py -v
```

Expected: FAIL with `ModuleNotFoundError: hoga.api.watchlist`.

- [ ] **Step 3: Create `hoga/api/watchlist.py` with load/save**

```python
"""Watchlist persistence + async-safe mutations.

See CONTEXT.md ("Watchlist", "WatchlistEntry") and spec
docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md.

ADR-0034 invariant: the Daily Scheduler / Catch-up Run import this
module, but this module does NOT import captures.py. The reverse
dependency (captures.py importing bump_last_success) goes through a
local-import to avoid cycles.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from dataclasses import dataclass
from pathlib import Path

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import WatchlistEntry

log = logging.getLogger(__name__)

# Module-scope lock — serializes load → mutate → save across all writers
# (API POST/DELETE and the _finalize_item hook).
_lock = asyncio.Lock()


@dataclass(frozen=True)
class Watchlist:
    """In-memory snapshot. Order preserved = display order."""
    entries: list[WatchlistEntry]


def _path(data_dir: Path) -> Path:
    return data_dir / "watchlist.json"


def load_watchlist(data_dir: Path) -> Watchlist:
    """Read watchlist.json. Missing file → empty. Corrupt file → backup +
    empty + warning log."""
    p = _path(data_dir)
    if not p.exists():
        return Watchlist(entries=[])
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        entries = [WatchlistEntry.model_validate(e) for e in raw.get("entries", [])]
        return Watchlist(entries=entries)
    except Exception as e:  # noqa: BLE001 — any parse/validation failure
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = p.with_name(f"watchlist.json.corrupt-{stamp}")
        try:
            p.rename(backup)
        except OSError:
            log.exception("could not back up corrupt watchlist.json")
        log.warning("watchlist.json was corrupt (%s); backed up to %s",
                    e, backup)
        return Watchlist(entries=[])


def save_watchlist(data_dir: Path, *, entries: list[WatchlistEntry]) -> None:
    """Atomic write."""
    payload = {
        "version": 1,
        "entries": [e.model_dump() for e in entries],
    }
    atomic_write_json(_path(data_dir), payload)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_watchlist.py -v
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist.py tests/test_api_watchlist.py
git commit -m "feat(watchlist): load/save with corrupted-file backup recovery"
```

---

### Task 4: `watchlist.py` — `add_entry`, `remove_entry`, `bump_last_success`

**Files:**
- Modify: `hoga/api/watchlist.py`
- Modify: `tests/test_api_watchlist.py`

- [ ] **Step 1: Write failing tests for the three mutations under lock**

Append to `tests/test_api_watchlist.py`:

```python
@pytest.mark.asyncio
async def test_add_entry_inserts(tmp_path: Path):
    from hoga.api.watchlist import add_entry, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    wl = load_watchlist(tmp_path)
    assert [e.code for e in wl.entries] == ["003490"]
    assert wl.entries[0].registered_at_kst_date == "20260526"
    assert wl.entries[0].last_success_date is None


@pytest.mark.asyncio
async def test_add_entry_duplicate_raises(tmp_path: Path):
    from hoga.api.watchlist import add_entry, AlreadyInWatchlistError
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    with pytest.raises(AlreadyInWatchlistError):
        await add_entry(tmp_path, code="003490", name="대한항공",
                        today_kst_date="20260527")


@pytest.mark.asyncio
async def test_remove_entry(tmp_path: Path):
    from hoga.api.watchlist import add_entry, remove_entry, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await remove_entry(tmp_path, code="003490")
    assert load_watchlist(tmp_path).entries == []


@pytest.mark.asyncio
async def test_remove_entry_missing_raises(tmp_path: Path):
    from hoga.api.watchlist import remove_entry, NotInWatchlistError
    with pytest.raises(NotInWatchlistError):
        await remove_entry(tmp_path, code="003490")


@pytest.mark.asyncio
async def test_bump_last_success_advances_marker(tmp_path: Path):
    from hoga.api.watchlist import add_entry, bump_last_success, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await bump_last_success(tmp_path, code="003490", date="20260527")
    assert load_watchlist(tmp_path).entries[0].last_success_date == "20260527"


@pytest.mark.asyncio
async def test_bump_last_success_does_not_regress(tmp_path: Path):
    from hoga.api.watchlist import add_entry, bump_last_success, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await bump_last_success(tmp_path, code="003490", date="20260528")
    await bump_last_success(tmp_path, code="003490", date="20260527")  # older
    assert load_watchlist(tmp_path).entries[0].last_success_date == "20260528"


@pytest.mark.asyncio
async def test_bump_last_success_ignores_unwatched_code(tmp_path: Path):
    """Ad-hoc captures of non-watched Codes must not create entries."""
    from hoga.api.watchlist import bump_last_success, load_watchlist
    await bump_last_success(tmp_path, code="005930", date="20260527")
    assert load_watchlist(tmp_path).entries == []


@pytest.mark.asyncio
async def test_concurrent_bumps_serialize(tmp_path: Path):
    """Two simultaneous bumps must not clobber each other."""
    import asyncio
    from hoga.api.watchlist import add_entry, bump_last_success, load_watchlist
    await add_entry(tmp_path, code="003490", name="대한항공",
                    today_kst_date="20260526")
    await add_entry(tmp_path, code="005930", name="삼성전자",
                    today_kst_date="20260526")
    await asyncio.gather(
        bump_last_success(tmp_path, code="003490", date="20260527"),
        bump_last_success(tmp_path, code="005930", date="20260527"),
    )
    wl = load_watchlist(tmp_path)
    by_code = {e.code: e.last_success_date for e in wl.entries}
    assert by_code == {"003490": "20260527", "005930": "20260527"}
```

Also add to the top of `tests/test_api_watchlist.py`:
```python
pytestmark = pytest.mark.asyncio
```

(Or keep per-test marks as shown — both are fine.)

Confirm `pytest-asyncio` is in the dev deps:

```bash
grep -E "pytest-asyncio|asyncio_mode" pyproject.toml
```

If not present, add `pytest-asyncio` to `[dependency-groups].dev` in pyproject.toml and run `uv sync --group dev`. Otherwise skip.

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_watchlist.py -v
```

Expected: FAIL — `add_entry`, `remove_entry`, `bump_last_success`, `AlreadyInWatchlistError`, `NotInWatchlistError` don't exist.

- [ ] **Step 3: Add mutations + exceptions to `hoga/api/watchlist.py`**

Append to `hoga/api/watchlist.py`:

```python
class AlreadyInWatchlistError(Exception):
    """Raised by add_entry when the Code is already present."""


class NotInWatchlistError(Exception):
    """Raised by remove_entry when the Code is absent."""


async def add_entry(
    data_dir: Path,
    *,
    code: str,
    name: str,
    today_kst_date: str,
) -> WatchlistEntry:
    async with _lock:
        wl = load_watchlist(data_dir)
        if any(e.code == code for e in wl.entries):
            raise AlreadyInWatchlistError(code)
        entry = WatchlistEntry(
            code=code,
            name=name,
            registered_at_kst_date=today_kst_date,
            last_success_date=None,
        )
        save_watchlist(data_dir, entries=[*wl.entries, entry])
        return entry


async def remove_entry(data_dir: Path, *, code: str) -> None:
    async with _lock:
        wl = load_watchlist(data_dir)
        if not any(e.code == code for e in wl.entries):
            raise NotInWatchlistError(code)
        save_watchlist(
            data_dir,
            entries=[e for e in wl.entries if e.code != code],
        )


async def bump_last_success(
    data_dir: Path,
    *,
    code: str,
    date: str,
) -> None:
    """Advance ``last_success_date`` for ``code`` if ``date`` is newer.

    Silent no-op when ``code`` is not in the Watchlist (capture was ad-hoc)
    or when ``date`` is not newer than the existing marker (out-of-order
    completions cannot regress).
    """
    async with _lock:
        wl = load_watchlist(data_dir)
        new_entries: list[WatchlistEntry] = []
        changed = False
        for e in wl.entries:
            if e.code == code and (
                e.last_success_date is None or date > e.last_success_date
            ):
                new_entries.append(e.model_copy(update={"last_success_date": date}))
                changed = True
            else:
                new_entries.append(e)
        if changed:
            save_watchlist(data_dir, entries=new_entries)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_watchlist.py -v
```

Expected: all PASS (8+ tests).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist.py tests/test_api_watchlist.py pyproject.toml
git commit -m "feat(watchlist): add/remove/bump_last_success under asyncio.Lock"
```

(If pyproject.toml was unchanged, drop it from the add list.)

---

## Phase 3 — Scheduler

### Task 5: `seconds_until_next_18_kst` time helper

**Files:**
- Create: `hoga/api/scheduler.py`
- Create: `tests/test_api_scheduler.py`

- [ ] **Step 1: Write failing tests for the boundary calculation**

Create `tests/test_api_scheduler.py`:

```python
"""Scheduler unit tests. See spec 2026-05-26 + ADR-0034."""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import pytest


KST = ZoneInfo("Asia/Seoul")


def _at(h: int, m: int = 0, day: int = 26) -> dt.datetime:
    return dt.datetime(2026, 5, day, h, m, 0, tzinfo=KST)


def test_before_18_returns_today_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(17, 59))
    assert 50 < secs < 70


def test_at_exactly_18_returns_tomorrow_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(18, 0))
    assert secs == pytest.approx(24 * 3600, abs=2)


def test_after_18_returns_tomorrow_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(18, 1))
    # 23h 59m to tomorrow's 18:00.
    assert 23 * 3600 + 59 * 60 - 2 < secs < 23 * 3600 + 59 * 60 + 2


def test_midnight_returns_18h():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(0, 0))
    assert secs == pytest.approx(18 * 3600, abs=2)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_scheduler.py -v
```

Expected: FAIL — `ModuleNotFoundError: hoga.api.scheduler`.

- [ ] **Step 3: Create `hoga/api/scheduler.py` with the helper**

```python
"""Daily Scheduler + Catch-up Run for the Watchlist.

See CONTEXT.md ("Daily Scheduler", "Catch-up Run"), spec
docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md,
and ADR-0034 (Scheduler is a queue client, not a peer).

The scheduler MUST go through ``captures.enqueue_items_core`` for all
enqueues. Direct manipulation of ``captures._queue`` / ``_active`` /
``_done`` is forbidden — see ADR-0034.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path


def seconds_until_next_18_kst(now: dt.datetime) -> float:
    """Seconds from ``now`` until the next KST 18:00 boundary.

    If ``now`` is exactly 18:00 or later, returns the duration to
    *tomorrow's* 18:00. ``now`` must be tz-aware (Asia/Seoul).
    """
    today_18 = now.replace(hour=18, minute=0, second=0, microsecond=0)
    target = today_18 if now < today_18 else today_18 + dt.timedelta(days=1)
    return (target - now).total_seconds()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_scheduler.py -v
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/scheduler.py tests/test_api_scheduler.py
git commit -m "feat(scheduler): seconds_until_next_18_kst helper"
```

---

### Task 6: `_daily_run` — enqueue today for every Watchlist entry

**Files:**
- Modify: `hoga/api/scheduler.py`
- Modify: `tests/test_api_scheduler.py`

- [ ] **Step 1: Write failing tests for `_daily_run` behavior**

Append to `tests/test_api_scheduler.py`:

```python
import datetime as dt
from unittest.mock import AsyncMock, patch
from pathlib import Path


@pytest.mark.asyncio
async def test_daily_run_enqueues_each_watchlist_entry_on_trading_day(tmp_path: Path):
    from hoga.api import scheduler, watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 18, 0, 0, tzinfo=KST)  # Tuesday

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        await scheduler._daily_run(tmp_path)

    # Two calls — one per Watchlist entry.
    assert enq.await_count == 2
    codes = sorted(c.kwargs["req"].code if "req" in c.kwargs
                   else c.args[0].code for c in enq.await_args_list)
    assert codes == ["003490", "005930"]


@pytest.mark.asyncio
async def test_daily_run_skips_non_trading_day(tmp_path: Path):
    from hoga.api import scheduler, watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 24, 18, 0, 0, tzinfo=KST)  # Sunday

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        await scheduler._daily_run(tmp_path)

    assert enq.await_count == 0


@pytest.mark.asyncio
async def test_daily_run_per_entry_failure_does_not_abort_loop(tmp_path: Path):
    """One bad entry must not stop later entries from being enqueued."""
    from fastapi import HTTPException
    from hoga.api import scheduler, watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 18, 0, 0, tzinfo=KST)

    async def flaky(req, *, data_dir, now):
        if req.code == "003490":
            raise HTTPException(status_code=503,
                                detail={"code": "krx_credentials_missing"})
        from hoga.api.models import EnqueueResponse
        return EnqueueResponse(enqueued=[], deduped=[])

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               side_effect=flaky) as enq:
        await scheduler._daily_run(tmp_path)

    assert enq.await_count == 2  # Both attempted despite the first failing.
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_scheduler.py -v
```

Expected: FAIL — `_daily_run` / `now_kst` / `trading_days_in_range` / `enqueue_items_core` not bound at module level.

- [ ] **Step 3: Implement `_daily_run` and imports**

Append to `hoga/api/scheduler.py`:

```python
import logging

from hoga.api.calendar import trading_days_in_range
from hoga.api.captures import enqueue_items_core
from hoga.api.models import EnqueueRequest
from hoga.api.watchlist import load_watchlist
from hoga.collector.orchestrator import now_kst

log = logging.getLogger(__name__)


async def _daily_run(data_dir: Path) -> None:
    """Enqueue ``(code, today_kst)`` for every Watchlist entry on a
    trading day. Per-entry exceptions are logged; the loop continues.
    """
    now = now_kst()
    today = now.strftime("%Y%m%d")
    trading = trading_days_in_range(today, today)
    if today not in trading:
        log.info("daily run: %s is not a trading day, skipping", today)
        return
    wl = load_watchlist(data_dir)
    for entry in wl.entries:
        try:
            await enqueue_items_core(
                EnqueueRequest(code=entry.code, dates=[today]),
                data_dir=data_dir,
                now=now,
            )
        except Exception:  # noqa: BLE001 — one bad entry mustn't kill the run
            log.exception("daily enqueue failed for %s/%s", entry.code, today)
```

**Note:** `trading_days_in_range` may raise `KrxUnavailableError`. Wrap the call:

Replace the body's trading-day check with:

```python
    try:
        trading = trading_days_in_range(today, today)
    except Exception:  # noqa: BLE001
        log.warning("daily run: trading-day check failed, skipping")
        return
    if today not in trading:
        log.info("daily run: %s is not a trading day, skipping", today)
        return
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_scheduler.py -v
```

Expected: 3 new tests PASS, time-helper tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/scheduler.py tests/test_api_scheduler.py
git commit -m "feat(scheduler): _daily_run — enqueue today for each watchlist entry"
```

---

### Task 7: `_catchup_run` — backfill since last_success per entry

**Files:**
- Modify: `hoga/api/scheduler.py`
- Modify: `tests/test_api_scheduler.py`

- [ ] **Step 1: Write failing tests for catch-up date math + Q14 pre-trim**

Append to `tests/test_api_scheduler.py`:

```python
@pytest.mark.asyncio
async def test_catchup_enqueues_gap_since_last_success(tmp_path: Path):
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260522")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)  # after 18

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260525", "20260526"]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler._catchup_run(tmp_path)

    assert enq.await_count == 1
    call_req = enq.await_args.kwargs["req"]
    assert call_req.code == "003490"
    assert call_req.dates == ["20260525", "20260526"]


@pytest.mark.asyncio
async def test_catchup_pretrims_today_when_too_early(tmp_path: Path):
    """When now < 18:00, today must be removed before calling core."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260522")
    fake_now = dt.datetime(2026, 5, 26, 10, 0, 0, tzinfo=KST)  # before 18

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260525", "20260526"]), \
         patch("hoga.api.scheduler.find_ineligible_dates",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler._catchup_run(tmp_path)

    assert enq.await_args.kwargs["req"].dates == ["20260525"]


@pytest.mark.asyncio
async def test_catchup_uses_registered_at_when_no_last_success(tmp_path: Path):
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260521", "20260522"]) as trading, \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler._catchup_run(tmp_path)

    # next_kst_day(20260520) = 20260521
    trading.assert_called_with("20260521", "20260526")
    assert enq.await_count == 1


@pytest.mark.asyncio
async def test_catchup_skips_entry_with_empty_range(tmp_path: Path):
    """If last_success >= today, the gap is empty — no enqueue."""
    from hoga.api import scheduler, watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260526")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        await scheduler._catchup_run(tmp_path)
    # Gap is [next_day(20260526)=20260527 .. 20260526] which is empty.
    assert enq.await_count == 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_scheduler.py -k catchup -v
```

Expected: FAIL — `_catchup_run` / `find_ineligible_dates` not bound.

- [ ] **Step 3: Implement `_catchup_run` and `next_kst_day` helper**

Append to `hoga/api/scheduler.py`:

```python
from hoga.api.eligibility import find_ineligible_dates


def _next_kst_day(yyyymmdd: str) -> str:
    d = dt.date(int(yyyymmdd[0:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]))
    return (d + dt.timedelta(days=1)).strftime("%Y%m%d")


async def _catchup_run(data_dir: Path) -> None:
    """Backfill every Watchlist entry from its (last_success or
    registered_at) marker up to today. Pre-trims Q14-ineligible dates so
    a multi-day catch-up that includes today before 18:00 still enqueues
    the prior days successfully (see ADR-0034 carve-out).
    """
    now = now_kst()
    today = now.strftime("%Y%m%d")
    wl = load_watchlist(data_dir)
    for entry in wl.entries:
        floor = entry.last_success_date or entry.registered_at_kst_date
        start = _next_kst_day(floor)
        if start > today:
            continue
        try:
            candidates = trading_days_in_range(start, today)
        except Exception:  # noqa: BLE001 — KrxUnavailableError or worse
            log.warning("catch-up: trading-day list unavailable for %s",
                        entry.code)
            continue
        too_early = set(find_ineligible_dates(
            candidate_dates=candidates, now=now,
        ))
        candidates = [d for d in candidates if d not in too_early]
        if not candidates:
            continue
        try:
            await enqueue_items_core(
                EnqueueRequest(code=entry.code, dates=candidates),
                data_dir=data_dir,
                now=now,
            )
        except Exception:  # noqa: BLE001
            log.exception("catch-up enqueue failed for %s", entry.code)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_scheduler.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/scheduler.py tests/test_api_scheduler.py
git commit -m "feat(scheduler): _catchup_run backfills since last_success per entry"
```

---

### Task 8: `start_scheduler` — wire `_daily_loop` + one-shot catch-up

**Files:**
- Modify: `hoga/api/scheduler.py`
- Modify: `tests/test_api_scheduler.py`

- [ ] **Step 1: Write a failing test that confirms `start_scheduler` spawns two tasks**

Append to `tests/test_api_scheduler.py`:

```python
@pytest.mark.asyncio
async def test_start_scheduler_spawns_catchup_and_daily_loop(tmp_path: Path):
    import asyncio
    from hoga.api import scheduler

    catchup_called = asyncio.Event()
    daily_loop_entered = asyncio.Event()

    async def fake_catchup(data_dir):
        catchup_called.set()

    async def fake_daily_loop(data_dir):
        daily_loop_entered.set()
        await asyncio.sleep(3600)  # never fire in this test

    with patch("hoga.api.scheduler._catchup_run", side_effect=fake_catchup), \
         patch("hoga.api.scheduler._daily_loop", side_effect=fake_daily_loop):
        tasks = scheduler.start_scheduler(tmp_path)
        await asyncio.wait_for(catchup_called.wait(), timeout=1.0)
        await asyncio.wait_for(daily_loop_entered.wait(), timeout=1.0)
        for t in tasks:
            t.cancel()
        for t in tasks:
            with pytest.raises((asyncio.CancelledError, BaseException)):
                await t
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run pytest tests/test_api_scheduler.py::test_start_scheduler_spawns_catchup_and_daily_loop -v
```

Expected: FAIL — `start_scheduler` / `_daily_loop` not defined.

- [ ] **Step 3: Implement `_daily_loop` and `start_scheduler`**

Append to `hoga/api/scheduler.py`:

```python
import asyncio


async def _daily_loop(data_dir: Path) -> None:
    """Perpetual: sleep to next KST 18:00, run _daily_run, repeat.

    Never lets a single failure kill the loop — see ADR-0034 for the
    "scheduler is a queue client" framing. The Capture Queue's own
    pause/resume semantics handle the heavyweight failures; this loop
    only ensures the *trigger* stays alive.
    """
    while True:
        await asyncio.sleep(seconds_until_next_18_kst(now_kst()))
        try:
            await _daily_run(data_dir)
        except Exception:  # noqa: BLE001
            log.exception("daily run crashed; loop continues")


def start_scheduler(data_dir: Path) -> list[asyncio.Task]:
    """Spawn the catch-up (one-shot) and daily-loop tasks. Returns the
    handles so the FastAPI lifespan can cancel them on shutdown.
    """
    return [
        asyncio.create_task(_catchup_run(data_dir), name="watchlist-catchup"),
        asyncio.create_task(_daily_loop(data_dir), name="watchlist-daily-loop"),
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_scheduler.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/scheduler.py tests/test_api_scheduler.py
git commit -m "feat(scheduler): _daily_loop + start_scheduler entry point"
```

---

## Phase 4 — Backend wiring

### Task 9: `_finalize_item` hook — bump `last_success_date` on done

**Files:**
- Modify: `hoga/api/captures.py:584-613` (the `_finalize_item` function)
- Test: `tests/test_api_captures_queue.py` (extend)

- [ ] **Step 1: Write a failing test that confirms the hook fires only for `done` watched Codes**

Append to `tests/test_api_captures_queue.py`:

```python
@pytest.mark.asyncio
async def test_finalize_item_done_bumps_watchlist_last_success(tmp_path):
    """The _finalize_item hook must call watchlist.bump_last_success
    when phase is 'done', and never otherwise."""
    from unittest.mock import patch, AsyncMock
    from hoga.api import captures, watchlist
    captures.reset_state_for_tests()
    captures._data_dir = tmp_path
    # Register the Code in the Watchlist so the bump has somewhere to land.
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260526")

    state = captures.QueueItemState(
        item_id="x", code="005930", date="20260526",
        force_retry=False, enqueued_at_ms=0, attempt=1,
    )
    state.phase = "done"

    with patch("hoga.api.captures.watchlist.bump_last_success",
               new_callable=AsyncMock) as bump:
        await captures._finalize_item(state)

    bump.assert_awaited_once_with(tmp_path, code="005930", date="20260526")


@pytest.mark.asyncio
async def test_finalize_item_failed_does_not_bump(tmp_path):
    from unittest.mock import patch, AsyncMock
    from hoga.api import captures
    captures.reset_state_for_tests()
    captures._data_dir = tmp_path
    state = captures.QueueItemState(
        item_id="x", code="005930", date="20260526",
        force_retry=False, enqueued_at_ms=0, attempt=1,
    )
    state.phase = "failed"

    with patch("hoga.api.captures.watchlist.bump_last_success",
               new_callable=AsyncMock) as bump:
        await captures._finalize_item(state)

    bump.assert_not_awaited()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_captures_queue.py -k finalize_item_done -v
```

Expected: FAIL — `captures.watchlist` not bound or `bump_last_success` not called.

- [ ] **Step 3: Add the hook to `_finalize_item`**

In `hoga/api/captures.py`, near the top with the other imports, add (after the existing local imports):

```python
from hoga.api import watchlist
```

If this creates a circular import (`watchlist.py` does not import `captures.py`, so it shouldn't — verify), move the import *inside* `_finalize_item` as `from hoga.api import watchlist` at the function call site.

In the `_finalize_item` function at `hoga/api/captures.py:584`, immediately after the `_publish_event(CaptureFinishedEvent(...))` call at the end, add:

```python
    # ADR-0034: Watchlist's last_success_date marker advances on successful
    # captures regardless of whether the capture was ad-hoc or scheduled.
    if state.phase == "done":
        try:
            await watchlist.bump_last_success(
                _require_data_dir(), code=state.code, date=state.date,
            )
        except Exception:  # noqa: BLE001 — never let watchlist break the queue
            logging.getLogger(__name__).exception(
                "watchlist bump_last_success failed for %s/%s",
                state.code, state.date,
            )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_captures_queue.py -k finalize_item -v
uv run pytest tests/test_api_captures_queue.py tests/test_api_watchlist.py tests/test_api_scheduler.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): bump watchlist last_success_date on phase=done"
```

---

### Task 10: `GET /api/watchlist` route

**Files:**
- Create: `hoga/api/watchlist_routes.py`
- Create: `tests/test_api_watchlist_routes.py`

- [ ] **Step 1: Write a failing test for the GET route**

Create `tests/test_api_watchlist_routes.py`:

```python
"""Watchlist HTTP route tests. See spec 2026-05-26."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


KST = ZoneInfo("Asia/Seoul")


def _app(tmp_path: Path) -> FastAPI:
    from hoga.api.watchlist_routes import build_router
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return app


def test_get_empty_watchlist(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.get("/api/watchlist")
    assert r.status_code == 200
    body = r.json()
    assert body["entries"] == []
    # next_run_at_ms is today's 18:00 KST in Unix-ms.
    expected = int(dt.datetime(2026, 5, 26, 18, 0, tzinfo=KST).timestamp() * 1000)
    assert body["next_run_at_ms"] == expected


@pytest.mark.asyncio
async def test_get_returns_entries(tmp_path: Path):
    from hoga.api import watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, tzinfo=KST)  # after 18 → tomorrow
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.get("/api/watchlist")
    assert r.status_code == 200
    body = r.json()
    assert len(body["entries"]) == 1
    assert body["entries"][0]["code"] == "003490"
    # 2026-05-27 18:00 KST
    expected = int(dt.datetime(2026, 5, 27, 18, 0, tzinfo=KST).timestamp() * 1000)
    assert body["next_run_at_ms"] == expected
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_watchlist_routes.py -v
```

Expected: FAIL — `ModuleNotFoundError: hoga.api.watchlist_routes`.

- [ ] **Step 3: Create the router with GET only**

Create `hoga/api/watchlist_routes.py`:

```python
"""FastAPI router for /api/watchlist.

See spec docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

from fastapi import APIRouter

from hoga.api.models import WatchlistResponse
from hoga.api.scheduler import seconds_until_next_18_kst
from hoga.api.watchlist import load_watchlist
from hoga.collector.orchestrator import now_kst


def _next_run_at_ms(now: dt.datetime) -> int:
    secs = seconds_until_next_18_kst(now)
    target = now + dt.timedelta(seconds=secs)
    return int(target.timestamp() * 1000)


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

    @router.get("", response_model=WatchlistResponse)
    async def get_watchlist() -> WatchlistResponse:
        wl = load_watchlist(data_dir)
        return WatchlistResponse(
            entries=wl.entries,
            next_run_at_ms=_next_run_at_ms(now_kst()),
        )

    return router
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_watchlist_routes.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist_routes.py tests/test_api_watchlist_routes.py
git commit -m "feat(watchlist): GET /api/watchlist route"
```

---

### Task 11: `POST /api/watchlist` route

**Files:**
- Modify: `hoga/api/watchlist_routes.py`
- Modify: `tests/test_api_watchlist_routes.py`

- [ ] **Step 1: Write failing tests for POST behavior**

Append to `tests/test_api_watchlist_routes.py`:

```python
def test_post_unknown_code_returns_400(tmp_path: Path):
    """Code must be present in symbol-master cache."""
    with patch("hoga.api.watchlist_routes.symbols.search",
               return_value=[]):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist", json={"code": "999999"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "unknown_code"


def test_post_adds_entry(tmp_path: Path):
    from hoga.api.symbols import SymbolHit
    fake_hit = SymbolHit(code="003490", name="대한항공", market="KOSPI")
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.symbols.search",
               return_value=[fake_hit]), \
         patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist", json={"code": "003490"})
    assert r.status_code == 201
    body = r.json()
    assert body["code"] == "003490"
    assert body["name"] == "대한항공"
    assert body["registered_at_kst_date"] == "20260526"
    assert body["last_success_date"] is None


def test_post_duplicate_returns_409(tmp_path: Path):
    from hoga.api.symbols import SymbolHit
    fake_hit = SymbolHit(code="003490", name="대한항공", market="KOSPI")
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.symbols.search",
               return_value=[fake_hit]), \
         patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        client.post("/api/watchlist", json={"code": "003490"})
        r = client.post("/api/watchlist", json={"code": "003490"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "already_in_watchlist"
```

**Note:** Confirm the `SymbolHit` import path before pasting:

```bash
grep -n "^class SymbolHit" /home/dev/code/hoga-ops.worktrees/feat+frontend4/hoga/api/symbols.py
```

If `SymbolHit` is in a different module, adjust the import.

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_watchlist_routes.py -k post -v
```

Expected: FAIL — POST route returns 405.

- [ ] **Step 3: Add POST handler**

Edit `hoga/api/watchlist_routes.py`. Add imports at the top:

```python
from fastapi import HTTPException
from hoga.api import symbols
from hoga.api.models import WatchlistAddRequest, WatchlistEntry
from hoga.api.watchlist import AlreadyInWatchlistError, add_entry
```

Inside `build_router`, add after the GET:

```python
    @router.post("", status_code=201, response_model=WatchlistEntry)
    async def add_to_watchlist(req: WatchlistAddRequest) -> WatchlistEntry:
        hits = symbols.search(req.code, limit=1)
        match = next((h for h in hits if h.code == req.code), None)
        if match is None:
            raise HTTPException(status_code=400, detail={
                "code": "unknown_code",
                "message": f"Code {req.code} is not in the symbol master.",
            })
        today = now_kst().strftime("%Y%m%d")
        try:
            entry = await add_entry(
                data_dir, code=req.code, name=match.name, today_kst_date=today,
            )
        except AlreadyInWatchlistError as e:
            raise HTTPException(status_code=409, detail={
                "code": "already_in_watchlist",
                "message": f"Code {req.code} is already in the Watchlist.",
            }) from e
        return entry
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_watchlist_routes.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist_routes.py tests/test_api_watchlist_routes.py
git commit -m "feat(watchlist): POST /api/watchlist with symbol-master validation"
```

---

### Task 12: `DELETE /api/watchlist/{code}` route

**Files:**
- Modify: `hoga/api/watchlist_routes.py`
- Modify: `tests/test_api_watchlist_routes.py`

- [ ] **Step 1: Write failing tests for DELETE**

Append to `tests/test_api_watchlist_routes.py`:

```python
def test_delete_missing_returns_404(tmp_path: Path):
    client = TestClient(_app(tmp_path))
    r = client.delete("/api/watchlist/003490")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_in_watchlist"


@pytest.mark.asyncio
async def test_delete_removes_entry(tmp_path: Path):
    from hoga.api import watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    client = TestClient(_app(tmp_path))
    r = client.delete("/api/watchlist/003490")
    assert r.status_code == 204
    assert watchlist.load_watchlist(tmp_path).entries == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_watchlist_routes.py -k delete -v
```

Expected: FAIL — 405.

- [ ] **Step 3: Add DELETE handler**

Add to imports in `hoga/api/watchlist_routes.py`:

```python
from hoga.api.watchlist import NotInWatchlistError, remove_entry
```

Inside `build_router`, after POST:

```python
    @router.delete("/{code}", status_code=204)
    async def remove_from_watchlist(code: str) -> None:
        if not code.isdigit() or len(code) != 6:
            raise HTTPException(status_code=400, detail={
                "code": "invalid_code", "message": "Code must be 6 digits.",
            })
        try:
            await remove_entry(data_dir, code=code)
        except NotInWatchlistError as e:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_watchlist",
                "message": f"Code {code} is not in the Watchlist.",
            }) from e
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_watchlist_routes.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/watchlist_routes.py tests/test_api_watchlist_routes.py
git commit -m "feat(watchlist): DELETE /api/watchlist/{code} route"
```

---

### Task 13: Mount router + start scheduler in `app.py` lifespan

**Files:**
- Modify: `hoga/api/app.py`

- [ ] **Step 1: Write a failing integration test that hits the mounted route**

Append to `tests/test_api.py` (existing app-level integration tests):

```python
def test_watchlist_route_is_mounted(tmp_path):
    """The /api/watchlist endpoint must be reachable via create_app."""
    from hoga.api.app import create_app
    from fastapi.testclient import TestClient
    app = create_app(tmp_path)
    with TestClient(app):  # triggers lifespan startup
        r = TestClient(app).get("/api/watchlist")
    assert r.status_code == 200
    assert "entries" in r.json()
    assert "next_run_at_ms" in r.json()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run pytest tests/test_api.py::test_watchlist_route_is_mounted -v
```

Expected: FAIL — 404 because router is not mounted.

- [ ] **Step 3: Wire `app.py`**

Edit `hoga/api/app.py`:

Add imports after the existing `build_*` imports (around line 17):

```python
from hoga.api.watchlist_routes import build_router as build_watchlist_router
from hoga.api.scheduler import start_scheduler
```

In the `lifespan` async generator, just after `_captures_module._workers = _captures_module.start_capture_pool(data_dir)`, add:

```python
        # ADR-0034: Watchlist scheduler runs alongside the capture pool
        # in the same uvicorn process. Tasks are cancelled in `finally`.
        _scheduler_tasks = start_scheduler(data_dir)
```

(Use a local variable in the lifespan; no module-level handle needed for v1 because shutdown is via `try/finally` below.)

Then in the `finally` block of the lifespan, just before `cancel_all_on_shutdown()`, add:

```python
            for t in _scheduler_tasks:
                t.cancel()
            for t in _scheduler_tasks:
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
```

In the `create_app` function, just after the existing `app.include_router(build_calendar_router(data_dir=data_dir))`, add:

```python
    app.include_router(build_watchlist_router(data_dir=data_dir))
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api.py::test_watchlist_route_is_mounted tests/test_api_watchlist_routes.py tests/test_api_scheduler.py tests/test_api_watchlist.py tests/test_api_captures_queue.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/app.py tests/test_api.py
git commit -m "feat(app): mount watchlist router and start scheduler in lifespan"
```

---

## Phase 5 — Frontend

### Task 14: REST client `frontend/src/api/watchlist.ts`

**Files:**
- Create: `frontend/src/api/watchlist.ts`
- Create: `frontend/src/api/watchlist.test.ts`

- [ ] **Step 1: Write failing tests for the four client functions**

Create `frontend/src/api/watchlist.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  type WatchlistResponse,
} from './watchlist';

vi.mock('./client', () => ({
  apiCall: vi.fn(),
  apiAction: vi.fn(),
}));

import { apiCall, apiAction } from './client';

beforeEach(() => {
  vi.mocked(apiCall).mockReset();
  vi.mocked(apiAction).mockReset();
});

describe('watchlist api client', () => {
  it('getWatchlist hits /api/watchlist', async () => {
    const fake: WatchlistResponse = { entries: [], next_run_at_ms: 0 };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await getWatchlist();
    expect(apiCall).toHaveBeenCalledWith('/api/watchlist');
    expect(r).toEqual(fake);
  });

  it('addToWatchlist POSTs JSON body with the code', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      code: '003490', name: '대한항공',
      registered_at_kst_date: '20260526', last_success_date: null,
    });
    await addToWatchlist('003490');
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/watchlist');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ code: '003490' });
  });

  it('removeFromWatchlist DELETEs /api/watchlist/{code}', async () => {
    vi.mocked(apiAction).mockResolvedValueOnce(undefined);
    await removeFromWatchlist('003490');
    expect(apiAction).toHaveBeenCalledWith(
      '/api/watchlist/003490',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npm test -- --run src/api/watchlist.test.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Create `frontend/src/api/watchlist.ts`**

```typescript
import { apiCall, apiAction } from './client';

export interface WatchlistEntry {
  code: string;
  name: string;
  registered_at_kst_date: string;  // YYYYMMDD
  last_success_date: string | null;
}

export interface WatchlistResponse {
  entries: WatchlistEntry[];
  next_run_at_ms: number;
}

export function getWatchlist(): Promise<WatchlistResponse> {
  return apiCall<WatchlistResponse>('/api/watchlist');
}

export function addToWatchlist(code: string): Promise<WatchlistEntry> {
  return apiCall<WatchlistEntry>('/api/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export function removeFromWatchlist(code: string): Promise<void> {
  return apiAction(`/api/watchlist/${code}`, { method: 'DELETE' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npm test -- --run src/api/watchlist.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/watchlist.ts frontend/src/api/watchlist.test.ts
git commit -m "feat(frontend): watchlist REST client"
```

---

### Task 15: `useWatchlist` react-query hook

**Files:**
- Create: `frontend/src/watchlist/useWatchlist.ts`

The hook wraps `getWatchlist` with `@tanstack/react-query`'s `useQuery`, plus `useMutation` for add/remove with cache invalidation.

- [ ] **Step 1: Create the hook (no test — covered by component tests)**

Create `frontend/src/watchlist/useWatchlist.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  type WatchlistResponse,
} from '../api/watchlist';

const KEY = ['watchlist'] as const;

export function useWatchlist() {
  return useQuery<WatchlistResponse>({
    queryKey: KEY,
    queryFn: getWatchlist,
    refetchInterval: 60_000,  // refresh the countdown source minute-ly
  });
}

export function useAddToWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => addToWatchlist(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoveFromWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => removeFromWatchlist(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors related to these files.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/watchlist/useWatchlist.ts
git commit -m "feat(frontend): useWatchlist react-query hook"
```

---

### Task 16: `Countdown` component

**Files:**
- Create: `frontend/src/watchlist/Countdown.tsx`
- Create: `frontend/src/watchlist/Countdown.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/watchlist/Countdown.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Countdown } from './Countdown';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Countdown', () => {
  it('shows hours/minutes/seconds until target', () => {
    const now = Date.UTC(2026, 4, 26, 9, 0, 0);  // 2026-05-26T09:00Z = 18:00 KST
    vi.setSystemTime(now);
    // Target = now + 1h 2m 3s
    const target = now + (1 * 3600 + 2 * 60 + 3) * 1000;
    render(<Countdown targetMs={target} />);
    expect(screen.getByText(/01:02:03/)).toBeInTheDocument();
  });

  it('ticks down every second', () => {
    const now = Date.UTC(2026, 4, 26, 9, 0, 0);
    vi.setSystemTime(now);
    const target = now + 5_000;
    render(<Countdown targetMs={target} />);
    expect(screen.getByText(/00:00:05/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/00:00:04/)).toBeInTheDocument();
  });

  it('shows 00:00:00 when past target', () => {
    const now = Date.UTC(2026, 4, 26, 9, 0, 0);
    vi.setSystemTime(now);
    render(<Countdown targetMs={now - 1000} />);
    expect(screen.getByText(/00:00:00/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npm test -- --run src/watchlist/Countdown.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Create `frontend/src/watchlist/Countdown.tsx`**

```typescript
import { useEffect, useState } from 'react';

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600).toString().padStart(2, '0');
  const m = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function Countdown({ targetMs }: { targetMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="font-mono tabular-nums">{fmt(targetMs - now)}</span>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npm test -- --run src/watchlist/Countdown.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/watchlist/Countdown.tsx frontend/src/watchlist/Countdown.test.tsx
git commit -m "feat(frontend): Countdown component"
```

---

### Task 17: `WatchlistRow` component

**Files:**
- Create: `frontend/src/watchlist/WatchlistRow.tsx`

The row shows code, name, registered/last-success dates, and a delete button. Read DESIGN.md before styling.

- [ ] **Step 1: Read DESIGN.md for color tokens, spacing, typography**

```bash
sed -n '1,80p' DESIGN.md
```

Use only the documented design tokens — no hardcoded colors or spacing values.

- [ ] **Step 2: Create the row component (no separate test — covered by Panel)**

Create `frontend/src/watchlist/WatchlistRow.tsx`:

```typescript
import type { WatchlistEntry } from '../api/watchlist';

function fmtDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

export interface WatchlistRowProps {
  entry: WatchlistEntry;
  onRemove: (code: string) => void;
  removing: boolean;
}

export function WatchlistRow({ entry, onRemove, removing }: WatchlistRowProps) {
  return (
    <div className="grid grid-cols-[6ch_1fr_8ch_8ch_3ch] items-center gap-3 px-3 py-2 border-b border-border text-sm hover:bg-bg-subtle">
      <span className="font-mono text-fg-dim">{entry.code}</span>
      <span className="truncate">{entry.name}</span>
      <span className="font-mono text-xs text-fg-dim">등록 {fmtDate(entry.registered_at_kst_date)}</span>
      <span className="font-mono text-xs">
        {entry.last_success_date
          ? <>마지막 {fmtDate(entry.last_success_date)}</>
          : <span className="text-fg-dimmer">아직 없음</span>}
      </span>
      <button
        type="button"
        aria-label={`Remove ${entry.name}`}
        onClick={() => onRemove(entry.code)}
        disabled={removing}
        className="text-fg-dim hover:text-danger disabled:opacity-40"
      >
        🗑
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/watchlist/WatchlistRow.tsx
git commit -m "feat(frontend): WatchlistRow component"
```

---

### Task 18: `WatchlistPanel` component (search + list)

**Files:**
- Create: `frontend/src/watchlist/WatchlistPanel.tsx`
- Create: `frontend/src/watchlist/WatchlistPanel.test.tsx`

- [ ] **Step 1: Write failing tests for empty state and add/remove flows**

Create `frontend/src/watchlist/WatchlistPanel.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WatchlistPanel } from './WatchlistPanel';

vi.mock('../api/watchlist');
import * as api from '../api/watchlist';

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.getWatchlist).mockReset();
  vi.mocked(api.addToWatchlist).mockReset();
  vi.mocked(api.removeFromWatchlist).mockReset();
});

describe('WatchlistPanel', () => {
  it('shows empty state when no entries', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValueOnce({
      entries: [],
      next_run_at_ms: Date.now() + 3600_000,
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() =>
      expect(screen.getByText(/자동 수집할 종목이 아직 없습니다/)).toBeInTheDocument());
  });

  it('lists entries when present', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValueOnce({
      entries: [{
        code: '003490', name: '대한항공',
        registered_at_kst_date: '20260526', last_success_date: null,
      }],
      next_run_at_ms: Date.now() + 3600_000,
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => expect(screen.getByText('대한항공')).toBeInTheDocument());
  });

  it('calls removeFromWatchlist when the trash button is clicked', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [{
        code: '003490', name: '대한항공',
        registered_at_kst_date: '20260526', last_success_date: null,
      }],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.removeFromWatchlist).mockResolvedValueOnce(undefined);
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByText('대한항공'));
    const btn = screen.getByLabelText(/Remove 대한항공/);
    await userEvent.click(btn);
    await waitFor(() =>
      expect(api.removeFromWatchlist).toHaveBeenCalledWith('003490'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npm test -- --run src/watchlist/WatchlistPanel.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Create `WatchlistPanel.tsx`**

```typescript
import { useState } from 'react';
import { Countdown } from './Countdown';
import { WatchlistRow } from './WatchlistRow';
import {
  useWatchlist,
  useAddToWatchlist,
  useRemoveFromWatchlist,
} from './useWatchlist';

export function WatchlistPanel() {
  const { data, isLoading, error } = useWatchlist();
  const addM = useAddToWatchlist();
  const removeM = useRemoveFromWatchlist();
  const [codeInput, setCodeInput] = useState('');

  if (isLoading) return <div className="p-6 text-fg-dim">로딩 중…</div>;
  if (error) return <div className="p-6 text-danger">불러오기 실패: {(error as Error).message}</div>;
  if (!data) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = codeInput.trim();
    if (!/^\d{6}$/.test(code)) return;
    try {
      await addM.mutateAsync(code);
      setCodeInput('');
    } catch {
      // error surfaces via addM.error
    }
  };

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold">Watchlist</h1>
        <p className="text-sm text-fg-dim mt-1">
          다음 자동 수집까지: <Countdown targetMs={data.next_run_at_ms} /> (KST 18:00)
        </p>
      </header>

      <form onSubmit={submit} className="px-6 py-3 border-b border-border flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          placeholder="6자리 종목 코드 (예: 003490)"
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value)}
          className="flex-1 px-3 py-1.5 rounded border border-border bg-bg text-sm font-mono"
        />
        <button
          type="submit"
          disabled={addM.isPending || !/^\d{6}$/.test(codeInput.trim())}
          className="px-3 py-1.5 rounded bg-accent text-bg text-sm font-medium disabled:opacity-40"
        >
          + 추가
        </button>
      </form>

      {addM.error && (
        <div className="mx-6 my-2 px-3 py-2 rounded bg-danger-subtle text-sm text-danger">
          {(addM.error as Error).message}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {data.entries.length === 0 ? (
          <div className="p-8 text-center text-fg-dim text-sm">
            자동 수집할 종목이 아직 없습니다. 위에서 검색해서 추가하면
            매일 KST 18:00에 자동으로 캡쳐됩니다.
          </div>
        ) : (
          data.entries.map((e) => (
            <WatchlistRow
              key={e.code}
              entry={e}
              onRemove={(c) => removeM.mutate(c)}
              removing={removeM.isPending && removeM.variables === e.code}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

**Note:** The plain 6-digit input is a v1 simplification. A future task can swap in the `SymbolSearch` autocomplete from `frontend/src/inventory/`. The plan deliberately keeps v1 minimal — TDD covers the 6-digit case.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npm test -- --run src/watchlist/WatchlistPanel.test.tsx
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/watchlist/WatchlistPanel.tsx frontend/src/watchlist/WatchlistPanel.test.tsx
git commit -m "feat(frontend): WatchlistPanel — list + add + remove"
```

---

### Task 19: Wire `/watchlist` route + nav item

**Files:**
- Create: `frontend/src/pages/Watchlist.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/nav/LeftNav.tsx`

- [ ] **Step 1: Create the page wrapper**

Create `frontend/src/pages/Watchlist.tsx`:

```typescript
import { WatchlistPanel } from '../watchlist/WatchlistPanel';

export default function Watchlist() {
  return <WatchlistPanel />;
}
```

- [ ] **Step 2: Add the route**

Edit `frontend/src/main.tsx`. Add the import after the other page imports:

```typescript
import Watchlist from './pages/Watchlist';
```

Add the route inside `<Route element={<App />}>`, after the `capture` route:

```typescript
          <Route path="watchlist" element={<Watchlist />} />
```

- [ ] **Step 3: Add the nav item**

Edit `frontend/src/nav/LeftNav.tsx`. Inside the `<Section label="Workspace">`, add after `<NavItem to="/capture" label="Capture" />`:

```typescript
        <NavItem to="/watchlist" label="Watchlist" />
```

- [ ] **Step 4: Type-check and run full frontend tests**

```bash
cd frontend && npx tsc --noEmit && npm test -- --run
```

Expected: no type errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Watchlist.tsx frontend/src/main.tsx frontend/src/nav/LeftNav.tsx
git commit -m "feat(frontend): /watchlist route and nav item"
```

---

## Phase 6 — End-to-end verification

### Task 20: Manual smoke test

**Files:**
- None modified — verification only

This task is a checkpoint, not a code change. Skip if running headless.

- [ ] **Step 1: Start both dev servers (see CLAUDE.md)**

Backend:
```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 \
    --reload --reload-dir hoga
```

Frontend:
```bash
cd frontend && npm install && npm run dev
```

Wait for both to print their ready messages.

- [ ] **Step 2: Open the Watchlist tab**

In a browser, open `http://localhost:5173/watchlist`. The empty-state message should appear.

- [ ] **Step 3: Add a stock**

Type `003490` in the input and click `+ 추가`. The row for 대한항공 should appear. Verify `<data_dir>/watchlist.json` exists:

```bash
ls -la "$(uv run python -c 'from hoga.config import resolve_data_dir; print(resolve_data_dir())')/watchlist.json"
cat "$(uv run python -c 'from hoga.config import resolve_data_dir; print(resolve_data_dir())')/watchlist.json"
```

Verify the JSON contains the entry.

- [ ] **Step 4: Restart the backend and watch for catch-up logs**

Restart uvicorn. In the logs, look for either no catch-up output (if last_success_date is current) or a daily-enqueue log for the gap. Open the Capture tab to confirm new items appear in the queue if catch-up enqueued any.

- [ ] **Step 5: Remove the stock**

Click the trash button on the row. The row should disappear, and `watchlist.json`'s `entries` array should be empty.

- [ ] **Step 6: Commit the verification (no code change — empty commit allowed)**

```bash
git commit --allow-empty -m "test(watchlist): manual smoke verified — add/list/remove/persist"
```

---

## Final integration check

- [ ] **Run the full test suite (Python + frontend)**

```bash
uv run pytest -q
cd frontend && npm test -- --run && npx tsc --noEmit
```

Expected: green across the board.

- [ ] **Confirm ADR-0034 invariant in `hoga/api/scheduler.py`**

```bash
grep -nE "_queue|_active|_done|_inflight_paths" hoga/api/scheduler.py
```

Expected: **no matches**. The Scheduler must not reference any of these names — see ADR-0034.

- [ ] **Confirm `_finalize_item` writes go through `bump_last_success`**

```bash
grep -n "watchlist\." hoga/api/captures.py
```

Expected: exactly one `bump_last_success` call in `_finalize_item`, no direct file writes.

---

## Notes for the implementer

- **Frequent commits.** Each task is one commit. Don't batch unrelated changes.
- **Korean text.** The codebase uses Korean comments and UI strings. Match the surrounding voice.
- **Backwards compatibility.** No callers exist for Watchlist functions outside the new modules — no compat shims needed.
- **Test isolation.** `captures.reset_state_for_tests()` is the standard fixture; the new `watchlist.py` uses `tmp_path` per test so no reset is needed.
- **Design tokens.** Read `DESIGN.md` before adjusting any frontend styling.
- **Concurrent-agent caution.** Per `memory/feedback_no_concurrent_agents_in_worktree.md`, run `git status --porcelain` before each commit to catch unrelated changes from another agent's work in the same worktree. Stage only the files you touched in the current task.
