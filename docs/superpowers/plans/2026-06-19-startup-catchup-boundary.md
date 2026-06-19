# Startup Catch-up Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백엔드 시작 직후 Watchlist catch-up과 live stream startup이 자동으로 KIS calendar/capture 경로를 건드리지 않게 하고, catch-up/live start는 명시적 opt-in 또는 수동 동작에서만 실행되게 한다.

**Architecture:** `hoga.api.scheduler.start_scheduler()`는 기본적으로 daily loop만 소유한다. Startup catch-up은 `HOGA_STARTUP_CATCHUP_ENABLED=true`일 때만 opt-in으로 spawn되며, 기존 수동 Watchlist catch-up route와 daily run은 그대로 유지한다. FastAPI lifespan은 live stream startup도 `HOGA_LIVE_STARTUP_ENABLED=true`일 때만 실행하고, watchdog은 stream이 시작되지 않은 상태에서는 calendar gate를 평가하지 않는다.

**Tech Stack:** Python 3.14, FastAPI lifespan, asyncio tasks, pytest, existing `hoga.api.scheduler` and `hoga.api.watchlist_routes`.

## Global Constraints

- TDD 순서 준수: 실패 테스트 작성 → 실패 확인 → 구현 → 통과 확인.
- Startup 기본 경로에서 `_catchup_run(data_dir)`를 호출하거나 task로 spawn하지 않는다.
- `POST /api/watchlist/{code}/catchup`와 `POST /api/watchlist/catchup` 수동 경로는 유지한다.
- `_daily_loop()`와 `_daily_run()`은 유지한다.
- Screener daily update와 manual update 변경 금지.
- KIS 직접 호출 경로를 새로 만들지 않는다.
- Startup opt-in env는 `HOGA_STARTUP_CATCHUP_ENABLED=true`만 true로 인정한다. unset, `false`, 기타 값은 false.
- Live startup opt-in env는 `HOGA_LIVE_STARTUP_ENABLED=true`만 true로 인정한다. unset, `false`, 기타 값은 false.
- Startup 기본값에서 live stream/watchdog 경로가 KIS calendar `chk-holiday`를 호출하지 않는다.

---

## File Structure

- Modify: `hoga/api/scheduler.py`
  - Add `startup_catchup_enabled_from_env() -> bool`.
  - Change `start_scheduler(data_dir: Path)` so it starts `_daily_loop` by default and starts `_catchup_run` only when the env helper returns true.
- Modify: `tests/test_api_scheduler.py`
  - Replace current startup scheduler test with default-no-catchup behavior.
  - Add opt-in test proving catch-up still can be enabled for local recovery.
  - Add env parsing tests for unset/false/true/invalid values.
- Verify only: `hoga/api/watchlist_routes.py`
  - Manual catch-up routes should already call `catchup_one_entry(...)`; no code change expected.
- Verify only: `hoga/api/app.py`
  - Existing `start_scheduler(data_dir)` call should remain unchanged and inherit the new default.
  - Live stream startup should be gated by `HOGA_LIVE_STARTUP_ENABLED=true`.
- Modify if needed: `hoga/live/lifecycle.py`
  - Watchdog should return before calendar gate evaluation when no stream has started.

---

## Task 1: Startup Catch-up Env Boundary

**Files:**
- Modify: `tests/test_api_scheduler.py`
- Modify: `hoga/api/scheduler.py`

**Interfaces:**
- Produces: `hoga.api.scheduler.startup_catchup_enabled_from_env() -> bool`
- Preserves: `hoga.api.scheduler.start_scheduler(data_dir: Path) -> list[asyncio.Task]`
- Env: `HOGA_STARTUP_CATCHUP_ENABLED=true` enables startup catch-up. All other values disable it.

- [ ] **Step 1: Add failing env parsing tests**

Append these tests near the scheduler startup tests in `tests/test_api_scheduler.py`:

