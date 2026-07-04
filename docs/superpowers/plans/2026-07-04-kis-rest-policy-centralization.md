# KIS REST Policy Centralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `KIS API 우회` a backend-authoritative KIS REST data-call bypass that stops backend REST producers, serves stored/cache data, and keeps live/study charts usable during KIS outages.

**Architecture:** Add `kis_rest_bypass_enabled` to persisted live settings, expose it through `/api/live/settings` and `/api/live/status`, and enforce it at `hoga/live/kis_access.py` before scheduler submission or legacy role fallback. Runtime supervisors stop before they can spam blocked work; route/domain modules own their own cache-only or empty/stale fallback responses.

**Tech Stack:** FastAPI + Pydantic backend, pytest + pytest-asyncio backend tests, React + TypeScript + Zustand + TanStack Query frontend, Vitest/Testing Library frontend tests.

## Global Constraints

- Bypass controls KIS REST data requests only; KIS WebSocket live capture and `KisClient.get_approval_key()` remain allowed.
- Bypass is persisted in `<data_dir>/live_settings.json`, default `false`, and survives restart until explicitly turned off.
- Bypass does not mutate `storage_policy` or Source Preference.
- Already-written `hogaplay`, `kis_live`, and `kis_api` Source artifacts remain displayable.
- Bypass ON is an intentional paused state, not a degraded-health state.
- Cache misses while bypass is ON produce warnings, not retries or repeated toasts.
- Do not label transport failures as `점검중` unless KIS returns an explicit maintenance code/message.
- Keep KIS candle parquet integration out of this implementation.

---

## File Structure

- `hoga/api/models.py`: add `kis_rest_bypass_enabled` to `LiveSettingsResponse`, make `LiveSettingsUpdate` partial, add status/quote stale fields.
- `hoga/live/settings.py`: preserve omitted settings fields and persist bypass.
- `hoga/live/kis_access.py`: central bypass helper and `KisRestBypassedError`; block `run_with_capacity` and legacy role fallback.
- `hoga/live/storage_runtime.py`: suppress REST 30s recorder and program-trade collector under bypass while preserving `storage_policy`.
- `hoga/live/lifecycle.py`: expose bypass in `LiveStatus`; do not create display REST poller under bypass.
- `hoga/live/live_candle_backfill.py`: add minute cache-only collection.
- `hoga/live/live_daily_candle_backfill.py`: add daily cache-only collection.
- `hoga/live/api.py`: route bypass behavior for settings/status, quotes, tab metrics, index candles, investor endpoints, and candle endpoints.
- `hoga/api/screener_intraday.py` and `hoga/api/screener.py`: skip intraday overlay while bypass is ON and return EOD fallback warning.
- `frontend/src/api/liveSettings.ts`, `frontend/src/api/liveStatus.ts`, `frontend/src/api/liveQuotes.ts`: wire new fields and stale quote flags.
- `frontend/src/state/kisRestMode.ts`: keep notification state and bounded legacy migration helpers; stop owning bypass truth.
- `frontend/src/live/KisRestUnavailableToastHost.tsx` and `frontend/src/live/LiveSettingsSections.tsx`: patch backend setting.
- `frontend/src/live/useLiveBundle.ts` and `frontend/src/studyViews/useStudyReferenceBundle.ts`: query cache-only KIS endpoints and local fallbacks instead of disabling candle layers.

---

### Task 1: Backend Live Settings Become Partial and Persist Bypass

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/live/settings.py`
- Modify: `hoga/live/api.py`
- Test: `tests/unit/live/test_settings.py`

**Interfaces:**
- Produces: `LiveSettingsResponse.kis_rest_bypass_enabled: bool`
- Produces: `LiveSettingsUpdate(storage_policy: LiveStoragePolicy | None, program_trade_storage_enabled: bool | None, kis_rest_bypass_enabled: bool | None)`
- Produces: `update_live_settings(data_dir, *, storage_policy=None, program_trade_storage_enabled=None, kis_rest_bypass_enabled=None) -> LiveSettings`
- Consumes: existing `save_live_settings`, `load_live_settings`, `/api/live/settings`

- [ ] **Step 1: Write failing settings model tests**

Create `tests/unit/live/test_settings.py` with:

```python
from __future__ import annotations

import json

from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import load_live_settings, save_live_settings, update_live_settings


def test_live_settings_default_has_bypass_false(tmp_path):
    settings = load_live_settings(tmp_path)

    assert settings.storage_policy == "ws_plus_rest"
    assert settings.program_trade_storage_enabled is False
    assert settings.kis_rest_bypass_enabled is False


def test_update_live_settings_partial_patch_preserves_omitted_fields(tmp_path):
    save_live_settings(
        tmp_path,
        LiveSettingsResponse(
            storage_policy="rest_only",
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=False,
        ),
    )

    updated = update_live_settings(tmp_path, kis_rest_bypass_enabled=True)

    assert updated.storage_policy == "rest_only"
    assert updated.program_trade_storage_enabled is True
    assert updated.kis_rest_bypass_enabled is True
    on_disk = json.loads((tmp_path / "live_settings.json").read_text(encoding="utf-8"))
    assert on_disk["kis_rest_bypass_enabled"] is True


def test_ws_only_still_disables_program_trade_without_changing_bypass(tmp_path):
    save_live_settings(
        tmp_path,
        LiveSettingsResponse(
            storage_policy="rest_only",
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=True,
        ),
    )

    updated = update_live_settings(tmp_path, storage_policy="ws_only")

    assert updated.storage_policy == "ws_only"
    assert updated.program_trade_storage_enabled is False
    assert updated.kis_rest_bypass_enabled is True


