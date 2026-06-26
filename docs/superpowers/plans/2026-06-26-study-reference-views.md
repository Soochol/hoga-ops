# Study Reference Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert new `/study` saves into **복기뷰 (Reference Study View)** entries that store a saved code/timeframe/period/viewport and reload that period with the current `/live` indicator settings.

**Architecture:** Introduce a v2 study-view contract that stores metadata plus a replay data range (`from_date`, `to_date`, `from_ms`, `to_ms`) and stops persisting `indicator_state` and `snapshot` as the source of truth for new saves. The data range is the padded fetch window chosen by `visibleWindow`, while `viewport` restores the exact zoom/scroll position. `/study` will fetch range/candle data from existing APIs, build a `RangeBundle`, and pass it to `LiveChartRoot` without pane override props so live-page indicator toggles remain canonical. Keep legacy **스냅샷 학습뷰** loading as a read-only compatibility path; detail-sidebar parity and legacy cleanup are Phase 2.

**Tech Stack:** FastAPI + Pydantic v2 + pytest; React 18 + TypeScript + TanStack Query + Zustand + Vitest + Testing Library. No new dependencies.

## Global Constraints

- Product model: saved study views are "학습/복기할 구간을 저장해 두고 현재 도구로 다시 분석".
- Canonical terms: **저장 학습뷰** is the umbrella; **복기뷰 (Reference Study View)** is v2; **스냅샷 학습뷰 (Legacy Parquet Study Snapshot)** is v1.
- `/live` indicator settings in `useLivePageStore` remain the single source of truth for study chart pane visibility and indicator styles.
- Current global source preference remains the source selector for v2 `/study` reloads; v2 saves do not persist `source_policy` or segment source choices.
- `range` means the padded data fetch window; `viewport` means the exact restored visible window.
- `/study` must not subscribe to live SSE.
- `/study` may call `/api/range`, `/api/live/past-candles`, and `/api/live/past-daily-candles` in Phase 1. Cursor detail endpoints are Phase 2.
- Existing `/api/study-views/saves` list, create, update, metadata update, delete route names remain stable.
- Legacy v1 snapshot saves should continue to open during the transition, but new saves must be v2 reference saves.
- Avoid changing `/api/range` behavior unless study cannot fetch the saved range through the existing query shape.
- Existing `/live` chart behavior and tabs must not regress.

---

## Plan-Eng Grilling Decisions

- **D1 Scope:** Use a two-phase migration. Phase 1 ships the core user outcome: new saves are v2 **복기뷰** references, `/study` reloads the saved period, and live indicator settings drive chart rendering. Phase 2 handles cursor detail sidebar parity, migration/cleanup of v1 snapshot code, and any richer source-policy UX.
- **D2 Terminology:** Keep **저장 학습뷰** as the umbrella term because the Right Rail UI and existing user language already use 저장뷰. Use **복기뷰 (Reference Study View)** for v2 and **스냅샷 학습뷰 (Legacy Parquet Study Snapshot)** for v1 to avoid saying "snapshot" when new saves do not store chart data.
- **D3 Detail Sidebar:** Phase 1 must not fabricate v2 detail data by passing empty dense bucket maps to `StudyDetailPanel`. For v2, render the chart and memo path; show a deliberately limited reference detail area or hide cursor cards until Phase 2 adds on-demand `/api/orderbook` and `/api/brokers/series` queries.
- **D4 Data Hook Boundary:** Do not reuse `useLiveBundle` directly. It owns live-specific SSE, today-promotion seam, and left-pan extension state. Build a small `useStudyReferenceBundle` from `useRange`, study-scoped past-candle query wrappers, and `buildChartBundle`.
- **D4a Query Freshness:** Do not call `useLivePastCandles` or `useLivePastDailyCandles` directly from `/study`. Those hooks intentionally refetch for live venue behavior. V2 `/study` should reuse the same HTTP endpoints through study-specific wrappers with `staleTime: Infinity` and `refetchInterval: false`.
- **D5 Source Policy:** Do not persist source policy in v2. `/study` reference reloads follow the current global source preference, matching the "current tools" mental model.
- **D6 Range Semantics:** Store the padded data range selected by `visibleWindow`, not only the exact visible bars. The viewport remains exact; the range gives `/study` enough surrounding data for immediate pan/zoom and indicator warmup.
- **D7 Range Validation:** Store both `from_date/to_date` and `from_ms/to_ms`, and validate that the Unix-ms values fall inside the KST date bounds. The dates are needed for existing API calls; the ms values are needed to trim the padded restored range precisely.
- **D8 ADR:** Update ADR-0077 in Phase 1 rather than creating a new ADR. This is a real semantic reversal inside the same route: `/study` used to mean fixed snapshot restore, while v2 means saved-period reanalysis.

## Phase Boundary

```text
Phase 1: Reference chart restore

Right Rail Save
  -> StudyViewReferenceWriteRequest
  -> saves.json row, no snapshot JSON
  -> /study?view=id
  -> useStudyReferenceBundle
  -> LiveChartRoot without indicator overrides
  -> current /live indicator settings apply

Phase 2: Detail parity and cleanup

Cursor in /study
  -> derive active Stock-Date + cursor bucket
  -> GET /api/orderbook and /api/brokers/series on demand
  -> detail cards return without storing dense buckets
  -> legacy snapshot branch can be migrated or retired
```

## Current Code Map

- `hoga/api/models.py`
  - Current `ParquetStudyView`, `ParquetStudyViewWriteRequest`, and `ParquetStudySnapshot` live here.
  - Current models duplicate `snapshot_from_ms`, `snapshot_to_ms`, `viewport`, `indicator_state`, `provenance`, and `snapshot_path`.
- `hoga/api/study_views.py`
  - Writes a snapshot JSON under `data_dir/study_views/snapshots/{id}.json`.
  - Uses `prepare_restorable_snapshot()` to enrich detail buckets at save time.
- `hoga/api/study_view_routes.py`
  - Exposes `/api/study-views/saves` and `/api/study-views/saves/{id}/snapshot`.
- `frontend/src/api/studyViews.ts`
  - Mirrors the v1 backend contract and exposes `getStudyViewSnapshot`.
- `frontend/src/studyViews/studySaveRequest.ts`
  - Computes visible candle window and currently builds a full `ParquetStudyViewWriteRequest` via `buildStudySnapshotRequest`.
- `frontend/src/studyViews/useStudySnapshotCapture.ts`
  - Freezes candles, hoga series, program trade, peaks, volume distributions, and indicator state into a snapshot.
- `frontend/src/studyViews/StudyPage.tsx`
  - Fetches snapshot and renders `LiveChartRoot` with `paneTogglesOverride`, `dailyMovingAverageOverride`, and `tradeVolumePocOverride`.
- `frontend/src/studyViews/studySnapshotAdapter.ts`
  - Converts v1 snapshot JSON into a render model.
- `frontend/src/live/useLiveBundle.ts`
  - Live-only orchestration; do not reuse directly because it includes SSE and today seam logic.
- `frontend/src/api/range.ts`, `frontend/src/api/livePastCandles.ts`, `frontend/src/api/livePastDailyCandles.ts`
  - Reusable data-fetching pieces for study reference rendering.