```python
def test_startup_catchup_enabled_defaults_to_false(monkeypatch):
    from hoga.api import scheduler

    monkeypatch.delenv("HOGA_STARTUP_CATCHUP_ENABLED", raising=False)

    assert scheduler.startup_catchup_enabled_from_env() is False


def test_startup_catchup_enabled_accepts_true_only(monkeypatch):
    from hoga.api import scheduler

    monkeypatch.setenv("HOGA_STARTUP_CATCHUP_ENABLED", "true")
    assert scheduler.startup_catchup_enabled_from_env() is True

    for value in ["false", "1", "yes", "", "TRUE "]:
        monkeypatch.setenv("HOGA_STARTUP_CATCHUP_ENABLED", value)
        assert scheduler.startup_catchup_enabled_from_env() is False
```

- [ ] **Step 2: Run env tests to verify RED**

Run:

```bash
uv run --extra dev pytest \
  tests/test_api_scheduler.py::test_startup_catchup_enabled_defaults_to_false \
  tests/test_api_scheduler.py::test_startup_catchup_enabled_accepts_true_only \
  -q
```

Expected: FAIL with:

```text
AttributeError: module 'hoga.api.scheduler' has no attribute 'startup_catchup_enabled_from_env'
```

- [ ] **Step 3: Implement env helper**

In `hoga/api/scheduler.py`, add `import os` with the other stdlib imports:

```python
import os
```

Then add this helper above `start_scheduler(...)`:

```python
def startup_catchup_enabled_from_env() -> bool:
    """Whether startup should run the one-shot watchlist catch-up.

    Default is false so process boot does not fan out into KIS calendar/capture
    work. Operators can opt in locally with HOGA_STARTUP_CATCHUP_ENABLED=true.
    """
    return os.environ.get("HOGA_STARTUP_CATCHUP_ENABLED") == "true"
```

- [ ] **Step 4: Run env tests to verify GREEN**

Run:

```bash
uv run --extra dev pytest \
  tests/test_api_scheduler.py::test_startup_catchup_enabled_defaults_to_false \
  tests/test_api_scheduler.py::test_startup_catchup_enabled_accepts_true_only \
  -q
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add hoga/api/scheduler.py tests/test_api_scheduler.py
git commit -m "test(api): define startup catchup env boundary"
```

If the repository convention prefers one final commit instead of task commits, skip this commit and commit after Task 4.

---

## Task 2: Make `start_scheduler` Daily-only by Default

**Files:**
- Modify: `tests/test_api_scheduler.py`
- Modify: `hoga/api/scheduler.py`

**Interfaces:**
- Consumes: `startup_catchup_enabled_from_env() -> bool`
- Produces: `start_scheduler(data_dir: Path) -> list[asyncio.Task]` that returns one daily-loop task by default.
- Produces: Opt-in startup catch-up task named `watchlist-catchup` only when env helper returns true.

- [ ] **Step 1: Replace existing scheduler startup test**

Replace `test_start_scheduler_spawns_catchup_and_daily_loop` in `tests/test_api_scheduler.py` with:

```python
@pytest.mark.asyncio
async def test_start_scheduler_spawns_only_daily_loop_by_default(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    import asyncio
    from hoga.api import scheduler

    catchup_called = asyncio.Event()
    daily_loop_entered = asyncio.Event()

    async def fake_catchup(data_dir):
        catchup_called.set()
        await asyncio.sleep(3600)

    async def fake_daily_loop(data_dir):
        daily_loop_entered.set()
        await asyncio.sleep(3600)

    monkeypatch.delenv("HOGA_STARTUP_CATCHUP_ENABLED", raising=False)

    with patch("hoga.api.scheduler._catchup_run", side_effect=fake_catchup), \
         patch("hoga.api.scheduler._daily_loop", side_effect=fake_daily_loop):
        tasks = scheduler.start_scheduler(tmp_path)
        await asyncio.wait_for(daily_loop_entered.wait(), timeout=1.0)
        assert catchup_called.is_set() is False
        assert [t.get_name() for t in tasks] == ["watchlist-daily-loop"]
        for t in tasks:
            t.cancel()
        for t in tasks:
            with pytest.raises((asyncio.CancelledError, BaseException)):
                await t
```

- [ ] **Step 2: Add opt-in catch-up test**

Append this test after the default startup test:

```python
@pytest.mark.asyncio
async def test_start_scheduler_can_opt_into_startup_catchup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    import asyncio
    from hoga.api import scheduler

    catchup_called = asyncio.Event()
    daily_loop_entered = asyncio.Event()

    async def fake_catchup(data_dir):
        catchup_called.set()
        await asyncio.sleep(3600)

    async def fake_daily_loop(data_dir):
        daily_loop_entered.set()
        await asyncio.sleep(3600)

    monkeypatch.setenv("HOGA_STARTUP_CATCHUP_ENABLED", "true")

    with patch("hoga.api.scheduler._catchup_run", side_effect=fake_catchup), \
         patch("hoga.api.scheduler._daily_loop", side_effect=fake_daily_loop):
        tasks = scheduler.start_scheduler(tmp_path)
        await asyncio.wait_for(catchup_called.wait(), timeout=1.0)
        await asyncio.wait_for(daily_loop_entered.wait(), timeout=1.0)
        assert sorted(t.get_name() for t in tasks) == [
            "watchlist-catchup",
            "watchlist-daily-loop",
        ]
        for t in tasks:
            t.cancel()
        for t in tasks:
            with pytest.raises((asyncio.CancelledError, BaseException)):
                await t
```

- [ ] **Step 3: Run startup scheduler tests to verify RED**

Run:

```bash
uv run --extra dev pytest \
  tests/test_api_scheduler.py::test_start_scheduler_spawns_only_daily_loop_by_default \
  tests/test_api_scheduler.py::test_start_scheduler_can_opt_into_startup_catchup \
  -q
```

Expected: first test FAIL because current `start_scheduler()` still spawns `_catchup_run` by default.

- [ ] **Step 4: Implement daily-only default**

Replace `start_scheduler(...)` in `hoga/api/scheduler.py` with:

```python
def start_scheduler(data_dir: Path) -> list[asyncio.Task]:
    """Spawn scheduler-owned background tasks.

    Startup catch-up is opt-in only; daily-loop remains always-on.
    """
    tasks = [
        asyncio.create_task(_daily_loop(data_dir), name="watchlist-daily-loop"),
    ]
    if startup_catchup_enabled_from_env():
        tasks.append(asyncio.create_task(_catchup_run(data_dir), name="watchlist-catchup"))
    return tasks
```

- [ ] **Step 5: Run startup scheduler tests to verify GREEN**

Run:

```bash
uv run --extra dev pytest \
  tests/test_api_scheduler.py::test_start_scheduler_spawns_only_daily_loop_by_default \
  tests/test_api_scheduler.py::test_start_scheduler_can_opt_into_startup_catchup \
  -q
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add hoga/api/scheduler.py tests/test_api_scheduler.py
git commit -m "fix(api): disable startup watchlist catchup by default"
```

If using one final commit, skip this commit and commit after Task 4.

---

## Task 3: Preserve Manual Catch-up and Daily Scheduler Behavior

**Files:**
- Modify: `tests/test_api_scheduler.py`
- Verify only: `hoga/api/watchlist_routes.py`

**Interfaces:**
- Preserves: `_daily_run(data_dir: Path) -> None`
- Preserves: `_catchup_run(data_dir: Path) -> None`
- Preserves: `catchup_one_entry(entry: WatchlistEntry, *, data_dir: Path, now: datetime) -> EnqueueResponse`
- Preserves: manual route `POST /api/watchlist/catchup`
- Preserves: manual route `POST /api/watchlist/{code}/catchup`

- [ ] **Step 1: Run existing manual catch-up route tests**

Run:

```bash
uv run --extra dev pytest \
  tests/test_api_watchlist_routes.py::test_catchup_one_returns_enqueue_response \
  tests/test_api_watchlist_routes.py::test_catchup_all_aggregates_results \
  tests/test_api_watchlist_routes.py::test_catchup_all_per_entry_failure_does_not_abort \
  tests/test_api_watchlist_routes.py::test_catchup_all_surfaces_trading_day_unavailable \
  tests/test_api_watchlist_routes.py::test_catchup_one_route_maps_trading_day_unavailable_to_503 \
  -q
```

Expected: PASS without production code changes.

- [ ] **Step 2: Run existing scheduler behavior tests**

Run:

```bash
uv run --extra dev pytest \
  tests/test_api_scheduler.py::test_daily_run_enqueues_each_watchlist_entry_on_trading_day \
  tests/test_api_scheduler.py::test_daily_run_skips_non_trading_day \
  tests/test_api_scheduler.py::test_daily_run_per_entry_failure_does_not_abort_loop \
  tests/test_api_scheduler.py::test_daily_run_swallows_trading_day_lookup_failure \
  tests/test_api_scheduler.py::test_catchup_enqueues_gap_since_last_success \
  tests/test_api_scheduler.py::test_catchup_one_entry_reconciles_then_backfills \
  tests/test_api_scheduler.py::test_catchup_one_entry_propagates_trading_day_unavailable \
  -q
```

Expected: PASS.

- [ ] **Step 3: Inspect manual route ownership**

Confirm `hoga/api/watchlist_routes.py` still imports and calls `catchup_one_entry(...)` in both manual catch-up routes. No production code change is needed if present.

Use:

```bash
rg -n "catchup_one_entry|@router.post\\(\"/api/watchlist|catchup" hoga/api/watchlist_routes.py
```

Expected: output shows manual route handlers still delegate to `catchup_one_entry`.

---

## Task 4: FastAPI Startup Regression and Smoke

**Files:**
- Modify: `tests/api/test_screener_update.py` or create `tests/api/test_app_startup_scheduler.py`
- Modify if needed: `hoga/api/app.py`
- Modify if needed: `hoga/live/lifecycle.py`

**Interfaces:**
- Preserves: `hoga.api.app.create_app(data_dir: Path) -> FastAPI`
- Confirms: App lifespan still calls `start_scheduler(data_dir)`.
- Confirms: Default `start_scheduler(data_dir)` no longer includes `watchlist-catchup`.
- Confirms: Default lifespan does not call `start_live_stream(data_dir=...)`.
- Confirms: `HOGA_LIVE_STARTUP_ENABLED=true` opts live startup back in.
- Confirms: live watchdog does not evaluate calendar gate before a stream has started.

- [ ] **Step 1: Add app lifespan test for default scheduler task names**

Prefer creating `tests/api/test_app_startup_scheduler.py` if that file does not exist. Add:

```python
from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient


def test_app_startup_scheduler_does_not_spawn_catchup_by_default(
    tmp_path: Path,
    monkeypatch,
):
    from hoga.api import app as app_mod
    from hoga.api import scheduler as scheduler_mod

    task_names: list[str] = []

    async def async_noop(**_kw):
        return None

    async def fake_daily_loop(data_dir):
        await asyncio.sleep(3600)

    async def fake_catchup(data_dir):
        raise AssertionError("startup catch-up must not run by default")

    original_create_task = asyncio.create_task

    def tracking_create_task(coro, *, name=None, context=None):
        if name is not None:
            task_names.append(name)
        return original_create_task(coro, name=name, context=context)

    monkeypatch.delenv("HOGA_STARTUP_CATCHUP_ENABLED", raising=False)
    monkeypatch.setattr(scheduler_mod, "_daily_loop", fake_daily_loop)
    monkeypatch.setattr(scheduler_mod, "_catchup_run", fake_catchup)
    monkeypatch.setattr(app_mod, "start_live_stream", async_noop)
    monkeypatch.setattr(app_mod, "start_live_stream_watchdog", async_noop)
    monkeypatch.setattr(app_mod, "start_today_promoter", async_noop)
    monkeypatch.setattr(asyncio, "create_task", tracking_create_task)

    with TestClient(app_mod.create_app(tmp_path)) as client:
        assert client.get("/health").status_code == 200

    assert "watchlist-daily-loop" in task_names
    assert "watchlist-catchup" not in task_names
```

- [ ] **Step 2: Run app lifespan test**

Run:

```bash
uv run --extra dev pytest tests/api/test_app_startup_scheduler.py::test_app_startup_scheduler_does_not_spawn_catchup_by_default -q
```

Expected: PASS after Task 2 implementation. If it fails because monkeypatching `scheduler_mod._daily_loop` does not affect the imported function used by `app_mod.start_scheduler`, patch `hoga.api.scheduler._daily_loop` before creating the app and keep `app_mod.start_scheduler` unchanged.

