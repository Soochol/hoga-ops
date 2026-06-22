# Live Capture Source Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add folder-gated live storage policies, KIS REST 30-second persisted capture, and three-source display priority for `/live`.

**Architecture:** Keep `kis_live` as the internal WebSocket source id and add `kis_api` as a first-class persisted source. Compute Capture Candidates from watchlist folders with `capture_enabled=true`, then split them by a backend-persisted Storage Policy into WS and REST targets. Reuse the existing live JSONL-to-Parquet promotion path by parameterizing its source id instead of inventing a second table writer.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, asyncio, pytest, React, TypeScript, Zustand, TanStack Query, Vitest.

## Global Constraints

- Watchlist group opt-in owns capture candidates: only folders with capture enabled contribute live-storage candidates.
- WS capture remains code-disjoint per account.
- Current viewed-code REST poller remains display-only.
- Source preference is read policy, not write policy.
- Missing or invalid preferred data falls back.
- Internal source id remains `kis_live`; UI label becomes `KIS WS`.
- New persisted REST source id is `kis_api`.
- REST API persisted capture samples every `30000` ms.
- REST API persisted capture stores orderbook, trades, and brokers.
- Storage policy values are `ws_only`, `ws_plus_rest`, and `rest_only`.
- Display priority orders are `hogaplay -> kis_live -> kis_api`, `kis_live -> kis_api -> hogaplay`, and `kis_api -> kis_live -> hogaplay`.
- The REST display poller must not write `kis_api` files.
- Do not silently cap KIS API targets; expose configured targets and degraded status.

---

## File Structure

- Modify `hoga/api/models.py`
  - Add `capture_enabled` to `WatchlistFolder` and `WatchlistFolderView`.
  - Add request model `FolderCaptureRequest`.
  - Add live settings wire models `LiveStoragePolicy`, `LiveSettings`, and `LiveSettingsUpdate`.

- Modify `hoga/api/watchlist.py`
  - Migrate existing folders to `capture_enabled=true`.
  - Create new folders with `capture_enabled=false`.
  - Add `set_folder_capture_enabled(data_dir: Path, *, folder_id: str, capture_enabled: bool) -> WatchlistFolder`.

- Modify `hoga/api/watchlist_projection.py`
  - Include `capture_enabled` in folder wire projection.
  - Add `capture_ordered_codes(doc: WatchlistDocument, *, known_codes: set[str] | None = None) -> list[str]`.

- Modify `hoga/api/watchlist_routes.py`
  - Return folder views with capture flag.
  - Add `PATCH /api/watchlist/folders/{folder_id}/capture`.
  - Refresh live capture after toggle changes.

- Create `hoga/live/settings.py`
  - Own backend-persisted `<data_dir>/live_settings.json`.
  - Provide load/save/update helpers and the default `ws_plus_rest`.

- Create `hoga/live/rest30_writer.py`
  - Own the REST 30s JSONL staging root `<data_dir>/live_api/{date}/{code}.jsonl`.
  - Reuse `LiveSnapshot` and `LiveWriter`.

- Create `hoga/live/rest30_recorder.py`
  - Own the long-running 30-second KIS API recorder task.
  - Fetch orderbook, trades, brokers per target.
  - Append JSONL, publish to `LiveBuffer`, isolate per-symbol failures, and report status.

- Modify `hoga/live/promote.py`
  - Parameterize source id for JSONL promotion so `kis_live` and `kis_api` share one converter.
  - Add `promote_api_today(data_dir: Path, *, code: str) -> None`.

- Modify `hoga/live/coverage.py`
  - Compute Capture Candidates from capture-enabled folders.
  - Add storage-policy target planning for WS and REST.

- Modify `hoga/live/live_session.py`
  - Use planned WS targets, not the whole watchlist order.
  - Keep partitioning behavior unchanged for non-empty WS targets.

- Modify `hoga/live/lifecycle.py`
  - Load storage policy.
  - Start/stop/reconfigure WS and `Rest30sRecorder`.
  - Add LiveStatus fields for storage policy and KIS API recorder state.

- Modify `hoga/live/api.py`
  - Add `GET /api/live/settings`.
  - Add `PATCH /api/live/settings`.

- Modify `hoga/api/sources.py`
  - Add `kis_api`.
  - Add display-priority policy parsing and ordered fallback.
  - Keep legacy `source_pref=hogaplay` and `source_pref=kis_live` compatibility.

- Modify `hoga/api/bundle.py`, `hoga/api/routes.py`, and `hoga/api/disk_state.py`
  - Use ordered source policies instead of a single two-value source preference.
  - Include `kis_api` in source classification and aggregate selection.

- Modify frontend files:
  - `frontend/src/api/types.ts`: add `kis_api` and live settings types.
  - `frontend/src/api/liveSettings.ts`: create settings client and hooks.
  - `frontend/src/api/watchlist.ts`: add `capture_enabled` and toggle API.
  - `frontend/src/watchlist/useWatchlist.ts`: add optimistic capture toggle mutation.
  - `frontend/src/watchlist/WatchlistEditModal.tsx`: render group capture toggles.
  - `frontend/src/state/sourcePreference.ts`: add display priority values.
  - `frontend/src/live/settings/SourcePreferenceRadio.tsx`: relabel as display priority.
  - `frontend/src/live/LiveSettingsSections.tsx`: add storage policy controls.
  - `frontend/src/chart/SourceChip.tsx`: label `kis_live` as KIS WS and `kis_api` as KIS API 30s.
  - `frontend/src/api/liveStatus.ts`: add KIS API recorder status fields.

---

### Task 1: Folder Capture Toggle Domain

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `hoga/api/watchlist.py`
- Modify: `hoga/api/watchlist_projection.py`
- Modify: `hoga/api/watchlist_routes.py`
- Test: `tests/test_api_watchlist_folders.py`
- Test: `tests/api/test_watchlist_projection.py`
- Test: `tests/test_api_watchlist_routes.py`
- Test: `tests/unit/api/test_rest_wire_schema_contract.py`

**Interfaces:**
- Produces: `WatchlistFolder.capture_enabled: bool`
- Produces: `WatchlistFolderView.capture_enabled: bool`
- Produces: `FolderCaptureRequest(capture_enabled: bool)`
- Produces: `capture_ordered_codes(doc: WatchlistDocument, *, known_codes: set[str] | None = None) -> list[str]`
- Produces: `set_folder_capture_enabled(data_dir: Path, *, folder_id: str, capture_enabled: bool) -> WatchlistFolder`
- Consumes: existing `load_document`, `save_document`, `project_watchlist_response`, and `refresh_live_stream`.

- [ ] **Step 1: Write failing tests for model defaults and migration**

Append to `tests/test_api_watchlist_folders.py`:

```python
def test_watchlist_folder_defaults_capture_enabled_true_for_direct_model() -> None:
    from hoga.api.models import WatchlistFolder

    folder = WatchlistFolder(id="f_0000000a", name="스윙", order=0)

    assert folder.capture_enabled is True


def test_migrate_existing_v3_folder_without_capture_enabled_defaults_true(tmp_path):
    import json

    from hoga.api.watchlist import load_document

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 3,
        "folders": [{
            "id": "f_0000000a",
            "name": "스윙",
            "order": 0,
            "member_codes": ["005930"],
        }],
        "entries": [{
            "code": "005930",
            "name": "삼성전자",
            "registered_at_kst_date": "20260101",
            "last_success_date": None,
        }],
    }), encoding="utf-8")

    doc = load_document(tmp_path)

    assert doc.folders[0].capture_enabled is True


def test_new_folder_defaults_capture_disabled(tmp_path):
    import asyncio

    from hoga.api.watchlist import create_folder, load_document

    folder = asyncio.run(create_folder(tmp_path, name="신규"))

    assert folder.capture_enabled is False
    assert load_document(tmp_path).folders[0].capture_enabled is False


def test_set_folder_capture_enabled_persists(tmp_path):
    import asyncio

    from hoga.api.watchlist import create_folder, load_document, set_folder_capture_enabled

    folder = asyncio.run(create_folder(tmp_path, name="스윙"))
    updated = asyncio.run(set_folder_capture_enabled(
        tmp_path,
        folder_id=folder.id,
        capture_enabled=True,
    ))

    assert updated.capture_enabled is True
    assert load_document(tmp_path).folders[0].capture_enabled is True
```

- [ ] **Step 2: Write failing projection tests**

Append to `tests/api/test_watchlist_projection.py`:

```python
def test_project_folder_views_includes_capture_enabled() -> None:
    from hoga.api.watchlist_projection import project_folder_views

    views = project_folder_views(_doc())

    assert views[0].capture_enabled is True


def test_capture_ordered_codes_uses_enabled_folders_only() -> None:
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist_projection import capture_ordered_codes

    doc = WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000a",
                name="Enabled",
                order=0,
                member_codes=["005930", "000660"],
                capture_enabled=True,
            ),
            WatchlistFolder(
                id="f_0000000b",
                name="Disabled",
                order=1,
                member_codes=["035720"],
                capture_enabled=False,
            ),
            WatchlistFolder(
                id="f_0000000c",
                name="AlsoEnabled",
                order=2,
                member_codes=["000660", "035420"],
                capture_enabled=True,
            ),
        ],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            WatchlistEntry(code="035720", name="카카오", registered_at_kst_date="20260601"),
            WatchlistEntry(code="035420", name="NAVER", registered_at_kst_date="20260601"),
        ],
    )

    assert capture_ordered_codes(doc) == ["005930", "000660", "035420"]
    assert capture_ordered_codes(doc, known_codes={"005930", "035420"}) == ["005930", "035420"]
```

- [ ] **Step 3: Write failing route tests**

Append to `tests/test_api_watchlist_routes.py`:

```python
def test_create_folder_response_includes_capture_disabled(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        r = client.post("/api/watchlist/folders", json={"name": "스윙"})

    assert r.status_code == 201
    assert r.json()["capture_enabled"] is False


def test_patch_folder_capture_refreshes_live_stream(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        with patch("hoga.api.watchlist_routes.refresh_live_stream", new=AsyncMock()) as ref:
            r = client.patch(
                f"/api/watchlist/folders/{fid}/capture",
                json={"capture_enabled": True},
            )

    assert r.status_code == 200
    assert r.json()["capture_enabled"] is True
    ref.assert_awaited_once()


def test_patch_folder_capture_unknown_folder_returns_404(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        r = client.patch(
            "/api/watchlist/folders/f_deadbeef/capture",
            json={"capture_enabled": True},
        )

    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "folder_not_found"
```

Modify the contract in `tests/unit/api/test_rest_wire_schema_contract.py`:

```python
"WatchlistFolderView": frozenset({"id", "name", "order", "capture_enabled"}),
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
uv run pytest \
  tests/test_api_watchlist_folders.py \
  tests/api/test_watchlist_projection.py \
  tests/test_api_watchlist_routes.py \
  tests/unit/api/test_rest_wire_schema_contract.py -v
```