def test_corrupt_settings_falls_back_to_bypass_false(tmp_path):
    (tmp_path / "live_settings.json").write_text("{broken", encoding="utf-8")

    settings = load_live_settings(tmp_path)

    assert settings.kis_rest_bypass_enabled is False
    assert list(tmp_path.glob("live_settings.json.corrupt-*"))
```

- [ ] **Step 2: Run settings tests and verify failure**

Run: `pytest tests/unit/live/test_settings.py -q`

Expected: FAIL because `kis_rest_bypass_enabled` and partial `update_live_settings` do not exist yet.

- [ ] **Step 3: Implement backend settings fields**

In `hoga/api/models.py`, replace the live settings models with:

```python
LiveStoragePolicy = Literal["ws_only", "ws_plus_rest", "rest_only"]


class LiveSettingsResponse(BaseModel):
    schema_version: int = 1
    storage_policy: LiveStoragePolicy = "ws_plus_rest"
    program_trade_storage_enabled: bool = False
    kis_rest_bypass_enabled: bool = False


class LiveSettingsUpdate(BaseModel):
    storage_policy: LiveStoragePolicy | None = None
    program_trade_storage_enabled: bool | None = None
    kis_rest_bypass_enabled: bool | None = None
```

In `hoga/live/settings.py`, replace `update_live_settings` with:

```python
def update_live_settings(
    data_dir: Path,
    *,
    storage_policy: LiveStoragePolicy | None = None,
    program_trade_storage_enabled: bool | None = None,
    kis_rest_bypass_enabled: bool | None = None,
) -> LiveSettings:
    previous = load_live_settings(data_dir)
    next_storage_policy = storage_policy or previous.storage_policy
    next_program_enabled = (
        previous.program_trade_storage_enabled
        if program_trade_storage_enabled is None
        else program_trade_storage_enabled
    )
    settings = LiveSettings(
        storage_policy=next_storage_policy,
        program_trade_storage_enabled=(
            False if next_storage_policy == "ws_only" else bool(next_program_enabled)
        ),
        kis_rest_bypass_enabled=(
            previous.kis_rest_bypass_enabled
            if kis_rest_bypass_enabled is None
            else bool(kis_rest_bypass_enabled)
        ),
    )
    save_live_settings(data_dir, settings)
    return settings
```

In `hoga/live/api.py`, pass the new field:

```python
settings = update_live_settings(
    data_dir,
    storage_policy=req.storage_policy,
    program_trade_storage_enabled=req.program_trade_storage_enabled,
    kis_rest_bypass_enabled=req.kis_rest_bypass_enabled,
)
```

- [ ] **Step 4: Run settings tests and existing live settings frontend-adjacent backend tests**

Run: `pytest tests/unit/live/test_settings.py tests/unit/live/test_storage_runtime.py -q`

Expected: PASS for settings; storage runtime may still fail until Task 3 if it assumes no bypass field.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py hoga/live/settings.py hoga/live/api.py tests/unit/live/test_settings.py
git commit -m "feat: persist KIS REST bypass setting"
```

---

### Task 2: Central KIS REST Access Guard

**Files:**
- Modify: `hoga/live/kis_access.py`
- Test: `tests/unit/live/test_kis_rest_bypass_access.py`

**Interfaces:**
- Produces: `kis_rest_bypass_enabled(data_dir: Path) -> bool`
- Produces: `class KisRestBypassedError(KisApiError)`
- Produces: `run_with_capacity` raises `KisRestBypassedError` before scheduler/client resolution when bypass ON
- Consumes: `load_live_settings(data_dir)`

- [ ] **Step 1: Write failing guard tests**

Create `tests/unit/live/test_kis_rest_bypass_access.py` with:

```python
from __future__ import annotations

import pytest

import hoga.live.kis_access as kis_access
from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import save_live_settings


class FakeScheduler:
    def __init__(self) -> None:
        self.calls = 0

    async def submit(self, **kwargs):
        self.calls += 1
        return await kwargs["call"](object())


@pytest.mark.asyncio
async def test_run_with_capacity_blocks_before_scheduler_when_bypass_on(tmp_path):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    scheduler = FakeScheduler()
    called = False

    async def fetch_fn(_kis):
        nonlocal called
        called = True
        return "ok"

    with pytest.raises(kis_access.KisRestBypassedError) as err:
        await kis_access.run_with_capacity(
            scheduler,
            data_dir=tmp_path,
            role="background",
            key=("quotes",),
            endpoint=kis_access.KisRestEndpoint.QUOTES,
            priority="background",
            fetch_fn=fetch_fn,
        )

    assert err.value.msg_cd == "KIS_REST_BYPASSED"
    assert scheduler.calls == 0
    assert called is False


@pytest.mark.asyncio
async def test_run_with_capacity_blocks_legacy_fallback_when_bypass_on(tmp_path, monkeypatch):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    monkeypatch.setattr(kis_access, "kis_for_role", lambda role, data_dir: object())

    with pytest.raises(kis_access.KisRestBypassedError):
        await kis_access.run_with_capacity(
            None,
            data_dir=tmp_path,
            role="background",
            key=("legacy",),
            endpoint=kis_access.KisRestEndpoint.QUOTES,
            priority="background",
            fetch_fn=lambda _kis: "not awaited",
        )


@pytest.mark.asyncio
async def test_run_with_capacity_allows_scheduler_when_bypass_off(tmp_path):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=False))
    scheduler = FakeScheduler()

    async def fetch_fn(_kis):
        return "ok"

    result = await kis_access.run_with_capacity(
        scheduler,
        data_dir=tmp_path,
        role="background",
        key=("quotes",),
        endpoint=kis_access.KisRestEndpoint.QUOTES,
        priority="background",
        fetch_fn=fetch_fn,
    )

    assert result == "ok"
    assert scheduler.calls == 1
```

