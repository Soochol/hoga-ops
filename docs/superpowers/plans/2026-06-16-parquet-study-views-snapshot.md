# Parquet Study Views Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 저장 학습뷰 as a snapshot-backed `/study` workflow that saves the rendered chart slice and restores it without `/api/range`, KIS past-candle, or live SSE reads.

**Architecture:** Backend owns manifest and snapshot JSON files under `data_dir/study_views/`, mirroring saved screener persistence with structural validation only. Frontend adds study-view API hooks, a third Right Rail panel, snapshot capture utilities, and a `/study` page that adapts `StudySnapshotBundle` into the existing `LiveChartRoot` chart surface. Save-time code captures displayed series and viewport; restore-time code only reads the saved snapshot.

**Tech Stack:** FastAPI, Pydantic v2, pytest, React 18, React Router 7, TanStack Query, Zustand, Vitest, Testing Library, lightweight-charts.

---

## File Structure

Backend:
- Create `hoga/api/study_views.py`: file-backed CRUD for manifests and snapshot JSON files.
- Modify `hoga/api/models.py`: add `ParquetStudyView`, `ParquetStudySnapshot`, `StudySnapshotBundle`, and write/file models.
- Create `hoga/api/study_view_routes.py`: `/api/study-views/saves` router.
- Modify `hoga/api/app.py`: import and mount `study_view_routes.build_router(data_dir=...)`.
- Create `tests/api/test_study_views.py`: model, persistence, and route coverage.

Frontend API/state:
- Create `frontend/src/api/studyViews.ts`: wire types and HTTP calls.
- Create `frontend/src/studyViews/useStudyViews.ts`: React Query hooks and mutation invalidation.
- Modify `frontend/src/api/types.ts`: mirror snapshot wire types if shared by chart adapters.
- Modify `frontend/src/state/rightRail.ts`: add `savedViews`.
- Modify `frontend/src/rightrail/RightRail.tsx`: third rail item.
- Modify `frontend/src/App.tsx`: render `StudyViewsDrawer`.
- Modify `frontend/src/main.tsx`: add `/study` route.

Frontend study feature:
- Create `frontend/src/studyViews/snapshotWindow.ts`: choose the `max(visible, 200)` bar window.
- Create `frontend/src/studyViews/studySnapshotAdapter.ts`: convert `StudySnapshotBundle` to a `RangeBundle`-compatible object for `LiveChartRoot`.
- Create `frontend/src/studyViews/useStudySnapshotCapture.ts`: collect active chart context and rendered series into a write request.
- Create `frontend/src/studyViews/StudyViewsDrawer.tsx`: list/search/save/delete UI.
- Create `frontend/src/studyViews/StudyViewSaveDialog.tsx`: create/update form with snapshot summary.
- Create `frontend/src/studyViews/StudyPage.tsx`: `/study` restore page.

Frontend chart seams:
- Modify `frontend/src/live/LiveChartRoot.tsx`: expose stable optional `onViewportCaptureReady`; keep default `/live` behavior unchanged.
- Modify `frontend/src/live/LiveWorkarea.tsx`: pass `onViewportCaptureReady` down to `LiveChartRoot`.
- Modify `frontend/src/live/paneSpecsForTimeframe.ts`: add an option so study D/W/M can mount hoga panes from stored snapshot data.

---

### Task 1: Backend Models

**Files:**
- Modify: `hoga/api/models.py`
- Test: `tests/api/test_study_views.py`

- [ ] **Step 1: Write failing model validation tests**

Append these tests to new `tests/api/test_study_views.py`:

```python
import pytest
from pydantic import ValidationError

from hoga.api.models import (
    ParquetStudySnapshot,
    ParquetStudyViewWriteRequest,
    StudyViewsFile,
)


def _snapshot(**overrides):
    base = {
        "schema_version": 1,
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot_from_ms": 1_000,
        "snapshot_to_ms": 2_000,
        "bucket_kind": "5m",
        "viewport": {"right_edge_ms": 2_000, "bar_span": 200, "at_live_edge": False},
        "indicator_state": {
            "volume_enabled": True,
            "quote_totals_enabled": True,
            "ratio_enabled": True,
            "fill_strength_enabled": True,
            "aggregation_basis": "close",
            "auction_window_mask": True,
            "ratio_outlier_filter_enabled": True,
            "ratio_outlier_threshold": 50,
        },
        "provenance": {"saved_from_route": "/live", "data_provenance": "live_mixed"},
        "bundle": {
            "code": "005930",
            "timeframe": "5m",
            "snapshot_from_ms": 1_000,
            "snapshot_to_ms": 2_000,
            "segments": [{"date": "20260616", "session_open_ms": 1_000, "session_close_ms": 2_000}],
            "candles": [{"t": 1_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10}],
            "quote_totals": [{"t": 1_000, "bid_total": 100, "ask_total": 90, "visible": True}],
            "ratio": [{"t": 1_000, "value": 0.1, "visible": True}],
            "fill_strength": [{"t": 1_000, "buy_qty": 5, "sell_qty": 4, "visible": True}],
            "data_warnings": [],
        },
        "captured_at_ms": 3_000,
    }
    base.update(overrides)
    return base


def _req(**overrides):
    snap = _snapshot()
    base = {
        "name": "삼성전자 5분봉 2026.06.16",
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "snapshot_from_ms": 1_000,
        "snapshot_to_ms": 2_000,
        "viewport": snap["viewport"],
        "indicator_state": snap["indicator_state"],
        "snapshot": snap,
        "provenance": snap["provenance"],
    }
    base.update(overrides)
    return base


def test_study_view_write_request_trims_name_and_defaults_memo_tags():
    req = ParquetStudyViewWriteRequest.model_validate(_req(name="  내 저장뷰  "))
    assert req.name == "내 저장뷰"
    assert req.memo == ""
    assert req.tags == []


def test_study_view_write_request_rejects_whitespace_name():
    with pytest.raises(ValidationError):
        ParquetStudyViewWriteRequest.model_validate(_req(name="   "))


def test_study_view_write_request_rejects_snapshot_metadata_mismatch():
    bad = _req(snapshot=_snapshot(code="000660"))
    with pytest.raises(ValidationError):
        ParquetStudyViewWriteRequest.model_validate(bad)


def test_study_snapshot_allows_hidden_indicator_without_numeric_value():
    snap = _snapshot()
    snap["bundle"]["ratio"] = [{"t": 1_000, "visible": False}]
    parsed = ParquetStudySnapshot.model_validate(snap)
    assert parsed.bundle.ratio[0].visible is False


def test_study_snapshot_rejects_unsorted_candles():
    snap = _snapshot()
    snap["bundle"]["candles"] = [
        {"t": 2_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10},
        {"t": 1_000, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 10},
    ]
    with pytest.raises(ValidationError):
        ParquetStudySnapshot.model_validate(snap)


def test_study_views_file_defaults_empty():
    assert StudyViewsFile().schema_version == 1
    assert StudyViewsFile().saves == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: import errors for `ParquetStudySnapshot`, `ParquetStudyViewWriteRequest`, and `StudyViewsFile`.

- [ ] **Step 3: Add Pydantic models**

Append near the saved screener models in `hoga/api/models.py`:

```python
LiveTimeframeModel = Literal["1m", "3m", "5m", "10m", "15m", "30m", "D", "W", "M"]
StudyAggregationBasis = Literal["close", "intra_period_max"]
StudySavedFromRoute = Literal["/live", "/study"]
StudyDataProvenance = Literal["live_mixed", "study_snapshot", "unknown"]


class StudyViewport(BaseModel):
    right_edge_ms: int
    bar_span: float
    at_live_edge: bool

    @field_validator("right_edge_ms", "bar_span")
    @classmethod
    def _finite_positive(cls, v: int | float):
        import math
        if not math.isfinite(float(v)):
            raise ValueError("must be finite")
        return v

    @model_validator(mode="after")
    def _bar_span_positive(self):
        if self.bar_span <= 0:
            raise ValueError("bar_span must be positive")
        return self