- `frontend/src/api/livePastCandles.ts`, `frontend/src/api/livePastDailyCandles.ts`
  - Do not consume the exported hooks directly in `/study`; they use `liveVenueRefetchInterval(venue)` and `staleTime: 60_000`.
  - Reuse their response types and API endpoint shape through study-specific wrappers.
- `docs/adr/0077-parquet-study-views-separate-route.md`
  - Must be revised or superseded because it currently says `/study` must render fixed snapshots and must not refetch parquet/KIS data.

## Target Data Model

Backend wire shape for new saves:

```python
class StudyViewRange(BaseModel):
    from_date: str = Field(pattern=r"^\d{8}$")
    to_date: str = Field(pattern=r"^\d{8}$")
    from_ms: int
    to_ms: int

    @model_validator(mode="after")
    def _valid_range(self):
        if self.from_date > self.to_date:
            raise ValueError("from_date must be <= to_date")
        if self.from_ms > self.to_ms:
            raise ValueError("from_ms must be <= to_ms")
        from_ms_date = datetime.fromtimestamp(self.from_ms / 1000, tz=ZoneInfo("Asia/Seoul")).strftime("%Y%m%d")
        to_ms_date = datetime.fromtimestamp(self.to_ms / 1000, tz=ZoneInfo("Asia/Seoul")).strftime("%Y%m%d")
        if not (self.from_date <= from_ms_date <= self.to_date):
            raise ValueError("from_ms must fall within from_date/to_date")
        if not (self.from_date <= to_ms_date <= self.to_date):
            raise ValueError("to_ms must fall within from_date/to_date")
        return self

class StudyViewReference(BaseModel):
    schema_version: Literal[2] = 2
    id: str
    name: str
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    range: StudyViewRange
    viewport: StudyViewport
    memo: str = ""
    tags: list[str] = Field(default_factory=list)
    created_at_ms: int
    updated_at_ms: int
```

Frontend mirror:

```ts
export type StudyViewRange = {
  /** Padded data fetch window, not the exact visible viewport. */
  from_date: string;
  to_date: string;
  from_ms: number;
  to_ms: number;
};

export type StudyViewReference = {
  schema_version: 2;
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  range: StudyViewRange;
  viewport: StudyViewport;
  memo: string;
  tags: string[];
  created_at_ms: number;
  updated_at_ms: number;
};

export type StudyViewWriteRequest = {
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  range: StudyViewRange;
  viewport: StudyViewport;
  memo?: string;
  tags?: string[];
};
```

Compatibility choice:

```ts
export type StudyViewListRow = StudyViewReference | ParquetStudyView;
```

During implementation, add `schema_version: 1` to legacy `ParquetStudyView` rows and use `schema_version === 2` to route to the new reference flow. Legacy v1 rows can continue to use `getStudyViewSnapshot` and `studySnapshotRenderModel` until a later cleanup.

## Task 1: Backend v2 Reference Contract

**Files:**
- Modify: `hoga/api/models.py`
- Modify: `tests/api/test_study_views.py`

**Interfaces:**
- Produces: `StudyViewRange`
- Produces: `StudyViewReference`
- Produces: `StudyViewReferenceWriteRequest`
- Produces: `StudyViewListRow = Annotated[Union[ParquetStudyView, StudyViewReference], Field(discriminator="schema_version")]`
- Keeps: `ParquetStudyView`, `ParquetStudyViewWriteRequest`, and `ParquetStudySnapshot` for legacy reads.

- [ ] **Step 1: Write failing model tests**

Append to `tests/api/test_study_views.py`:

```python
from hoga.api.models import StudyViewReference, StudyViewReferenceWriteRequest


def _ref_req(**overrides):
    from_ms = hhmmssms_to_unix_ms("20260616", 90_000_000)
    to_ms = hhmmssms_to_unix_ms("20260618", 153_000_000)
    base = {
        "name": "삼성전자 복기",
        "code": "005930",
        "label": "삼성전자",
        "timeframe": "5m",
        "range": {
            "from_date": "20260616",
            "to_date": "20260618",
            "from_ms": from_ms,
            "to_ms": to_ms,
        },
        "viewport": {"right_edge_ms": to_ms, "bar_span": 200, "at_live_edge": False},
        "memo": "돌파 복기",
        "tags": ["breakout"],
    }
    base.update(overrides)
    return base


def test_study_view_reference_write_request_trims_name_and_defaults():
    req = StudyViewReferenceWriteRequest.model_validate(_ref_req(name="  내 복기  ", memo=None, tags=None))
    assert req.name == "내 복기"
    assert req.memo == ""
    assert req.tags == []
    assert req.range.from_date == "20260616"


@pytest.mark.parametrize(
    "patch",
    [
        {"name": "   "},
        {"code": "bad"},
        {"range": {"from_date": "20260619", "to_date": "20260618", "from_ms": hhmmssms_to_unix_ms("20260618", 90_000_000), "to_ms": hhmmssms_to_unix_ms("20260618", 153_000_000)}},
        {"range": {"from_date": "20260616", "to_date": "20260618", "from_ms": hhmmssms_to_unix_ms("20260618", 153_000_000), "to_ms": hhmmssms_to_unix_ms("20260616", 90_000_000)}},
        {"range": {"from_date": "20260616", "to_date": "20260618", "from_ms": 0, "to_ms": hhmmssms_to_unix_ms("20260618", 153_000_000)}},
    ],
)
def test_study_view_reference_write_request_rejects_invalid_values(patch):
    raw = _ref_req()
    raw.update(patch)
    with pytest.raises(ValidationError):
        StudyViewReferenceWriteRequest.model_validate(raw)


def test_study_view_reference_manifest_shape():
    row = StudyViewReference.model_validate({
        **_ref_req(),
        "schema_version": 2,
        "id": "view1",
        "created_at_ms": 10,
        "updated_at_ms": 20,
    })
    assert row.schema_version == 2
    assert row.range.to_date == "20260618"
    assert row.memo == "돌파 복기"
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
pytest tests/api/test_study_views.py -q
```

Expected: FAIL because the v2 model classes do not exist.

- [ ] **Step 3: Implement v2 models**

Add near the existing study models in `hoga/api/models.py`:

```python
from datetime import datetime
from zoneinfo import ZoneInfo


class StudyViewRange(BaseModel):
    from_date: str = Field(pattern=r"^\d{8}$")
    to_date: str = Field(pattern=r"^\d{8}$")
    from_ms: int
    to_ms: int

    @field_validator("from_ms", "to_ms")
    @classmethod
    def _finite_ms(cls, v: int):
        return _ensure_finite(v)

    @model_validator(mode="after")
    def _valid_range(self):
        if self.from_date > self.to_date:
            raise ValueError("from_date must be <= to_date")
        if self.from_ms > self.to_ms:
            raise ValueError("from_ms must be <= to_ms")
        return self


class StudyViewReferenceWriteRequest(BaseModel):
    name: str
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    range: StudyViewRange
    viewport: StudyViewport
    memo: str = ""
    tags: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _trim_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v

    @field_validator("memo", mode="before")
    @classmethod
    def _default_memo(cls, v: object) -> object:
        return "" if v is None else v

    @field_validator("tags", mode="before")
    @classmethod
    def _default_tags(cls, v: object) -> object:
        return [] if v is None else v


class StudyViewReference(BaseModel):
    schema_version: Literal[2] = 2
    id: str
    name: str
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    range: StudyViewRange
    viewport: StudyViewport
    memo: str = ""
    tags: list[str] = Field(default_factory=list)
    created_at_ms: int
    updated_at_ms: int

    @field_validator("name")
    @classmethod
    def _trim_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v
```