- [ ] **Step 2: Run guard tests and verify failure**

Run: `pytest tests/unit/live/test_kis_rest_bypass_access.py -q`

Expected: FAIL because `KisRestBypassedError` does not exist.

- [ ] **Step 3: Implement guard**

In `hoga/live/kis_access.py`, add imports and helpers:

```python
from .settings import load_live_settings
from .kis_client import KisApiError, KisAuthError, KisClient


class KisRestBypassedError(KisApiError):
    def __init__(self) -> None:
        super().__init__(
            msg_cd="KIS_REST_BYPASSED",
            msg1="KIS REST bypass is enabled",
        )


def kis_rest_bypass_enabled(data_dir: Path) -> bool:
    return load_live_settings(data_dir).kis_rest_bypass_enabled


def _raise_if_bypassed(data_dir: Path) -> None:
    if kis_rest_bypass_enabled(data_dir):
        raise KisRestBypassedError()
```

At the start of `fetch_for_role`, before the `kis_for_role(role, data_dir)` call, add:

```python
    _raise_if_bypassed(data_dir)
```

At the start of `run_with_capacity`, before `_endpoint_value(endpoint)`, add:

```python
    _raise_if_bypassed(data_dir)
```

- [ ] **Step 4: Run guard tests and scheduler invariants**

Run: `pytest tests/unit/live/test_kis_rest_bypass_access.py tests/unit/live/test_kis_runtime_accounts.py::test_kis_for_role_n1_all_account0 -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_access.py tests/unit/live/test_kis_rest_bypass_access.py
git commit -m "feat: block KIS REST data calls when bypassed"
```

---

### Task 3: Stop REST Supervisors and Expose Paused Status

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/live/storage_runtime.py`
- Modify: `hoga/live/lifecycle.py`
- Test: `tests/unit/live/test_storage_runtime.py`
- Test: `tests/unit/live/test_lifecycle_rest_poller.py`

**Interfaces:**
- Consumes: `load_live_settings(data_dir).kis_rest_bypass_enabled`
- Produces: `LiveStatus.kis_rest_bypass_enabled: bool`
- Produces: storage runtime snapshot with `kis_api_targets=()` while bypass ON

- [ ] **Step 1: Extend storage runtime tests**

Append to `tests/unit/live/test_storage_runtime.py`:

```python
@pytest.mark.asyncio
async def test_storage_runtime_bypass_stops_api_recorder_without_mutating_policy(tmp_path, monkeypatch) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    existing = FakeRest30Recorder()
    save_live_settings(
        tmp_path,
        LiveSettings(storage_policy="rest_only", kis_rest_bypass_enabled=True),
    )
    state = FakeStorageState(rest30_recorder=existing)

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.storage_policy == "rest_only"
    assert snapshot.ws_targets == ()
    assert snapshot.kis_api_targets == ()
    assert existing.targets == set()
    assert existing.stopped is True


@pytest.mark.asyncio
async def test_storage_runtime_bypass_stops_program_trade_collector(tmp_path, monkeypatch) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    existing = FakeProgramTradeCollector()
    save_live_settings(
        tmp_path,
        LiveSettings(
            storage_policy="ws_plus_rest",
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=True,
        ),
    )
    state = FakeStorageState(program_trade_collector=existing)

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260623",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.kis_api_targets == ()
    assert existing.stopped is True
```

- [ ] **Step 2: Add lifecycle/status tests**

Create `tests/unit/live/test_lifecycle_rest_poller.py` if absent with:

```python
from __future__ import annotations

from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import save_live_settings


def test_status_exposes_kis_rest_bypass_enabled(tmp_path, monkeypatch):
    from hoga.live import lifecycle

    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    monkeypatch.setattr(lifecycle, "_data_dir", tmp_path, raising=False)
    lifecycle.refresh_status_from_settings(tmp_path)

    status = lifecycle.get_status()

    assert status.kis_rest_bypass_enabled is True
```

If `refresh_status_from_settings` does not exist, implement it in Step 4 rather than reaching into `_state` from the test.

- [ ] **Step 3: Run tests and verify failure**

Run: `pytest tests/unit/live/test_storage_runtime.py tests/unit/live/test_lifecycle_rest_poller.py -q`

Expected: FAIL because runtime ignores bypass and `LiveStatus` lacks the field.

- [ ] **Step 4: Implement runtime suppression**

In `hoga/api/models.py`, add to `LiveStatus`:

```python
kis_rest_bypass_enabled: bool = False
```

In `hoga/live/storage_runtime.py`, after loading settings, compute:

```python
bypass = settings.kis_rest_bypass_enabled
```

Then replace the targets calculation with:

```python
targets = compute_live_storage_targets(
    data_dir,
    n_configured=n_configured,
    storage_policy=settings.storage_policy,
    current_ws_live_set=current_ws_live_set,
)
if bypass:
    targets = LiveStorageTargets(
        ws_targets=targets.ws_targets,
        kis_api_targets=(),
    )
```

Use the existing `if targets.kis_api_targets` branches to stop `rest30_recorder`. Gate program-trade collector with `not bypass`:

```python
program_trade_allowed = (
    settings.program_trade_storage_enabled
    and settings.storage_policy != "ws_only"
    and not bypass
)
```

In `hoga/live/lifecycle.py`, add:

```python
def refresh_status_from_settings(data_dir: Path) -> None:
    settings = load_live_settings(data_dir)
    _state.storage_policy = settings.storage_policy
    _state.kis_rest_bypass_enabled = settings.kis_rest_bypass_enabled