Expected: FAIL because `capture_enabled`, `FolderCaptureRequest`, `capture_ordered_codes`, and the capture route do not exist yet.

- [ ] **Step 5: Implement models and migration**

In `hoga/api/models.py`, update the watchlist models:

```python
class WatchlistFolder(BaseModel):
    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)
    member_codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]] = Field(default_factory=list)
    capture_enabled: bool = True


class WatchlistFolderView(BaseModel):
    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)
    capture_enabled: bool


class FolderCaptureRequest(BaseModel):
    capture_enabled: bool
```

In `hoga/api/watchlist.py`, preserve old folders as capture-enabled during `_migrate`:

```python
if version >= 3:
    return {
        "schema_version": 3,
        "folders": [{
            "id": f["id"],
            "name": f["name"],
            "order": f.get("order", i),
            "member_codes": list(f.get("member_codes", [])),
            "capture_enabled": bool(f.get("capture_enabled", True)),
        } for i, f in enumerate(raw.get("folders", []))],
        "entries": [_slim(e) for e in raw.get("entries", [])],
    }
```

Also include `capture_enabled=True` in every v1/v2 migrated folder because those folders already represented the old live-storage universe:

```python
folders_v3 = [{
    "id": f["id"],
    "name": f["name"],
    "order": f.get("order", i),
    "member_codes": codes_in(f["id"]),
    "capture_enabled": True,
} for i, f in enumerate(folders_v2)]
if nulls:
    folders_v3.append({
        "id": _DEFAULT_FOLDER_ID,
        "name": _DEFAULT_FOLDER_NAME,
        "order": len(folders_v3),
        "member_codes": nulls,
        "capture_enabled": True,
    })
```

Update `create_folder` so new folders opt out by default:

```python
folder = WatchlistFolder(
    id=_mint_folder_id(doc),
    name=name.strip(),
    order=len(doc.folders),
    member_codes=[],
    capture_enabled=False,
)
```

Add the setter near `rename_folder`:

```python
async def set_folder_capture_enabled(
    data_dir: Path,
    *,
    folder_id: str,
    capture_enabled: bool,
) -> WatchlistFolder:
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        updated = folder.model_copy(update={"capture_enabled": capture_enabled})
        folders = [updated if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": folders}))
        return updated
```

- [ ] **Step 6: Implement projection and route**

In `hoga/api/watchlist_projection.py`, update `project_folder_views`:

```python
def project_folder_views(doc: WatchlistDocument) -> list[WatchlistFolderView]:
    return [
        WatchlistFolderView(
            id=folder.id,
            name=folder.name,
            order=folder.order,
            capture_enabled=folder.capture_enabled,
        )
        for folder in ordered_folders(doc)
    ]
```

Add:

```python
def capture_ordered_codes(
    doc: WatchlistDocument,
    *,
    known_codes: set[str] | None = None,
) -> list[str]:
    by_code = {e.code for e in doc.entries}
    seen: set[str] = set()
    out: list[str] = []
    for folder in ordered_folders(doc):
        if not folder.capture_enabled:
            continue
        for code in folder.member_codes:
            if code in seen:
                continue
            if code not in by_code:
                log.warning(
                    "watchlist.drift: member %s in folder %s has no entry (skipped)",
                    code,
                    folder.id,
                )
                continue
            if known_codes is not None and code not in known_codes:
                continue
            seen.add(code)
            out.append(code)
    return out
```

In `hoga/api/watchlist_routes.py`, import `FolderCaptureRequest` and `set_folder_capture_enabled`, return capture flag from create route, and add:

```python
    @router.patch("/folders/{folder_id}/capture", response_model=WatchlistFolderView)
    async def set_watchlist_folder_capture(
        folder_id: str,
        req: FolderCaptureRequest,
    ) -> WatchlistFolderView:
        try:
            folder = await set_folder_capture_enabled(
                data_dir,
                folder_id=folder_id,
                capture_enabled=req.capture_enabled,
            )
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found",
                "message": f"Folder {folder_id} not found.",
            }) from e
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:
            log.exception("watchlist.folder_capture: refresh_live_stream failed")
        return WatchlistFolderView(
            id=folder.id,
            name=folder.name,
            order=folder.order,
            capture_enabled=folder.capture_enabled,
        )
```

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
uv run pytest \
  tests/test_api_watchlist_folders.py \
  tests/api/test_watchlist_projection.py \
  tests/test_api_watchlist_routes.py \
  tests/unit/api/test_rest_wire_schema_contract.py -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hoga/api/models.py hoga/api/watchlist.py hoga/api/watchlist_projection.py hoga/api/watchlist_routes.py tests/test_api_watchlist_folders.py tests/api/test_watchlist_projection.py tests/test_api_watchlist_routes.py tests/unit/api/test_rest_wire_schema_contract.py
git commit -m "feat: add watchlist capture toggles"
```

---

### Task 2: Backend Live Settings Storage Policy

**Files:**
- Create: `hoga/live/settings.py`
- Modify: `hoga/api/models.py`
- Modify: `hoga/live/api.py`
- Test: `tests/unit/live/test_settings.py`
- Test: `tests/unit/live/test_api.py`

**Interfaces:**
- Produces: `LiveStoragePolicy = Literal["ws_only", "ws_plus_rest", "rest_only"]`
- Produces: `LiveSettings(schema_version: int = 1, storage_policy: LiveStoragePolicy = "ws_plus_rest")`
- Produces: `load_live_settings(data_dir: Path) -> LiveSettings`
- Produces: `save_live_settings(data_dir: Path, settings: LiveSettings) -> None`
- Produces: `update_live_settings(data_dir: Path, *, storage_policy: LiveStoragePolicy) -> LiveSettings`
- Produces routes `GET /api/live/settings` and `PATCH /api/live/settings`.

- [ ] **Step 1: Write failing settings persistence tests**

Create `tests/unit/live/test_settings.py`:

```python
import json


def test_load_missing_live_settings_defaults_ws_plus_rest(tmp_path):
    from hoga.live.settings import load_live_settings

    settings = load_live_settings(tmp_path)

    assert settings.schema_version == 1
    assert settings.storage_policy == "ws_plus_rest"


def test_save_and_reload_live_settings(tmp_path):
    from hoga.live.settings import LiveSettings, load_live_settings, save_live_settings

    save_live_settings(tmp_path, LiveSettings(storage_policy="rest_only"))

    assert load_live_settings(tmp_path).storage_policy == "rest_only"
    raw = json.loads((tmp_path / "live_settings.json").read_text())
    assert raw == {"schema_version": 1, "storage_policy": "rest_only"}


def test_invalid_live_settings_file_falls_back_to_default(tmp_path):
    from hoga.live.settings import load_live_settings

    (tmp_path / "live_settings.json").write_text('{"schema_version": 1, "storage_policy": "bad"}')

    assert load_live_settings(tmp_path).storage_policy == "ws_plus_rest"
    assert list(tmp_path.glob("live_settings.json.corrupt-*"))