Update `StudyViewsFile` to accept both v1 and v2 rows:

```python
class ParquetStudyView(BaseModel):
    schema_version: Literal[1] = 1
    ...

StudyViewRow = Annotated[
    Union[ParquetStudyView, StudyViewReference],
    Field(discriminator="schema_version"),
]

class StudyViewsFile(BaseModel):
    schema_version: int = 1
    saves: list[StudyViewRow] = Field(default_factory=list)
```

This adds one harmless response field to legacy rows and makes frontend routing explicit.

- [ ] **Step 4: Verify**

Run:

```bash
pytest tests/api/test_study_views.py::test_study_view_reference_write_request_trims_name_and_defaults tests/api/test_study_views.py::test_study_view_reference_write_request_rejects_invalid_values tests/api/test_study_views.py::test_study_view_reference_manifest_shape -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/api/test_study_views.py
git commit -m "feat: add study reference view contract"
```

## Task 2: Backend Persistence and Routes for New Saves

**Files:**
- Modify: `hoga/api/study_views.py`
- Modify: `hoga/api/study_view_routes.py`
- Modify: `tests/api/test_study_views.py`

**Interfaces:**
- Consumes: `StudyViewReferenceWriteRequest`
- Produces: `create_reference_save_sync(data_dir, req, id, now_ms) -> StudyViewReference`
- Produces: `update_reference_save_sync(data_dir, id, req, now_ms) -> StudyViewReference`
- Keeps legacy snapshot create/update only for callers still posting `snapshot`.

- [ ] **Step 1: Write failing route test**

Append:

```python
def test_study_view_reference_routes_crud(study_client):
    r = study_client.post("/api/study-views/saves", json=_ref_req())
    assert r.status_code == 201
    row = r.json()
    sid = row["id"]
    assert row["schema_version"] == 2
    assert row["range"]["from_date"] == "20260616"
    assert "indicator_state" not in row
    assert "snapshot_path" not in row

    listed = study_client.get("/api/study-views/saves").json()["saves"]
    assert listed[0]["id"] == sid
    assert listed[0]["schema_version"] == 2

    fetched = study_client.get(f"/api/study-views/saves/{sid}").json()
    assert fetched["range"]["to_date"] == "20260618"

    updated_body = _ref_req(name="수정", range={
        "from_date": "20260617",
        "to_date": "20260618",
        "from_ms": hhmmssms_to_unix_ms("20260617", 90_000_000),
        "to_ms": hhmmssms_to_unix_ms("20260618", 153_000_000),
    })
    r2 = study_client.put(f"/api/study-views/saves/{sid}", json=updated_body)
    assert r2.status_code == 200
    assert r2.json()["name"] == "수정"
    assert r2.json()["range"]["from_date"] == "20260617"

    snapshot_response = study_client.get(f"/api/study-views/saves/{sid}/snapshot")
    assert snapshot_response.status_code == 409
    assert snapshot_response.json()["code"] == "study_view_snapshot_not_applicable"


def test_study_view_reference_persistence_does_not_write_snapshot_file(tmp_path):
    row = sv.create_reference_save_sync(
        tmp_path,
        req=StudyViewReferenceWriteRequest.model_validate(_ref_req()),
        id="ref1",
        now_ms=10,
    )
    assert row.schema_version == 2
    assert not (tmp_path / "study_views" / "snapshots" / "ref1.json").exists()
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pytest tests/api/test_study_views.py::test_study_view_reference_routes_crud tests/api/test_study_views.py::test_study_view_reference_persistence_does_not_write_snapshot_file -q
```

Expected: FAIL because routes only accept `ParquetStudyViewWriteRequest`.

- [ ] **Step 3: Implement request dispatch**

In `hoga/api/study_views.py`, add:

```python
def _reference_from_req(
    *,
    req: StudyViewReferenceWriteRequest,
    id: str,
    created_at_ms: int,
    updated_at_ms: int,
) -> StudyViewReference:
    return StudyViewReference(
        id=id,
        name=req.name,
        code=req.code,
        label=req.label,
        timeframe=req.timeframe,
        range=req.range,
        viewport=req.viewport,
        memo=req.memo,
        tags=req.tags,
        created_at_ms=created_at_ms,
        updated_at_ms=updated_at_ms,
    )


def create_reference_save_sync(
    data_dir: Path, *, req: StudyViewReferenceWriteRequest, id: str, now_ms: int
) -> StudyViewReference:
    file = load_saves(data_dir)
    save = _reference_from_req(req=req, id=id, created_at_ms=now_ms, updated_at_ms=now_ms)
    file.saves.append(save)
    file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
    save_saves(data_dir, file)
    return save


def update_reference_save_sync(
    data_dir: Path, *, id: str, req: StudyViewReferenceWriteRequest, now_ms: int
) -> StudyViewReference:
    file = load_saves(data_dir)
    for idx, old in enumerate(file.saves):
        if old.id == id:
            save = _reference_from_req(
                req=req,
                id=id,
                created_at_ms=old.created_at_ms,
                updated_at_ms=now_ms,
            )
            file.saves[idx] = save
            file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
            save_saves(data_dir, file)
            with suppress(FileNotFoundError):
                _snapshot_path(data_dir, id).unlink()
            return save
    raise StudyViewNotFoundError(id)
```

Add async wrappers mirroring existing `create_save` and `update_save`.

In `hoga/api/study_view_routes.py`, import `StudyViewReferenceWriteRequest`, parse by payload shape instead of trial-and-error. New v2 saves do not send `snapshot`; legacy v1 saves do.

```python
from fastapi import Body


def _parse_write_request(raw: dict):
    if "snapshot" in raw:
        return ParquetStudyViewWriteRequest.model_validate(raw)
    return StudyViewReferenceWriteRequest.model_validate(raw)
```

Change route signatures:

```python
@router.post("/saves", status_code=201, response_model=StudyViewRow)
async def create_save(req_raw: dict = Body(...)):
    req = _parse_write_request(req_raw)
    now_ms = int(time.time() * 1000)
    if isinstance(req, StudyViewReferenceWriteRequest):
        return await study_views.create_reference_save(data_dir, req=req, id=uuid.uuid4().hex, now_ms=now_ms)
    return await study_views.create_save(data_dir, req=req, id=uuid.uuid4().hex, now_ms=now_ms)
```

Apply the same branch to `PUT /saves/{save_id}`.

For `GET /saves/{save_id}/snapshot`, if `get_save_sync()` returns a v2 reference row, return 409 with:

```python
{
    "code": "study_view_snapshot_not_applicable",
    "message": f"study view snapshot is not available for reference view: {save_id}",
}
```

- [ ] **Step 4: Verify routes**

Run:

```bash
pytest tests/api/test_study_views.py::test_study_view_reference_routes_crud tests/api/test_study_views.py::test_study_view_reference_persistence_does_not_write_snapshot_file tests/api/test_study_views.py::test_study_view_routes_crud -q
```