```

Add `kis_rest_bypass_enabled: bool = False` to the lifecycle state class/dataclass and include it in `get_status()`:

```python
kis_rest_bypass_enabled=_state.kis_rest_bypass_enabled,
```

Where `refresh_live_stream` loads settings for its `data_dir` keyword argument, call `refresh_status_from_settings(data_dir)` and skip `_ensure_poller` when `_state.kis_rest_bypass_enabled` is true. If an existing poller is present when bypass flips ON, stop it and set `_state.rest_poller = None`.

- [ ] **Step 5: Run runtime tests**

Run: `pytest tests/unit/live/test_storage_runtime.py tests/unit/live/test_lifecycle_rest_poller.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py hoga/live/storage_runtime.py hoga/live/lifecycle.py tests/unit/live/test_storage_runtime.py tests/unit/live/test_lifecycle_rest_poller.py
git commit -m "feat: pause KIS REST supervisors during bypass"
```

---

### Task 4: Cache-Only Candle and Index Endpoints

**Files:**
- Modify: `hoga/live/live_candle_backfill.py`
- Modify: `hoga/live/live_daily_candle_backfill.py`
- Modify: `hoga/live/api.py`
- Test: `tests/unit/live/test_api_kis_rest_bypass_candles.py`

**Interfaces:**
- Produces: minute cache-only mode returning cached candles plus `kis_rest_bypassed` warnings
- Produces: daily cache-only mode returning cached rows plus `kis_rest_bypassed` warnings
- Consumes: `kis_access.kis_rest_bypass_enabled(data_dir)`

- [ ] **Step 1: Write endpoint-level failing tests**

Create `tests/unit/live/test_api_kis_rest_bypass_candles.py` with route tests around the live API router factory. Use existing route fixture style from `tests/unit/live/test_api.py` if present. The critical assertions are:

```python
assert response.status_code == 200
assert response.json()["data_warnings"][0]["reason"] == "kis_rest_bypassed"
assert fake_kis_fetch_count == 0
```

For index candles:

```python
assert response.status_code == 200
assert response.json()["data_warnings"][0]["reason"] == "kis_rest_bypassed"
assert fake_index_fetch_count == 0
```

- [ ] **Step 2: Run candle bypass tests and verify failure**

Run: `pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q`

Expected: FAIL because the endpoints still try KIS on cache miss.

- [ ] **Step 3: Implement minute cache-only helper**

In `hoga/live/live_candle_backfill.py`, add:

```python
async def collect_minute_cache_only(
    self,
    *,
    code: str,
    from_s: str,
    to_s: str,
    venue_policy: LiveVenuePolicy,
) -> LivePastCandlesResponse:
    candles: list[dict] = []
    warnings: list[dict] = []
    for date_s in each_yyyymmdd(from_s, to_s):
        cached = self.cache.get_past(code, date_s, venue=venue_policy.cache_venue_for_date(date_s))
        if cached:
            candles.extend(cached)
        else:
            warnings.append({
                "reason": "kis_rest_bypassed",
                "date": date_s,
                "msg": "KIS REST bypass is enabled; served cache-only data",
            })
    return LivePastCandlesResponse(
        code=code,
        from_=from_s,
        to=to_s,
        candles=sorted(candles, key=lambda c: c["t_ms"]),
        effective_sessions=[],
        data_warnings=warnings,
    )
```

Adapt names to the actual response type and existing date iteration helpers in the file. Keep the behavior concrete: cache hit returns rows, cache miss emits warning, no KIS fetch.

- [ ] **Step 4: Implement daily cache-only helper**

In `hoga/live/live_daily_candle_backfill.py`, add:

```python
async def collect_daily_cache_only(
    self,
    *,
    code: str,
    from_s: str,
    to_s: str,
    venue_policy: LiveVenuePolicy,
) -> LivePastDailyCandlesResponse:
    loaded: list[dict] = []
    warnings: list[dict] = []
    covered: list[tuple[str, str]] = []
    for batch_from, batch_to, rows in self.cache.list_batches(code):
        if batch_to < from_s or batch_from > to_s:
            continue
        loaded.extend(rows)
        covered.append((batch_from, batch_to))
    gaps = compute_uncovered_gaps(from_s, to_s, covered)
    for gap_from, gap_to in gaps:
        warnings.append({
            "reason": "kis_rest_bypassed",
            "batch": f"{gap_from}__{gap_to}",
            "msg": "KIS REST bypass is enabled; served cache-only data",
        })
    return LivePastDailyCandlesResponse(
        code=code,
        from_=from_s,
        to=to_s,
        candles=sorted(loaded, key=lambda c: c["t_ms"]),
        cached_batches=[{"from": a, "to": b} for a, b in covered],
        fresh_batches=[],
        data_warnings=warnings,
    )
```

If the project already has gap helpers in `batched_daily_walkback`, use that helper directly rather than duplicating date math.

- [ ] **Step 5: Route bypass to cache-only helpers**

In `hoga/live/api.py`, in `/past-candles`, `/past-daily-candles`, and `/index-candles`, branch before constructing any `run_with_capacity` fetch. The minute route call shape is:

```python
if data_dir is not None and kis_access.kis_rest_bypass_enabled(data_dir):
    return await _minute_backfill.collect_minute_cache_only(
        code=code,
        from_s=from_,
        to_s=to,
        venue_policy=venue_policy,
    )
```

For `/index-candles`, use the existing index cache object. The route branch returns the same wire shape as the normal path:

```python
if kis_access.kis_rest_bypass_enabled(data_dir):
    result = collect_index_candles_cache_only(
        cache=index_candles_cache_instance,
        key=(index.id, timeframe),
        from_s=from_,
        to_s=to,
    )