class StudyIndicatorState(BaseModel):
    volume_enabled: bool
    quote_totals_enabled: bool
    ratio_enabled: bool
    fill_strength_enabled: bool
    aggregation_basis: StudyAggregationBasis
    auction_window_mask: bool
    ratio_outlier_filter_enabled: bool
    ratio_outlier_threshold: float


class StudyProvenance(BaseModel):
    saved_from_route: StudySavedFromRoute
    data_provenance: StudyDataProvenance


class StudySegment(BaseModel):
    date: str
    session_open_ms: int
    session_close_ms: int


class StudyCandlePoint(BaseModel):
    t: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class StudyQuoteTotalsPoint(BaseModel):
    t: int
    bid_total: float | None = None
    ask_total: float | None = None
    visible: bool

    @model_validator(mode="after")
    def _visible_has_values(self):
        if self.visible and (self.bid_total is None or self.ask_total is None):
            raise ValueError("visible quote total points require bid_total and ask_total")
        return self


class StudyRatioPoint(BaseModel):
    t: int
    value: float | None = None
    visible: bool

    @model_validator(mode="after")
    def _visible_has_value(self):
        if self.visible and self.value is None:
            raise ValueError("visible ratio points require value")
        return self


class StudyFillStrengthPoint(BaseModel):
    t: int
    buy_qty: float | None = None
    sell_qty: float | None = None
    visible: bool

    @model_validator(mode="after")
    def _visible_has_values(self):
        if self.visible and (self.buy_qty is None or self.sell_qty is None):
            raise ValueError("visible fill strength points require buy_qty and sell_qty")
        return self


class StudySnapshotBundle(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    segments: list[StudySegment]
    candles: list[StudyCandlePoint]
    quote_totals: list[StudyQuoteTotalsPoint]
    ratio: list[StudyRatioPoint]
    fill_strength: list[StudyFillStrengthPoint]
    data_warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_bundle(self):
        if self.snapshot_from_ms > self.snapshot_to_ms:
            raise ValueError("snapshot_from_ms must be <= snapshot_to_ms")
        for name in ("candles", "quote_totals", "ratio", "fill_strength"):
            points = getattr(self, name)
            ts = [p.t for p in points]
            if ts != sorted(ts):
                raise ValueError(f"{name} must be sorted by t")
        return self


class ParquetStudySnapshot(BaseModel):
    schema_version: Literal[1] = 1
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    bucket_kind: LiveTimeframeModel
    viewport: StudyViewport
    indicator_state: StudyIndicatorState
    provenance: StudyProvenance
    bundle: StudySnapshotBundle
    captured_at_ms: int

    @model_validator(mode="after")
    def _metadata_matches_bundle(self):
        if self.snapshot_from_ms > self.snapshot_to_ms:
            raise ValueError("snapshot_from_ms must be <= snapshot_to_ms")
        if self.bundle.code != self.code:
            raise ValueError("snapshot bundle code mismatch")
        if self.bundle.timeframe != self.timeframe:
            raise ValueError("snapshot bundle timeframe mismatch")
        if self.bundle.snapshot_from_ms != self.snapshot_from_ms:
            raise ValueError("snapshot bundle from bound mismatch")
        if self.bundle.snapshot_to_ms != self.snapshot_to_ms:
            raise ValueError("snapshot bundle to bound mismatch")
        return self


class ParquetStudyViewWriteRequest(BaseModel):
    name: str
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    viewport: StudyViewport
    indicator_state: StudyIndicatorState
    snapshot: ParquetStudySnapshot
    provenance: StudyProvenance
    memo: str = ""
    tags: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v

    @model_validator(mode="after")
    def _request_matches_snapshot(self):
        if self.snapshot_from_ms > self.snapshot_to_ms:
            raise ValueError("snapshot_from_ms must be <= snapshot_to_ms")
        fields = ("code", "label", "timeframe", "snapshot_from_ms", "snapshot_to_ms")
        for field in fields:
            if getattr(self.snapshot, field) != getattr(self, field):
                raise ValueError(f"snapshot {field} mismatch")
        if self.snapshot.viewport != self.viewport:
            raise ValueError("snapshot viewport mismatch")
        if self.snapshot.indicator_state != self.indicator_state:
            raise ValueError("snapshot indicator_state mismatch")
        if self.snapshot.provenance != self.provenance:
            raise ValueError("snapshot provenance mismatch")
        return self


class ParquetStudyView(BaseModel):
    id: str
    name: str
    code: str
    label: str
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    viewport: StudyViewport
    indicator_state: StudyIndicatorState
    memo: str
    tags: list[str]
    provenance: StudyProvenance
    snapshot_schema_version: int
    snapshot_path: str
    snapshot_size_bytes: int
    created_at_ms: int
    updated_at_ms: int


class StudyViewsFile(BaseModel):
    schema_version: int = 1
    saves: list[ParquetStudyView] = Field(default_factory=list)
```

- [ ] **Step 4: Run model tests**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: model tests pass; persistence/route tests are not present yet.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/api/test_study_views.py
git commit -m "feat: add study view snapshot models"
```

---

### Task 2: Backend Persistence

**Files:**
- Create: `hoga/api/study_views.py`
- Modify: `tests/api/test_study_views.py`

- [ ] **Step 1: Add failing persistence tests**

Append to `tests/api/test_study_views.py`:

```python
import json

from hoga.api import study_views as sv


def test_study_views_load_missing_returns_empty(tmp_path):
    assert sv.load_saves(tmp_path).saves == []


def test_study_views_create_writes_manifest_and_snapshot(tmp_path):
    created = sv.create_save_sync(tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10)
    assert created.id == "view1"
    assert (tmp_path / "study_views" / "saves.json").exists()
    assert (tmp_path / "study_views" / "snapshots" / "view1.json").exists()
    assert sv.load_snapshot(tmp_path, id="view1").code == "005930"


def test_study_views_corrupt_manifest_quarantined(tmp_path):
    p = tmp_path / "study_views" / "saves.json"
    p.parent.mkdir(parents=True)
    p.write_text("{ not json", encoding="utf-8")
    assert sv.load_saves(tmp_path).saves == []
    assert list(p.parent.glob("saves.json.corrupt-*-badjson"))


def test_study_views_delete_missing_snapshot_still_removes_manifest(tmp_path):
    sv.create_save_sync(tmp_path, req=ParquetStudyViewWriteRequest.model_validate(_req()), id="view1", now_ms=10)
    (tmp_path / "study_views" / "snapshots" / "view1.json").unlink()
    sv.delete_save_sync(tmp_path, id="view1")
    assert sv.load_saves(tmp_path).saves == []


def test_study_views_missing_save_raises(tmp_path):
    with pytest.raises(sv.StudyViewNotFoundError):
        sv.get_save_sync(tmp_path, id="missing")
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: import error for `hoga.api.study_views`.

- [ ] **Step 3: Implement persistence module**

Create `hoga/api/study_views.py`:

```python
from __future__ import annotations

import asyncio
import datetime as dt
import json
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    ParquetStudySnapshot,
    ParquetStudyView,
    ParquetStudyViewWriteRequest,
    StudyViewsFile,
)

_CURRENT_VERSION = 1
_lock = asyncio.Lock()


class StudyViewNotFoundError(Exception):
    pass


def _root(data_dir: Path) -> Path:
    return data_dir / "study_views"


def _manifest_path(data_dir: Path) -> Path:
    return _root(data_dir) / "saves.json"


def _snapshot_path(data_dir: Path, id: str) -> Path:
    return _root(data_dir) / "snapshots" / f"{id}.json"


def _quarantine(p: Path, reason: str) -> StudyViewsFile:
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    backup = p.with_name(f"saves.json.corrupt-{stamp}-{reason}")
    try:
        p.rename(backup)
    except OSError:
        pass
    return StudyViewsFile()


def load_saves(data_dir: Path) -> StudyViewsFile:
    p = _manifest_path(data_dir)
    if not p.exists():
        return StudyViewsFile()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return _quarantine(p, "badjson")
    if not isinstance(raw, dict):
        return _quarantine(p, "badshape")
    if raw.get("schema_version", 0) > _CURRENT_VERSION:
        return _quarantine(p, "future-version")
    try:
        return StudyViewsFile.model_validate(raw)
    except ValidationError:
        return _quarantine(p, "schema")