Expected: PASS; legacy CRUD still passes.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/study_views.py hoga/api/study_view_routes.py tests/api/test_study_views.py
git commit -m "feat: persist study views as range references"
```

## Task 3: Frontend API Types and Save Request Builder

**Files:**
- Modify: `frontend/src/api/studyViews.ts`
- Modify: `frontend/src/studyViews/studySaveRequest.ts`
- Modify: `frontend/src/studyViews/studySaveCommand.ts`
- Modify: `frontend/src/studyViews/LiveStudyViewSaveButton.tsx`
- Modify: `frontend/src/studyViews/StudyViewSaveDialog.tsx`
- Modify: `frontend/src/studyViews/StudyViewsDrawer.tsx`
- Modify: `frontend/src/studyViews/studyViewSelection.ts`
- Modify: `frontend/src/state/studyTabs.ts`
- Test: `frontend/src/studyViews/studySaveCommand.test.ts`
- Test: `frontend/src/studyViews/LiveStudyViewSaveButton.test.tsx`
- Test: `frontend/src/studyViews/StudyViewSaveDialog.test.tsx`
- Test: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`

**Interfaces:**
- Produces: `StudyViewReference`, `StudyViewWriteRequest`, `isReferenceStudyView(row)`
- Propagates: `StudyViewListRow` through drawer filtering, selection, and study tab state.
- Produces: `buildStudyReferenceSaveRequest(source: CurrentStudySaveSource): StudyViewWriteRequest | null`
- Stops new saves from calling `buildStudySnapshotRequest`.

- [ ] **Step 1: Write failing save-command test**

Add to `frontend/src/studyViews/studySaveCommand.test.ts`:

```ts
it('creates a range reference request from the current visible window', () => {
  const command = makeStudySaveCommand({
    mode: 'create',
    source: {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: {
        code: '005930',
        from_date: '20260616',
        to_date: '20260618',
        bucket_ms: 300_000,
        segments: [
          { date: '20260616', session_open_ms: 1_000, session_close_ms: 1_900 },
          { date: '20260618', session_open_ms: 2_000, session_close_ms: 3_000 },
        ],
        candles: [
          { ts_ms: 1_000, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0 },
          { ts_ms: 2_000, open: 2, high: 2, low: 2, close: 2, vol_a: 1, vol_b: 0 },
          { ts_ms: 3_000, open: 3, high: 3, low: 3, close: 3, vol_a: 1, vol_b: 0 },
        ],
        quote_ratio: { bucket_ms: 300_000, points: [] },
        fill_strength: { bucket_ms: 300_000, points: [] },
      } as never,
      indicatorState: indicatorState,
      captureViewport: () => ({ rightEdgeMs: 3_000, barSpan: 2, atLiveEdge: false }),
    },
    existingSave: null,
  });

  expect(command?.request).toMatchObject({
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    range: {
      from_date: '20260616',
      to_date: '20260618',
      from_ms: 1_000,
      to_ms: 3_000,
    },
    viewport: { right_edge_ms: 3_000, bar_span: 2, at_live_edge: false },
  });
  expect('snapshot' in command!.request).toBe(false);
  expect('indicator_state' in command!.request).toBe(false);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cd frontend && npx vitest run src/studyViews/studySaveCommand.test.ts
```

Expected: FAIL because requests still include `snapshot` and `indicator_state`.

- [ ] **Step 3: Update frontend API contract**

In `frontend/src/api/studyViews.ts`, add:

```ts
export type StudyViewRange = {
  from_date: string;
  to_date: string;
  from_ms: number;
  to_ms: number;
};

export type StudyViewReference = {
  schema_version: 2;
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  range: StudyViewRange;
  viewport: StudyViewport;
  memo: string;
  tags: string[];
  created_at_ms: number;
  updated_at_ms: number;
};

export type StudyViewListRow = ParquetStudyView | StudyViewReference;
export type StudyViewsFile = { schema_version: number; saves: StudyViewListRow[] };

export type StudyViewWriteRequest = {
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  range: StudyViewRange;
  viewport: StudyViewport;
  memo?: string;
  tags?: string[];
};

export function isReferenceStudyView(row: StudyViewListRow): row is StudyViewReference {
  return (row as StudyViewReference).schema_version === 2;
}
```

Change `createStudyView` and `updateStudyView` to accept `StudyViewWriteRequest | ParquetStudyViewWriteRequest` during transition.

Also update list-row consumers so they do not assume every row has `snapshot_*`, `indicator_state`, or `provenance`:

- `StudyViewsDrawer.tsx`: filtering, date grouping, item subtitles, overwrite dialog opening.
- `studyViewSelection.ts`: selected id helpers should accept `StudyViewListRow`.
- `state/studyTabs.ts`: tab payload should store row identity plus title/code/timeframe fields that exist on both versions.
- Associated tests should include one v1 row and one v2 row in the same `saves` array.

- [ ] **Step 4: Build a reference request instead of snapshot request**

In `frontend/src/studyViews/studySaveRequest.ts`, add:

```ts
import { realMsToYyyymmdd } from '../live/liveDateTime';
import type { StudyViewWriteRequest } from '../api/studyViews';

function rangeForWindow(bundle: RangeBundle, fromIndex: number, toIndex: number) {
  const fromCandle = bundle.candles[Math.max(0, fromIndex)];
  const toCandle = bundle.candles[Math.max(0, toIndex)];
  if (!fromCandle || !toCandle) return null;
  return {
    from_date: realMsToYyyymmdd(fromCandle.ts_ms),
    to_date: realMsToYyyymmdd(toCandle.ts_ms),
    from_ms: fromCandle.ts_ms,
    to_ms: toCandle.ts_ms,
  };
}

export function buildStudyReferenceSaveRequest(
  source: LiveStudySaveSource,
): StudyViewWriteRequest | null {
  const viewport = viewportFromCapture(source.captureViewport, fallbackViewport(source.bundle));
  if (!viewport) return null;
  const window = visibleWindow(source.bundle, viewport);
  const range = rangeForWindow(source.bundle, window.fromIndex, window.toIndex);
  if (!range) return null;
  return {
    name: defaultStudyViewName(undefined, source.label, source.timeframe),
    code: source.code,
    label: source.label,
    timeframe: source.timeframe,
    range,
    viewport,
    memo: '',
    tags: [],
  };
}
```

Update `studySaveCommand.ts` to use `buildStudyReferenceSaveRequest()` for both `/live` and `/study` sources. For a `/study` source, preserve `source.snapshot` legacy only as a fallback until `CurrentStudySaveSource` is changed in Task 5.

- [ ] **Step 5: Update save dialog byte-size text**

In `LiveStudyViewSaveButton.tsx`, replace snapshot-specific size copy with range count copy:

```tsx
<StudyViewSaveDialog
  mode="create"
  defaultName={command.defaultName}
  defaultMemo={command.defaultMemo}
  rangeLabel={'range' in command.request ? `${command.request.range.from_date} ~ ${command.request.range.to_date}` : undefined}
  barCount={'snapshot' in command.request ? command.request.snapshot.bundle.candles.length : undefined}
  sizeBytes={'snapshot' in command.request ? studySnapshotByteSize(command.request.snapshot) : undefined}
  isSubmitting={mutations.create.isPending}
  errorMessage={createError}
  onCancel={() => setCommand(null)}
  onSubmit={handleSubmit}
/>
```

Make `StudyViewSaveDialog` props `barCount?: number`, `sizeBytes?: number`, and `rangeLabel?: string`. For v2, render copy equivalent to "기간 참조" and the saved date range; do not render snapshot byte size or "현재 화면의 계산된 차트 데이터를 스냅샷으로 저장" wording.