```

The cache-only index result contains `data_warnings=[{"reason": "kis_rest_bypassed", "msg": "KIS REST bypass is enabled; served cache-only data"}]` for missing ranges.

- [ ] **Step 6: Run candle tests**

Run: `pytest tests/unit/live/test_api_kis_rest_bypass_candles.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hoga/live/live_candle_backfill.py hoga/live/live_daily_candle_backfill.py hoga/live/api.py tests/unit/live/test_api_kis_rest_bypass_candles.py
git commit -m "feat: serve KIS candles cache-only during bypass"
```

---

### Task 5: Quotes, Tab Metrics, Screener, and Investor Degrade Without KIS

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/live/api.py`
- Modify: `hoga/api/screener_intraday.py`
- Modify: `hoga/api/screener.py`
- Test: `tests/unit/live/test_api_kis_rest_bypass_quotes.py`
- Test: relevant screener scan tests under `tests/unit/api/`

**Interfaces:**
- Produces: `LiveQuote.stale: bool`
- Produces: `LiveQuote.stale_reason: str | None`
- Produces: `/api/live/quotes` returns stale last-good quotes under bypass without KIS
- Produces: `/api/live/tab-metrics` keeps hoga fields but nulls quote fields under bypass
- Produces: screener intraday overlay skipped warning

- [ ] **Step 1: Write quote bypass tests**

Create `tests/unit/live/test_api_kis_rest_bypass_quotes.py` with:

```python
def test_quotes_bypass_returns_stale_last_good_without_fetch(client, tmp_path, fake_quote_fetcher):
    fake_quote_fetcher.seed_last_quote(code="005930", price=70000, change_pct=1.2, change_won=800)
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))

    response = client.get("/api/live/quotes?codes=005930&venue=KRX")

    assert response.status_code == 200
    body = response.json()
    assert body["quotes"][0]["code"] == "005930"
    assert body["quotes"][0]["stale"] is True
    assert body["quotes"][0]["stale_reason"] == "kis_rest_bypassed"
    assert fake_quote_fetcher.fetch_count == 0


def test_quotes_bypass_returns_empty_without_last_good(client, tmp_path, fake_quote_fetcher):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))

    response = client.get("/api/live/quotes?codes=005930&venue=KRX")

    assert response.status_code == 200
    assert response.json()["quotes"] == []
    assert fake_quote_fetcher.fetch_count == 0
```

Use the existing live API test fixture names if they differ; keep these assertions unchanged.

- [ ] **Step 2: Write screener intraday fallback test**

Add a test to the existing screener scan test module:

```python
def test_intraday_scan_bypass_skips_quote_overlay_and_uses_eod(tmp_path, monkeypatch):
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    called = False

    async def fake_overlay(*args, **kwargs):
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr("hoga.api.screener_intraday.build_intraday_overlay", fake_overlay)

    response = run_scan(data_dir=tmp_path, basis="intraday", conditions=[])

    assert called is False
    assert "kis_rest_bypassed_intraday_overlay_skipped" in response.warnings
```

Use the project’s actual scan helper/route fixture. The invariant is no KIS overlay call and EOD fallback warning.

- [ ] **Step 3: Run tests and verify failure**

Run: `pytest tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/unit/api -k intraday -q`

Expected: FAIL because stale fields and bypass branch do not exist.

- [ ] **Step 4: Implement stale quote wire and helper**

In `hoga/api/models.py` or `hoga/live/api.py` where `LiveQuote` is defined, add:

```python
stale: bool = False
stale_reason: str | None = None
```

In `LiveQuoteFetcher`, add:

```python
def stale_last_good(
    self,
    code_list: list[str],
    phase: str,
    today: date | None = None,
) -> list[LiveQuote]:
    rows: list[LiveQuote] = []
    for code in code_list:
        q = self._last_quotes.get(code)
        if q is None:
            continue
        live = self._to_live_quote(q, phase=phase, today=today)
        live.stale = True
        live.stale_reason = "kis_rest_bypassed"
        rows.append(live)
    return rows
```

In `/api/live/quotes`, before `run_with_capacity`, add:

```python
if kis_access.kis_rest_bypass_enabled(data_dir):
    return LiveQuotesResponse(
        phase=phase,
        quotes=_quote_fetcher.stale_last_good(code_list, phase, today=now.date()),
    )
```

- [ ] **Step 5: Implement tab metrics quote-null branch**

In `/api/live/tab-metrics`, before the quote `run_with_capacity` block:

```python
if kis_access.kis_rest_bypass_enabled(data_dir):
    quotes = []
else:
    quotes = await asyncio.wait_for(
        asyncio.shield(
            kis_access.run_with_capacity(
                _kis_scheduler,
                data_dir=data_dir,
                role="background",
                key=("tab-metrics-quotes", quote_venue, tuple(sorted(code_list)), phase),
                endpoint=kis_access.KisRestEndpoint.QUOTES,
                priority="background",
                cooldown_scope=f"quotes:{quote_venue}",
                fetch_fn=lambda kis: _quote_fetcher.fetch_and_gate(
                    kis,
                    code_list,
                    phase,
                    today=now.date(),
                    venue=quote_venue,
                ),
            )
        ),
        timeout=1.0,
    )
```

Ensure the existing `quote_by_code = {}` path leaves `change_pct` and other quote-derived fields as `None`.

- [ ] **Step 6: Implement screener intraday bypass**

In `hoga/api/screener_intraday.py`, add a callable helper:

```python
def intraday_overlay_bypassed(data_dir: Path) -> bool:
    return kis_access.kis_rest_bypass_enabled(data_dir)
```

In the scan path before scheduling `KisRestEndpoint.QUOTES`:

```python
if intraday_overlay_bypassed(data_dir):
    return IntradayOverlayResult(rows={}, warnings=["kis_rest_bypassed_intraday_overlay_skipped"])
```

In `hoga/api/screener.py`, merge this warning into the scan response and evaluate against the EOD corpus.

- [ ] **Step 7: Run quote/screener tests**

Run: `pytest tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/unit/api -k "screener and intraday" -q`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hoga/api/models.py hoga/live/api.py hoga/api/screener_intraday.py hoga/api/screener.py tests/unit/live/test_api_kis_rest_bypass_quotes.py tests/unit/api
git commit -m "feat: degrade quote and screener REST paths during bypass"
```

---

### Task 6: Frontend Backend-Owned Toggle, Toast, and Legacy Migration

**Files:**
- Modify: `frontend/src/api/liveSettings.ts`
- Modify: `frontend/src/api/liveStatus.ts`
- Modify: `frontend/src/state/kisRestMode.ts`
- Modify: `frontend/src/live/KisRestUnavailableToastHost.tsx`
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Test: `frontend/src/api/liveSettings.test.ts`
- Test: `frontend/src/state/kisRestMode.test.ts`
- Test: `frontend/src/live/KisRestUnavailableToastHost.test.tsx`
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`

**Interfaces:**
- Consumes: `LiveSettings.kis_rest_bypass_enabled`
- Produces: `patchLiveSettings({ kis_rest_bypass_enabled: boolean })`
- Produces: local store tracks notification timestamps, not bypass truth
- Produces: one-way legacy migration from `chart.kisRestMode.v1`

- [ ] **Step 1: Update frontend settings API tests**

In `frontend/src/api/liveSettings.test.ts`, add:

```ts
it('patches only kis_rest_bypass_enabled', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
    schema_version: 1,
    storage_policy: 'ws_plus_rest',
    program_trade_storage_enabled: false,
    kis_rest_bypass_enabled: true,
  });

  const result = await patchLiveSettings({ kis_rest_bypass_enabled: true });

  expect(spy).toHaveBeenCalledWith('/api/live/settings', expect.objectContaining({
    method: 'PATCH',
    body: JSON.stringify({ kis_rest_bypass_enabled: true }),
  }));
  expect(result.kis_rest_bypass_enabled).toBe(true);
});
```

- [ ] **Step 2: Update store tests for notification-only ownership**

In `frontend/src/state/kisRestMode.test.ts`, replace persistence ownership tests with:

```ts
it('keeps toast timing state without owning backend bypass truth', () => {
  expect(useKisRestModeStore.getState().lastFailureAtMs).toBeNull();

  useKisRestModeStore.getState().notifyFailure(1_000);

  expect(useKisRestModeStore.getState().lastFailureAtMs).toBe(1_000);
  expect(useKisRestModeStore.getState().lastToastAtMs).toBe(1_000);
});

it('reads legacy true once for backend migration', () => {
  localStorage.setItem('chart.kisRestMode.v1', JSON.stringify({ kisRestBypassEnabled: true }));

  expect(readLegacyKisRestBypass()).toEqual({ kisRestBypassEnabled: true });

  markLegacyKisRestBypassMigrated();

  expect(readLegacyKisRestBypass()).toBeNull();
});
```

Export `readLegacyKisRestBypass` and `markLegacyKisRestBypassMigrated` from the store file in Step 4.

- [ ] **Step 3: Run frontend tests and verify failure**

Run: `npm test -- --run frontend/src/api/liveSettings.test.ts frontend/src/state/kisRestMode.test.ts frontend/src/live/KisRestUnavailableToastHost.test.tsx frontend/src/live/LiveSettingsSections.test.tsx`

Expected: FAIL because the frontend still uses localStorage as bypass truth.

- [ ] **Step 4: Implement frontend API types and migration helpers**

In `frontend/src/api/liveSettings.ts`:

```ts
export interface LiveSettings {
  schema_version: number;
  storage_policy: LiveStoragePolicy;
  program_trade_storage_enabled: boolean;
  kis_rest_bypass_enabled: boolean;
}

export type LiveSettingsPatch = {
  storage_policy?: LiveStoragePolicy;
  program_trade_storage_enabled?: boolean;
  kis_rest_bypass_enabled?: boolean;
};
```

In `frontend/src/state/kisRestMode.ts`, remove `kisRestBypassEnabled` and `setKisRestBypassEnabled` from the store interface. Add:

```ts
const STORAGE_KEY = 'chart.kisRestMode.v1';
const MIGRATED_KEY = 'chart.kisRestMode.v1.migrated';

export function readLegacyKisRestBypass(): { kisRestBypassEnabled: boolean } | null {
  try {
    if (localStorage.getItem(MIGRATED_KEY) === 'true') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kisRestBypassEnabled?: unknown };
    return parsed.kisRestBypassEnabled === true ? { kisRestBypassEnabled: true } : null;
  } catch {
    return null;
  }
}

export function markLegacyKisRestBypassMigrated(): void {
  try {
    localStorage.setItem(MIGRATED_KEY, 'true');
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable.
  }
}
```

- [ ] **Step 5: Implement backend-owned settings toggle**

In `LiveSettingsSections.tsx`, replace local store usage with:

```tsx
const kisRestBypassEnabled = data?.kis_rest_bypass_enabled ?? false;

<ToggleSwitch
  label="KIS API 우회"
  checked={kisRestBypassEnabled}
  onClick={() => patch.mutate({ kis_rest_bypass_enabled: !kisRestBypassEnabled })}
/>
```