```

- [ ] **Step 2: Write failing live settings route tests**

Append to `tests/unit/live/test_api.py`:

```python
def test_live_settings_routes_round_trip(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.live.api import build_router
    from hoga.live.lifecycle import LiveStatus

    app = FastAPI()
    app.include_router(build_router(
        data_dir=tmp_path,
        get_status=lambda: LiveStatus(
            running=False,
            started_at_ms=None,
            last_tick_ms=None,
            cycle_lag_ms=0,
            watchlist_count=0,
            kis_calls_today=0,
            kis_rate_limit_remaining=None,
        ),
    ))
    client = TestClient(app)

    assert client.get("/api/live/settings").json()["storage_policy"] == "ws_plus_rest"

    r = client.patch("/api/live/settings", json={"storage_policy": "rest_only"})

    assert r.status_code == 200
    assert r.json()["storage_policy"] == "rest_only"
    assert client.get("/api/live/settings").json()["storage_policy"] == "rest_only"


def test_live_settings_rejects_unknown_storage_policy(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.live.api import build_router
    from hoga.live.lifecycle import LiveStatus

    app = FastAPI()
    app.include_router(build_router(
        data_dir=tmp_path,
        get_status=lambda: LiveStatus(
            running=False,
            started_at_ms=None,
            last_tick_ms=None,
            cycle_lag_ms=0,
            watchlist_count=0,
            kis_calls_today=0,
            kis_rate_limit_remaining=None,
        ),
    ))
    client = TestClient(app)

    r = client.patch("/api/live/settings", json={"storage_policy": "bad"})

    assert r.status_code == 422
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/live/test_settings.py tests/unit/live/test_api.py -v
```

Expected: FAIL because `hoga.live.settings` and live settings routes do not exist.

- [ ] **Step 4: Implement live settings models and persistence**

In `hoga/api/models.py`, add:

```python
LiveStoragePolicy = Literal["ws_only", "ws_plus_rest", "rest_only"]


class LiveSettingsResponse(BaseModel):
    schema_version: int = 1
    storage_policy: LiveStoragePolicy = "ws_plus_rest"


class LiveSettingsUpdate(BaseModel):
    storage_policy: LiveStoragePolicy
```

Create `hoga/live/settings.py`:

```python
"""Backend-persisted /live write-policy settings."""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import LiveSettingsResponse, LiveStoragePolicy

log = logging.getLogger(__name__)

LiveSettings = LiveSettingsResponse


def _path(data_dir: Path) -> Path:
    return data_dir / "live_settings.json"


def load_live_settings(data_dir: Path) -> LiveSettings:
    path = _path(data_dir)
    if not path.exists():
        return LiveSettings()
    try:
        return LiveSettings.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, ValidationError, TypeError, OSError) as e:
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = path.with_name(f"live_settings.json.corrupt-{stamp}")
        try:
            path.rename(backup)
        except OSError:
            log.exception("could not back up corrupt live_settings.json")
        log.warning("live_settings.json was corrupt (%s); backed up to %s", e, backup)
        return LiveSettings()


def save_live_settings(data_dir: Path, settings: LiveSettings) -> None:
    atomic_write_json(_path(data_dir), settings.model_dump())


def update_live_settings(
    data_dir: Path,
    *,
    storage_policy: LiveStoragePolicy,
) -> LiveSettings:
    settings = LiveSettings(storage_policy=storage_policy)
    save_live_settings(data_dir, settings)
    return settings
```

- [ ] **Step 5: Implement live settings routes**

In `hoga/live/api.py`, import the models and helpers:

```python
from hoga.api.models import LiveSettingsResponse, LiveSettingsUpdate
from hoga.live.settings import load_live_settings, update_live_settings
from hoga.live.lifecycle import refresh_live_stream
```

Inside `build_router`, add:

```python
    @router.get("/settings", response_model=LiveSettingsResponse)
    async def _get_settings() -> LiveSettingsResponse:
        return load_live_settings(data_dir)

    @router.patch("/settings", response_model=LiveSettingsResponse)
    async def _patch_settings(req: LiveSettingsUpdate) -> LiveSettingsResponse:
        settings = update_live_settings(data_dir, storage_policy=req.storage_policy)
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:
            log.exception("live.settings: refresh_live_stream failed")
        return settings
```

This direct `refresh_live_stream` import is acceptable here because `hoga/live/api.py` already imports `LiveStatus` from `hoga.live.lifecycle`; the new route follows the existing lifecycle dependency direction.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
uv run pytest tests/unit/live/test_settings.py tests/unit/live/test_api.py -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/models.py hoga/live/settings.py hoga/live/api.py tests/unit/live/test_settings.py tests/unit/live/test_api.py
git commit -m "feat: persist live storage policy"
```

---

### Task 3: Three-Source Display Priority

**Files:**
- Modify: `hoga/api/sources.py`
- Modify: `hoga/api/bundle.py`
- Modify: `hoga/api/routes.py`
- Modify: `hoga/api/disk_state.py`
- Test: `tests/unit/api/test_sources.py`
- Test: `tests/unit/api/test_bundle_source.py`
- Test: `tests/unit/api/test_bundle_source_aware.py`
- Test: `tests/unit/api/test_orderbook_endpoint.py`
- Test: `tests/unit/api/test_brokers_endpoint.py`

**Interfaces:**
- Produces: `SourceName = Literal["hogaplay", "kis_live", "kis_api"]`
- Produces: `SourcePolicy = Literal["hogaplay", "kis_live", "kis_api", "hogaplay_first", "kis_ws_first", "kis_api_first"]`
- Produces: `ordered_sources(policy: SourcePolicy) -> tuple[SourceName, ...]`
- Produces: `resolve_source(engine: QueryEngine, date: str, code: str, pref: SourcePolicy) -> SourceName`
- Consumes: existing `classify_stock_date`, `QueryEngine.parquet_dir`, and `build_range_bundle(source_pref=...)`.

- [ ] **Step 1: Replace source tests with ordered-policy tests**

Update `tests/unit/api/test_sources.py`:

```python
"""Tests for three-source display-priority resolution."""
from __future__ import annotations

from pathlib import Path
from typing import get_args
from unittest.mock import MagicMock

import pytest

from hoga.api.sources import SourceName, ordered_sources, resolve_source


def _make_engine(tmp_path: Path) -> MagicMock:
    engine = MagicMock()
    engine.data_dir = tmp_path
    return engine


def _seed_source(tmp_path: Path, date: str, code: str, source: str) -> None:
    sd = tmp_path / "parquet" / date / code / source
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text('{"collection_complete": true, "is_partial": false}')


def test_source_name_literal_includes_kis_api() -> None:
    assert set(get_args(SourceName)) == {"hogaplay", "kis_live", "kis_api"}


@pytest.mark.parametrize(
    ("policy", "expected"),
    [
        ("hogaplay", ("hogaplay", "kis_live", "kis_api")),
        ("hogaplay_first", ("hogaplay", "kis_live", "kis_api")),
        ("kis_live", ("kis_live", "kis_api", "hogaplay")),
        ("kis_ws_first", ("kis_live", "kis_api", "hogaplay")),
        ("kis_api", ("kis_api", "kis_live", "hogaplay")),
        ("kis_api_first", ("kis_api", "kis_live", "hogaplay")),
    ],
)
def test_ordered_sources_maps_legacy_and_policy_names(policy, expected) -> None:
    assert ordered_sources(policy) == expected


def test_resolve_source_uses_ordered_policy(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")
    _seed_source(tmp_path, "20260622", "005930", "kis_live")
    _seed_source(tmp_path, "20260622", "005930", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "hogaplay_first") == "hogaplay"
    assert resolve_source(engine, "20260622", "005930", "kis_ws_first") == "kis_live"
    assert resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"


def test_resolve_source_falls_back_to_second_source(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "hogaplay_first") == "kis_api"


def test_resolve_source_returns_first_policy_source_when_none_exist(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"


@pytest.mark.parametrize("bad", ["", "kis_ws", "HOGAPLAY"])
def test_ordered_sources_rejects_unknown_policy(bad: str) -> None:
    with pytest.raises(ValueError, match="unknown source policy"):
        ordered_sources(bad)
```

- [ ] **Step 2: Add bundle tests for `kis_api` fallback**

Append to `tests/unit/api/test_bundle_source.py`:

```python
def test_resolve_source_prefers_kis_api_when_policy_requests_it(tmp_path: Path) -> None:
    import json

    from hoga.api.bundle import _resolve_source
    from hoga.api.queries import QueryEngine

    sd_dir = tmp_path / "parquet" / "20260622" / "005930"
    for source in ("hogaplay", "kis_live", "kis_api"):
        (sd_dir / source).mkdir(parents=True, exist_ok=True)
        (sd_dir / source / "meta.json").write_text(json.dumps({
            "collection_complete": True,
            "is_partial": False,
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
        }))

    engine = QueryEngine(tmp_path)
    try:
        assert _resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"
    finally:
        engine.close()
```

Append to `tests/unit/api/test_bundle_source_aware.py`:

```python
def test_source_pref_kis_api_first_reads_kis_api(tmp_path: Path) -> None:
    code = "003490"
    date = "20260622"
    sd_dir = tmp_path / "parquet" / date / code

    _write_meta(sd_dir / "kis_live" / "meta.json", source="kis_live", date=date)
    _write_snapshots(sd_dir / "kis_live" / "snapshots.parquet", [_snap(100000000, 11111, 22222)])
    _write_empty_candles(sd_dir / "kis_live" / "candles.parquet")
    _write_empty_trades(sd_dir / "kis_live" / "trades.parquet")

    _write_meta(sd_dir / "kis_api" / "meta.json", source="kis_api", date=date, sampling_ms=30000)
    _write_snapshots(sd_dir / "kis_api" / "snapshots.parquet", [_snap(100000000, 33333, 44444)])
    _write_empty_trades(sd_dir / "kis_api" / "trades.parquet")

    engine = QueryEngine(tmp_path)
    try:
        bundle = build_range_bundle(
            engine,
            code=code,
            from_date=date,
            to_date=date,
            bucket_ms=60_000,
            source_pref="kis_api_first",
        )
    finally:
        engine.close()

    assert bundle.segments[0].source == "kis_api"
    assert any(p.bid_total == 33333 for p in bundle.quote_ratio.points)
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
uv run pytest \
  tests/unit/api/test_sources.py \
  tests/unit/api/test_bundle_source.py \
  tests/unit/api/test_bundle_source_aware.py \
  tests/unit/api/test_orderbook_endpoint.py \
  tests/unit/api/test_brokers_endpoint.py -v
```

Expected: FAIL because `kis_api` and ordered policy names are not accepted.

- [ ] **Step 4: Implement source policy helper**

Replace `hoga/api/sources.py` with:

```python
"""Source-name resolution for /api routes."""
from __future__ import annotations

from typing import TYPE_CHECKING, Literal, cast

if TYPE_CHECKING:
    from hoga.api.queries import QueryEngine

SourceName = Literal["hogaplay", "kis_live", "kis_api"]
SourcePolicy = Literal[
    "hogaplay",
    "kis_live",
    "kis_api",
    "hogaplay_first",
    "kis_ws_first",
    "kis_api_first",
]

_POLICY_ORDER: dict[str, tuple[SourceName, ...]] = {
    "hogaplay": ("hogaplay", "kis_live", "kis_api"),
    "hogaplay_first": ("hogaplay", "kis_live", "kis_api"),
    "kis_live": ("kis_live", "kis_api", "hogaplay"),
    "kis_ws_first": ("kis_live", "kis_api", "hogaplay"),
    "kis_api": ("kis_api", "kis_live", "hogaplay"),
    "kis_api_first": ("kis_api", "kis_live", "hogaplay"),
}


def ordered_sources(policy: str) -> tuple[SourceName, ...]:
    try:
        return _POLICY_ORDER[policy]
    except KeyError as e:
        raise ValueError(f"unknown source policy: {policy}") from e


def resolve_source(engine: "QueryEngine", date: str, code: str, pref: str) -> SourceName:
    from hoga.api.disk_state import DiskState, classify_stock_date

    order = ordered_sources(pref)
    sd_dir = engine.data_dir / "parquet" / date / code
    per_source = classify_stock_date(sd_dir)
    healthy = {
        source
        for source, classification in per_source.items()
        if classification.state != DiskState.INVALID
    }
    for source in order:
        if source in healthy:
            return source
    return cast(SourceName, order[0])
```

- [ ] **Step 5: Thread string policy through bundle and routes**

In `hoga/api/bundle.py`, keep `_resolve_source` import from `hoga.api.sources` and allow `source_pref: str`.

In `hoga/api/routes.py`, change route query parameters from `SourceName` to `str` with explicit validation:

```python
def _validate_source_policy(value: str) -> str:
    from hoga.api.sources import ordered_sources

    try:
        ordered_sources(value)
    except ValueError as e:
        raise HTTPException(status_code=422, detail={
            "code": "invalid_source_pref",
            "message": str(e),
        }) from e
    return value
```

Use it at each route boundary before calling `_resolved_parquet_dir` or `build_range_bundle`:

```python
source_pref = _validate_source_policy(source_pref)
```

Keep response fields typed as `SourceName`; `resolve_source` returns a concrete source id.

- [ ] **Step 6: Include `kis_api` in disk-state aggregate source priority**

In `hoga/api/disk_state.py`, update any hard-coded source order from:

```python
("hogaplay", "kis_live")
```

to:

```python
("hogaplay", "kis_live", "kis_api")
```

The aggregate disk state should continue to choose the healthiest source, not the display preference.

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
uv run pytest \
  tests/unit/api/test_sources.py \
  tests/unit/api/test_bundle_source.py \
  tests/unit/api/test_bundle_source_aware.py \
  tests/unit/api/test_orderbook_endpoint.py \
  tests/unit/api/test_brokers_endpoint.py -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add hoga/api/sources.py hoga/api/bundle.py hoga/api/routes.py hoga/api/disk_state.py tests/unit/api/test_sources.py tests/unit/api/test_bundle_source.py tests/unit/api/test_bundle_source_aware.py tests/unit/api/test_orderbook_endpoint.py tests/unit/api/test_brokers_endpoint.py
git commit -m "feat: add three-source display priority"
```

---

### Task 4: Storage Target Planning

**Files:**
- Modify: `hoga/live/coverage.py`
- Modify: `hoga/live/live_session.py`
- Test: `tests/unit/live/test_coverage_plan.py`
- Test: `tests/unit/live/test_display_ordered_codes_v3.py`
- Test: `tests/unit/live/test_lifecycle_dynamic_n.py`

**Interfaces:**
- Produces: `LiveStorageTargets(ws_targets: tuple[str, ...], kis_api_targets: tuple[str, ...], capture_candidates: tuple[str, ...])`
- Produces: `plan_storage_targets(capture_candidates: list[str], *, n_configured: int, storage_policy: LiveStoragePolicy, current_ws_live_set: tuple[str, ...] = ()) -> LiveStorageTargets`
- Produces: `_compute_capture_candidates(data_dir: Path) -> list[str]`
- Produces: `_compute_ws_targets(data_dir: Path, n_configured: int, storage_policy: LiveStoragePolicy) -> list[str]`
- Consumes: `capture_ordered_codes`, `symbols.search`, and `_PER_ACCOUNT_MAX`.

- [ ] **Step 1: Write failing target planner tests**

Append to `tests/unit/live/test_coverage_plan.py`:

```python
def test_plan_storage_targets_ws_only_excludes_rest() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_only",
    )

    assert plan.ws_targets == ("A", "B")
    assert plan.kis_api_targets == ()
    assert plan.capture_candidates == ("A", "B", "C")