def save_saves(data_dir: Path, file: StudyViewsFile) -> None:
    atomic_write_json(_manifest_path(data_dir), file.model_dump(mode="json"))


def load_snapshot(data_dir: Path, *, id: str) -> ParquetStudySnapshot:
    p = _snapshot_path(data_dir, id)
    if not p.exists():
        raise StudyViewNotFoundError(id)
    return ParquetStudySnapshot.model_validate_json(p.read_text(encoding="utf-8"))


def _view_from_req(
    data_dir: Path,
    *,
    req: ParquetStudyViewWriteRequest,
    id: str,
    created_at_ms: int,
    updated_at_ms: int,
) -> ParquetStudyView:
    snap_path = _snapshot_path(data_dir, id)
    size = snap_path.stat().st_size if snap_path.exists() else 0
    return ParquetStudyView(
        id=id,
        name=req.name,
        code=req.code,
        label=req.label,
        timeframe=req.timeframe,
        snapshot_from_ms=req.snapshot_from_ms,
        snapshot_to_ms=req.snapshot_to_ms,
        viewport=req.viewport,
        indicator_state=req.indicator_state,
        memo=req.memo,
        tags=req.tags,
        provenance=req.provenance,
        snapshot_schema_version=req.snapshot.schema_version,
        snapshot_path=f"study_views/snapshots/{id}.json",
        snapshot_size_bytes=size,
        created_at_ms=created_at_ms,
        updated_at_ms=updated_at_ms,
    )


def list_saves_sync(data_dir: Path) -> list[ParquetStudyView]:
    return load_saves(data_dir).saves


def get_save_sync(data_dir: Path, *, id: str) -> ParquetStudyView:
    for save in load_saves(data_dir).saves:
        if save.id == id:
            return save
    raise StudyViewNotFoundError(id)


def create_save_sync(data_dir: Path, *, req: ParquetStudyViewWriteRequest, id: str, now_ms: int) -> ParquetStudyView:
    snapshot_path = _snapshot_path(data_dir, id)
    atomic_write_json(snapshot_path, req.snapshot.model_dump(mode="json"))
    file = load_saves(data_dir)
    save = _view_from_req(data_dir, req=req, id=id, created_at_ms=now_ms, updated_at_ms=now_ms)
    file.saves.append(save)
    file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
    save_saves(data_dir, file)
    return save


def update_save_sync(data_dir: Path, *, id: str, req: ParquetStudyViewWriteRequest, now_ms: int) -> ParquetStudyView:
    file = load_saves(data_dir)
    for idx, old in enumerate(file.saves):
        if old.id == id:
            atomic_write_json(_snapshot_path(data_dir, id), req.snapshot.model_dump(mode="json"))
            new = _view_from_req(data_dir, req=req, id=id, created_at_ms=old.created_at_ms, updated_at_ms=now_ms)
            file.saves[idx] = new
            file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
            save_saves(data_dir, file)
            return new
    raise StudyViewNotFoundError(id)


def delete_save_sync(data_dir: Path, *, id: str) -> None:
    file = load_saves(data_dir)
    if not any(s.id == id for s in file.saves):
        raise StudyViewNotFoundError(id)
    file.saves = [s for s in file.saves if s.id != id]
    try:
        _snapshot_path(data_dir, id).unlink()
    except FileNotFoundError:
        pass
    save_saves(data_dir, file)


async def create_save(data_dir: Path, *, req: ParquetStudyViewWriteRequest, id: str, now_ms: int) -> ParquetStudyView:
    async with _lock:
        return create_save_sync(data_dir, req=req, id=id, now_ms=now_ms)


async def update_save(data_dir: Path, *, id: str, req: ParquetStudyViewWriteRequest, now_ms: int) -> ParquetStudyView:
    async with _lock:
        return update_save_sync(data_dir, id=id, req=req, now_ms=now_ms)


async def delete_save(data_dir: Path, *, id: str) -> None:
    async with _lock:
        delete_save_sync(data_dir, id=id)
```

- [ ] **Step 4: Run persistence tests**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/study_views.py tests/api/test_study_views.py
git commit -m "feat: persist study view snapshots"
```

---

### Task 3: Backend Routes

**Files:**
- Create: `hoga/api/study_view_routes.py`
- Modify: `hoga/api/app.py`
- Modify: `tests/api/test_study_views.py`

- [ ] **Step 1: Add failing route tests**

Append to `tests/api/test_study_views.py`:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.study_view_routes import build_router