When patching `storage_policy`, send only the changed policy plus program-trade normalization:

```tsx
patch.mutate({
  storage_policy: value,
  program_trade_storage_enabled: value === 'ws_only'
    ? false
    : (data?.program_trade_storage_enabled ?? false),
})
```

- [ ] **Step 6: Implement toast backend toggle and legacy migration**

In `KisRestUnavailableToastHost.tsx`:

```tsx
const { data: settings } = useLiveSettings();
const patch = usePatchLiveSettings();
const kisRestBypassEnabled = settings?.kis_rest_bypass_enabled ?? false;

<ToggleSwitch
  label="KIS API 우회"
  checked={kisRestBypassEnabled}
  onClick={() => patch.mutate({ kis_rest_bypass_enabled: !kisRestBypassEnabled })}
/>
```

Add an effect:

```tsx
useEffect(() => {
  if (!settings || settings.kis_rest_bypass_enabled) return;
  const legacy = readLegacyKisRestBypass();
  if (legacy?.kisRestBypassEnabled) {
    patch.mutate(
      { kis_rest_bypass_enabled: true },
      { onSettled: () => markLegacyKisRestBypassMigrated() },
    );
  }
}, [settings, patch]);
```

Keep failure toast state from `useKisRestModeStore`. If `kisRestBypassEnabled` is true, render `KIS REST 우회 중` and do not show repeated new failure toasts.

- [ ] **Step 7: Run frontend settings/toast tests**

Run: `npm test -- --run frontend/src/api/liveSettings.test.ts frontend/src/state/kisRestMode.test.ts frontend/src/live/KisRestUnavailableToastHost.test.tsx frontend/src/live/LiveSettingsSections.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/liveSettings.ts frontend/src/api/liveStatus.ts frontend/src/state/kisRestMode.ts frontend/src/live/KisRestUnavailableToastHost.tsx frontend/src/live/LiveSettingsSections.tsx frontend/src/api/liveSettings.test.ts frontend/src/state/kisRestMode.test.ts frontend/src/live/KisRestUnavailableToastHost.test.tsx frontend/src/live/LiveSettingsSections.test.tsx
git commit -m "feat: make KIS REST bypass backend-owned in UI"
```

---

### Task 7: Live and Study Stored-Data Fallbacks

**Files:**
- Modify: `frontend/src/api/liveQuotes.ts`
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/studyViews/useStudyReferenceBundle.ts`
- Test: `frontend/src/api/liveQuotes.test.tsx`
- Test: `frontend/src/live/useLiveBundle.test.tsx`
- Test: `frontend/src/studyViews/useStudyReferenceBundle.test.tsx`

**Interfaces:**
- Consumes: backend `kis_rest_bypass_enabled`
- Consumes: `/api/range?mode=full` and screener daily queries
- Produces: live/study do not disable whole candle layer under bypass
- Produces: stale quotes are display-only

- [ ] **Step 1: Update LiveQuote type and tests**

In `frontend/src/api/liveQuotes.ts`, add:

```ts
stale?: boolean;
stale_reason?: string | null;
```

In `frontend/src/api/liveQuotes.test.tsx`, add:

```ts
it('preserves stale quote flags from the backend', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({
    phase: 'open',
    quotes: [{
      code: '005930',
      price: 70000,
      change_pct: 1.2,
      change_won: 800,
      stale: true,
      stale_reason: 'kis_rest_bypassed',
    }],
  });

  const res = await getQuotes(['005930']);

  expect(res.quotes[0].stale).toBe(true);
  expect(res.quotes[0].stale_reason).toBe('kis_rest_bypassed');
});
```

- [ ] **Step 2: Update live bundle tests**

Replace the existing bypass test that expects KIS candle query inputs to be skipped with:

```ts
it('keeps stored range and screener daily fallbacks enabled when bypass is enabled', () => {
  seedLiveSettings({ kis_rest_bypass_enabled: true });

  const bundle = renderUseLiveBundle({
    code: '005930',
    timeframe: 'D',
    rangeCandles: [{ t: 1, open: 1, high: 2, low: 1, close: 2, volume: 100 }],
    screenerDailyCandles: [{ t_ms: 1, open: 1, high: 2, low: 1, close: 2, volume: 100 }],
  });

  expect(bundle.candles.length).toBeGreaterThan(0);
  expect(getScreenerDailyQueryEnabled()).toBe(true);
});
```

Use the existing test helpers in the file; the invariant is screener daily/range fallback stays enabled under bypass.

- [ ] **Step 3: Update study bundle tests**

Replace the test named `disables KIS candle queries when KIS REST bypass is enabled` with:

```ts
it('uses range full-mode fallback for minute study when KIS REST bypass is enabled', () => {
  seedLiveSettings({ kis_rest_bypass_enabled: true });

  const result = renderUseStudyReferenceBundle({
    timeframe: '3m',
    rangeCandles: [{ t: 1, open: 1, high: 2, low: 1, close: 2, volume: 100 }],
  });

  expect(result.current.bundle.candles).toHaveLength(1);
});