- [ ] **Step 2a: Add live startup opt-in tests if default smoke still emits `chk-holiday`**

If default startup smoke still emits `chk-holiday call failed`, add app-level tests that default startup does not call `start_live_stream`, and `HOGA_LIVE_STARTUP_ENABLED=true` does call it. Also add a watchdog unit test proving `_ws_watchdog_check` returns before `ws_capture_window_async` when no stream has started.

- [ ] **Step 3: Run targeted backend suite**

Run:

```bash
uv run --extra dev pytest \
  tests/test_api_scheduler.py \
  tests/test_api_watchlist_routes.py \
  tests/api/test_app_startup_scheduler.py \
  tests/api/test_screener_update.py \
  tests/api/test_screener_run_update.py \
  tests/unit/live/test_lifecycle_start.py \
  -q
```

Expected: all PASS.

- [ ] **Step 4: Run startup smoke test**

Run:

```bash
timeout 10s uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8018 --reload-dir hoga
```

Expected:

```text
Application startup complete
```

Expected absent:

```text
watchlist-catchup
catch-up:
KIS rate-limited (EGW00201)
chk-holiday call failed
```

Note: `live.ws.appkey_in_use` can still appear if another process owns the same KIS appkey. That is out of scope.

- [ ] **Step 5: Run opt-in smoke test**

Run:

```bash
HOGA_STARTUP_CATCHUP_ENABLED=true HOGA_LIVE_STARTUP_ENABLED=true timeout 10s uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8019 --reload-dir hoga
```

Expected:

```text
Application startup complete
```

`catch-up:` and `chk-holiday` logs may appear in this opt-in run. That confirms the recovery/live paths still exist when explicitly enabled.

---

## Task 5: Final Diff Review and Commit

**Files:**
- Verify only.

**Interfaces:**
- Confirms no `HOGA_STARTUP_CATCHUP_ENABLED` behavior is wired anywhere except scheduler startup.
- Confirms no manual route or daily scheduler regression.

- [ ] **Step 1: Check diff**

Run:

```bash
git diff -- hoga/api/scheduler.py hoga/api/app.py tests/test_api_scheduler.py tests/api/test_app_startup_scheduler.py
```

Expected:
- `hoga/api/scheduler.py` has `startup_catchup_enabled_from_env()`.
- `start_scheduler()` creates `watchlist-daily-loop` by default.
- `watchlist-catchup` task is created only when `startup_catchup_enabled_from_env()` is true.
- `hoga/api/app.py` starts live stream only when `HOGA_LIVE_STARTUP_ENABLED=true`.
- `hoga/live/lifecycle.py` watchdog does not evaluate calendar gate before stream start.
- Tests cover default OFF and explicit opt-in.

- [ ] **Step 2: Run final verification**

Run:

```bash
uv run --extra dev pytest \
  tests/test_api_scheduler.py \
  tests/test_api_watchlist_routes.py \
  tests/api/test_app_startup_scheduler.py \
  tests/api/test_screener_update.py \
  tests/api/test_screener_run_update.py \
  tests/unit/live/test_lifecycle_start.py \
  -q
```

Expected: all PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add hoga/api/scheduler.py tests/test_api_scheduler.py tests/api/test_app_startup_scheduler.py
git commit -m "fix(api): disable startup watchlist catchup by default"
```

## Self-Review Checklist

- Startup 기본값에서 Watchlist catch-up task가 생성되지 않는다.
- Daily loop는 startup에서 계속 생성된다.
- Daily `_daily_run()`은 여전히 17:00 KST에 Watchlist enqueue와 screener update를 수행한다.
- Manual Watchlist catch-up routes는 여전히 동작한다.
- Startup opt-in env는 `HOGA_STARTUP_CATCHUP_ENABLED=true`만 허용한다.
- Live startup opt-in env는 `HOGA_LIVE_STARTUP_ENABLED=true`만 허용한다.
- Startup smoke에서 `catch-up:` 로그와 KIS calendar failure 로그가 기본값으로 발생하지 않는다.
- 새 KIS 직접 호출 경로가 없다.