def test_plan_storage_targets_ws_plus_rest_uses_remainder() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_plus_rest",
    )

    assert plan.ws_targets == ("A", "B")
    assert plan.kis_api_targets == ("C",)


def test_plan_storage_targets_rest_only_disables_ws() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=3,
        per_account_max=2,
        storage_policy="rest_only",
    )

    assert plan.ws_targets == ()
    assert plan.kis_api_targets == ("A", "B", "C")


def test_plan_storage_targets_does_not_silently_cap_rest_targets() -> None:
    from hoga.live.coverage import plan_storage_targets

    candidates = [f"{i:06d}" for i in range(50)]
    plan = plan_storage_targets(
        candidates,
        n_configured=1,
        per_account_max=10,
        storage_policy="rest_only",
    )

    assert plan.kis_api_targets == tuple(candidates)
```

- [ ] **Step 2: Write failing capture candidate integration test**

Append to `tests/unit/live/test_display_ordered_codes_v3.py`:

```python
def test_compute_capture_candidates_uses_enabled_folders(tmp_path, monkeypatch) -> None:
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist import save_document
    from hoga.live.coverage import _compute_capture_candidates

    save_document(tmp_path, WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000a",
                name="Enabled",
                order=0,
                member_codes=["005930", "000660"],
                capture_enabled=True,
            ),
            WatchlistFolder(
                id="f_0000000b",
                name="Disabled",
                order=1,
                member_codes=["035720"],
                capture_enabled=False,
            ),
        ],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            WatchlistEntry(code="035720", name="카카오", registered_at_kst_date="20260601"),
        ],
    ))

    class Hit:
        def __init__(self, code):
            self.code = code

    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [Hit("005930"), Hit("035720")],
    )

    assert _compute_capture_candidates(tmp_path) == ["005930"]
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
uv run pytest \
  tests/unit/live/test_coverage_plan.py \
  tests/unit/live/test_display_ordered_codes_v3.py \
  tests/unit/live/test_lifecycle_dynamic_n.py -v
```

Expected: FAIL because storage target planning does not exist.

- [ ] **Step 4: Implement storage planning**

In `hoga/live/coverage.py`, add:

```python
from hoga.api.models import LiveStoragePolicy
from hoga.api.watchlist_projection import capture_ordered_codes


@dataclass(frozen=True)
class LiveStorageTargets:
    ws_targets: tuple[str, ...]
    kis_api_targets: tuple[str, ...]
    capture_candidates: tuple[str, ...]


def plan_storage_targets(
    capture_candidates: list[str],
    *,
    n_configured: int,
    storage_policy: LiveStoragePolicy,
    per_account_max: int = _PER_ACCOUNT_MAX,
) -> LiveStorageTargets:
    candidates = tuple(capture_candidates)
    max_codes = per_account_max * n_configured
    if storage_policy == "rest_only":
        return LiveStorageTargets(
            ws_targets=(),
            kis_api_targets=candidates,
            capture_candidates=candidates,
        )
    ws_targets = candidates[:max_codes]
    if storage_policy == "ws_only":
        rest_targets: tuple[str, ...] = ()
    else:
        ws_set = set(ws_targets)
        rest_targets = tuple(code for code in candidates if code not in ws_set)
    return LiveStorageTargets(
        ws_targets=ws_targets,
        kis_api_targets=rest_targets,
        capture_candidates=candidates,
    )


def _known_symbol_codes() -> set[str]:
    from hoga.api import symbols as _symbols

    return {h.code for h in _symbols.search("", limit=10_000)}


def _compute_capture_candidates(data_dir: Path) -> list[str]:
    from hoga.api.watchlist import load_document

    known = _known_symbol_codes()
    doc = load_document(data_dir)
    candidates = capture_ordered_codes(doc, known_codes=known if known else None)
    if known:
        all_enabled = capture_ordered_codes(doc)
        dropped = tuple(code for code in all_enabled if code not in known)
        if dropped:
            _log.warning("live.capture.codes_unknown dropped=%r", list(dropped))
    return candidates


def _compute_ws_targets(
    data_dir: Path,
    n_configured: int = 1,
    storage_policy: LiveStoragePolicy = "ws_plus_rest",
) -> list[str]:
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        n_configured=n_configured,
        storage_policy=storage_policy,
    )
    return list(targets.ws_targets)
```

Update existing `_compute_live_set` to delegate:

```python
def _compute_live_set(data_dir: Path, n_configured: int = 1) -> list[str]:
    return _compute_ws_targets(data_dir, n_configured, "ws_plus_rest")
```

Keep `live_set_codes(doc)` as a compatibility helper, but change it to capture-enabled folders:

```python
def live_set_codes(doc: WatchlistDocument) -> list[str]:
    return capture_ordered_codes(doc)[:LIVE_SET_MAX_CODES]
```

- [ ] **Step 5: Update `LiveSession.restart` to use storage policy parameter**

In `hoga/live/live_session.py`, change `restart` signature:

```python
async def restart(
    self,
    account_id: int,
    *,
    data_dir: Path,
    storage_policy: LiveStoragePolicy,
    build_conn: _BuildConn,
    teardown_conn: _TeardownConn,
) -> None:
```

And compute parts from `_compute_ws_targets`:

```python
parts = plan_live_coverage(
    _compute_ws_targets(data_dir, n, storage_policy),
    n_configured=n,
).partitions
```

Import `LiveStoragePolicy` under `TYPE_CHECKING` or at runtime from `hoga.api.models`.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
uv run pytest \
  tests/unit/live/test_coverage_plan.py \
  tests/unit/live/test_display_ordered_codes_v3.py \
  tests/unit/live/test_lifecycle_dynamic_n.py -v
```

Expected: PASS after lifecycle call sites pass `"ws_plus_rest"` for existing behavior.

- [ ] **Step 7: Commit**

```bash
git add hoga/live/coverage.py hoga/live/live_session.py tests/unit/live/test_coverage_plan.py tests/unit/live/test_display_ordered_codes_v3.py tests/unit/live/test_lifecycle_dynamic_n.py
git commit -m "feat: plan live storage targets"
```

---

### Task 5: REST 30s Recorder And `kis_api` Promotion

**Files:**
- Create: `hoga/live/rest30_writer.py`
- Create: `hoga/live/rest30_recorder.py`
- Modify: `hoga/live/promote.py`
- Test: `tests/unit/live/test_rest30_recorder.py`
- Test: `tests/unit/live/test_promote_today.py`
- Test: `tests/unit/live/test_rest_poller.py`

**Interfaces:**
- Produces: `Rest30sStatus(running: bool, target_count: int, targets: tuple[str, ...], last_cycle_ms: int | None, last_error: str | None, last_error_count: int, degraded: bool)`
- Produces: `Rest30sRecorder.set_targets(codes: set[str]) -> None`
- Produces: `Rest30sRecorder.start() -> None`
- Produces: `Rest30sRecorder.stop() -> Awaitable[None]`
- Produces: `Rest30sRecorder.status() -> Rest30sStatus`
- Produces: `promote_api_today(data_dir: Path, *, code: str) -> None`
- Consumes: `LiveSnapshot`, `LiveWriter`, `ob_to_snapshot`, `trades_to_snapshots`, `brokers_to_snapshot`, `LiveBuffer`.

- [ ] **Step 1: Write failing recorder tests**

Create `tests/unit/live/test_rest30_recorder.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.live.kis_models import (
    KisBrokerEntry,
    KisBrokers,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)


class FakeKis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        self.calls.append(("orderbook", code))
        return KisOrderbook(
            code=code,
            asks=[OrderbookLevel(price=101, qty=10)],
            bids=[OrderbookLevel(price=100, qty=20)],
            total_ask_qty=10,
            total_bid_qty=20,
            t_ms=1770000000000,
        )

    async def fetch_trades(self, code: str) -> list[KisTrade]:
        self.calls.append(("trades", code))
        return [KisTrade(price=100, qty=3, side=1, side_source="inferred", t_ms=1770000000000)]

    async def fetch_brokers(self, code: str) -> KisBrokers:
        self.calls.append(("brokers", code))
        return KisBrokers(
            code=code,
            buy_top=[KisBrokerEntry(name="미래", qty=7)],
            sell_top=[KisBrokerEntry(name="삼성", qty=5)],
        )


@pytest.mark.asyncio
async def test_rest30_recorder_poll_once_writes_three_payload_kinds(tmp_path: Path) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    kis = FakeKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        interval_s=30.0,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()

    lines = (tmp_path / "live_api" / "20260622" / "005930.jsonl").read_text().splitlines()
    assert len(lines) == 3
    assert '"kind": "ob"' in lines[0]
    assert '"kind": "trade"' in lines[1]
    assert '"kind": "broker"' in lines[2]
    assert kis.calls == [
        ("orderbook", "005930"),
        ("trades", "005930"),
        ("brokers", "005930"),
    ]
    status = recorder.status()
    assert status.target_count == 1
    assert status.last_error_count == 0
    assert status.degraded is False


@pytest.mark.asyncio
async def test_rest30_recorder_isolates_one_symbol_failure(tmp_path: Path) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    class PartlyBroken(FakeKis):
        async def fetch_orderbook(self, code: str):
            if code == "000660":
                raise RuntimeError("boom")
            return await super().fetch_orderbook(code)

    recorder = Rest30sRecorder(
        kis_resolver=lambda: PartlyBroken(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    recorder.set_targets({"005930", "000660"})

    await recorder.poll_once()

    assert (tmp_path / "live_api" / "20260622" / "005930.jsonl").exists()
    assert not (tmp_path / "live_api" / "20260622" / "000660.jsonl").exists()
    assert recorder.status().last_error_count == 1
    assert recorder.status().degraded is True


@pytest.mark.asyncio
async def test_rest30_recorder_does_not_cap_targets(tmp_path: Path) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    recorder = Rest30sRecorder(
        kis_resolver=lambda: FakeKis(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    targets = {f"{i:06d}" for i in range(50)}

    recorder.set_targets(targets)

    assert recorder.status().target_count == 50
    assert set(recorder.status().targets) == targets
```

- [ ] **Step 2: Write failing promotion tests for `kis_api`**

Append to `tests/unit/live/test_promote_today.py`:

```python
@pytest.mark.asyncio
async def test_promote_api_today_writes_kis_api_source(tmp_path: Path) -> None:
    from hoga.live.promote import promote_api_today

    today = _today_kst_yyyymmdd()
    jsonl = tmp_path / "live_api" / today / "003490.jsonl"
    _write_jsonl(jsonl, [_ob_event(_t_ms_for(today))])

    await promote_api_today(tmp_path, code="003490")

    target = tmp_path / "parquet" / today / "003490" / "kis_api"
    assert (target / "snapshots.parquet").exists()
    meta = json.loads((target / "meta.json").read_text())
    assert meta["source"] == "kis_api"
    assert meta["sampling_ms"] == 30000
    assert meta["created_from"] == "kis_rest"
```

- [ ] **Step 3: Strengthen display poller no-write regression**

Append to `tests/unit/live/test_rest_poller.py`:

```python
def test_live_rest_poller_still_has_no_writer_dependency() -> None:
    import inspect

    import hoga.live.rest_poller as rest_poller

    src = inspect.getsource(rest_poller.LiveRestPoller)
    assert "LiveWriter" not in src
    assert "promote_api_today" not in src
    assert "live_api" not in src
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
uv run pytest \
  tests/unit/live/test_rest30_recorder.py \
  tests/unit/live/test_promote_today.py \
  tests/unit/live/test_rest_poller.py -v
```

Expected: FAIL because `Rest30sRecorder`, `promote_api_today`, and `live_api` writer do not exist.

- [ ] **Step 5: Implement REST 30s writer**

Create `hoga/live/rest30_writer.py`:

```python
"""JSONL staging writer for persisted KIS REST 30-second capture."""
from __future__ import annotations

from pathlib import Path

from hoga.live.writer import LiveWriter


def rest30_live_root(data_dir: Path) -> Path:
    return data_dir / "live_api"


def make_rest30_writer(data_dir: Path) -> LiveWriter:
    return LiveWriter(rest30_live_root(data_dir))
```

- [ ] **Step 6: Implement `Rest30sRecorder`**

Create `hoga/live/rest30_recorder.py`:

```python
"""Persisted 30-second KIS REST recorder for capture-enabled watchlist targets."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from hoga.live.buffer import LiveBuffer
from hoga.live.kis_models import KisBrokers, KisOrderbook, KisTrade
from hoga.live.rest30_writer import make_rest30_writer
from hoga.live.rest_buffer_build import brokers_to_snapshot, ob_to_snapshot, trades_to_snapshots

_log = logging.getLogger(__name__)


@runtime_checkable
class KisRestCaptureProto(Protocol):
    async def fetch_orderbook(self, code: str) -> KisOrderbook: ...
    async def fetch_trades(self, code: str) -> list[KisTrade]: ...
    async def fetch_brokers(self, code: str) -> KisBrokers: ...


@dataclass(frozen=True)
class Rest30sStatus:
    running: bool
    target_count: int
    targets: tuple[str, ...]
    last_cycle_ms: int | None
    last_error: str | None
    last_error_count: int
    degraded: bool


class Rest30sRecorder:
    def __init__(
        self,
        *,
        kis_resolver: Callable[[], KisRestCaptureProto | None],
        buffer: LiveBuffer,
        data_dir,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int] | None = None,
        phase_fn: Callable[[], str],
        interval_s: float = 30.0,
    ) -> None:
        self._resolve_kis = kis_resolver
        self._buffer = buffer
        self._writer = make_rest30_writer(data_dir)
        self._date_fn = date_fn
        self._now_ms = now_ms_fn or (lambda: int(time.time() * 1000))
        self._phase_fn = phase_fn
        self._interval_s = interval_s
        self._targets: set[str] = set()
        self._task: asyncio.Task | None = None
        self._last_cycle_ms: int | None = None
        self._last_error: str | None = None
        self._last_error_count = 0

    def set_targets(self, codes: set[str]) -> None:
        self._targets = set(codes)

    @property
    def alive(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> Rest30sStatus:
        return Rest30sStatus(
            running=self.alive,
            target_count=len(self._targets),
            targets=tuple(sorted(self._targets)),
            last_cycle_ms=self._last_cycle_ms,
            last_error=self._last_error,
            last_error_count=self._last_error_count,
            degraded=self._last_error_count > 0,
        )

    def start(self) -> None:
        if self.alive:
            return
        self._task = asyncio.create_task(self._run_loop(), name="live-rest30-recorder")

    async def stop(self) -> None:
        if self._task is None or self._task.done():
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    async def _run_loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except Exception:
                _log.exception("live.rest30.cycle_failed")
                self._last_error = "cycle_failed"
                self._last_error_count = max(1, self._last_error_count)
            await asyncio.sleep(self._interval_s)

    async def poll_once(self) -> None:
        kis = self._resolve_kis()
        if kis is None:
            self._last_cycle_ms = self._now_ms()
            self._last_error = "kis_unavailable"
            self._last_error_count = 1 if self._targets else 0
            return

        error_count = 0
        last_error: str | None = None
        for code in sorted(self._targets):
            try:
                await self._fetch_write_publish(code, kis)
            except Exception as e:
                error_count += 1
                last_error = f"{type(e).__name__}: {e}"
                _log.exception("live.rest30.code_failed code=%s", code)

        await self._writer.fsync_all()
        self._last_cycle_ms = self._now_ms()
        self._last_error = last_error
        self._last_error_count = error_count

    async def _fetch_write_publish(self, code: str, kis: KisRestCaptureProto) -> None:
        now_ms = self._now_ms()
        phase = self._phase_fn()
        date = self._date_fn()

        ob = await kis.fetch_orderbook(code)
        trades = await kis.fetch_trades(code)
        brokers = await kis.fetch_brokers(code)

        snapshots = [
            ob_to_snapshot(ob, phase=phase),
            *trades_to_snapshots(trades, phase=phase),
            brokers_to_snapshot(brokers, now_ms=now_ms, phase=phase),
        ]
        await self._writer.append(date, code, snapshots)
        await self._buffer.publish(code, snapshots, now_ms=now_ms)
```

- [ ] **Step 7: Parameterize promotion source**

In `hoga/live/promote.py`, change `_build_meta` signature:

```python
def _build_meta(
    code: str,
    date: str,
    snapshots: list,
    trades: list,
    broker_snapshot_count: int,
    fill_count: int = 0,
    *,
    source: str = "kis_live",
) -> dict:
```

Set source-specific fields:

```python
meta = {
    "source": source,
    "code": code,
    "date": date,
    "promoted_at": datetime.now(UTC).isoformat(),
    "row_counts": {
        "snapshots": len(snapshots),
        "trades": len(trades),
        "brokers": broker_snapshot_count,
        "fills": fill_count,
    },
    "regular_session_open_ms": 90000000,
    "regular_session_close_ms": 153000000,
}
if source == "kis_api":
    meta["sampling_ms"] = 30000
    meta["created_from"] = "kis_rest"
return meta
```

Change `_parse_jsonl_to_records` signature:

```python
def _parse_jsonl_to_records(
    jsonl_path: Path,
    *,
    code: str,
    date: str,
    source: str = "kis_live",
) -> tuple[list[Orderbook], list[Trade], list[BrokerRow], list[Fill], dict]:
```

Pass `source=source` to `_build_meta`.

Add:

```python
async def promote_api_today(data_dir: Path, *, code: str) -> None:
    from hoga.api._atomic_write import atomic_write_json

    today = _today_kst_yyyymmdd()
    jsonl_path = data_dir / "live_api" / today / f"{code}.jsonl"
    target = data_dir / "parquet" / today / code / "kis_api"
    if not jsonl_path.exists():
        return

    snapshots, trades, broker_rows, fills, meta = _parse_jsonl_to_records(
        jsonl_path,
        code=code,
        date=today,
        source="kis_api",
    )
    target.mkdir(parents=True, exist_ok=True)
    _atomic_write_table(write_snapshots_parquet, snapshots, target / "snapshots.parquet")
    _atomic_write_table(write_trades_parquet, trades, target / "trades.parquet")
    _atomic_write_table(write_brokers_parquet, broker_rows, target / "brokers.parquet")
    _atomic_write_table(write_fills_parquet, fills, target / "fills.parquet")
    atomic_write_json(target / "meta.json", meta, indent=2)
```

Do not create `candles.parquet` for `kis_api`; range candles continue to come from the KIS candle backfill path.

- [ ] **Step 8: Run tests to verify they pass**

Run:

```bash
uv run pytest \
  tests/unit/live/test_rest30_recorder.py \
  tests/unit/live/test_promote_today.py \
  tests/unit/live/test_rest_poller.py -v
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add hoga/live/rest30_writer.py hoga/live/rest30_recorder.py hoga/live/promote.py tests/unit/live/test_rest30_recorder.py tests/unit/live/test_promote_today.py tests/unit/live/test_rest_poller.py
git commit -m "feat: add persisted KIS API recorder"
```

---

### Task 6: Lifecycle Integration And Live Status

**Files:**
- Modify: `hoga/live/lifecycle.py`
- Modify: `hoga/live/live_session.py`
- Modify: `hoga/live/api.py`
- Test: `tests/unit/live/test_lifecycle.py`
- Test: `tests/unit/live/test_lifecycle_dynamic_n.py`
- Test: `tests/unit/live/test_lifecycle_rest30_recorder.py`
- Test: `frontend/src/api/liveStatus.test.tsx`

**Interfaces:**
- Produces LiveStatus fields:
  - `storage_policy: LiveStoragePolicy`
  - `kis_api_running: bool`
  - `kis_api_targets: list[str]`
  - `kis_api_target_count: int`
  - `kis_api_last_cycle_ms: int | None`
  - `kis_api_last_error: str | None`
  - `kis_api_last_error_count: int`
  - `kis_api_degraded: bool`
- Consumes: `load_live_settings`, `plan_storage_targets`, `Rest30sRecorder`, and existing lifecycle lock.

- [ ] **Step 1: Write failing lifecycle tests**

Create `tests/unit/live/test_lifecycle_rest30_recorder.py`:

```python
from __future__ import annotations

import asyncio

import pytest


class FakeRest30Recorder:
    created = []

    def __init__(self, **kwargs):
        self.targets = set()
        self.started = False
        self.stopped = False
        FakeRest30Recorder.created.append(self)

    def set_targets(self, codes):
        self.targets = set(codes)

    def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True

    @property
    def alive(self):
        return self.started and not self.stopped

    def status(self):
        from hoga.live.rest30_recorder import Rest30sStatus

        return Rest30sStatus(
            running=self.alive,
            target_count=len(self.targets),
            targets=tuple(sorted(self.targets)),
            last_cycle_ms=None,
            last_error=None,
            last_error_count=0,
            degraded=False,
        )


@pytest.mark.asyncio
async def test_rest_only_stops_ws_and_starts_api_recorder(tmp_path, monkeypatch):
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist import save_document
    from hoga.live.settings import LiveSettings, save_live_settings
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    FakeRest30Recorder.created.clear()
    save_live_settings(tmp_path, LiveSettings(storage_policy="rest_only"))
    save_document(tmp_path, WatchlistDocument(
        folders=[WatchlistFolder(
            id="f_0000000a",
            name="스윙",
            order=0,
            member_codes=["005930", "000660"],
            capture_enabled=True,
        )],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
        ],
    ))

    class Hit:
        def __init__(self, code):
            self.code = code

    monkeypatch.setattr("hoga.api.symbols.search", lambda _query, limit=10_000: [Hit("005930"), Hit("000660")])
    monkeypatch.setattr("hoga.live.kis_runtime.configured_account_ids", lambda data_dir: [0])
    monkeypatch.setattr("hoga.live.kis_runtime.ensure_kis_client_from_env", lambda data_dir: object())
    monkeypatch.setattr("hoga.live.kis_access.kis_for_role", lambda role, data_dir: object())
    monkeypatch.setattr("hoga.live.rest30_recorder.Rest30sRecorder", FakeRest30Recorder)

    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True

    status = lifecycle.get_status()
    assert status.live_set == []
    assert status.storage_policy == "rest_only"
    assert status.kis_api_targets == ["000660", "005930"]
    assert FakeRest30Recorder.created[0].started is True

    await lifecycle.stop_live_stream()
    assert FakeRest30Recorder.created[0].stopped is True


@pytest.mark.asyncio
async def test_ws_plus_rest_excludes_ws_targets_from_api_recorder(tmp_path, monkeypatch):
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist import save_document
    from hoga.live.settings import LiveSettings, save_live_settings
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    FakeRest30Recorder.created.clear()
    save_live_settings(tmp_path, LiveSettings(storage_policy="ws_plus_rest"))
    save_document(tmp_path, WatchlistDocument(
        folders=[WatchlistFolder(
            id="f_0000000a",
            name="스윙",
            order=0,
            member_codes=["005930", "000660"],
            capture_enabled=True,
        )],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
        ],
    ))

    class Hit:
        def __init__(self, code):
            self.code = code

    monkeypatch.setattr("hoga.api.symbols.search", lambda _query, limit=10_000: [Hit("005930"), Hit("000660")])
    monkeypatch.setattr("hoga.live.coverage._PER_ACCOUNT_MAX", 1)
    monkeypatch.setattr("hoga.live.kis_runtime.configured_account_ids", lambda data_dir: [0])
    monkeypatch.setattr("hoga.live.kis_runtime.ensure_kis_client_from_env", lambda data_dir: object())
    monkeypatch.setattr("hoga.live.kis_access.kis_for_role", lambda role, data_dir: object())
    monkeypatch.setattr("hoga.live.rest30_recorder.Rest30sRecorder", FakeRest30Recorder)
    monkeypatch.setattr("hoga.live.lifecycle._build_conn", lambda account_id, codes, data_dir: None)

    await lifecycle.start_live_stream(data_dir=tmp_path)

    assert lifecycle.get_status().live_set == ["005930"]
    assert lifecycle.get_status().kis_api_targets == ["000660"]
```

- [ ] **Step 2: Update frontend live status test fixture**

In `frontend/src/api/liveStatus.test.tsx`, add the new fields to the mocked response:

```ts
storage_policy: 'ws_plus_rest',
kis_api_running: true,
kis_api_targets: ['000660'],
kis_api_target_count: 1,
kis_api_last_cycle_ms: 1770000000000,
kis_api_last_error: null,
kis_api_last_error_count: 0,
kis_api_degraded: false,
```

Add an assertion:

```ts
expect(result.current.data?.kis_api_targets).toEqual(['000660']);
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/live/test_lifecycle_rest30_recorder.py tests/unit/live/test_lifecycle.py tests/unit/live/test_lifecycle_dynamic_n.py -v
npm --prefix frontend test -- liveStatus.test.tsx --run
```

Expected: FAIL because lifecycle has no REST 30s recorder state and frontend status type lacks fields.

- [ ] **Step 4: Extend lifecycle state and status**

In `hoga/live/lifecycle.py`, import:

```python
from hoga.api.models import LiveStoragePolicy
from hoga.live.settings import load_live_settings
from hoga.live.coverage import _compute_capture_candidates, plan_storage_targets
```

Under `TYPE_CHECKING`, add `Rest30sRecorder`.

Extend `LiveStatus`:

```python
    storage_policy: LiveStoragePolicy = "ws_plus_rest"
    kis_api_running: bool = False
    kis_api_targets: list[str] = Field(default_factory=list)
    kis_api_target_count: int = 0
    kis_api_last_cycle_ms: int | None = None
    kis_api_last_error: str | None = None
    kis_api_last_error_count: int = 0
    kis_api_degraded: bool = False
```

Extend `_State.__init__` with:

```python
        rest30_recorder: Rest30sRecorder | None = None,
        storage_policy: LiveStoragePolicy = "ws_plus_rest",
```

Assign:

```python
self.rest30_recorder = rest30_recorder
self.storage_policy = storage_policy
```

- [ ] **Step 5: Add recorder helper functions**

In `hoga/live/lifecycle.py`, add:

```python
def _ensure_rest30_recorder(data_dir: Path):
    from .rest30_recorder import Rest30sRecorder

    if _state.rest30_recorder is not None:
        return _state.rest30_recorder
    if kis_runtime.ensure_kis_client_from_env(data_dir) is None:
        return None
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis_access.kis_for_role("background", data_dir),
        buffer=_buffer,
        data_dir=data_dir,
        date_fn=_today_kst,
        phase_fn=lambda: __import__("hoga.live.session_gate", fromlist=["market_phase"]).market_phase(_now_ms()),
    )
    _state.rest30_recorder = recorder
    return recorder


async def _sync_storage_targets(data_dir: Path) -> tuple[list[str], tuple[str, ...]]:
    settings = load_live_settings(data_dir)
    _state.storage_policy = settings.storage_policy
    n_configured = len(kis_runtime.configured_account_ids(data_dir))
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        n_configured=n_configured,
        storage_policy=settings.storage_policy,
    )
    recorder = _ensure_rest30_recorder(data_dir) if targets.kis_api_targets else _state.rest30_recorder
    if recorder is not None:
        recorder.set_targets(set(targets.kis_api_targets))
        if targets.kis_api_targets:
            recorder.start()
        else:
            await recorder.stop()
    return list(targets.ws_targets), targets.kis_api_targets
```

- [ ] **Step 6: Wire storage targets into start, refresh, stop, and watchdog restart**

In `_start_live_stream_locked`, replace direct `_compute_live_set(...)` with:

```python
codes, _rest_targets = await _sync_storage_targets(data_dir)
```

If `storage_policy == "rest_only"`, keep the REST recorder active and do not build WS streams:

```python
if _state.storage_policy == "rest_only":
    _state.rest_poller = poller
    await _state.session.start(
        codes=[],
        n_configured=n_configured,
        data_dir=data_dir,
        now_ms=_now_ms(),
        build_conn=_build_conn,
    )
    return True
```

In `refresh_live_stream`, use:

```python
codes, _rest_targets = await _sync_storage_targets(data_dir)
```

Then refresh WS with `codes`.

In `_stop_live_stream_locked`, stop `rest30_recorder` before resetting state:

```python
if _state.rest30_recorder is not None:
    await _state.rest30_recorder.stop()
```

In `_restart_conn`, pass `_state.storage_policy` to `session.restart`.

- [ ] **Step 7: Add REST recorder status to `get_status`**

In `get_status`, read:

```python
rest30_status = _state.rest30_recorder.status() if _state.rest30_recorder is not None else None
```

Add to `LiveStatus(...)`:

```python
storage_policy=_state.storage_policy,
kis_api_running=bool(rest30_status and rest30_status.running),
kis_api_targets=list(rest30_status.targets) if rest30_status else [],
kis_api_target_count=rest30_status.target_count if rest30_status else 0,
kis_api_last_cycle_ms=rest30_status.last_cycle_ms if rest30_status else None,
kis_api_last_error=rest30_status.last_error if rest30_status else None,
kis_api_last_error_count=rest30_status.last_error_count if rest30_status else 0,
kis_api_degraded=rest30_status.degraded if rest30_status else False,
```

- [ ] **Step 8: Update frontend live status type**

In `frontend/src/api/liveStatus.ts`, extend `LiveStatus`:

```ts
  storage_policy: 'ws_only' | 'ws_plus_rest' | 'rest_only';
  kis_api_running: boolean;
  kis_api_targets: string[];
  kis_api_target_count: number;
  kis_api_last_cycle_ms: number | null;
  kis_api_last_error: string | null;
  kis_api_last_error_count: number;
  kis_api_degraded: boolean;
```

- [ ] **Step 9: Run tests to verify they pass**

Run:

```bash
uv run pytest tests/unit/live/test_lifecycle_rest30_recorder.py tests/unit/live/test_lifecycle.py tests/unit/live/test_lifecycle_dynamic_n.py -v
npm --prefix frontend test -- liveStatus.test.tsx --run
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add hoga/live/lifecycle.py hoga/live/live_session.py hoga/live/api.py tests/unit/live/test_lifecycle_rest30_recorder.py tests/unit/live/test_lifecycle.py tests/unit/live/test_lifecycle_dynamic_n.py frontend/src/api/liveStatus.ts frontend/src/api/liveStatus.test.tsx
git commit -m "feat: integrate live storage policies"
```

---

### Task 7: Frontend Settings And Watchlist Toggle UI

**Files:**
- Create: `frontend/src/api/liveSettings.ts`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/watchlist.ts`
- Modify: `frontend/src/watchlist/useWatchlist.ts`
- Modify: `frontend/src/watchlist/WatchlistEditModal.tsx`
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Test: `frontend/src/api/watchlist.test.ts`
- Test: `frontend/src/watchlist/WatchlistEditModal.test.tsx`
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`

**Interfaces:**
- Produces frontend type `LiveStoragePolicy = 'ws_only' | 'ws_plus_rest' | 'rest_only'`
- Produces `getLiveSettings(): Promise<LiveSettings>`
- Produces `patchLiveSettings(storage_policy: LiveStoragePolicy): Promise<LiveSettings>`
- Produces `setFolderCaptureEnabled(folderId: string, capture_enabled: boolean): Promise<WatchlistFolder>`
- Produces hook `useSetFolderCaptureEnabled()`.
- Consumes existing `apiCall`, `apiAction`, `WATCHLIST_KEY`, and TanStack Query.

- [ ] **Step 1: Write failing frontend API tests**

Append to `frontend/src/api/watchlist.test.ts`:

```ts
it('sets folder capture flag', async () => {
  const { setFolderCaptureEnabled } = await import('./watchlist');
  vi.spyOn(client, 'apiCall').mockResolvedValue({
    id: 'f_0000000a',
    name: '스윙',
    order: 0,
    capture_enabled: true,
  });

  const result = await setFolderCaptureEnabled('f_0000000a', true);

  expect(client.apiCall).toHaveBeenCalledWith('/api/watchlist/folders/f_0000000a/capture', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture_enabled: true }),
  });
  expect(result.capture_enabled).toBe(true);
});
```