- [ ] **Step 6: Verify frontend save tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/studySaveCommand.test.ts src/studyViews/LiveStudyViewSaveButton.test.tsx src/api/studyViews.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/studyViews.ts frontend/src/studyViews/studySaveRequest.ts frontend/src/studyViews/studySaveCommand.ts frontend/src/studyViews/LiveStudyViewSaveButton.tsx frontend/src/studyViews/StudyViewSaveDialog.tsx frontend/src/studyViews/StudyViewsDrawer.tsx frontend/src/studyViews/studyViewSelection.ts frontend/src/state/studyTabs.ts frontend/src/studyViews/*.test.ts*
git commit -m "feat: save study views as range references"
```

## Task 4: Study Reference Data Hook

**Files:**
- Create: `frontend/src/api/studyPastCandles.ts`
- Create: `frontend/src/studyViews/useStudyReferenceBundle.ts`
- Test: `frontend/src/api/studyPastCandles.test.tsx`
- Test: `frontend/src/studyViews/useStudyReferenceBundle.test.tsx`

**Interfaces:**
- Consumes: `StudyViewReference`
- Consumes: `useRange`, `useStudyPastCandles`, `useStudyPastDailyCandles`
- Produces: `useStudyReferenceBundle(save: StudyViewReference | null): { bundle: RangeBundle | null; chartBundle: RangeBundle | null; isLoading: boolean; error: unknown; pastDataWarnings: LiveDataWarning[] }`
- Guarantees: study past-candle queries have `staleTime: Infinity` and `refetchInterval: false`.

- [ ] **Step 1: Write failing study past-candle wrapper tests**

Create `frontend/src/api/studyPastCandles.test.tsx`:

```ts
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useStudyPastCandles, useStudyPastDailyCandles } from './studyPastCandles';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('study past-candle queries', () => {
  it('use static study freshness instead of live venue refetching', () => {
    const minute = renderHook(() => useStudyPastCandles('005930', '20260616', '20260618', 'KRX'), { wrapper });
    const daily = renderHook(() => useStudyPastDailyCandles('005930', '20260616', '20260618', 'KRX'), { wrapper });

    expect(minute.result.current).toBeDefined();
    expect(daily.result.current).toBeDefined();
    // Assert through exported helper if available, or by spying on useQuery options in local test style.
  });
});
```

Use the existing `frontend/src/api/livePastCandles.test.tsx` style to assert the actual `useQuery` options. Required assertions: `staleTime === Infinity` and `refetchInterval === false` for both minute and daily wrappers.

- [ ] **Step 2: Implement study past-candle wrappers**

Create `frontend/src/api/studyPastCandles.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type {
  LivePastCandlesResponse,
  LivePastCandlesWarning,
} from './livePastCandles';
import type {
  LivePastDailyCandlesResponse,
  LivePastDailyCandlesWarning,
} from './livePastDailyCandles';
import type { LiveVenueOption } from '../state/liveVenue';

export type { LivePastCandlesWarning, LivePastDailyCandlesWarning };

export function useStudyPastCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['study', 'past-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: Infinity,
    refetchInterval: false,
    placeholderData: (prev) => (prev && prev.code === code && (prev.venue ?? 'KRX') === venue ? prev : undefined),
  });
}

export function useStudyPastDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['study', 'past-daily-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastDailyCandlesResponse>(
        `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: Infinity,
    refetchInterval: false,
    placeholderData: (prev) => (prev && prev.code === code && (prev.venue ?? 'KRX') === venue ? prev : undefined),
  });
}
```

- [ ] **Step 3: Write failing hook tests**

Create `frontend/src/studyViews/useStudyReferenceBundle.test.tsx`:

```ts
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { useStudyReferenceBundle } from './useStudyReferenceBundle';

const useRangeMock = vi.fn();
const useStudyPastCandlesMock = vi.fn();
const useStudyPastDailyCandlesMock = vi.fn();

vi.mock('../api/range', () => ({ useRange: (...args: unknown[]) => useRangeMock(...args) }));
vi.mock('../api/studyPastCandles', () => ({
  useStudyPastCandles: (...args: unknown[]) => useStudyPastCandlesMock(...args),
  useStudyPastDailyCandles: (...args: unknown[]) => useStudyPastDailyCandlesMock(...args),
}));

const save: StudyViewReference = {
  schema_version: 2,
  id: 'view1',
  name: '복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 3_000 },
  viewport: { right_edge_ms: 3_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  useRangeMock.mockReset();
  useStudyPastCandlesMock.mockReset();
  useStudyPastDailyCandlesMock.mockReset();
  useRangeMock.mockReturnValue({ data: null, isLoading: false, error: null });
  useStudyPastCandlesMock.mockReturnValue({ data: { candles: [], data_warnings: [] }, isLoading: false, error: null });
  useStudyPastDailyCandlesMock.mockReturnValue({ data: { candles: [], data_warnings: [] }, isLoading: false, error: null });
});

describe('useStudyReferenceBundle', () => {
  it('fetches minute range and KIS candles for the saved reference range', () => {
    renderHook(() => useStudyReferenceBundle(save), { wrapper });
    expect(useRangeMock).toHaveBeenCalledWith(
      '005930',
      '20260616',
      '20260618',
      '5m',
      undefined,
      null,
      expect.any(Object),
    );
    expect(useStudyPastCandlesMock).toHaveBeenCalledWith('005930', '20260616', '20260618', expect.any(String));
    expect(useStudyPastDailyCandlesMock).toHaveBeenCalledWith(null, null, null, expect.any(String));
  });

  it('uses daily candle endpoint and disables /api/range on calendar frames', () => {
    renderHook(() => useStudyReferenceBundle({ ...save, timeframe: 'D' }), { wrapper });
    expect(useRangeMock).toHaveBeenCalledWith(null, null, null, null, undefined, null, expect.any(Object));
    expect(useStudyPastDailyCandlesMock).toHaveBeenCalledWith('005930', '20260616', '20260618', expect.any(String));
  });
});
```

- [ ] **Step 4: Run failing hook test**

Run:

```bash
cd frontend && npx vitest run src/studyViews/useStudyReferenceBundle.test.tsx
```

Expected: FAIL because the hook does not exist.

- [ ] **Step 5: Implement hook**

Create `frontend/src/studyViews/useStudyReferenceBundle.ts`:

```ts
import { useMemo } from 'react';
import { useRange } from '../api/range';
import {
  useStudyPastCandles,
  useStudyPastDailyCandles,
  type LivePastCandlesWarning,
  type LivePastDailyCandlesWarning,
} from '../api/studyPastCandles';
import type { RangeBundle, Candle } from '../api/types';
import { aggregateCalendar, aggregateCandles } from '../live/aggregateCandles';
import { buildChartBundle } from '../live/buildLiveBundle';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { TIMEFRAME_TO_MS, type Timeframe } from '../api/types';
import type { StudyViewReference } from '../api/studyViews';
import { useLiveVenueStore } from '../state/liveVenue';
import { liveVenueSessionBoundsMs, liveVenueUsesExtendedMinuteWindow } from '../live/liveVenuePolicy';
import { regularSessionCloseMs, regularSessionOpenMs } from '../live/liveDateTime';

function kisBarToCandle(c: { t_ms: number; open: number; high: number; low: number; close: number; volume: number }): Candle {
  return { ts_ms: c.t_ms, open: c.open, high: c.high, low: c.low, close: c.close, vol_a: c.volume, vol_b: 0 };
}

function emptyRangeBundle(code: string, bucketMs: number): RangeBundle {
  return {
    code,
    from_date: '',
    to_date: '',
    bucket_ms: bucketMs,
    segments: [],
    candles: [],
    quote_ratio: { bucket_ms: bucketMs, points: [] },
    fill_strength: { bucket_ms: bucketMs, points: [] },
    volume_profile_range: null,
    volume_profile_by_day: [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    trade_volume_pocs: [],
    volume_distributions: [],
    price_level_hits: [],
    excluded_dates: [],
    data_warnings: [],
  } as RangeBundle;
}

export function useStudyReferenceBundle(save: StudyViewReference | null) {
  const venue = useLiveVenueStore((s) => s.venue);
  const timeframe = save?.timeframe ?? null;
  const isMinute = timeframe ? isMinuteTimeframe(timeframe) : false;
  const bucketMs = timeframe && isMinute ? TIMEFRAME_TO_MS[timeframe as Timeframe] : 60_000;

  const past = useRange(
    save && isMinute ? save.code : null,
    save && isMinute ? save.range.from_date : null,
    save && isMinute ? save.range.to_date : null,
    save && isMinute ? (save.timeframe as Timeframe) : null,
    undefined,
    null,
    { volumeDistributionBins: null, tradeVolumePocBins: null, volumeDistributionPriceRange: null },
  );
  const minuteCandles = useStudyPastCandles(
    save && isMinute ? save.code : null,
    save && isMinute ? save.range.from_date : null,
    save && isMinute ? save.range.to_date : null,
    venue,
  );
  const dailyCandles = useStudyPastDailyCandles(
    save && !isMinute ? save.code : null,
    save && !isMinute ? save.range.from_date : null,
    save && !isMinute ? save.range.to_date : null,
    venue,
  );

  const kisCandles = useMemo<Candle[]>(() => {
    if (!save || !timeframe) return [];
    if (isMinute) {
      const raw = minuteCandles.data?.candles ?? [];
      return aggregateCandles(raw, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000).map(kisBarToCandle);
    }
    const raw = dailyCandles.data?.candles ?? [];
    const bars = timeframe === 'D' ? raw : aggregateCalendar(raw, timeframe as 'W' | 'M');
    return bars.map(kisBarToCandle);
  }, [dailyCandles.data, isMinute, minuteCandles.data, save, timeframe]);

  const chartBundle = useMemo<RangeBundle | null>(() => {
    if (!save) return null;
    if (!isMinute) {
      return {
        ...emptyRangeBundle(save.code, bucketMs),
        from_date: save.range.from_date,
        to_date: save.range.to_date,
        segments: [{
          date: save.range.from_date,
          session_open_ms: regularSessionOpenMs(save.range.from_date),
          session_close_ms: regularSessionCloseMs(save.range.to_date),
          source: 'kis_live',
        }],
        candles: kisCandles.filter((c) => c.ts_ms >= save.range.from_ms && c.ts_ms <= save.range.to_ms),
      };
    }
    const sessionForDate = liveVenueUsesExtendedMinuteWindow(venue)
      ? (yyyymmdd: string) => liveVenueSessionBoundsMs(yyyymmdd, venue)
      : undefined;
    return buildChartBundle({
      code: save.code,
      todayDate: save.range.to_date,
      todaySession: {
        open_ms: regularSessionOpenMs(save.range.to_date),
        close_ms: regularSessionCloseMs(save.range.to_date),
      },
      pastBundle: past.data ?? null,
      kisCandles: kisCandles.filter((c) => c.ts_ms >= save.range.from_ms && c.ts_ms <= save.range.to_ms),
      bucketMs,
      hasTodayObSignal: false,
      investorPoints: [],
      sessionBoundsForDate: sessionForDate,
    });
  }, [bucketMs, isMinute, kisCandles, past.data, save, venue]);

  const bundle = useMemo<RangeBundle | null>(() => {
    if (!chartBundle) return null;
    if (!isMinute || !past.data) return chartBundle;
    return {
      ...chartBundle,
      quote_ratio: past.data.quote_ratio,
      fill_strength: past.data.fill_strength,
      ask_peaks: past.data.ask_peaks,
      bid_peaks: past.data.bid_peaks ?? [],
      program_trade: past.data.program_trade,
      trade_volume_pocs: past.data.trade_volume_pocs ?? [],
      volume_distributions: past.data.volume_distributions ?? [],
    };
  }, [chartBundle, isMinute, past.data]);

  const warnings: Array<LivePastCandlesWarning | LivePastDailyCandlesWarning> = isMinute
    ? minuteCandles.data?.data_warnings ?? []
    : dailyCandles.data?.data_warnings ?? [];

  return {
    bundle,
    chartBundle,
    isLoading: past.isLoading || minuteCandles.isLoading || dailyCandles.isLoading,
    error: past.error ?? minuteCandles.error ?? dailyCandles.error ?? null,
    pastDataWarnings: warnings,
  };
}
```

Adjust imports/types to match the exact local exports; if `RangeBundle` optional fields differ, prefer copying defaults from existing test fixtures in `frontend/src/live/LiveChartRoot.test.tsx`.

- [ ] **Step 6: Verify hook tests**

Run:

```bash
cd frontend && npx vitest run src/api/studyPastCandles.test.tsx src/studyViews/useStudyReferenceBundle.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/studyPastCandles.ts frontend/src/api/studyPastCandles.test.tsx frontend/src/studyViews/useStudyReferenceBundle.ts frontend/src/studyViews/useStudyReferenceBundle.test.tsx
git commit -m "feat: load study reference ranges"
```

## Task 5: Switch StudyPage to Reference Rendering

**Files:**
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Modify: `frontend/src/studyViews/studySaveSource.ts`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: `isReferenceStudyView(row)`
- Consumes: `useStudyReferenceBundle(save)`
- Removes override props for reference saves.
- Keeps legacy v1 snapshot render branch.
- Keeps v2 detail sidebar intentionally limited in Phase 1; no fake dense detail maps.

- [ ] **Step 1: Write failing StudyPage test**

In `frontend/src/studyViews/StudyPage.test.tsx`, add a v2 save fixture and test:

```ts
it('renders a reference study view by fetching range data and using live indicator store settings', () => {
  const refSave = {
    schema_version: 2,
    id: 'view-ref',
    name: '복기',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 2_000 },
    viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
    memo: '',
    tags: [],
    created_at_ms: 1,
    updated_at_ms: 2,
  };
  useStudyViewsMock.mockReturnValue({ data: { schema_version: 1, saves: [refSave] }, isLoading: false });
  useStudyReferenceBundleMock.mockReturnValue({
    bundle: makeRangeBundle(),
    chartBundle: makeRangeBundle(),
    isLoading: false,
    error: null,
    pastDataWarnings: [],
  });

  renderAt('/study?view=view-ref');

  expect(useStudyReferenceBundleMock).toHaveBeenCalledWith(refSave);
  expect(useStudyViewSnapshotMock).not.toHaveBeenCalledWith('view-ref');
  const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
  expect(props.paneTogglesOverride).toBeUndefined();
  expect(props.dailyMovingAverageOverride).toBeUndefined();
  expect(props.tradeVolumePocOverride).toBeUndefined();
});
```

Mock `useStudyReferenceBundle` at the top of the test file.

- [ ] **Step 2: Run failing test**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx
```

Expected: FAIL because `StudyPage` only fetches snapshots.

- [ ] **Step 3: Implement reference branch**

In `StudyPage.tsx`:

```ts
const selectedSave = useMemo(
  () => savesQuery.data?.saves.find((row) => row.id === activeViewId) ?? null,
  [activeViewId, savesQuery.data?.saves],
);
const referenceSave = selectedSave && isReferenceStudyView(selectedSave) ? selectedSave : null;
const legacySnapshotId = selectedSave && !isReferenceStudyView(selectedSave) ? selectedSave.id : null;
const referenceQuery = useStudyReferenceBundle(referenceSave);
const snapshotQuery = useStudyViewSnapshot(legacySnapshotId);
```

For reference rows:

```tsx
<LiveChartRoot
  code={referenceSave.code}
  timeframe={referenceSave.timeframe}
  viewIdentity={activeTabId ? `${activeTabId}:${referenceSave.id}` : referenceSave.id}
  bundle={referenceQuery.bundle}
  chartBundle={referenceQuery.chartBundle}
  clampEngaged={false}
  isPastCandlesLoading={referenceQuery.isLoading}
  isExtending={false}
  pastDataWarnings={referenceQuery.pastDataWarnings}
  restoreViewport={{
    rightEdgeMs: referenceSave.viewport.right_edge_ms,
    barSpan: referenceSave.viewport.bar_span,
    atLiveEdge: referenceSave.viewport.at_live_edge,
  }}
  todayKst={referenceSave.range.to_date}
  onViewportCaptureReady={handleViewportCaptureReady}
  onCursorActiveChange={setIsCursorActive}
/>
```

Do not pass `paneTogglesOverride`, `dailyMovingAverageOverride`, or `tradeVolumePocOverride`.

For `setCurrentStudySaveSource`, change `StoredStudySaveSource` to support reference saves:

```ts
export type ReferenceStudySaveSource = {
  origin: 'study-reference';
  viewId: string;
  save: StudyViewReference;
  bundle: RangeBundle;
  captureViewport: () => TabViewport | null;
};
```

Update `studySaveCommand.ts` so `origin === 'study-reference'` creates a v2 update command with the active viewport and visible window from the current bundle.

- [ ] **Step 4: Detail panel policy**

For v2 reference rows in Phase 1, do not render `StudyDetailPanel`. That component's props mean "dense snapshot details are available by bucket"; passing empty maps would make the UI look operational while silently dropping orderbook and broker context.

Render a minimal aside that preserves memo editing and leaves cursor cards out of the reference branch:

```tsx
<aside
  ref={detailPanelScrollRef}
  role="complementary"
  aria-label="Study Detail Panel"
  data-testid="study-reference-detail-panel"
  className="relative z-10 min-h-0 overflow-y-auto overflow-x-hidden border-l border-[var(--border)] bg-[var(--bg-card)]"
>
  {isMemoOpen && selectedSave && (
    <StudyMemoPanel
      memo={selectedSave.memo}
      isSaving={mutations.updateMetadata.isPending}
      errorMessage={memoError}
      onClose={() => setIsMemoOpen(false)}
      onCommit={commitMemo}
    />
  )}
</aside>
```

Add Phase 2 work for detail parity: fetch cursor orderbook and broker series on demand through existing `/api/orderbook` and `/api/brokers/series` routes instead of snapshot-enriched dense buckets.

- [ ] **Step 5: Verify StudyPage tests**

Run:

```bash
cd frontend && npx vitest run src/studyViews/StudyPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/studySaveSource.ts frontend/src/studyViews/studySaveCommand.ts frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat: render study views from saved ranges"
```

## Task 6: Documentation and ADR Update

**Files:**
- Modify: `docs/adr/0077-parquet-study-views-separate-route.md`
- Modify: `CONTEXT.md`
- Optional Modify: `docs/superpowers/specs/2026-06-16-saved-chart-views-design.md`

**Interfaces:**
- Documents that `/study` is no longer a fixed snapshot route for v2 reference saves.
- Documents that live indicator prefs are canonical for `/study`.

- [ ] **Step 1: Update ADR text**

Replace the opening paragraph in `docs/adr/0077-parquet-study-views-separate-route.md` with:

```md
Reference Study Views open in a dedicated `/study` route, but v2 saved views are no longer self-contained chart snapshots. A v2 saved view stores the stock, timeframe, saved period, viewport, memo, and tags; `/study` reloads the corresponding range data and renders it with the current `/live` indicator preferences. Legacy v1 Parquet Study Views with `source_policy: "fixed"` remain readable during migration and continue to render through the persisted snapshot path.
```

Add a "Supersedes fixed snapshot behavior for v2" section:

```md
For v2, reproducibility means "same saved period", not "same frozen indicator output". This intentionally trades exact historical screen reproduction for a better study workflow: old periods can be re-analyzed with today's indicator toggles, styles, and calculation options.
```

- [ ] **Step 2: Update domain language**

In `CONTEXT.md`, update "저장 학습뷰" to distinguish:

```md
New v2 Reference Study View: a user-named saved analysis range for one Code that opens in `/study`, storing code, timeframe, period, viewport, memo, and tags. It reloads data from the local/API range paths and renders with current `/live` indicator preferences.

Legacy v1 Parquet Study Snapshot: the older fixed JSON artifact that carries candles, indicator output, and optional detail buckets. Kept readable for migration only.
```

- [ ] **Step 3: Verify docs do not contradict**

Run:

```bash
rg -n "does not call KIS|does not refetch|fixed snapshot|source_policy|indicator_state" docs/adr/0077-parquet-study-views-separate-route.md CONTEXT.md docs/superpowers/specs/2026-06-16-saved-chart-views-design.md
```

Expected: Any remaining fixed-snapshot wording is explicitly marked legacy v1.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0077-parquet-study-views-separate-route.md CONTEXT.md docs/superpowers/specs/2026-06-16-saved-chart-views-design.md
git commit -m "docs: define reference study views"
```

## Task 7: End-to-End Verification

**Files:**
- No source changes unless failures reveal bugs.

**Interfaces:**
- Verifies new save/read path, legacy read path, and study rendering.

- [ ] **Step 1: Run backend tests**

Run:

```bash
pytest tests/api/test_study_views.py tests/hoga/api/test_bundle.py::test_build_range_bundle_single_day_yields_one_segment -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run:

```bash
cd frontend && npx vitest run src/api/studyViews.test.ts src/api/studyPastCandles.test.tsx src/studyViews/studySaveCommand.test.ts src/studyViews/useStudyReferenceBundle.test.tsx src/studyViews/StudyPage.test.tsx src/studyViews/StudyViewsDrawer.test.tsx src/studyViews/StudyViewSaveDialog.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run typecheck/build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual smoke**

Run the app:

```bash
hoga api --reload
cd frontend && npm run dev
```

Manual checks:

- Open `/live`, select a stock, pan to a historical period, save a study view.
- Open `/study?view=<id>` and confirm the chart reloads the same period.
- Toggle 호가비/총잔량/체결강도 in the live indicator modal and confirm `/study` reflects the same pane visibility.
- Confirm a legacy v1 saved view still opens.
- Confirm deleting a v2 saved view does not leave a stale snapshot integrity error.

- [ ] **Step 5: Commit final fixes**

```bash
git status --short
git add <only files changed for fixes>
git commit -m "test: verify reference study views"
```

## Risks and Follow-Ups

- **Legacy wording drift:** ADR-0077 and `CONTEXT.md` now distinguish v2 references from v1 snapshots, but older product specs may still describe saved study views as fixed snapshots. Treat that wording as legacy unless the spec is explicitly updated.
- **Study detail panel parity:** v1 snapshots store dense orderbook/broker buckets. V2 should eventually fetch cursor detail on demand instead of storing dense detail arrays.
- **Calendar segment modeling:** D/W/M study reference rendering may need a better segment builder if `LiveChartRoot` assumptions require one segment per trading day. Start with tests around D/W/M before shipping broadly.
- **Today-inclusive saved ranges:** If users save today's unpromoted live edge, v2 reload can show only promoted/API data. This is acceptable for the new model but should be visible through existing loading/warning UI.
- **Legacy cleanup:** After migration confidence, remove `ParquetStudySnapshot` frontend render code and `/snapshot` dependency, or keep it behind a legacy-only branch.

## Self-Review

- Spec coverage: The plan stores only study period references, reloads data in `/study`, and keeps `/live` indicator settings as canonical.
- Placeholder scan: No task uses TBD/TODO/fill-in language; known follow-ups are explicitly marked as risks or later parity work.
- Type consistency: Backend `StudyViewReferenceWriteRequest` maps to frontend `StudyViewWriteRequest`; list rows use `StudyViewReference | ParquetStudyView` during transition.

## Implementation Status

Implemented on 2026-06-26:

- Backend v2 reference models, manifest union loading, v2 create/update routes, and v2 `/snapshot` 409 behavior.
- Frontend v2 API types, range-reference save command, period-reference save dialog copy, and list/tab union propagation.
- `/study` v2 rendering through `useStudyReferenceBundle` with no saved indicator overrides; legacy v1 snapshot rendering remains intact.
- Study-scoped past-candle query wrappers with static freshness, avoiding live venue refetch on `/study`.
- Phase 1 detail policy: v2 reference rows render chart/memo and intentionally skip dense snapshot detail cards.

Verified:

- `uv run --with pytest python -m pytest tests/api/test_study_views.py tests/hoga/api/test_bundle.py::test_build_range_bundle_single_day_yields_one_segment -q`
- `cd frontend && npm run build`
- `cd frontend && npx vitest run src/api/studyViews.test.ts src/api/studyPastCandles.test.tsx src/studyViews/studySaveCommand.test.ts src/studyViews/StudyPage.test.tsx src/studyViews/StudyViewsDrawer.test.tsx src/studyViews/StudyViewSaveDialog.test.tsx`

## Architecture Deepening Status

Completed after the Phase 1 implementation:

- **Study view variant Module:** moved v1/v2 classification and rendering policy into `studyViewVariant.ts`, so page Modules no longer duplicate `schema_version` checks.
- **Study reference bundle Module:** moved saved-period query input derivation and render-model assembly into `studyReferenceBundleModel.ts`, leaving `useStudyReferenceBundle` as a thin query Adapter.
- **Study save command Module:** deepened `studySaveCommand.ts` so UI Modules submit commands through `studySaveCommandBody()` and read dialog metadata from `command.dialog`, instead of inspecting request shape.
- **Study active view model Module:** moved `/study` ready/loading/error and v1/v2 render-model selection into `studyActiveViewModel.ts`, so `StudyPage.tsx` keeps route, tab, and layout orchestration separate from render model selection.

Additional verification:

- `cd frontend && npm run build`
- `cd frontend && npx vitest run src/studyViews/studyViewVariant.test.ts src/studyViews/StudyPage.test.tsx src/studyViews/StudyViewsDrawer.test.tsx src/studyViews/LiveStudyViewSaveButton.test.tsx src/studyViews/StudyViewSaveDialog.test.tsx`
- `cd frontend && npx vitest run src/studyViews/studyReferenceBundleModel.test.ts src/studyViews/studyViewVariant.test.ts src/studyViews/StudyPage.test.tsx src/api/studyPastCandles.test.tsx`
- `cd frontend && npx vitest run src/studyViews/studySaveCommand.test.ts src/studyViews/LiveStudyViewSaveButton.test.tsx src/studyViews/StudyViewsDrawer.test.tsx src/studyViews/studyViewVariant.test.ts src/studyViews/StudyViewSaveDialog.test.tsx`
- `cd frontend && npx vitest run src/studyViews/studyActiveViewModel.test.ts src/studyViews/StudyPage.test.tsx src/studyViews/studyReferenceBundleModel.test.ts src/studyViews/studySaveCommand.test.ts`

## GSTACK REVIEW REPORT

Runs:

| Run | Lens | Status | Result |
| --- | --- | --- | --- |
| 1 | Domain/docs grill | Complete | Reframed v2 as **복기뷰** and v1 as legacy **스냅샷 학습뷰**; updated `CONTEXT.md` and ADR-0077. |
| 2 | Eng review | Complete | Added discriminated schema-version contract, no-snapshot persistence tests, and `/snapshot` 409 behavior for v2. |
| 3 | Eng review | Complete | Replaced direct `useLivePastCandles` reuse with study-scoped static freshness wrappers. |
| 4 | Eng review | Complete | Expanded frontend type propagation through drawer, selection, and study tabs. |
| 5 | Eng review | Complete | Locked Phase 1 detail policy: no fake dense cursor detail; memo/chart only until on-demand detail queries ship. |

Findings:

| Severity | Finding | Plan Update |
| --- | --- | --- |
| High | Directly using `useLivePastCandles` in `/study` would inherit `staleTime: 60_000` and `liveVenueRefetchInterval(venue)`, causing a saved historical review page to refresh like live UI. | Task 4 now creates `useStudyPastCandles` and `useStudyPastDailyCandles` wrappers with `staleTime: Infinity` and `refetchInterval: false`. |
| High | `StudyViewsDrawer`, selection helpers, and study tab state currently assume `ParquetStudyView`; v2 rows would be treated like snapshot rows unless the union type is propagated. | Task 3 now includes `StudyViewListRow` propagation through drawer, selection, tabs, and mixed v1/v2 list tests. |
| Medium | V2 `/snapshot` behavior must be explicit, or clients may see generic 404/500 behavior for reference saves. | Task 2 now requires 409 with `code: "study_view_snapshot_not_applicable"`. |
| Medium | Passing empty dense maps into `StudyDetailPanel` would silently hide missing orderbook/broker context. | Task 5 keeps v2 detail intentionally limited and defers cursor cards to Phase 2 on-demand APIs. |
| Medium | Save dialog copy still described snapshot byte size and calculated chart data. | Task 3 now makes `barCount`/`sizeBytes` optional and uses period-reference copy for v2 saves. |
| Low | ADR-0077 contradicted the new product semantics. | ADR-0077 now separates v2 period reanalysis from legacy v1 fixed snapshots. |

VERDICT: PROCEED WITH PHASE 1 AS PLANNED

NO UNRESOLVED DECISIONS