@pytest.fixture
def study_client(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


def test_study_view_routes_crud(study_client):
    r = study_client.post("/api/study-views/saves", json=_req())
    assert r.status_code == 201
    sid = r.json()["id"]
    assert study_client.get("/api/study-views/saves").json()["saves"][0]["id"] == sid
    assert study_client.get(f"/api/study-views/saves/{sid}").json()["id"] == sid
    snap = study_client.get(f"/api/study-views/saves/{sid}/snapshot").json()
    assert snap["code"] == "005930"
    r2 = study_client.put(f"/api/study-views/saves/{sid}", json=_req(name="수정"))
    assert r2.status_code == 200
    assert r2.json()["id"] == sid
    assert r2.json()["name"] == "수정"
    assert study_client.delete(f"/api/study-views/saves/{sid}").status_code == 204
    assert study_client.get(f"/api/study-views/saves/{sid}").status_code == 404


def test_study_view_routes_missing_ids_return_study_specific_404(study_client):
    r = study_client.get("/api/study-views/saves/missing")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "study_view_not_found"
```

- [ ] **Step 2: Run route tests to verify failure**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: import error for `hoga.api.study_view_routes`.

- [ ] **Step 3: Implement route module**

Create `hoga/api/study_view_routes.py`:

```python
from __future__ import annotations

import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import study_views
from hoga.api.models import (
    ParquetStudySnapshot,
    ParquetStudyView,
    ParquetStudyViewWriteRequest,
    StudyViewsFile,
)


def _not_found(save_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"code": "study_view_not_found", "message": f"study view not found: {save_id}"},
    )


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/study-views", tags=["study-views"])

    @router.get("/saves", response_model=StudyViewsFile)
    async def list_saves() -> StudyViewsFile:
        return study_views.load_saves(data_dir)

    @router.post("/saves", status_code=201, response_model=ParquetStudyView)
    async def create_save(req: ParquetStudyViewWriteRequest) -> ParquetStudyView:
        return await study_views.create_save(
            data_dir,
            req=req,
            id=uuid.uuid4().hex,
            now_ms=int(time.time() * 1000),
        )

    @router.get("/saves/{save_id}", response_model=ParquetStudyView)
    async def get_save(save_id: str) -> ParquetStudyView:
        try:
            return study_views.get_save_sync(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    @router.get("/saves/{save_id}/snapshot", response_model=ParquetStudySnapshot)
    async def get_snapshot(save_id: str) -> ParquetStudySnapshot:
        try:
            study_views.get_save_sync(data_dir, id=save_id)
            return study_views.load_snapshot(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    @router.put("/saves/{save_id}", response_model=ParquetStudyView)
    async def update_save(save_id: str, req: ParquetStudyViewWriteRequest) -> ParquetStudyView:
        try:
            return await study_views.update_save(data_dir, id=save_id, req=req, now_ms=int(time.time() * 1000))
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    @router.delete("/saves/{save_id}", status_code=204)
    async def delete_save(save_id: str) -> None:
        try:
            await study_views.delete_save(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    return router
```

- [ ] **Step 4: Mount router in app composition**

Modify `hoga/api/app.py`. Near the existing router imports, add:

```python
from hoga.api.study_view_routes import build_router as build_study_view_router
```

Near the existing `app.include_router(build_screener_router(data_dir=data_dir, bus=bus))`, add:

```python
app.include_router(build_study_view_router(data_dir=data_dir))
```

- [ ] **Step 5: Run route tests**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: all study view backend tests pass.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/study_view_routes.py hoga/api/app.py tests/api/test_study_views.py
git commit -m "feat: add study view API routes"
```

---

### Task 4: Frontend API Hooks

**Files:**
- Create: `frontend/src/api/studyViews.ts`
- Create: `frontend/src/studyViews/useStudyViews.ts`
- Create: `frontend/src/api/studyViews.test.ts`

- [ ] **Step 1: Write failing API tests**

Create `frontend/src/api/studyViews.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createStudyView, deleteStudyView, getStudyViewSnapshot, listStudyViews, updateStudyView } from './studyViews';

const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/study-views/saves' && !init) {
      return new Response(JSON.stringify({ schema_version: 1, saves: [] }), { status: 200 });
    }
    if (path.endsWith('/snapshot')) {
      return new Response(JSON.stringify({ schema_version: 1, code: '005930' }), { status: 200 });
    }
    if (init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ id: 'view1', name: '저장뷰' }), { status: init?.method === 'POST' ? 201 : 200 });
  }) as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

it('calls study view endpoints', async () => {
  await expect(listStudyViews()).resolves.toEqual({ schema_version: 1, saves: [] });
  await expect(getStudyViewSnapshot('view1')).resolves.toMatchObject({ code: '005930' });
  await createStudyView({ name: '저장뷰' } as any);
  await updateStudyView('view1', { name: '수정' } as any);
  await deleteStudyView('view1');
  expect(global.fetch).toHaveBeenCalledWith('/api/study-views/saves', expect.anything());
  expect(global.fetch).toHaveBeenCalledWith('/api/study-views/saves/view1', expect.objectContaining({ method: 'PUT' }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npx vitest run src/api/studyViews.test.ts
```

Expected: module import failure.

- [ ] **Step 3: Implement API module**

Create `frontend/src/api/studyViews.ts`:

```ts
import { apiAction, apiCall } from './client';
import type { LiveTimeframe } from '../state/livePage';

export type StudyAggregationBasis = 'close' | 'intra_period_max';
export type StudyDataProvenance = 'live_mixed' | 'study_snapshot' | 'unknown';
export type StudySavedFromRoute = '/live' | '/study';

export type StudyViewport = {
  right_edge_ms: number;
  bar_span: number;
  at_live_edge: boolean;
};

export type StudyIndicatorState = {
  volume_enabled: boolean;
  quote_totals_enabled: boolean;
  ratio_enabled: boolean;
  fill_strength_enabled: boolean;
  aggregation_basis: StudyAggregationBasis;
  auction_window_mask: boolean;
  ratio_outlier_filter_enabled: boolean;
  ratio_outlier_threshold: number;
};

export type StudyProvenance = {
  saved_from_route: StudySavedFromRoute;
  data_provenance: StudyDataProvenance;
};

export type StudySnapshotBundle = {
  code: string;
  timeframe: LiveTimeframe;
  snapshot_from_ms: number;
  snapshot_to_ms: number;
  segments: { date: string; session_open_ms: number; session_close_ms: number }[];
  candles: { t: number; open: number; high: number; low: number; close: number; volume: number }[];
  quote_totals: { t: number; bid_total?: number; ask_total?: number; visible: boolean }[];
  ratio: { t: number; value?: number; visible: boolean }[];
  fill_strength: { t: number; buy_qty?: number; sell_qty?: number; visible: boolean }[];
  data_warnings: string[];
};

export type ParquetStudySnapshot = {
  schema_version: 1;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  snapshot_from_ms: number;
  snapshot_to_ms: number;
  bucket_kind: LiveTimeframe;
  viewport: StudyViewport;
  indicator_state: StudyIndicatorState;
  provenance: StudyProvenance;
  bundle: StudySnapshotBundle;
  captured_at_ms: number;
};

export type ParquetStudyView = {
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  snapshot_from_ms: number;
  snapshot_to_ms: number;
  viewport: StudyViewport;
  indicator_state: StudyIndicatorState;
  memo: string;
  tags: string[];
  provenance: StudyProvenance;
  snapshot_schema_version: number;
  snapshot_path: string;
  snapshot_size_bytes: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type StudyViewsFile = { schema_version: number; saves: ParquetStudyView[] };
export type ParquetStudyViewWriteRequest = Omit<
  ParquetStudyView,
  'id' | 'snapshot_schema_version' | 'snapshot_path' | 'snapshot_size_bytes' | 'created_at_ms' | 'updated_at_ms'
> & { snapshot: ParquetStudySnapshot };

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const listStudyViews = () => apiCall<StudyViewsFile>('/api/study-views/saves');
export const createStudyView = (body: ParquetStudyViewWriteRequest) =>
  apiCall<ParquetStudyView>('/api/study-views/saves', { method: 'POST', ...json(body) });
export const getStudyView = (id: string) => apiCall<ParquetStudyView>(`/api/study-views/saves/${id}`);
export const getStudyViewSnapshot = (id: string) =>
  apiCall<ParquetStudySnapshot>(`/api/study-views/saves/${id}/snapshot`);
export const updateStudyView = (id: string, body: ParquetStudyViewWriteRequest) =>
  apiCall<ParquetStudyView>(`/api/study-views/saves/${id}`, { method: 'PUT', ...json(body) });
export const deleteStudyView = (id: string) =>
  apiAction(`/api/study-views/saves/${id}`, { method: 'DELETE' });
```

- [ ] **Step 4: Add React Query hooks**

Create `frontend/src/studyViews/useStudyViews.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createStudyView,
  deleteStudyView,
  getStudyViewSnapshot,
  listStudyViews,
  updateStudyView,
  type ParquetStudyViewWriteRequest,
} from '../api/studyViews';

export const STUDY_VIEW_SAVES_QUERY = ['study-view-saves'] as const;
export const studyViewSnapshotQuery = (id: string | null) => ['study-view-snapshot', id] as const;

export function useStudyViews() {
  return useQuery({ queryKey: STUDY_VIEW_SAVES_QUERY, queryFn: listStudyViews });
}

export function useStudyViewSnapshot(id: string | null) {
  return useQuery({
    queryKey: studyViewSnapshotQuery(id),
    queryFn: () => getStudyViewSnapshot(id!),
    enabled: id !== null,
  });
}

export function useStudyViewMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: STUDY_VIEW_SAVES_QUERY });
  return {
    create: useMutation({
      mutationFn: (body: ParquetStudyViewWriteRequest) => createStudyView(body),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: ParquetStudyViewWriteRequest }) => updateStudyView(id, body),
      onSuccess: (_save, vars) => {
        invalidate();
        qc.invalidateQueries({ queryKey: studyViewSnapshotQuery(vars.id) });
      },
    }),
    remove: useMutation({
      mutationFn: deleteStudyView,
      onSuccess: invalidate,
    }),
  };
}
```

- [ ] **Step 5: Run API tests**

Run:

```bash
cd frontend && npx vitest run src/api/studyViews.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/studyViews.ts frontend/src/studyViews/useStudyViews.ts frontend/src/api/studyViews.test.ts
git commit -m "feat: add study view frontend API"
```

---

### Task 5: Right Rail Entry and Drawer Shell

**Files:**
- Modify: `frontend/src/state/rightRail.ts`
- Modify: `frontend/src/rightrail/RightRail.tsx`
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/ui/BookmarkIcon.tsx`
- Create: `frontend/src/studyViews/StudyViewsDrawer.tsx`
- Modify: `frontend/src/rightrail/RightRail.test.tsx`
- Create: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`

- [ ] **Step 1: Add failing right rail tests**

In `frontend/src/rightrail/RightRail.test.tsx`, add:

```ts
it('renders saved views as the third rail item', () => {
  render(<RightRail />);
  expect(screen.getByRole('button', { name: '저장뷰 패널 토글' })).toBeTruthy();
});
```

In `frontend/src/state/rightRail.ts` tests, or existing `frontend/src/rightrail/RightRail.test.tsx`, add a persistence check:

```ts
it('accepts savedViews from persisted right rail state', async () => {
  localStorage.setItem('rightRail.layout', JSON.stringify({ activePanel: 'savedViews' }));
  vi.resetModules();
  const mod = await import('../state/rightRail');
  expect(mod.useRightRailStore.getState().activePanel).toBe('savedViews');
});
```

- [ ] **Step 2: Implement right rail state and icon**

Modify `frontend/src/state/rightRail.ts`:

```ts
export type RailPanel = 'watchlist' | 'screener' | 'savedViews';
const VALID_PANELS: readonly RailPanel[] = ['watchlist', 'screener', 'savedViews'];
```

Create `frontend/src/ui/BookmarkIcon.tsx`:

```tsx
export function BookmarkIcon({ filled, className = '' }: { filled?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill={filled ? 'currentColor' : 'none'}>
      <path
        d="M6 4.75A2.25 2.25 0 0 1 8.25 2.5h7.5A2.25 2.25 0 0 1 18 4.75v16l-6-3.75-6 3.75v-16Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

- [ ] **Step 3: Add rail item and drawer rendering**

Modify `frontend/src/rightrail/RightRail.tsx`:

```tsx
import { BookmarkIcon } from '../ui/BookmarkIcon';
```

Add after Screener:

```tsx
<RailItem
  label="저장뷰"
  ariaLabel="저장뷰 패널 토글"
  controls="right-rail-saved-views-panel"
  active={activePanel === 'savedViews'}
  onClick={() => togglePanel('savedViews')}
  icon={<BookmarkIcon filled={activePanel === 'savedViews'} className="w-[1.125em] h-[1.125em]" />}
/>
```

Modify `frontend/src/App.tsx`:

```tsx
import { StudyViewsDrawer } from './studyViews/StudyViewsDrawer';
```

Add:

```tsx
{activePanel === 'savedViews' && <StudyViewsDrawer />}
```

- [ ] **Step 4: Create drawer shell**

Create `frontend/src/studyViews/StudyViewsDrawer.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useStudyViews } from './useStudyViews';

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export function filterStudyViews<T extends { name: string; code: string; memo: string }>(rows: T[], query: string): T[] {
  const q = normalize(query);
  if (!q) return rows;
  return rows.filter((row) => [row.name, row.code, row.memo].some((v) => normalize(v).includes(q)));
}

export function StudyViewsDrawer() {
  const { data, isLoading, isError, refetch } = useStudyViews();
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const rows = useMemo(() => filterStudyViews(data?.saves ?? [], query), [data?.saves, query]);
  const canSave = location.pathname === '/live' || location.pathname === '/study';

  return (
    <aside id="right-rail-saved-views-panel" className="h-full min-w-0 overflow-hidden border-l bg-bg">
      <div className="h-full flex flex-col">
        <header className="px-3 py-2 border-b flex items-center justify-between">
          <h2 className="text-sm font-semibold">저장 뷰</h2>
          <button type="button" disabled={!canSave} className="text-xs px-2 py-1 border rounded">
            {location.pathname === '/study' ? '덮어쓰기' : '현재 뷰 저장'}
          </button>
        </header>
        <div className="p-3 border-b">
          <input
            aria-label="저장 뷰 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-bg-input border rounded px-2 py-1 text-sm"
          />
          {!canSave && <p className="mt-2 text-xs text-fg-dim">차트 화면에서 저장할 수 있습니다.</p>}
        </div>
        {isLoading && <div className="p-3 text-sm text-fg-dim">불러오는 중</div>}
        {isError && (
          <div className="p-3 text-sm">
            <p>저장 뷰를 불러오지 못했습니다.</p>
            <button type="button" onClick={() => refetch()} className="mt-2 underline">다시 시도</button>
          </div>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) === 0 && (
          <div className="p-3 text-sm text-fg-dim">저장된 뷰가 없습니다.</div>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) > 0 && rows.length === 0 && (
          <div className="p-3 text-sm text-fg-dim">검색 결과가 없습니다.</div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => navigate(`/study?view=${row.id}`)}
              className="w-full text-left px-3 py-2 border-b hover:bg-bg-input-hover"
            >
              <div className="text-sm font-medium truncate">{row.name}</div>
              <div className="text-xs text-fg-dim truncate">{row.label} {row.code} · {row.timeframe}</div>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Add drawer tests**

Create `frontend/src/studyViews/StudyViewsDrawer.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { StudyViewsDrawer, filterStudyViews } from './StudyViewsDrawer';

vi.mock('./useStudyViews', () => ({
  useStudyViews: () => ({
    data: { schema_version: 1, saves: [
      { id: 'a', name: '급등 이후', code: '005930', label: '삼성전자', timeframe: '5m', memo: 'memo one' },
      { id: 'b', name: '눌림', code: '000660', label: 'SK하이닉스', timeframe: 'D', memo: 'space memo' },
    ] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

it('filters by name, code, and memo ignoring whitespace and case', () => {
  const rows = [
    { name: 'My View', code: '005930', memo: 'hello world' },
    { name: 'Other', code: '000660', memo: 'nothing' },
  ];
  expect(filterStudyViews(rows, 'myview')).toHaveLength(1);
  expect(filterStudyViews(rows, '005 930')).toHaveLength(1);
  expect(filterStudyViews(rows, 'HELLO WORLD')).toHaveLength(1);
});

it('renders list and no-match state', async () => {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}><StudyViewsDrawer /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByText('급등 이후')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('저장 뷰 검색'), '없음');
  expect(screen.getByText('검색 결과가 없습니다.')).toBeTruthy();
  expect(screen.getByText('차트 화면에서 저장할 수 있습니다.')).toBeTruthy();
});
```

- [ ] **Step 6: Run frontend tests**

Run:

```bash
cd frontend && npx vitest run src/rightrail/RightRail.test.tsx src/studyViews/StudyViewsDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/state/rightRail.ts frontend/src/rightrail/RightRail.tsx frontend/src/App.tsx frontend/src/ui/BookmarkIcon.tsx frontend/src/studyViews/StudyViewsDrawer.tsx frontend/src/rightrail/RightRail.test.tsx frontend/src/studyViews/StudyViewsDrawer.test.tsx
git commit -m "feat: add saved views right rail panel"
```

---

### Task 6: Snapshot Window and Adapter

**Files:**
- Create: `frontend/src/studyViews/snapshotWindow.ts`
- Create: `frontend/src/studyViews/studySnapshotAdapter.ts`
- Create: `frontend/src/studyViews/snapshotWindow.test.ts`
- Create: `frontend/src/studyViews/studySnapshotAdapter.test.ts`
- Modify: `frontend/src/live/paneSpecsForTimeframe.ts`
- Modify: `frontend/src/live/paneSpecsForTimeframe.test.ts`

- [ ] **Step 1: Write failing utility tests**

Create `frontend/src/studyViews/snapshotWindow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chooseSnapshotWindow } from './snapshotWindow';

const bars = Array.from({ length: 300 }, (_, i) => ({ t: i }));

it('keeps visible range when it is wider than 200 bars', () => {
  expect(chooseSnapshotWindow(bars, 10, 250)).toEqual({ fromIndex: 10, toIndex: 250 });
});

it('expands a narrow range to 200 centered around visible range', () => {
  expect(chooseSnapshotWindow(bars, 100, 119)).toEqual({ fromIndex: 10, toIndex: 209 });
});

it('fills from the right when left edge lacks enough bars', () => {
  expect(chooseSnapshotWindow(bars, 0, 20)).toEqual({ fromIndex: 0, toIndex: 199 });
});
```

Create `frontend/src/studyViews/studySnapshotAdapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { studySnapshotBundleToRangeBundle } from './studySnapshotAdapter';

it('adapts display-locked study snapshot into RangeBundle shape', () => {
  const bundle = studySnapshotBundleToRangeBundle({
    code: '005930',
    timeframe: '5m',
    snapshot_from_ms: 1000,
    snapshot_to_ms: 2000,
    segments: [{ date: '20260616', session_open_ms: 1000, session_close_ms: 2000 }],
    candles: [{ t: 1000, open: 1, high: 2, low: 1, close: 2, volume: 10 }],
    quote_totals: [{ t: 1000, bid_total: 100, ask_total: 90, visible: true }, { t: 1500, visible: false }],
    ratio: [{ t: 1000, value: 0.2, visible: true }],
    fill_strength: [{ t: 1000, buy_qty: 5, sell_qty: 4, visible: true }],
    data_warnings: ['partial'],
  });
  expect(bundle.candles[0]).toMatchObject({ ts_ms: 1000, open: 1, close: 2 });
  expect(bundle.quote_ratio.points[0]).toMatchObject({ t: 1000, bid_total: 100, ask_total: 90 });
  expect(bundle.quote_ratio.points).toHaveLength(1);
  expect(bundle.fill_strength.points[0]).toMatchObject({ t: 1000, buy_qty: 5, sell_qty: 4 });
});
```

- [ ] **Step 2: Implement snapshot window**

Create `frontend/src/studyViews/snapshotWindow.ts`:

```ts
export function chooseSnapshotWindow<T>(
  bars: readonly T[],
  visibleFromIndex: number,
  visibleToIndex: number,
  minBars = 200,
): { fromIndex: number; toIndex: number } {
  if (bars.length === 0) return { fromIndex: 0, toIndex: -1 };
  const lo = Math.max(0, Math.min(visibleFromIndex, visibleToIndex));
  const hi = Math.min(bars.length - 1, Math.max(visibleFromIndex, visibleToIndex));
  const visibleCount = hi - lo + 1;
  if (visibleCount >= minBars) return { fromIndex: lo, toIndex: hi };
  const need = Math.min(minBars, bars.length) - visibleCount;
  const leftWant = Math.floor(need / 2);
  const rightWant = need - leftWant;
  let from = Math.max(0, lo - leftWant);
  let to = Math.min(bars.length - 1, hi + rightWant);
  const missingLeft = leftWant - (lo - from);
  const missingRight = rightWant - (to - hi);
  if (missingLeft > 0) to = Math.min(bars.length - 1, to + missingLeft);
  if (missingRight > 0) from = Math.max(0, from - missingRight);
  return { fromIndex: from, toIndex: to };
}
```

- [ ] **Step 3: Implement adapter**

Create `frontend/src/studyViews/studySnapshotAdapter.ts`:

```ts
import type { RangeBundle } from '../api/types';
import type { StudySnapshotBundle } from '../api/studyViews';

export function studySnapshotBundleToRangeBundle(snapshot: StudySnapshotBundle): RangeBundle {
  return {
    code: snapshot.code,
    bucket_ms: 60_000,
    segments: snapshot.segments,
    candles: snapshot.candles.map((c) => ({
      ts_ms: c.t,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      vol_a: c.volume,
      vol_b: 0,
    })),
    orderbook: [],
    trades: [],
    brokers: [],
    volume_profile: null,
    ask_peaks: [],
    investor_points: [],
    quote_ratio: {
      bucket_ms: 60_000,
      points: snapshot.quote_totals
        .filter((p) => p.visible && p.bid_total != null && p.ask_total != null)
        .map((p) => ({
          t: p.t,
          bid_total: p.bid_total!,
          ask_total: p.ask_total!,
          bid_max: p.bid_total!,
          ask_max: p.ask_total!,
          imb_max_bid: p.bid_total!,
          imb_max_ask: p.ask_total!,
        })),
    },
    fill_strength: {
      bucket_ms: 60_000,
      points: snapshot.fill_strength
        .filter((p) => p.visible && p.buy_qty != null && p.sell_qty != null)
        .map((p) => ({ t: p.t, buy_qty: p.buy_qty!, sell_qty: p.sell_qty! })),
    },
    data_warnings: snapshot.data_warnings,
  } as RangeBundle;
}
```

- [ ] **Step 4: Allow study calendar panes**

Modify `frontend/src/live/paneSpecsForTimeframe.ts`:

```ts
export type PaneToggles = {
  foreignNet: boolean;
  institutionNet: boolean;
  volumeEnabled?: boolean;
  quoteTotalsEnabled?: boolean;
  ratioEnabled?: boolean;
  fillStrengthEnabled?: boolean;
  forceHogaPanes?: boolean;
};

const hogaAllowed = (tf: LiveTimeframe, t: PaneToggles): boolean => t.forceHogaPanes === true || isMinute(tf);

const GATE_BY_NAME: Partial<Record<string, PaneGate>> = {
  volume: (_tf, t) => t.volumeEnabled !== false,
  'quote-totals': (tf, t) => hogaAllowed(tf, t) && t.quoteTotalsEnabled !== false,
  ratio: (tf, t) => hogaAllowed(tf, t) && t.ratioEnabled !== false,
  'fill-strength': (tf, t) => hogaAllowed(tf, t) && t.fillStrengthEnabled !== false,
};
```

Add test:

```ts
it('study mode can mount hoga panes for calendar timeframe snapshots', () => {
  const names = paneSpecsForTimeframe('D', {
    foreignNet: false,
    institutionNet: false,
    forceHogaPanes: true,
  }).map((s) => s.name);
  expect(names).toEqual(['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength']);
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/snapshotWindow.test.ts src/studyViews/studySnapshotAdapter.test.ts src/live/paneSpecsForTimeframe.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/studyViews/snapshotWindow.ts frontend/src/studyViews/studySnapshotAdapter.ts frontend/src/studyViews/snapshotWindow.test.ts frontend/src/studyViews/studySnapshotAdapter.test.ts frontend/src/live/paneSpecsForTimeframe.ts frontend/src/live/paneSpecsForTimeframe.test.ts
git commit -m "feat: adapt study snapshots for chart restore"
```

---

### Task 7: Study Page Restore

**Files:**
- Create: `frontend/src/studyViews/StudyPage.tsx`
- Create: `frontend/src/studyViews/StudyPage.test.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`

- [ ] **Step 1: Write failing route/page tests**

Create `frontend/src/studyViews/StudyPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { StudyPage } from './StudyPage';

const useLiveBundleSpy = vi.fn();
const useRangeSpy = vi.fn();

vi.mock('../live/LiveChartRoot', () => ({
  LiveChartRoot: (props: any) => <div data-testid="study-chart">{props.code}:{props.timeframe}:{props.restoreViewport?.barSpan}</div>,
}));
vi.mock('../live/useLiveBundle', () => ({ useLiveBundle: (...args: unknown[]) => useLiveBundleSpy(...args) }));
vi.mock('../api/range', () => ({ useRange: (...args: unknown[]) => useRangeSpy(...args) }));
vi.mock('./useStudyViews', () => ({
  useStudyViewSnapshot: (id: string | null) => ({
    data: id === 'view1' ? {
      schema_version: 1,
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      viewport: { right_edge_ms: 1000, bar_span: 200, at_live_edge: false },
      bundle: {
        code: '005930',
        timeframe: '5m',
        snapshot_from_ms: 1000,
        snapshot_to_ms: 2000,
        segments: [{ date: '20260616', session_open_ms: 1000, session_close_ms: 2000 }],
        candles: [{ t: 1000, open: 1, high: 2, low: 1, close: 2, volume: 10 }],
        quote_totals: [],
        ratio: [],
        fill_strength: [],
        data_warnings: [],
      },
    } : null,
    isLoading: false,
    isError: id !== 'view1',
  }),
}));

function renderStudy(path: string) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/study" element={<StudyPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('renders saved snapshot without live/range hooks', () => {
  renderStudy('/study?view=view1');
  expect(screen.getByTestId('study-chart').textContent).toBe('005930:5m:200');
  expect(useLiveBundleSpy).not.toHaveBeenCalled();
  expect(useRangeSpy).not.toHaveBeenCalled();
});

it('shows list-only empty state without view param', () => {
  renderStudy('/study');
  expect(screen.getByText('저장뷰를 선택하세요')).toBeTruthy();
});
```

- [ ] **Step 2: Implement StudyPage**

Create `frontend/src/studyViews/StudyPage.tsx`:

```tsx
import { useSearchParams } from 'react-router';
import { LiveChartRoot } from '../live/LiveChartRoot';
import { useStudyViewSnapshot } from './useStudyViews';
import { studySnapshotBundleToRangeBundle } from './studySnapshotAdapter';

export function StudyPage() {
  const [params] = useSearchParams();
  const viewId = params.get('view');
  const snapshot = useStudyViewSnapshot(viewId);

  if (!viewId) {
    return <div className="h-full grid place-items-center text-sm text-fg-dim">저장뷰를 선택하세요</div>;
  }
  if (snapshot.isLoading) {
    return <div className="h-full grid place-items-center text-sm text-fg-dim">저장뷰를 불러오는 중</div>;
  }
  if (snapshot.isError || !snapshot.data) {
    return <div className="h-full grid place-items-center text-sm text-fg-dim">저장 학습뷰를 찾을 수 없습니다</div>;
  }

  const bundle = studySnapshotBundleToRangeBundle(snapshot.data.bundle);

  return (
    <div className="h-full min-h-0">
      <LiveChartRoot
        code={snapshot.data.code}
        timeframe={snapshot.data.timeframe}
        bundle={bundle}
        chartBundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        pastDataWarnings={[]}
        restoreViewport={snapshot.data.viewport}
        dayAskPeaks={[]}
        todayKst=""
        forceHogaPanes
      />
    </div>
  );
}
```

- [ ] **Step 3: Add `forceHogaPanes` prop**

Modify `frontend/src/live/LiveChartRoot.tsx` props:

```ts
forceHogaPanes?: boolean;
```

Thread it into `paneSpecsForTimeframe`:

```ts
const paneSpecs = paneSpecsForTimeframe(timeframe, {
  foreignNet: foreignNetEnabled,
  institutionNet: institutionNetEnabled,
  volumeEnabled,
  quoteTotalsEnabled,
  ratioEnabled,
  fillStrengthEnabled,
  forceHogaPanes,
});
```

Default `forceHogaPanes = false` in the function signature so `/live` is unchanged.

- [ ] **Step 4: Register `/study` route**

Modify `frontend/src/main.tsx`:

```tsx
import { StudyPage } from './studyViews/StudyPage';
```

Add:

```tsx
<Route path="study" element={<StudyPage />} />
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx frontend/src/main.tsx frontend/src/live/LiveChartRoot.tsx
git commit -m "feat: add snapshot-backed study page"
```

---

### Task 8: Snapshot Capture Contract

**Files:**
- Create: `frontend/src/studyViews/useStudySnapshotCapture.ts`
- Create: `frontend/src/studyViews/useStudySnapshotCapture.test.ts`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`

- [ ] **Step 1: Write failing capture builder tests**

Create `frontend/src/studyViews/useStudySnapshotCapture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildStudySnapshotRequest } from './useStudySnapshotCapture';

it('builds display-locked write request from chart data', () => {
  const req = buildStudySnapshotRequest({
    name: '삼성전자 5분봉 2026.06.16',
    memo: '메모',
    route: '/live',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    viewport: { right_edge_ms: 2000, bar_span: 200, at_live_edge: false },
    indicatorState: {
      volume_enabled: true,
      quote_totals_enabled: true,
      ratio_enabled: true,
      fill_strength_enabled: true,
      aggregation_basis: 'close',
      auction_window_mask: true,
      ratio_outlier_filter_enabled: false,
      ratio_outlier_threshold: 50,
    },
    bundle: {
      code: '005930',
      bucket_ms: 300000,
      segments: [{ date: '20260616', session_open_ms: 1000, session_close_ms: 3000 }],
      candles: [
        { ts_ms: 1000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
        { ts_ms: 2000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
      ],
      quote_ratio: { bucket_ms: 300000, points: [{ t: 1000, bid_total: 100, ask_total: 90, bid_max: 100, ask_max: 90, imb_max_bid: 100, imb_max_ask: 90 }] },
      fill_strength: { bucket_ms: 300000, points: [{ t: 1000, buy_qty: 5, sell_qty: 4 }] },
      data_warnings: [],
    } as any,
    fromIndex: 0,
    toIndex: 1,
  });
  expect(req.snapshot.bundle.candles).toHaveLength(2);
  expect(req.snapshot.bundle.quote_totals[0]).toEqual({ t: 1000, bid_total: 100, ask_total: 90, visible: true });
  expect(req.provenance).toEqual({ saved_from_route: '/live', data_provenance: 'live_mixed' });
});
```

- [ ] **Step 2: Implement capture builder**

Create `frontend/src/studyViews/useStudySnapshotCapture.ts`:

```ts
import type { RangeBundle } from '../api/types';
import type { LiveTimeframe } from '../state/livePage';
import type {
  ParquetStudyViewWriteRequest,
  StudyIndicatorState,
  StudySavedFromRoute,
  StudyViewport,
} from '../api/studyViews';

type BuildArgs = {
  name: string;
  memo?: string;
  route: StudySavedFromRoute;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  viewport: StudyViewport;
  indicatorState: StudyIndicatorState;
  bundle: RangeBundle;
  fromIndex: number;
  toIndex: number;
};

export function buildStudySnapshotRequest(args: BuildArgs): ParquetStudyViewWriteRequest {
  const candles = args.bundle.candles.slice(args.fromIndex, args.toIndex + 1);
  const from = candles[0]?.ts_ms ?? args.viewport.right_edge_ms;
  const to = candles[candles.length - 1]?.ts_ms ?? args.viewport.right_edge_ms;
  const within = (t: number) => t >= from && t <= to;
  const provenance = {
    saved_from_route: args.route,
    data_provenance: args.route === '/study' ? 'study_snapshot' : 'live_mixed',
  } as const;
  const snapshot = {
    schema_version: 1 as const,
    code: args.code,
    label: args.label,
    timeframe: args.timeframe,
    snapshot_from_ms: from,
    snapshot_to_ms: to,
    bucket_kind: args.timeframe,
    viewport: args.viewport,
    indicator_state: args.indicatorState,
    provenance,
    bundle: {
      code: args.code,
      timeframe: args.timeframe,
      snapshot_from_ms: from,
      snapshot_to_ms: to,
      segments: args.bundle.segments.filter((s) => s.session_close_ms >= from && s.session_open_ms <= to),
      candles: candles.map((c) => ({
        t: c.ts_ms,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.vol_a + c.vol_b,
      })),
      quote_totals: args.bundle.quote_ratio.points
        .filter((p) => within(p.t))
        .map((p) => ({ t: p.t, bid_total: p.bid_total, ask_total: p.ask_total, visible: true })),
      ratio: args.bundle.quote_ratio.points
        .filter((p) => within(p.t))
        .map((p) => {
          const total = p.bid_total + p.ask_total;
          return { t: p.t, value: total === 0 ? 0 : (p.bid_total - p.ask_total) / total, visible: true };
        }),
      fill_strength: args.bundle.fill_strength.points
        .filter((p) => within(p.t))
        .map((p) => ({ t: p.t, buy_qty: p.buy_qty, sell_qty: p.sell_qty, visible: true })),
      data_warnings: args.bundle.data_warnings ?? [],
    },
    captured_at_ms: Date.now(),
  };
  return {
    name: args.name,
    code: args.code,
    label: args.label,
    timeframe: args.timeframe,
    snapshot_from_ms: from,
    snapshot_to_ms: to,
    viewport: args.viewport,
    indicator_state: args.indicatorState,
    snapshot,
    provenance,
    memo: args.memo ?? '',
    tags: [],
  };
}
```

- [ ] **Step 3: Add live chart capture seam**

In `frontend/src/live/LiveChartRoot.tsx`, add a prop:

```ts
onViewportCaptureReady?: (capture: () => TabViewport | null) => void;
```

Add an effect near `registerViewportCapture`:

```ts
useEffect(() => {
  onViewportCaptureReady?.(captureViewport);
  return () => onViewportCaptureReady?.(() => null);
}, [captureViewport, onViewportCaptureReady]);
```

Thread the prop through `LiveWorkarea` so `LivePage` can keep the current capture function in a ref for save actions.

- [ ] **Step 4: Run capture tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/useStudySnapshotCapture.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/studyViews/useStudySnapshotCapture.ts frontend/src/studyViews/useStudySnapshotCapture.test.ts frontend/src/live/LivePage.tsx frontend/src/live/LiveWorkarea.tsx frontend/src/live/LiveChartRoot.tsx
git commit -m "feat: build study view snapshots from chart state"
```

---

### Task 9: Save, Overwrite, Delete UI

**Files:**
- Modify: `frontend/src/studyViews/StudyViewsDrawer.tsx`
- Create: `frontend/src/studyViews/StudyViewSaveDialog.tsx`
- Create: `frontend/src/studyViews/StudyViewSaveDialog.test.tsx`
- Modify: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`
- Modify: `frontend/src/studyViews/StudyPage.tsx`

- [ ] **Step 1: Add failing UI tests**

Create `frontend/src/studyViews/StudyViewSaveDialog.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StudyViewSaveDialog } from './StudyViewSaveDialog';

it('shows snapshot summary and submits edited name and memo', async () => {
  const onSubmit = vi.fn();
  render(
    <StudyViewSaveDialog
      mode="create"
      defaultName="삼성전자 5분봉 2026.06.16"
      defaultMemo=""
      barCount={220}
      sizeBytes={12000}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  expect(screen.getByText(/220개 봉/)).toBeTruthy();
  await userEvent.clear(screen.getByLabelText('이름'));
  await userEvent.type(screen.getByLabelText('이름'), '내 저장뷰');
  await userEvent.type(screen.getByLabelText('메모'), '중요');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(onSubmit).toHaveBeenCalledWith({ name: '내 저장뷰', memo: '중요' });
});

it('requires confirmation wording for overwrite mode', async () => {
  const onSubmit = vi.fn();
  render(
    <StudyViewSaveDialog
      mode="overwrite"
      defaultName="기존"
      defaultMemo=""
      barCount={200}
      sizeBytes={1}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  expect(screen.getByText(/덮어쓰기/)).toBeTruthy();
});
```

- [ ] **Step 2: Implement save dialog**

Create `frontend/src/studyViews/StudyViewSaveDialog.tsx`:

```tsx
import { useState } from 'react';

export function StudyViewSaveDialog({
  mode,
  defaultName,
  defaultMemo,
  barCount,
  sizeBytes,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'overwrite';
  defaultName: string;
  defaultMemo: string;
  barCount: number;
  sizeBytes: number;
  onCancel: () => void;
  onSubmit: (v: { name: string; memo: string }) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [memo, setMemo] = useState(defaultMemo);
  const valid = name.trim().length > 0;
  return (
    <div role="dialog" aria-modal="true" aria-label={mode === 'overwrite' ? '저장뷰 덮어쓰기' : '저장뷰 만들기'} className="fixed inset-0 z-50 grid place-items-center bg-black/40">
      <form
        className="w-[360px] bg-bg border rounded p-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit({ name: name.trim(), memo });
        }}
      >
        <h2 className="text-sm font-semibold">{mode === 'overwrite' ? '덮어쓰기' : '저장 뷰 만들기'}</h2>
        <p className="text-xs text-fg-dim">{barCount}개 봉 · 약 {Math.ceil(sizeBytes / 1024)}KB</p>
        <label className="block text-xs">
          이름
          <input aria-label="이름" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full border rounded bg-bg-input px-2 py-1" />
        </label>
        <label className="block text-xs">
          메모
          <textarea aria-label="메모" value={memo} onChange={(e) => setMemo(e.target.value)} className="mt-1 w-full border rounded bg-bg-input px-2 py-1" />
        </label>
        <p className="text-xs text-fg-dim">저장 학습뷰는 현재 화면의 계산된 차트 데이터를 스냅샷으로 저장합니다.</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1 border rounded">취소</button>
          <button type="submit" disabled={!valid} className="px-3 py-1 border rounded bg-accent text-white">저장</button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Wire create/update/delete actions**

In `StudyViewsDrawer`, connect:
- `현재 뷰 저장` opens `StudyViewSaveDialog` in `create` mode.
- `/study?view=<id>` primary action opens `overwrite` mode.
- `새 저장본 만들기` opens `create` mode using current rendered study snapshot.
- Delete button opens a `role="dialog"` confirmation and calls `mutations.remove.mutate(id)`.
- On create from `/study`, navigate to `/study?view=${created.id}` in mutation success handling.

Use this action pattern:

```tsx
const mutations = useStudyViewMutations();
const [dialog, setDialog] = useState<null | { mode: 'create' | 'overwrite'; id?: string }>(null);
const [deleteTarget, setDeleteTarget] = useState<ParquetStudyView | null>(null);
```

On delete confirmation:

```tsx
<button type="button" onClick={() => deleteTarget && mutations.remove.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) })}>
  삭제
</button>
```

- [ ] **Step 4: Run UI tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyViewSaveDialog.test.tsx src/studyViews/StudyViewsDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/studyViews/StudyViewsDrawer.tsx frontend/src/studyViews/StudyViewSaveDialog.tsx frontend/src/studyViews/StudyViewSaveDialog.test.tsx frontend/src/studyViews/StudyViewsDrawer.test.tsx frontend/src/studyViews/StudyPage.tsx
git commit -m "feat: add study view save controls"
```

---

### Task 10: Final Verification and Guardrails

**Files:**
- Modify tests only if a legitimate mismatch is found.
- Modify docs only if implementation intentionally narrows the spec.

- [ ] **Step 1: Run backend study tests**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: PASS.

- [ ] **Step 2: Run focused frontend tests**

Run:

```bash
cd frontend && npx vitest run src/api/studyViews.test.ts src/studyViews src/rightrail/RightRail.test.tsx src/live/paneSpecsForTimeframe.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: TypeScript build and Vite build complete without errors.

- [ ] **Step 4: Run backend suite slice**

Run:

```bash
pytest tests/api/test_screener_saves.py tests/api/test_study_views.py -q
```

Expected: PASS. This verifies the new persistence module did not drift from saved screener semantics.

- [ ] **Step 5: Manual browser smoke**

Run:

```bash
cd frontend && npm run dev -- --host 127.0.0.1
```

Open the local Vite URL. Verify:
- Right Rail shows `관심`, `스크리너`, `저장뷰`.
- `/study` without query shows `저장뷰를 선택하세요`.
- Clicking a saved row navigates to `/study?view=<id>` with browser history push behavior.
- Network tab shows `/study?view=<id>` calls `/api/study-views/saves/<id>/snapshot` and does not call `/api/range`, `/api/live/past-candles`, or `/api/live/past-daily-candles`.

- [ ] **Step 6: Commit final fixes**

```bash
git status --short
git add <only files changed for this feature>
git commit -m "test: verify study view snapshot workflow"
```

---

## Self-Review

Spec coverage:
- Backend manifest/snapshot persistence: Tasks 1-3.
- CRUD API and missing-id behavior: Task 3.
- Right Rail third item and saved-view drawer: Task 5.
- Search by name/code/memo, whitespace-insensitive: Task 5.
- Snapshot window minimum 200 bars: Task 6.
- Snapshot restore without `/api/range`, KIS, or SSE: Task 7 and Task 10.
- D/W/M study hoga panes: Task 6 and Task 7.
- Save/overwrite/delete dialogs: Task 9.
- Query invalidation: Task 4 and Task 9.

Known implementation cautions:
- `studySnapshotBundleToRangeBundle` uses a minimal `RangeBundle` adapter. If TypeScript reveals required `RangeBundle` fields omitted by the snippet, add the fields with inert empty values in Task 6 and pin them in `studySnapshotAdapter.test.ts`.
- Display-locked Auction Mask and Ratio Outlier Mask are represented by saved visible/value fields. If current projectors only expose pre-display raw points, add a small projector helper before Task 8 so saved points match what the chart rendered.
- The plan uses a manual `BookmarkIcon` because the repo currently uses app-local SVG icons, not lucide. If lucide is later added before execution, replace only that icon implementation.

Placeholder scan:
- No task uses undefined "later" work as acceptance criteria. Every implementation step gives file paths, code shape, and commands.

Type consistency:
- Backend `ParquetStudySnapshot`, `StudySnapshotBundle`, and `ParquetStudyViewWriteRequest` names match frontend `api/studyViews.ts`.
- `StudyViewport` field names match the existing `TabViewport` wire names.
- `forceHogaPanes` is the same prop name in `paneSpecsForTimeframe`, `LiveChartRoot`, and `StudyPage`.