Create `frontend/src/api/liveSettings.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import * as client from './client';

describe('liveSettings api', () => {
  it('gets live settings', async () => {
    const { getLiveSettings } = await import('./liveSettings');
    vi.spyOn(client, 'apiCall').mockResolvedValue({ schema_version: 1, storage_policy: 'ws_plus_rest' });

    await getLiveSettings();

    expect(client.apiCall).toHaveBeenCalledWith('/api/live/settings');
  });

  it('patches live storage policy', async () => {
    const { patchLiveSettings } = await import('./liveSettings');
    vi.spyOn(client, 'apiCall').mockResolvedValue({ schema_version: 1, storage_policy: 'rest_only' });

    const result = await patchLiveSettings('rest_only');

    expect(client.apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage_policy: 'rest_only' }),
    });
    expect(result.storage_policy).toBe('rest_only');
  });
});
```

- [ ] **Step 2: Write failing UI tests**

Append to `frontend/src/watchlist/WatchlistEditModal.test.tsx`:

```tsx
it('renders and toggles folder capture setting', async () => {
  vi.spyOn(api, 'getWatchlist').mockResolvedValue({
    folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: false }],
    entries: [],
    next_run_at_ms: 0,
  });
  const setCapture = vi.spyOn(api, 'setFolderCaptureEnabled').mockResolvedValue({
    id: 'f_a',
    name: '스윙',
    order: 0,
    capture_enabled: true,
  });
  const qc = new QueryClient();

  render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });

  const toggle = await screen.findByRole('switch', { name: '스윙 저장 대상' });
  expect(toggle).not.toBeChecked();

  fireEvent.click(toggle);

  expect(setCapture).toHaveBeenCalledWith('f_a', true);
});
```

Append to `frontend/src/live/LiveSettingsSections.test.tsx`:

```tsx
it('renders storage policy and display priority separately', async () => {
  vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue({
    schema_version: 1,
    storage_policy: 'ws_plus_rest',
  });
  vi.spyOn(liveSettingsApi, 'patchLiveSettings').mockResolvedValue({
    schema_version: 1,
    storage_policy: 'rest_only',
  });

  render(<LiveSettingsSections />, { wrapper: wrap(new QueryClient()) });
  fireEvent.click(screen.getByTestId('settings-nav-data-source'));

  expect(await screen.findByText('데이터 저장 방식')).toBeInTheDocument();
  expect(screen.getByText('데이터 표현 기준')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'WS만 저장' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'WS 우선 + 나머지 REST 저장' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'REST만 저장' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'KIS API 우선' })).toBeInTheDocument();
});
```

At the top of that test file, import:

```ts
import * as liveSettingsApi from '../api/liveSettings';
```

- [ ] **Step 3: Run frontend tests to verify they fail**

Run:

```bash
npm --prefix frontend test -- watchlist.test.ts WatchlistEditModal.test.tsx LiveSettingsSections.test.tsx liveSettings.test.ts --run
```

Expected: FAIL because the new API and UI controls do not exist.

- [ ] **Step 4: Implement frontend live settings API**

Create `frontend/src/api/liveSettings.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';

export type LiveStoragePolicy = 'ws_only' | 'ws_plus_rest' | 'rest_only';

export interface LiveSettings {
  schema_version: number;
  storage_policy: LiveStoragePolicy;
}

export const LIVE_SETTINGS_KEY = ['live', 'settings'] as const;

export function getLiveSettings(): Promise<LiveSettings> {
  return apiCall<LiveSettings>('/api/live/settings');
}

export function patchLiveSettings(storage_policy: LiveStoragePolicy): Promise<LiveSettings> {
  return apiCall<LiveSettings>('/api/live/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storage_policy }),
  });
}

export function useLiveSettings() {
  return useQuery({
    queryKey: LIVE_SETTINGS_KEY,
    queryFn: getLiveSettings,
  });
}

export function usePatchLiveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patchLiveSettings,
    onSuccess: (settings) => {
      qc.setQueryData(LIVE_SETTINGS_KEY, settings);
      void qc.invalidateQueries({ queryKey: ['live', 'status'] });
    },
  });
}
```

- [ ] **Step 5: Implement watchlist capture API and hook**

In `frontend/src/api/watchlist.ts`, extend `WatchlistFolder`:

```ts
export interface WatchlistFolder {
  id: string;
  name: string;
  order: number;
  capture_enabled: boolean;
}
```

Add:

```ts
export function setFolderCaptureEnabled(
  folderId: string,
  capture_enabled: boolean,
): Promise<WatchlistFolder> {
  return apiCall<WatchlistFolder>(`/api/watchlist/folders/${folderId}/capture`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture_enabled }),
  });
}
```

In `frontend/src/watchlist/useWatchlist.ts`, import `setFolderCaptureEnabled`, then add:

```ts
type CaptureVars = { folderId: string; captureEnabled: boolean };

function applyFolderCapture(data: WatchlistResponse, v: CaptureVars): WatchlistResponse {
  return {
    ...data,
    folders: data.folders.map((f) =>
      f.id === v.folderId ? { ...f, capture_enabled: v.captureEnabled } : f),
  };
}

export function useSetFolderCaptureEnabled() {
  return useOptimisticWatchlistMutation<CaptureVars>(
    (v) => setFolderCaptureEnabled(v.folderId, v.captureEnabled).then(() => undefined),
    applyFolderCapture,
  );
}
```

- [ ] **Step 6: Add group toggles to watchlist edit modal**

In `frontend/src/watchlist/WatchlistEditModal.tsx`, import `useSetFolderCaptureEnabled`.

Extend `FolderRow` props:

```ts
  captureEnabled: boolean;
  onToggleCapture: () => void;
```

Inside the non-editing action area, before move buttons, add:

```tsx
          <button
            type="button"
            role="switch"
            aria-checked={props.captureEnabled}
            aria-label={`${props.name} 저장 대상`}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleCapture();
            }}
            className={`w-8 h-4 rounded-full border ${
              props.captureEnabled ? 'bg-accent border-accent' : 'bg-bg-input border-border'
            }`}
          >
            <span
              aria-hidden
              className={`block w-3 h-3 rounded-full bg-fg transition-transform ${
                props.captureEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
```

In `WatchlistEditModal`, create mutation:

```ts
const captureM = useSetFolderCaptureEnabled();
```

Pass props when rendering `FolderRow`:

```tsx
captureEnabled={f.capture_enabled}
onToggleCapture={() => captureM.mutate({
  folderId: f.id,
  captureEnabled: !f.capture_enabled,
})}
```

- [ ] **Step 7: Add live storage policy controls**

In `frontend/src/live/LiveSettingsSections.tsx`, import:

```ts
import { useLiveSettings, usePatchLiveSettings, type LiveStoragePolicy } from '../api/liveSettings';
```

Add constants:

```ts
const STORAGE_POLICY_LABEL: Record<LiveStoragePolicy, string> = {
  ws_only: 'WS만 저장',
  ws_plus_rest: 'WS 우선 + 나머지 REST 저장',
  rest_only: 'REST만 저장',
};

const STORAGE_POLICY_OPTIONS: LiveStoragePolicy[] = ['ws_only', 'ws_plus_rest', 'rest_only'];
```

Add component:

```tsx
function StoragePolicyRadio({ value }: { value: LiveStoragePolicy }) {
  const { data } = useLiveSettings();
  const patch = usePatchLiveSettings();
  const checked = (data?.storage_policy ?? 'ws_plus_rest') === value;
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', cursor: 'pointer' }}>
      <input
        type="radio"
        name="live-storage-policy"
        value={value}
        checked={checked}
        onChange={() => patch.mutate(value)}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>
        {STORAGE_POLICY_LABEL[value]}
      </span>
    </label>
  );
}
```

In `DataSourceDetail`, replace the existing source-preference block with two sections:

```tsx
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
        데이터 저장 방식
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginBottom: 'var(--space-md)' }}>
        {STORAGE_POLICY_OPTIONS.map((opt) => (
          <StoragePolicyRadio key={opt} value={opt} />
        ))}
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
        데이터 표현 기준 <span style={{ color: 'var(--fg-dimmer)' }}>(모든 차트 공통)</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
        {SOURCE_OPTIONS.map((opt) => (
          <SourcePreferenceRadio key={opt} value={opt} />
        ))}
      </div>
```

- [ ] **Step 8: Run frontend tests to verify they pass**

Run:

```bash
npm --prefix frontend test -- watchlist.test.ts WatchlistEditModal.test.tsx LiveSettingsSections.test.tsx liveSettings.test.ts --run
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/api/liveSettings.ts frontend/src/api/types.ts frontend/src/api/watchlist.ts frontend/src/watchlist/useWatchlist.ts frontend/src/watchlist/WatchlistEditModal.tsx frontend/src/live/LiveSettingsSections.tsx frontend/src/api/watchlist.test.ts frontend/src/api/liveSettings.test.ts frontend/src/watchlist/WatchlistEditModal.test.tsx frontend/src/live/LiveSettingsSections.test.tsx
git commit -m "feat: add live storage settings UI"
```

---

### Task 8: Frontend Source Priority Labels And Status Presentation

**Files:**
- Modify: `frontend/src/state/sourcePreference.ts`
- Modify: `frontend/src/live/settings/SourcePreferenceRadio.tsx`
- Modify: `frontend/src/chart/SourceChip.tsx`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/range.ts`
- Modify: `frontend/src/api/useLiveCursor.ts`
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/state/sourcePreference.test.ts`
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`
- Test: `frontend/src/chart/SourceChip.test.tsx`
- Test: `frontend/src/api/range.test.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

**Interfaces:**
- Produces frontend source options `hogaplay_first`, `kis_ws_first`, `kis_api_first`.
- Sends `source_pref=<policy>` to range and spot endpoints.
- Displays source chip labels:
  - `hogaplay · tick`
  - `KIS WS · 10s`
  - `KIS API · 30s`
- Displays watchlist status:
  - `KIS WS 저장 중`
  - `KIS API 30초 저장 중`
  - `저장 제외`
  - `대기`

- [ ] **Step 1: Write failing source preference tests**

Create `frontend/src/state/sourcePreference.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { SOURCE_OPTIONS, useSourcePreferenceStore } from './sourcePreference';

describe('sourcePreference', () => {
  beforeEach(() => {
    localStorage.clear();
    useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay_first' });
  });

  it('offers three display priority policies', () => {
    expect(SOURCE_OPTIONS).toEqual(['hogaplay_first', 'kis_ws_first', 'kis_api_first']);
  });

  it('persists kis api priority', () => {
    useSourcePreferenceStore.getState().setSourcePreference('kis_api_first');

    expect(useSourcePreferenceStore.getState().sourcePreference).toBe('kis_api_first');
    expect(localStorage.getItem('chart.sourcePreference.v1')).toContain('kis_api_first');
  });
});
```

Create `frontend/src/chart/SourceChip.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SourceChip } from './SourceChip';