it('uses screener daily fallback for stock D/W/M study when KIS REST bypass is enabled', () => {
  seedLiveSettings({ kis_rest_bypass_enabled: true });

  const result = renderUseStudyReferenceBundle({
    timeframe: 'D',
    screenerDailyCandles: [{ t_ms: 1, open: 1, high: 2, low: 1, close: 2, volume: 100 }],
  });

  expect(result.current.bundle.candles).toHaveLength(1);
});
```

- [ ] **Step 4: Run live/study frontend tests and verify failure**

Run: `npm test -- --run frontend/src/api/liveQuotes.test.tsx frontend/src/live/useLiveBundle.test.tsx frontend/src/studyViews/useStudyReferenceBundle.test.tsx`

Expected: FAIL because hooks still read local bypass state and disable KIS candle layers.

- [ ] **Step 5: Implement hook changes**

In `useLiveBundle.ts`:

```ts
const { data: liveSettings } = useLiveSettings();
const kisRestBypassEnabled = liveSettings?.kis_rest_bypass_enabled ?? false;
```

Keep KIS past-candle endpoint queries enabled when they can return cache-only responses:

```ts
const enableMinute = !!(code && isMinute && minutePastFrom <= minutePastTo);
const enableDaily = !!(code && !isMinute);
```

Keep screener daily enabled independently:

```ts
const enableScreenerDaily = !!code && !isIndexInstrument(activeInstrument);
```

When KIS endpoint data returns `kis_rest_bypassed`, use `/api/range?mode=full` candles first for minute/D and screener daily fallback for stock D/W/M. Do not set `raw = []` merely because bypass is ON.

In `useStudyReferenceBundle.ts`, remove bypass-based query disabling:

```ts
const minuteQueryOptions = queryOptions.minuteCandles;
const dailyQueryOptions = queryOptions.dailyCandles;
```

Add a `rangeCandles` query using the existing range API with `mode: 'full'`, and merge:

```ts
const minuteCandles = kisMinuteCandles.length > 0
  ? kisMinuteCandles
  : rangeCandles.data?.candles ?? [];

const dailyCandles = kisDailyCandles.length > 0
  ? kisDailyCandles
  : screenerDailyCandles.data?.candles ?? [];
```

- [ ] **Step 6: Run live/study frontend tests**

Run: `npm test -- --run frontend/src/api/liveQuotes.test.tsx frontend/src/live/useLiveBundle.test.tsx frontend/src/studyViews/useStudyReferenceBundle.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/liveQuotes.ts frontend/src/live/useLiveBundle.ts frontend/src/studyViews/useStudyReferenceBundle.ts frontend/src/api/liveQuotes.test.tsx frontend/src/live/useLiveBundle.test.tsx frontend/src/studyViews/useStudyReferenceBundle.test.tsx
git commit -m "feat: keep stored chart fallbacks under KIS REST bypass"
```

---

### Task 8: Integration Verification and Documentation Sweep

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-kis-rest-policy-centralization-design.md` only if implementation discovers a mismatch
- Modify: `CONTEXT.md` only if implementation changes domain language
- Modify: `docs/adr/0083-kis-rest-bypass-backend-policy.md` only if the accepted decision changes

**Interfaces:**
- Consumes: all prior tasks
- Produces: verified branch ready for review

- [ ] **Step 1: Run backend focused suite**

Run:

```bash
pytest \
  tests/unit/live/test_settings.py \
  tests/unit/live/test_kis_rest_bypass_access.py \
  tests/unit/live/test_storage_runtime.py \
  tests/unit/live/test_lifecycle_rest_poller.py \
  tests/unit/live/test_api_kis_rest_bypass_candles.py \
  tests/unit/live/test_api_kis_rest_bypass_quotes.py \
  -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend focused suite**

Run:

```bash
npm test -- --run \
  frontend/src/api/liveSettings.test.ts \
  frontend/src/state/kisRestMode.test.ts \
  frontend/src/live/KisRestUnavailableToastHost.test.tsx \
  frontend/src/live/LiveSettingsSections.test.tsx \
  frontend/src/api/liveQuotes.test.tsx \
  frontend/src/live/useLiveBundle.test.tsx \
  frontend/src/studyViews/useStudyReferenceBundle.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run lint/type checks used by the repo**

Run the commands listed in `package.json` and the backend project config. For this repo, start with:

```bash
npm run typecheck
npm run test -- --run
pytest tests/unit/live -q
```

Expected: PASS. If a command is absent, record the missing script in the final handoff and run the closest existing check shown by `npm run`.

- [ ] **Step 4: Manual dev-server smoke**

Start the app the same way this repo normally does in development. In the browser:

1. Open `/live`.
2. Open Settings.
3. Turn `KIS API 우회` ON.
4. Confirm `/api/live/settings` returns `"kis_rest_bypass_enabled": true`.
5. Confirm `/api/live/status` returns `"kis_rest_bypass_enabled": true`.
6. Pan left on a minute chart.
7. Confirm server logs do not show KIS `inquire-time-dailychartprice`, `inquire-asking-price-exp-ccn`, or `intstock-multprice` calls triggered after the toggle.
8. Confirm the UI shows `저장 데이터만 표시 중` or `KIS API 저장 일시중지`, not repeated failure toasts.
9. Turn bypass OFF.
10. Confirm current visible queries refetch and the toggle does not bulk-refill old missing dates.

- [ ] **Step 5: Commit verification/documentation adjustments**

If Task 8 changed docs:

```bash
git add docs/superpowers/specs/2026-07-04-kis-rest-policy-centralization-design.md CONTEXT.md docs/adr/0083-kis-rest-bypass-backend-policy.md
git commit -m "docs: align KIS REST bypass implementation notes"
```

If Task 8 did not change docs, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage: Tasks 1-2 cover backend setting and central guard; Task 3 covers runtime loops/status; Tasks 4-5 cover endpoint behavior; Tasks 6-7 cover frontend toggle/toast/live/study fallback; Task 8 covers verification.
- Ambiguity scan: clear.
- Type consistency: The plan uses one backend field name, `kis_rest_bypass_enabled`, and one stale quote reason, `kis_rest_bypassed`.