describe('SourceChip', () => {
  it('labels kis_live as KIS WS', () => {
    render(<SourceChip source="kis_live" />);

    expect(screen.getByText('KIS WS')).toBeInTheDocument();
    expect(screen.getByText('10s')).toBeInTheDocument();
  });

  it('labels kis_api as KIS API 30s', () => {
    render(<SourceChip source="kis_api" />);

    expect(screen.getByText('KIS API')).toBeInTheDocument();
    expect(screen.getByText('30s')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Add range query test for new policy**

Append to `frontend/src/api/range.test.tsx`:

```ts
it('threads source preference policy value to range endpoint', async () => {
  const { fetchRangeBundle } = await import('./range');
  vi.spyOn(client, 'apiCall').mockResolvedValue({
    code: '005930',
    from_date: '20260622',
    to_date: '20260622',
    bucket_ms: 60000,
    segments: [],
    candles: [],
    quote_ratio: { bucket_ms: 60000, points: [] },
    fill_strength: { bucket_ms: 60000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    excluded_dates: [],
    data_warnings: [],
    ask_peaks: [],
    bid_peaks: [],
  });

  await fetchRangeBundle({
    code: '005930',
    fromDate: '20260622',
    toDate: '20260622',
    bucketMs: 60000,
    sourcePreference: 'kis_api_first',
  });

  expect(client.apiCall).toHaveBeenCalledWith(expect.stringContaining('source_pref=kis_api_first'));
});
```

- [ ] **Step 3: Run frontend tests to verify they fail**

Run:

```bash
npm --prefix frontend test -- sourcePreference.test.ts SourceChip.test.tsx range.test.tsx LiveSettingsSections.test.tsx WatchlistDrawer.test.tsx --run
```

Expected: FAIL because frontend still has two source options and old labels.

- [ ] **Step 4: Update source preference state**

In `frontend/src/state/sourcePreference.ts`, replace options:

```ts
export const SOURCE_OPTIONS = ['hogaplay_first', 'kis_ws_first', 'kis_api_first'] as const;
export type SourcePreference = (typeof SOURCE_OPTIONS)[number];
```

Default to:

```ts
sourcePreference: readStorage()?.sourcePreference ?? 'hogaplay_first',
```

Add legacy localStorage migration in `readStorage`:

```ts
const legacy: Record<string, SourcePreference> = {
  hogaplay: 'hogaplay_first',
  kis_live: 'kis_ws_first',
};
const value = legacy[parsed.sourcePreference] ?? parsed.sourcePreference;
if (SOURCE_OPTIONS.includes(value as SourcePreference)) {
  return { sourcePreference: value as SourcePreference };
}
```

- [ ] **Step 5: Update source radio labels**

In `frontend/src/live/settings/SourcePreferenceRadio.tsx`, use:

```ts
const labelMap: Record<SourcePreference, string> = {
  hogaplay_first: 'hogaplay 우선',
  kis_ws_first: 'KIS WS 우선',
  kis_api_first: 'KIS API 우선',
};
```

Keep radio `name="source-preference"`.

- [ ] **Step 6: Update source name types and chip**

In `frontend/src/api/types.ts`:

```ts
export type SourceName = 'hogaplay' | 'kis_live' | 'kis_api';
```

In `frontend/src/chart/SourceChip.tsx`, use separate display labels:

```ts
const SOURCE_LABEL: Record<SourceName, string> = {
  hogaplay: 'hogaplay',
  kis_live: 'KIS WS',
  kis_api: 'KIS API',
};

const RESOLUTION: Record<SourceName, string> = {
  hogaplay: 'tick',
  kis_live: '10s',
  kis_api: '30s',
};
```

Change props to:

```ts
import type { SourceName } from '../api/types';

interface Props {
  source: SourceName | undefined;
}
```

Render:

```tsx
<span>{SOURCE_LABEL[source]}</span>
```

- [ ] **Step 7: Ensure range and spot callers send policy string**

In `frontend/src/api/range.ts` and `frontend/src/api/useLiveCursor.ts`, keep the parameter name `source_pref` but type it as frontend `SourcePreference`. The outgoing value should be one of `hogaplay_first`, `kis_ws_first`, or `kis_api_first`.

If an API helper currently expects `SourceName`, change only the request preference type; response source fields remain `SourceName`.

- [ ] **Step 8: Add watchlist row status labels**

In `frontend/src/watchlist/WatchlistDrawer.tsx`, derive:

```ts
const liveSet = new Set(liveStatusData?.live_set ?? []);
const apiTargets = new Set(liveStatusData?.kis_api_targets ?? []);
```

For each row:

```ts
const storageLabel = liveSet.has(entry.code)
  ? 'KIS WS 저장 중'
  : apiTargets.has(entry.code)
    ? 'KIS API 30초 저장 중'
    : data?.folders.some((f) => f.capture_enabled && f.id === entry.folder_id)
      ? '대기'
      : '저장 제외';
```

Render the label in the existing row metadata/status area without replacing the existing catch-up date marker. Use `text-xs text-fg-dimmer` so it does not dominate the row.

- [ ] **Step 9: Run frontend tests to verify they pass**

Run:

```bash
npm --prefix frontend test -- sourcePreference.test.ts SourceChip.test.tsx range.test.tsx LiveSettingsSections.test.tsx WatchlistDrawer.test.tsx --run
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/state/sourcePreference.ts frontend/src/state/sourcePreference.test.ts frontend/src/live/settings/SourcePreferenceRadio.tsx frontend/src/chart/SourceChip.tsx frontend/src/chart/SourceChip.test.tsx frontend/src/api/types.ts frontend/src/api/range.ts frontend/src/api/useLiveCursor.ts frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/api/range.test.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx frontend/src/live/LiveSettingsSections.test.tsx
git commit -m "feat: add KIS API display priority"
```

---

### Task 9: End-to-End Verification And Documentation Sync

**Files:**
- Modify: `CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-06-22-live-capture-source-policies-design.md`
- Modify: `docs/adr/0079-capture-enabled-folders-gate-live-storage.md`
- Test: full targeted backend and frontend suites.

**Interfaces:**
- Consumes all prior task interfaces.
- Produces updated terminology if implementation names differ from the spec.

- [ ] **Step 1: Run backend target suites**

Run:

```bash
uv run pytest \
  tests/test_api_watchlist_folders.py \
  tests/api/test_watchlist_projection.py \
  tests/test_api_watchlist_routes.py \
  tests/unit/api/test_rest_wire_schema_contract.py \
  tests/unit/api/test_sources.py \
  tests/unit/api/test_bundle_source.py \
  tests/unit/api/test_bundle_source_aware.py \
  tests/unit/api/test_orderbook_endpoint.py \
  tests/unit/api/test_brokers_endpoint.py \
  tests/unit/live/test_settings.py \
  tests/unit/live/test_coverage_plan.py \
  tests/unit/live/test_display_ordered_codes_v3.py \
  tests/unit/live/test_rest30_recorder.py \
  tests/unit/live/test_promote_today.py \
  tests/unit/live/test_rest_poller.py \
  tests/unit/live/test_lifecycle_rest30_recorder.py \
  tests/unit/live/test_lifecycle.py \
  tests/unit/live/test_lifecycle_dynamic_n.py \
  tests/unit/live/test_api.py -v
```

Expected: PASS.

- [ ] **Step 2: Run frontend target suites**

Run:

```bash
npm --prefix frontend test -- \
  liveSettings.test.ts \
  liveStatus.test.tsx \
  watchlist.test.ts \
  WatchlistEditModal.test.tsx \
  LiveSettingsSections.test.tsx \
  sourcePreference.test.ts \
  SourceChip.test.tsx \
  range.test.tsx \
  WatchlistDrawer.test.tsx --run
```

Expected: PASS.

- [ ] **Step 3: Run static checks**

Run:

```bash
uv run pytest tests/unit/live/test_adr_invariants.py tests/unit/api/test_source_schema_contract.py -v
npm --prefix frontend run build
```

Expected: PASS.

- [ ] **Step 4: Search for stale terminology**

Run:

```bash
rg -n "kis_ws|기본 데이터 소스|10-second REST|organisational only|top .*Watchlist|Watchlist.*Live Set|kis_api_30s_enabled" hoga frontend/src tests docs CONTEXT.md
```

Expected: only intentional historical/spec notes remain. If a user-facing UI string says `기본 데이터 소스`, change it to `데이터 표현 기준`. If a source id says `kis_ws`, change it to `kis_live` or UI label `KIS WS` depending on context.

- [ ] **Step 5: Update docs only where implementation differed**

If implementation names match this plan, add no doc churn.

If implementation introduced different route or field names, update `CONTEXT.md`, the spec, and ADR-0079 with the final names. Use exact terminology:

```markdown
Storage Policy: `ws_only`, `ws_plus_rest`, `rest_only`.
Source ids: `hogaplay`, `kis_live`, `kis_api`.
Display policies: `hogaplay_first`, `kis_ws_first`, `kis_api_first`.
```

- [ ] **Step 6: Manual verification**

Run the app:

```bash
npm --prefix frontend run dev
```

In another terminal, run the backend using the repository's normal local command:

```bash
uv run hoga serve
```

Verify in browser:

```text
1. Open /live.
2. Open 설정 > 데이터소스.
3. Confirm 데이터 저장 방식 shows WS만 저장 / WS 우선 + 나머지 REST 저장 / REST만 저장.
4. Confirm 데이터 표현 기준 shows hogaplay 우선 / KIS WS 우선 / KIS API 우선.
5. Open 관심종목 편집.
6. Toggle one group ON and one group OFF.
7. Set REST만 저장.
8. Confirm /api/live/status has live_set=[] and kis_api_targets for the enabled group.
9. Set WS 우선 + 나머지 REST 저장.
10. Confirm WS targets appear in live_set and overflow targets appear in kis_api_targets.
```

- [ ] **Step 7: Commit documentation verification changes**

If Step 5 changed docs:

```bash
git add CONTEXT.md docs/superpowers/specs/2026-06-22-live-capture-source-policies-design.md docs/adr/0079-capture-enabled-folders-gate-live-storage.md
git commit -m "docs: sync live capture source policy implementation"
```

If Step 5 made no doc changes:

```bash
git status --short
```

Expected: no documentation files modified.

---

## Self-Review

**Spec coverage:** Covered group opt-in, storage policy, 30-second REST orderbook/trades/brokers recording, first-class `kis_api`, display-priority fallback, settings UI separation, watchlist toggles, status visibility, and the display-only REST poller invariant.

**Placeholder scan:** This plan avoids open-ended implementation notes. Every task includes file paths, interface names, test code, implementation snippets, commands, and expected outcomes.

**Type consistency:** Backend storage policy uses `ws_only | ws_plus_rest | rest_only`; frontend mirrors the same strings. Backend source ids use `hogaplay | kis_live | kis_api`; frontend response source type mirrors those ids. Frontend display priority uses policy strings `hogaplay_first | kis_ws_first | kis_api_first`, which backend `ordered_sources` accepts while keeping legacy `hogaplay` and `kis_live` compatibility.
