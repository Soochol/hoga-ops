# Live Page Hover Spot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

```yaml
scope: both
spec: docs/superpowers/specs/2026-05-28-live-page-hover-spot-design.md
adrs:
  - docs/adr/0044-live-hover-spot-from-parquet.md
  - docs/adr/0039-source-preference-fallback.md
  - docs/adr/0043-incremental-promote-today.md
  - docs/adr/0041-live-calendar-timeframe-panes.md
```

**Goal:** `/live` 페이지의 캔들 차트에 마우스를 hover하면 sidebar(10호가/거래원/체결)가 그 시점의 spot 데이터로 바뀌고, 마우스가 벗어나면 즉시 latest 복귀하도록 한다.

**Architecture:** replay의 cursor → REST 패턴을 재사용한다. 새 `useLiveCursorStore` 가 crosshair 좌표를 받고, 새 `useLiveCursor.ts` 의 세 훅이 cursor가 있을 때만 기존 `/api/orderbook` `/api/trades` `/api/brokers/series` 를 호출한다(`useSpot` 기반). 백엔드는 세 엔드포인트에 `source_pref` 쿼리 파라미터와 응답에 `source` 필드를 추가한다(ADR-0039 thread-through). LiveBuffer/SSE는 hover spot 경로에 참여하지 않는다(ADR-0044).

**Tech Stack:** FastAPI + Pydantic v2 (backend), React + Zustand + lightweight-charts + useSpot (frontend), pytest (backend tests), vitest + @testing-library/react (frontend tests).

---

## File map

### Backend — Create
- `hoga/api/sources.py` — `resolve_source(engine, date, code, pref) -> str` (promoted from `bundle.py` 의 private `_resolve_source`), `SourceName = Literal["hogaplay", "kis_live"]` 타입 정의.

### Backend — Modify
- `hoga/api/bundle.py` — private `_resolve_source` 삭제, 새 `hoga.api.sources.resolve_source` import 후 사용.
- `hoga/api/models.py` — `SourceName` import, `OrderbookResponse`/`TradesResponse`/`BrokerSeriesResponse` 에 `source: SourceName` 필드 추가.
- `hoga/api/routes.py` — 세 라우트에 `source_pref` 파라미터 추가, `resolve_source` 호출, 응답에 `source` 필드 포함.

### Backend — Tests (Create or Extend)
- `tests/unit/api/test_orderbook_endpoint.py` — source_pref 테스트 4종.
- `tests/unit/api/test_trades_endpoint.py` — source_pref 테스트 4종.
- `tests/unit/api/test_brokers_endpoint.py` — source_pref 테스트 4종.
- `tests/unit/api/test_sources.py` — `resolve_source` 단위 테스트.

### Frontend — Create
- `frontend/src/live/useLiveCursorStore.ts` — Zustand `{ cursorMs, setCursor, clearCursor }`.
- `frontend/src/live/useLiveAxisStore.ts` — Zustand `{ axis: VirtualAxis | null, setAxis }`.
- `frontend/src/api/useLiveCursor.ts` — `useLiveOrderbookAtCursor` / `useLiveTradesAroundCursor` / `useLiveBrokersAtCursor` (useSpot 기반).
- `frontend/src/live/useLiveCursorStore.test.ts`
- `frontend/src/api/useLiveCursor.test.ts`

### Frontend — Modify
- `frontend/src/live/LiveChartRoot.tsx` — minute timeframe에서 `subscribeCrosshairMove` 등록, axis를 `useLiveAxisStore` 에 publish.
- `frontend/src/live/LiveSidebar.tsx` — cursor 분기 추가, 헤더 LIVE/SPOT 토글, `TotalQtyBar.maskRatio` 활성 wiring.
- `frontend/src/live/LiveSidebar.test.tsx` — cursor 분기 케이스 추가.

---

## Task 1 — `hoga/api/sources.py` 생성 + `resolve_source` 승격

**Files:**
- Create: `hoga/api/sources.py`
- Modify: `hoga/api/bundle.py` (lines 342–362 삭제 후 import)
- Test: `tests/unit/api/test_sources.py` (create)

- [ ] **Step 1: Write the failing test**

`tests/unit/api/test_sources.py`:

```python
"""Tests for resolve_source — promoted from bundle._resolve_source (ADR-0044
boundary, source_pref thread-through to spot endpoints)."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from hoga.api.sources import SourceName, resolve_source


def _make_engine(tmp_path: Path) -> MagicMock:
    engine = MagicMock()
    engine.data_dir = tmp_path
    return engine


def _seed_source(tmp_path: Path, date: str, code: str, source: str) -> None:
    sd = tmp_path / "parquet" / date / code / source
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text("{}")


def test_prefers_kis_live_when_both_exist(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260528", "005930", "hogaplay")
    _seed_source(tmp_path, "20260528", "005930", "kis_live")
    engine = _make_engine(tmp_path)
    assert resolve_source(engine, "20260528", "005930", "kis_live") == "kis_live"


def test_falls_back_to_other_source_when_pref_missing(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260528", "005930", "hogaplay")
    engine = _make_engine(tmp_path)
    assert resolve_source(engine, "20260528", "005930", "kis_live") == "hogaplay"


def test_returns_pref_when_no_source_exists(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)
    # Caller-side StockDateNotFound will surface naturally — resolve_source
    # itself does not raise, mirroring the legacy _resolve_source contract.
    assert resolve_source(engine, "20260528", "005930", "kis_live") == "kis_live"


def test_mock_engine_data_dir_returns_pref(tmp_path: Path) -> None:
    # MagicMock data_dir (used in many unit tests) is not a real Path —
    # function must short-circuit to pref rather than blow up on Path ops.
    engine = MagicMock()
    engine.data_dir = MagicMock()  # not a real Path
    assert resolve_source(engine, "20260528", "005930", "hogaplay") == "hogaplay"


@pytest.mark.parametrize("bad", ["", "kis_ws", "HOGAPLAY"])
def test_source_name_literal_excludes_unknown(bad: str) -> None:
    # Static-typing guard. Runtime check is at the FastAPI layer (422).
    assert bad not in {"hogaplay", "kis_live"}
    valid: tuple[SourceName, ...] = ("hogaplay", "kis_live")
    assert all(v in {"hogaplay", "kis_live"} for v in valid)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/unit/api/test_sources.py -v
```

Expected: `ModuleNotFoundError: No module named 'hoga.api.sources'`.

- [ ] **Step 3: Create `hoga/api/sources.py`**

```python
"""Source-name resolution for /api routes.

The previous incarnation was `hoga.api.bundle._resolve_source`. Promoted
to a public module so the per-spot endpoints (/api/orderbook,
/api/trades, /api/brokers/series) can honor `?source_pref=` without
back-importing from bundle.py.

ADR-0039 (preference + fallback) defines the semantics. ADR-0044
documents the /live hover-spot boundary that motivated this promotion.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

SourceName = Literal["hogaplay", "kis_live"]


def resolve_source(engine, date: str, code: str, pref: str) -> str:
    """Return the source name actually present on disk for this (date, code).

    Prefers ``pref`` if its meta.json exists; otherwise picks the first other
    source that does. Returns ``pref`` even if nothing exists so the
    downstream StockDateNotFound surfaces naturally.

    MagicMock engines (used in unit tests) have a non-Path ``data_dir`` —
    fall back to ``pref`` immediately in that case to avoid blowing up on
    Path operations.
    """
    from hoga.api.disk_state import classify_stock_date

    sd_dir = engine.data_dir / "parquet" / date / code
    if not isinstance(sd_dir, Path):
        return pref
    per_source = classify_stock_date(sd_dir)
    if pref in per_source:
        return pref
    if per_source:
        return next(iter(per_source))
    return pref
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/unit/api/test_sources.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Update `hoga/api/bundle.py` to use the public symbol**

In `hoga/api/bundle.py`, delete the private definition (lines 342–362) and add at the top with the other `hoga.api.*` imports:

```python
from hoga.api.sources import resolve_source as _resolve_source
```

(Keep the local alias `_resolve_source` so the existing call sites at lines 447 etc. don't need to change.)

- [ ] **Step 6: Run the bundle-related test suite to confirm no regression**

```bash
uv run pytest tests/test_api_range.py tests/unit/api/ -v
```

Expected: all pass (no behavior change, just moved the function).

- [ ] **Step 7: Commit**

```bash
git add hoga/api/sources.py hoga/api/bundle.py tests/unit/api/test_sources.py
git commit -m "refactor(api): promote _resolve_source to hoga.api.sources (ADR-0044)"
```

---

## Task 2 — `SourceName` import + `source` field on `OrderbookResponse`

**Files:**
- Modify: `hoga/api/models.py:66-68`
- Test: `tests/unit/api/test_orderbook_endpoint.py` (extend or create)

- [ ] **Step 1: Write the failing test**

In `tests/unit/api/test_orderbook_endpoint.py` (create if missing), add:

```python
from hoga.api.models import OrderbookResponse
from hoga.api.sources import SourceName


def test_orderbook_response_has_source_field() -> None:
    resp = OrderbookResponse(available_from=None, snapshot=None, source="hogaplay")
    assert resp.source == "hogaplay"
    # Type narrowed to SourceName Literal — wrong values rejected by Pydantic
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        OrderbookResponse(available_from=None, snapshot=None, source="invalid")  # type: ignore[arg-type]
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/unit/api/test_orderbook_endpoint.py::test_orderbook_response_has_source_field -v
```

Expected: `ValidationError: source field required` (or attribute error).

- [ ] **Step 3: Add field to `OrderbookResponse`**

In `hoga/api/models.py`, near top with other imports:

```python
from hoga.api.sources import SourceName
```

Replace lines 66-68:

```python
class OrderbookResponse(BaseModel):
    available_from: int | None = None
    snapshot: ApiOrderbookSnapshot | None
    source: SourceName
```

- [ ] **Step 4: Run the new test**

```bash
uv run pytest tests/unit/api/test_orderbook_endpoint.py::test_orderbook_response_has_source_field -v
```

Expected: PASS.

- [ ] **Step 5: Confirm no regression in routes that construct OrderbookResponse**

```bash
uv run pytest tests/ -k orderbook -v
```

Expected: any pre-existing failures here are construction sites missing `source=` — that's covered in Task 3. **If only the new test passes and others fail with "source field required", proceed to Task 3 immediately. Do not commit yet** (route changes belong with the field).

---

## Task 3 — `/api/orderbook` accepts `source_pref` + returns `source`

**Files:**
- Modify: `hoga/api/routes.py:84-115`
- Test: `tests/unit/api/test_orderbook_endpoint.py`

- [ ] **Step 1: Write failing tests for source_pref behaviour**

Add to `tests/unit/api/test_orderbook_endpoint.py`:

```python
from fastapi.testclient import TestClient

from hoga.api.app import default_app
# Reuse the project's pytest fixtures that seed parquet dirs.
# (See tests/conftest.py for `seeded_engine` / `client` if present;
# otherwise this test file may need to add a minimal fixture mirroring
# tests/unit/api/test_*_endpoint.py patterns in the repo.)


def test_orderbook_source_pref_prefers_kis_live(seed_orderbook):
    # seed_orderbook: project fixture that writes snapshots.parquet under
    # both data/parquet/{date}/{code}/hogaplay/ and .../kis_live/
    client = seed_orderbook(date="20260528", code="005930", with_kis_live=True)
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260528", "t": 1748400000000, "source_pref": "kis_live"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "kis_live"


def test_orderbook_source_pref_falls_back_to_hogaplay(seed_orderbook):
    # Only hogaplay seeded — kis_live missing.
    client = seed_orderbook(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260528", "t": 1748400000000, "source_pref": "kis_live"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"  # fallback (ADR-0039)


def test_orderbook_source_pref_default_is_hogaplay(seed_orderbook):
    client = seed_orderbook(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260528", "t": 1748400000000,
        # no source_pref → default "hogaplay"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_orderbook_source_pref_invalid_returns_422(seed_orderbook):
    client = seed_orderbook(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260528", "t": 1748400000000, "source_pref": "garbage"
    })
    assert r.status_code == 422
```

If the project doesn't yet have a `seed_orderbook` fixture, add one in `tests/unit/api/conftest.py` following the same pattern other endpoint tests use (search for fixtures named like `seed_*` in `tests/unit/api/`). The fixture seeds a tiny snapshots.parquet under each source dir with at least one row at the asked `t`. **Do not invent a new pattern — mirror the closest existing fixture.**

- [ ] **Step 2: Run tests to confirm they fail**

```bash
uv run pytest tests/unit/api/test_orderbook_endpoint.py -v -k "source_pref or has_source_field"
```

Expected: existing test passes; the four new ones fail (route doesn't accept `source_pref`; response missing `source` field).

- [ ] **Step 3: Update `/api/orderbook` route**

In `hoga/api/routes.py`, add at top:

```python
from typing import Literal as _Literal  # if not already imported
from hoga.api.sources import resolve_source
```

Replace `orderbook` handler (lines 84-115) with:

```python
    @router.get("/orderbook", response_model=OrderbookResponse)
    def orderbook(
        code: Code,
        date: StockDate,
        t: int = Query(...),
        bucket_ms: int | None = Query(None),
        source_pref: _Literal["hogaplay", "kis_live"] = Query("hogaplay"),
    ) -> OrderbookResponse:
        # ADR-0044: hover spot path honors source_pref via resolve_source +
        # ADR-0039 preference+fallback semantics. The resolved source is
        # echoed back so LiveStatusBar's chip can reflect fallback honestly.
        source = resolve_source(engine, date, code, source_pref)
        try:
            sd_dir = engine.parquet_dir(date, code, source=source)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        path = sd_dir / "snapshots.parquet"
        if bucket_ms is not None:
            try:
                validate_bucket_ms(bucket_ms)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            cutoff_unix = t + bucket_ms - 1
        else:
            cutoff_unix = t
        raw_t = cursor_to_native(date, cutoff_unix)
        snap = snapshots_tbl.query_at(engine.conn, path=path, t_ms=raw_t)
        if snap is None:
            first_ts = snapshots_tbl.query_first_ts(engine.conn, path=path)
            available_from = (
                hhmmssms_to_unix_ms(date, first_ts) if first_ts is not None else None
            )
            return OrderbookResponse(available_from=available_from, snapshot=None, source=source)
        snap = snap.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, snap.ts_ms)})
        return OrderbookResponse(available_from=None, snapshot=snap, source=source)
```

- [ ] **Step 4: Run the orderbook tests**

```bash
uv run pytest tests/unit/api/test_orderbook_endpoint.py -v
```

Expected: all pass.

- [ ] **Step 5: Run the whole route-related suite to catch regressions**

```bash
uv run pytest tests/ -k "orderbook or api" -v
```

Expected: all pass (the response shape change adds a field; any test that asserts equality on the dict needs to be updated to include `source`).

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py hoga/api/routes.py tests/unit/api/test_orderbook_endpoint.py tests/unit/api/conftest.py
git commit -m "feat(api): /api/orderbook honors source_pref + returns resolved source (ADR-0044)"
```

---

## Task 4 — `source` field on `TradesResponse`

**Files:**
- Modify: `hoga/api/models.py:71-72`
- Test: `tests/unit/api/test_trades_endpoint.py`

- [ ] **Step 1: Write failing test**

```python
from hoga.api.models import TradesResponse


def test_trades_response_has_source_field() -> None:
    resp = TradesResponse(trades=[], source="hogaplay")
    assert resp.source == "hogaplay"
```

- [ ] **Step 2: Run test to confirm fail**

```bash
uv run pytest tests/unit/api/test_trades_endpoint.py::test_trades_response_has_source_field -v
```

Expected: `ValidationError: source field required`.

- [ ] **Step 3: Add field**

In `hoga/api/models.py`:

```python
class TradesResponse(BaseModel):
    trades: list[ApiTrade]
    source: SourceName
```

- [ ] **Step 4: Test passes; do not commit yet (route in Task 5).**

---

## Task 5 — `/api/trades` accepts `source_pref` + returns `source`

**Files:**
- Modify: `hoga/api/routes.py:117-142`
- Test: `tests/unit/api/test_trades_endpoint.py`

- [ ] **Step 1: Write failing tests**

Mirror Task 3's four tests against `/api/trades`. Same fixture pattern. Trades-specific param: `t=...&limit=20`.

```python
def test_trades_source_pref_prefers_kis_live(seed_trades):
    client = seed_trades(date="20260528", code="005930", with_kis_live=True)
    r = client.get("/api/trades", params={
        "code": "005930", "date": "20260528", "t": 1748400000000, "limit": 20,
        "source_pref": "kis_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "kis_live"


def test_trades_source_pref_falls_back_to_hogaplay(seed_trades):
    client = seed_trades(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/trades", params={
        "code": "005930", "date": "20260528", "t": 1748400000000, "limit": 20,
        "source_pref": "kis_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_trades_source_pref_default_is_hogaplay(seed_trades):
    client = seed_trades(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/trades", params={
        "code": "005930", "date": "20260528", "t": 1748400000000, "limit": 20,
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_trades_source_pref_invalid_returns_422(seed_trades):
    client = seed_trades(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/trades", params={
        "code": "005930", "date": "20260528", "t": 1748400000000, "limit": 20,
        "source_pref": "garbage",
    })
    assert r.status_code == 422
```

- [ ] **Step 2: Run to confirm fail**

```bash
uv run pytest tests/unit/api/test_trades_endpoint.py -v
```

Expected: 4 new tests fail; the trades-source-field test from Task 4 passes.

- [ ] **Step 3: Update `/api/trades` route**

Replace lines 117-142 in `hoga/api/routes.py`:

```python
    @router.get("/trades", response_model=TradesResponse)
    def trades(
        code: Code,
        date: StockDate,
        t: int | None = Query(None),
        from_ms: int | None = Query(None, alias="from"),
        to_ms: int | None = Query(None, alias="to"),
        limit: int = 50,
        source_pref: _Literal["hogaplay", "kis_live"] = Query("hogaplay"),
    ) -> TradesResponse:
        source = resolve_source(engine, date, code, source_pref)
        try:
            sd_dir = engine.parquet_dir(date, code, source=source)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        path = sd_dir / "trades.parquet"
        if from_ms is not None and to_ms is not None:
            rows = trades_tbl.query_range(
                engine.conn,
                path=path,
                from_ms=cursor_to_native(date, from_ms),
                to_ms=cursor_to_native(date, to_ms),
                limit=limit,
            )
        elif t is not None:
            rows = trades_tbl.query_up_to(
                engine.conn, path=path, t_ms=cursor_to_native(date, t), limit=limit
            )
        else:
            raise HTTPException(status_code=400, detail="provide either ?t= or ?from=&to=")
        rows = [r.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, r.ts_ms)}) for r in rows]
        return TradesResponse(trades=rows, source=source)
```

- [ ] **Step 4: Run tests**

```bash
uv run pytest tests/unit/api/test_trades_endpoint.py tests/ -k trades -v
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py hoga/api/routes.py tests/unit/api/test_trades_endpoint.py
git commit -m "feat(api): /api/trades honors source_pref + returns resolved source"
```

---

## Task 6 — `source` field on `BrokerSeriesResponse`

**Files:**
- Modify: `hoga/api/models.py:536-538`
- Test: `tests/unit/api/test_brokers_endpoint.py`

- [ ] **Step 1: Write failing test**

```python
from hoga.api.models import BrokerSeriesResponse


def test_brokers_response_has_source_field() -> None:
    resp = BrokerSeriesResponse(date="20260528", brokers=[], source="hogaplay")
    assert resp.source == "hogaplay"
```

- [ ] **Step 2: Run to confirm fail; then add the field**

```python
class BrokerSeriesResponse(BaseModel):
    date: str
    brokers: list[BrokerSeriesEntry]
    source: SourceName
```

- [ ] **Step 3: Test passes; do not commit yet (route in Task 7).**

---

## Task 7 — `/api/brokers/series` accepts `source_pref` + returns `source`

**Files:**
- Modify: `hoga/api/routes.py:154-…` (brokers_series handler)
- Test: `tests/unit/api/test_brokers_endpoint.py`

- [ ] **Step 1: Write the four failing tests**

Same pattern as Tasks 3 and 5. The endpoint takes only `code` + `date` (no `t`).

```python
def test_brokers_source_pref_prefers_kis_live(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kis_live=True)
    r = client.get("/api/brokers/series", params={
        "code": "005930", "date": "20260528", "source_pref": "kis_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "kis_live"


def test_brokers_source_pref_falls_back_to_hogaplay(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/brokers/series", params={
        "code": "005930", "date": "20260528", "source_pref": "kis_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_brokers_source_pref_default_is_hogaplay(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/brokers/series", params={
        "code": "005930", "date": "20260528",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_brokers_source_pref_invalid_returns_422(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/brokers/series", params={
        "code": "005930", "date": "20260528", "source_pref": "garbage",
    })
    assert r.status_code == 422
```

- [ ] **Step 2: Run to confirm fail**

- [ ] **Step 3: Update `brokers_series` handler**

In `hoga/api/routes.py`:

```python
    @router.get("/brokers/series", response_model=BrokerSeriesResponse)
    def brokers_series(
        code: Code,
        date: StockDate,
        source_pref: _Literal["hogaplay", "kis_live"] = Query("hogaplay"),
    ) -> BrokerSeriesResponse:
        source = resolve_source(engine, date, code, source_pref)
        try:
            sd_dir = engine.parquet_dir(date, code, source=source)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        path = sd_dir / "brokers.parquet"
        raw_entries = brokers_tbl.query_day_series(engine.conn, path=path)
        entries = [
            e.model_copy(
                update={
                    "points": [
                        p.model_copy(
                            update={"ts_ms": hhmmssms_to_unix_ms(date, p.ts_ms)}
                        )
                        for p in e.points
                    ]
                }
            )
            for e in raw_entries
        ]
        return BrokerSeriesResponse(date=date, brokers=entries, source=source)
```

(Match the exact `model_copy` chain that exists today at the current handler — copy from existing source if the structure differs.)

- [ ] **Step 4: Run tests**

```bash
uv run pytest tests/unit/api/test_brokers_endpoint.py tests/ -k brokers -v
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py hoga/api/routes.py tests/unit/api/test_brokers_endpoint.py
git commit -m "feat(api): /api/brokers/series honors source_pref + returns resolved source"
```

---

## Task 8 — `useLiveCursorStore` (Zustand)

**Files:**
- Create: `frontend/src/live/useLiveCursorStore.ts`
- Test: `frontend/src/live/useLiveCursorStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/live/useLiveCursorStore.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { useLiveCursorStore } from './useLiveCursorStore';

describe('useLiveCursorStore', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().clearCursor();
  });

  it('starts with cursorMs null', () => {
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
  });

  it('setCursor stores the value', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000000);
  });

  it('clearCursor resets to null', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    useLiveCursorStore.getState().clearCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
  });

  it('setCursor with same value is a no-op for subscribers', () => {
    // Implementation should not trigger needless rerenders.
    useLiveCursorStore.getState().setCursor(123);
    let calls = 0;
    const unsub = useLiveCursorStore.subscribe(() => { calls += 1; });
    useLiveCursorStore.getState().setCursor(123);
    unsub();
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
cd frontend && npx vitest run src/live/useLiveCursorStore.test.ts
```

Expected: `Cannot find module './useLiveCursorStore'`.

- [ ] **Step 3: Implement store**

```typescript
// frontend/src/live/useLiveCursorStore.ts
import { create } from 'zustand';

interface State {
  cursorMs: number | null;
  setCursor: (t: number) => void;
  clearCursor: () => void;
}

/**
 * /live page hover cursor. Set on chart crosshair move, cleared on
 * mouse-leave (LiveChartRoot). LiveSidebar reads this to switch between
 * latest-tracking and spot mode. See ADR-0044.
 */
export const useLiveCursorStore = create<State>((set, get) => ({
  cursorMs: null,
  setCursor: (t) => {
    if (get().cursorMs === t) return;  // identity-stable, no-op rerender
    set({ cursorMs: t });
  },
  clearCursor: () => {
    if (get().cursorMs === null) return;
    set({ cursorMs: null });
  },
}));
```

- [ ] **Step 4: Run test**

```bash
cd frontend && npx vitest run src/live/useLiveCursorStore.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/useLiveCursorStore.ts frontend/src/live/useLiveCursorStore.test.ts
git commit -m "feat(live): useLiveCursorStore for hover spot (ADR-0044)"
```

---

## Task 9 — `useLiveAxisStore` (share VirtualAxis from LiveChartRoot)

**Files:**
- Create: `frontend/src/live/useLiveAxisStore.ts`
- Test: `frontend/src/live/useLiveAxisStore.test.ts`

Background: `LiveSidebar` needs `axis.inClosingAuctionWindow(cursorMs)` to decide `TotalQtyBar.maskRatio`. `LiveChartRoot` already holds the `VirtualAxis` instance — share it through a Zustand store so the sidebar can read without prop drilling through `LivePage` and `LiveWorkarea`.

- [ ] **Step 1: Write failing test**

```typescript
// frontend/src/live/useLiveAxisStore.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { createVirtualAxis } from '../util/virtualAxis';
import { useLiveAxisStore } from './useLiveAxisStore';

describe('useLiveAxisStore', () => {
  beforeEach(() => {
    useLiveAxisStore.getState().setAxis(null);
  });

  it('starts with axis null', () => {
    expect(useLiveAxisStore.getState().axis).toBeNull();
  });

  it('setAxis stores the axis ref', () => {
    const axis = createVirtualAxis([]);
    useLiveAxisStore.getState().setAxis(axis);
    expect(useLiveAxisStore.getState().axis).toBe(axis);
  });

  it('inClosingAuctionWindow query routes through the stored axis', () => {
    const axis = createVirtualAxis([]);
    useLiveAxisStore.getState().setAxis(axis);
    // Empty segments → false for any t. Just exercise the wiring.
    expect(useLiveAxisStore.getState().axis?.inClosingAuctionWindow(0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
cd frontend && npx vitest run src/live/useLiveAxisStore.test.ts
```

- [ ] **Step 3: Implement store**

```typescript
// frontend/src/live/useLiveAxisStore.ts
import { create } from 'zustand';
import type { VirtualAxis } from '../util/virtualAxis';

interface State {
  axis: VirtualAxis | null;
  setAxis: (axis: VirtualAxis | null) => void;
}

/**
 * The /live VirtualAxis lives in LiveChartRoot. LiveSidebar borrows it
 * to evaluate axis.inClosingAuctionWindow(cursorMs) for TotalQtyBar's
 * Auction Mask. Stored as a ref-style singleton — the chart re-publishes
 * on segment changes (memoised in LiveChartRoot).
 */
export const useLiveAxisStore = create<State>((set, get) => ({
  axis: null,
  setAxis: (axis) => {
    if (get().axis === axis) return;
    set({ axis });
  },
}));
```

- [ ] **Step 4: Run test**

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/useLiveAxisStore.ts frontend/src/live/useLiveAxisStore.test.ts
git commit -m "feat(live): useLiveAxisStore so LiveSidebar can read axis for Auction Mask"
```

---

## Task 10 — `useLiveOrderbookAtCursor` hook

**Files:**
- Create: `frontend/src/api/useLiveCursor.ts`
- Test: `frontend/src/api/useLiveCursor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/api/useLiveCursor.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useLiveOrderbookAtCursor } from './useLiveCursor';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { useSourcePreferenceStore } from '../state/sourcePreference';

// Mock the low-level fetch helper used by useSpot fetchers.
vi.mock('./client', async (orig) => {
  const actual = await orig<typeof import('./client')>();
  return {
    ...actual,
    apiGet: vi.fn(async (url: string) => {
      if (url.includes('/api/orderbook')) {
        return { snapshot: { ts_ms: 1, asks: [], bids: [] }, source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    }),
  };
});

import { apiGet } from './client';

beforeEach(() => {
  useLiveCursorStore.getState().clearCursor();
  useSourcePreferenceStore.getState().setSourcePreference('hogaplay');
  (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe('useLiveOrderbookAtCursor', () => {
  it('returns undefined and does not fetch when cursorMs is null', async () => {
    const { result } = renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', date: '20260528', timeframe: '1m' }),
    );
    expect(result.current).toBeUndefined();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches once when cursorMs becomes set', async () => {
    const { result, rerender } = renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', date: '20260528', timeframe: '1m' }),
    );
    act(() => {
      useLiveCursorStore.getState().setCursor(1_748_400_060_000);  // 1m boundary
    });
    rerender();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/api/orderbook');
    expect(url).toContain('code=005930');
    expect(url).toContain('date=20260528');
    expect(url).toContain('t=1748400060000');
    expect(url).toContain('bucket_ms=60000');
    expect(url).toContain('source_pref=hogaplay');
  });

  it('client-side bucket alignment collapses within-minute hover to one fetch', async () => {
    renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', date: '20260528', timeframe: '1m' }),
    );
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_061_234));  // same minute
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_089_999));  // same minute
    // 50ms is enough for useSpot's 30ms debounce to fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(apiGet).toHaveBeenCalledTimes(1);  // bucket-aligned: same key, LRU hit
  });

  it('source_pref change reissues the query', async () => {
    renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', date: '20260528', timeframe: '1m' }),
    );
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    act(() => useSourcePreferenceStore.getState().setSourcePreference('kis_live'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(url).toContain('source_pref=kis_live');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
cd frontend && npx vitest run src/api/useLiveCursor.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the hook (orderbook only for this task)**

```typescript
// frontend/src/api/useLiveCursor.ts
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { useSpot } from './useSpot';
import { apiGet } from './client';
import { TIMEFRAME_TO_MS, type Timeframe } from './types';
import type { ApiOrderbookSnapshot, MinuteTimeframe } from '../state/livePage';
import type { OrderbookResponse } from './types';  // adjust import if response is declared elsewhere

interface Params {
  code: string | null;
  date: string | null;
  timeframe: MinuteTimeframe | null;
}

/**
 * Live-side cursor-keyed orderbook spot, mirroring replay's
 * useOrderbookAtCursor. See ADR-0044 — parquet-only path, source_pref
 * threaded, client-side bucket alignment for cache stability.
 */
export function useLiveOrderbookAtCursor(p: Params): ApiOrderbookSnapshot | null | undefined {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const bucketMs = p.timeframe ? TIMEFRAME_TO_MS[p.timeframe as Timeframe] : null;
  const alignedT =
    cursorMs !== null && bucketMs !== null
      ? Math.floor(cursorMs / bucketMs) * bucketMs
      : null;
  const key =
    p.code && p.date && alignedT !== null && bucketMs !== null
      ? `live|ob|${p.code}|${p.date}|${alignedT}|${bucketMs}|${sourcePref}`
      : null;
  const { data } = useSpot<ApiOrderbookSnapshot | null>(key, () =>
    apiGet<OrderbookResponse>(
      `/api/orderbook?code=${p.code}&date=${p.date}&t=${alignedT}&bucket_ms=${bucketMs}&source_pref=${sourcePref}`,
    ).then((r) => r.snapshot),
  );
  return data;
}
```

> **Engineer note:** if the project's `useSourcePreferenceStore` setter has a different name, mirror that (the test file imports `setSourcePreference` — confirm in `frontend/src/state/sourcePreference.ts`). Same for `OrderbookResponse` import location (`./types` vs a sibling).

- [ ] **Step 4: Run tests**

```bash
cd frontend && npx vitest run src/api/useLiveCursor.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/useLiveCursor.ts frontend/src/api/useLiveCursor.test.ts
git commit -m "feat(api): useLiveOrderbookAtCursor (ADR-0044, mirrors replay)"
```

---

## Task 11 — `useLiveTradesAroundCursor` hook

**Files:**
- Modify: `frontend/src/api/useLiveCursor.ts`
- Modify: `frontend/src/api/useLiveCursor.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `useLiveCursor.test.ts`:

```typescript
import { useLiveTradesAroundCursor } from './useLiveCursor';

describe('useLiveTradesAroundCursor', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().clearCursor();
    useSourcePreferenceStore.getState().setSourcePreference('hogaplay');
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/trades')) return { trades: [], source: 'hogaplay' };
      throw new Error('unexpected url: ' + url);
    });
  });

  it('does not fetch when cursorMs null', async () => {
    const { result } = renderHook(() =>
      useLiveTradesAroundCursor({ code: '005930', date: '20260528', timeframe: '1m' }),
    );
    expect(result.current).toBeUndefined();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('builds URL with t aligned, limit=20, source_pref', async () => {
    renderHook(() =>
      useLiveTradesAroundCursor({ code: '005930', date: '20260528', timeframe: '1m' }),
    );
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/api/trades');
    expect(url).toContain('t=1748400060000');
    expect(url).toContain('limit=20');
    expect(url).toContain('source_pref=hogaplay');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

- [ ] **Step 3: Add hook to `useLiveCursor.ts`**

```typescript
import type { Trade, SourceName } from './types';
// Note: frontend has no named TradesResponse type today — replay's
// useCursor.ts uses an inline `{ trades: Trade[] }`. We follow the same
// pattern and add `source` inline to avoid scope creep.

export function useLiveTradesAroundCursor(
  p: Params,
  limit: number = 20,
): Trade[] | null | undefined {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const bucketMs = p.timeframe ? TIMEFRAME_TO_MS[p.timeframe as Timeframe] : null;
  const alignedT =
    cursorMs !== null && bucketMs !== null
      ? Math.floor(cursorMs / bucketMs) * bucketMs
      : null;
  const key =
    p.code && p.date && alignedT !== null
      ? `live|tr|${p.code}|${p.date}|${alignedT}|${limit}|${sourcePref}`
      : null;
  const { data } = useSpot<Trade[]>(key, () =>
    apiGet<{ trades: Trade[]; source: SourceName }>(
      `/api/trades?code=${p.code}&date=${p.date}&t=${alignedT}&limit=${limit}&source_pref=${sourcePref}`,
    ).then((r) => r.trades),
  );
  return data;
}
```

- [ ] **Step 4: Run tests**

```bash
cd frontend && npx vitest run src/api/useLiveCursor.test.ts
```

Expected: all pass (orderbook + trades suites).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/useLiveCursor.ts frontend/src/api/useLiveCursor.test.ts
git commit -m "feat(api): useLiveTradesAroundCursor"
```

---

## Task 12 — `useLiveBrokersAtCursor` hook

**Files:**
- Modify: `frontend/src/api/useLiveCursor.ts`
- Modify: `frontend/src/api/useLiveCursor.test.ts`

Replay's broker pattern (see CONTEXT.md "Cursor Sidebar") fetches the **whole day series** once per (code, date, source_pref), then `BrokerTrajectoryTable` projects per-row net at cursor by binary-searching `points` for `ts_ms <= cursorMs`. We mirror that — the hook returns the day series; the sidebar already knows how to project.

- [ ] **Step 1: Write failing test**

```typescript
import { useLiveBrokersAtCursor } from './useLiveCursor';

describe('useLiveBrokersAtCursor', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().clearCursor();
    useSourcePreferenceStore.getState().setSourcePreference('hogaplay');
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/brokers/series')) {
        return { date: '20260528', brokers: [], source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    });
  });

  it('does not fetch when cursorMs null', () => {
    renderHook(() => useLiveBrokersAtCursor({ code: '005930', date: '20260528' }));
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches once when cursorMs set, key independent of cursorMs value', async () => {
    renderHook(() => useLiveBrokersAtCursor({ code: '005930', date: '20260528' }));
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    // Moving cursor within the same day must not refetch — the day series
    // is whole-day; the sidebar projects per-row net at cursor client-side.
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_900_000));
    await new Promise((r) => setTimeout(r, 80));
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('source_pref change reissues', async () => {
    renderHook(() => useLiveBrokersAtCursor({ code: '005930', date: '20260528' }));
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    act(() => useSourcePreferenceStore.getState().setSourcePreference('kis_live'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run to confirm fail**

- [ ] **Step 3: Add hook**

```typescript
import type { BrokerSeriesEntry, BrokerSeriesResponse } from './types';  // adjust

interface BrokersParams {
  code: string | null;
  date: string | null;
}

export function useLiveBrokersAtCursor(
  p: BrokersParams,
): BrokerSeriesEntry[] | null | undefined {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  // Key gates on cursor presence (so we don't fetch in latest mode) but
  // doesn't include cursorMs — the day series is the same for any t
  // within (code, date).
  const key =
    p.code && p.date && cursorMs !== null
      ? `live|br|${p.code}|${p.date}|${sourcePref}`
      : null;
  const { data } = useSpot<BrokerSeriesEntry[]>(key, () =>
    apiGet<BrokerSeriesResponse>(
      `/api/brokers/series?code=${p.code}&date=${p.date}&source_pref=${sourcePref}`,
    ).then((r) => r.brokers),
  );
  return data;
}
```

- [ ] **Step 4: Run tests**

```bash
cd frontend && npx vitest run src/api/useLiveCursor.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/useLiveCursor.ts frontend/src/api/useLiveCursor.test.ts
git commit -m "feat(api): useLiveBrokersAtCursor (day-series, client-projected)"
```

---

## Task 13 — `LiveChartRoot` crosshair subscription + axis publish

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveChartRoot.test.tsx` (if missing, create with minimal harness mirroring existing live chart tests)

- [ ] **Step 1: Write the failing tests**

`frontend/src/live/LiveChartRoot.test.tsx` already exists with a `createChart` mock that returns a chart object whose `subscribeCrosshairMove` / `unsubscribeCrosshairMove` are `vi.fn()`. Append a new `describe` block at the end of that file:

```typescript
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';

describe('LiveChartRoot crosshair → cursor store (ADR-0044)', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.getState().setAxis(null);
    vi.mocked(createChart).mockClear();
  });

  it('publishes axis to useLiveAxisStore on mount', () => {
    useLivePageStore.setState({ candleTimeframe: '1m' });
    render(<LiveChartRoot bundle={DEFAULT_BUNDLE} />, { wrapper });
    expect(useLiveAxisStore.getState().axis).not.toBeNull();
  });

  it('subscribes to crosshair move on minute timeframe', () => {
    useLivePageStore.setState({ candleTimeframe: '1m' });
    render(<LiveChartRoot bundle={DEFAULT_BUNDLE} />, { wrapper });
    const chart = vi.mocked(createChart).mock.results[0].value;
    expect(chart.subscribeCrosshairMove).toHaveBeenCalledTimes(1);
  });

  it('does NOT subscribe on calendar timeframe (D/W/M)', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
    render(<LiveChartRoot bundle={DEFAULT_BUNDLE} />, { wrapper });
    const chart = vi.mocked(createChart).mock.results[0].value;
    expect(chart.subscribeCrosshairMove).not.toHaveBeenCalled();
  });

  it('crosshair move → setCursor; crosshair leave → clearCursor', async () => {
    useLivePageStore.setState({ candleTimeframe: '1m' });
    render(<LiveChartRoot bundle={DEFAULT_BUNDLE} />, { wrapper });
    const chart = vi.mocked(createChart).mock.results[0].value;
    const handler = chart.subscribeCrosshairMove.mock.calls[0][0] as (p: {
      time?: unknown;
      point?: { x: number } | null;
    }) => void;
    // Pick a virtual-seconds value that VirtualAxis can map back. The empty
    // bundle's segment maps the first virtual second to session_open_ms.
    const SESSION_OPEN = DEFAULT_BUNDLE.segments[0].session_open_ms;
    act(() => handler({ time: 0, point: { x: 1 } }));
    // rAF coalescing — flush one frame.
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);

    act(() => handler({ time: undefined, point: null }));
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
  });

  it('clears cursor when timeframe switches from minute to calendar', () => {
    useLivePageStore.setState({ candleTimeframe: '1m' });
    const { rerender } = render(<LiveChartRoot bundle={DEFAULT_BUNDLE} />, { wrapper });
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    act(() => useLivePageStore.setState({ candleTimeframe: 'D' }));
    rerender(<LiveChartRoot bundle={DEFAULT_BUNDLE} />);
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
  });
});
```

> **Engineer note:** Two harness facts to verify before implementing:
> 1. `LiveChartRoot` reads `candleTimeframe` from `useLivePageStore` (not via prop) — confirm by checking the current `LiveChartRoot.tsx`.
> 2. `VirtualAxis.virtualToRealMs` is the right method name — if it's different (e.g. `realMsFromVirtualSeconds`), mirror what `ChartStage.tsx` calls in `subscribeCrosshairMove`.
> If either assumption is wrong, fix the implementation *and* the corresponding test expectation. The cursor value asserted above (`SESSION_OPEN`) assumes virtual second 0 ↔ session_open_ms. Adjust if the axis encoding differs.

- [ ] **Step 2: Run to confirm fail**

```bash
cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx
```

- [ ] **Step 3: Update `LiveChartRoot.tsx`**

Add imports near the top:

```typescript
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import { isMinuteTimeframe } from '../state/livePage';
```

After the existing `axis` useMemo (around line 65), add:

```typescript
  // Publish axis to the shared store so LiveSidebar can read
  // axis.inClosingAuctionWindow(cursorMs) for TotalQtyBar mask.
  useEffect(() => {
    useLiveAxisStore.getState().setAxis(axis);
    return () => {
      useLiveAxisStore.getState().setAxis(null);
    };
  }, [axis]);
```

Below the existing pane-stretch useEffect (around line 274), add:

```typescript
  // ADR-0044: hover → cursor store. Only mount on minute timeframes —
  // calendar timeframes (D/W/M) don't have backing parquet on /live.
  // rAF-coalesce to one update per frame (matches ChartStage's pattern).
  useEffect(() => {
    if (!chart || !isMinuteTimeframe(timeframe)) {
      useLiveCursorStore.getState().clearCursor();
      return;
    }
    let pending: number | null = null;
    const handler = (param: { time?: unknown; point?: { x: number } | null }) => {
      if (param.point == null) {
        useLiveCursorStore.getState().clearCursor();
        return;
      }
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = null;
        const t = param.time;
        if (typeof t !== 'number') return;
        const realMs = axis.virtualToRealMs(t);
        if (realMs == null) return;
        useLiveCursorStore.getState().setCursor(realMs);
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      if (pending !== null) cancelAnimationFrame(pending);
      useLiveCursorStore.getState().clearCursor();
    };
  }, [chart, axis, timeframe]);
```

> **Engineer note:** Verify the exact `VirtualAxis` method used in replay's `ChartStage.tsx` for virtual→real conversion. If it's not `virtualToRealMs`, mirror whatever method ChartStage uses (e.g. `axis.realMsFromVirtualSeconds` or similar). Don't invent — match.

- [ ] **Step 4: Run tests**

```bash
cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx
```

Expected: all crosshair-related tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx
git commit -m "feat(live): LiveChartRoot publishes axis + crosshair → cursor (ADR-0044)"
```

---

## Task 14 — `LiveSidebar` cursor branching + header toggle + Auction Mask wiring

**Files:**
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Modify: `frontend/src/live/LiveSidebar.test.tsx`

- [ ] **Step 1: Write failing tests**

The existing `LiveSidebar.test.tsx` already mocks `useLiveSeries`. Append a new `describe` block and additionally mock `useLiveCursor.ts` and `TotalQtyBar` (so we can spy on its `maskRatio` prop):

```typescript
// Append to frontend/src/live/LiveSidebar.test.tsx
import { act } from 'react';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';

vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: vi.fn(() => null),
  useLiveTradesAroundCursor: vi.fn(() => []),
  useLiveBrokersAtCursor: vi.fn(() => []),
}));

vi.mock('../sidebar/TotalQtyBar', () => ({
  default: vi.fn(() => <div data-testid="total-qty-bar" />),
}));

import * as cursorHooks from '../api/useLiveCursor';
import TotalQtyBar from '../sidebar/TotalQtyBar';

describe('LiveSidebar cursor branching (ADR-0044)', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.getState().setAxis(null);
    vi.mocked(TotalQtyBar).mockClear();
  });

  it('shows LIVE● header when cursorMs is null', () => {
    render(<LiveSidebar code="005930" />);
    expect(screen.getByTestId('live-sidebar-pulse')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('swaps to SPOT @ HH:MM:SS when cursor is set', () => {
    render(<LiveSidebar code="005930" />);
    // 2026-05-28 13:42:17 KST → millis (replace with a real KST ms in your TZ).
    const t = new Date('2026-05-28T04:42:17Z').getTime();
    act(() => useLiveCursorStore.getState().setCursor(t));
    expect(screen.queryByTestId('live-sidebar-pulse')).toBeNull();
    expect(screen.getByText(/^SPOT @ \d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it('does not call cursor hooks when cursorMs null', () => {
    render(<LiveSidebar code="005930" />);
    // The hooks are imported and rendered, but their inner useSpot
    // does not fetch — verified separately in useLiveCursor.test.ts.
    // Here we just confirm they were rendered with code='005930' so
    // they're ready to switch on when cursor sets.
    expect(cursorHooks.useLiveOrderbookAtCursor).toHaveBeenCalledWith(
      expect.objectContaining({ code: '005930' }),
    );
  });

  it('TotalQtyBar maskRatio=true when cursorMs in closing auction window', () => {
    const fakeAxis = { inClosingAuctionWindow: vi.fn(() => true) } as unknown as
      Parameters<typeof useLiveAxisStore.getState>['0'] extends never ? never : never;
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => true } as never });
    render(<LiveSidebar code="005930" />);
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_900_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: true }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs outside window', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => false } as never });
    render(<LiveSidebar code="005930" />);
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: false }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs null (preserves existing behavior)', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => true } as never });
    render(<LiveSidebar code="005930" />);
    // No setCursor — cursorMs stays null. maskRatio must be false despite
    // the axis predicate returning true, because we don't engage mask in
    // latest mode (existing behavior — see LiveSidebar:91 today).
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: false }),
      expect.anything(),
    );
  });
});
```

> **Engineer note:** The KST timestamp formatting in test 2 is tz-sensitive — adjust the `Date` literal to a UTC instant that lands on a known `HH:MM:SS` in your local timezone, then match the regex. If the test framework runs in UTC, write the expected string directly.

- [ ] **Step 2: Run to confirm fail**

```bash
cd frontend && npx vitest run src/live/LiveSidebar.test.tsx
```

- [ ] **Step 3: Update `LiveSidebar.tsx`**

Replace the file with a refactored version that branches on `cursorMs`:

```typescript
import { useMemo } from 'react';
import CursorSidebar from '../sidebar/CursorSidebar';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import FillTape from '../sidebar/FillTape';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import { useLiveSeries } from '../api/liveSeries';
import {
  aggregateBrokerSeries,
  flattenTrades,
  latestOrderbookSnapshot,
} from './liveSidebarAdapters';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import { useLivePageStore } from '../state/livePage';
import {
  useLiveOrderbookAtCursor,
  useLiveTradesAroundCursor,
  useLiveBrokersAtCursor,
} from '../api/useLiveCursor';
import type { MinuteTimeframe } from '../state/livePage';
import { isMinuteTimeframe } from '../state/livePage';

interface Props {
  code: string | null;
}

export function LiveSidebar({ code }: Props) {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const isSpot = cursorMs !== null;
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const date = useLivePageStore((s) => s.activeDate);  // adjust if the store field has a different name

  // Latest-mode data (always subscribed — useSpot hooks in spot mode
  // sit dormant when cursorMs is null, no extra fetches).
  const { ob, trade, broker } = useLiveSeries(code ?? '');
  const latestOrderbook = useMemo(() => latestOrderbookSnapshot(ob), [ob]);
  const latestBrokerSeries = useMemo(() => aggregateBrokerSeries(broker), [broker]);
  const latestTrades = useMemo(() => flattenTrades(trade), [trade]);
  const latestBrokerTs =
    broker.length > 0 ? (broker[broker.length - 1].t_ms as number) : Date.now();

  // Spot-mode data (dormant when cursorMs null).
  const spotTimeframe: MinuteTimeframe | null =
    timeframe && isMinuteTimeframe(timeframe) ? timeframe : null;
  const spotOrderbook = useLiveOrderbookAtCursor({ code, date, timeframe: spotTimeframe });
  const spotTrades = useLiveTradesAroundCursor({ code, date, timeframe: spotTimeframe });
  const spotBrokers = useLiveBrokersAtCursor({ code, date });

  // Axis for Auction Mask in spot mode.
  const axis = useLiveAxisStore((s) => s.axis);
  const maskRatio =
    isSpot && axis !== null && cursorMs !== null
      ? axis.inClosingAuctionWindow(cursorMs)
      : false;

  // Branch.
  const orderbookForCard = isSpot ? (spotOrderbook ?? null) : latestOrderbook;
  const tradesForCard = isSpot
    ? (spotTrades === undefined ? undefined : spotTrades ?? [])
    : (trade.length === 0 ? undefined : latestTrades);
  const brokerSeriesForCard = isSpot
    ? (spotBrokers === undefined ? undefined : spotBrokers ?? [])
    : (broker.length === 0 ? undefined : latestBrokerSeries);
  const brokerCursorMs = isSpot ? (cursorMs as number) : latestBrokerTs;

  return (
    <div
      data-testid="live-sidebar"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-card)',
      }}
    >
      <SidebarHeader cursorMs={cursorMs} latestOrderbookTs={latestOrderbook?.ts_ms ?? null} />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <CursorSidebar
          orderbook={
            <>
              <OrderbookTable snapshot={orderbookForCard} />
              <TotalQtyBar snapshot={orderbookForCard} maskRatio={maskRatio} />
            </>
          }
          brokers={
            <BrokerTrajectoryTable series={brokerSeriesForCard} cursorMs={brokerCursorMs} />
          }
          fills={<FillTape trades={tradesForCard} />}
        />
      </div>
    </div>
  );
}

function SidebarHeader({
  cursorMs,
  latestOrderbookTs,
}: {
  cursorMs: number | null;
  latestOrderbookTs: number | null;
}) {
  const isSpot = cursorMs !== null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        padding: 'var(--space-sm) var(--space-md)',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--text-xs)',
        color: 'var(--fg-dim)',
      }}
    >
      {isSpot ? (
        <>
          <span style={{ fontFamily: 'monospace' }}>SPOT @ {formatHms(cursorMs!)}</span>
        </>
      ) : (
        <>
          <span
            data-testid="live-sidebar-pulse"
            aria-label="live pulse"
            style={{
              display: 'inline-block',
              width: 'var(--space-xs)',
              height: 'var(--space-xs)',
              borderRadius: '50%',
              background: 'var(--accent)',
              animation: 'live-pulse 1.5s ease-in-out infinite',
            }}
          />
          <span style={{ fontFamily: 'monospace' }}>LIVE</span>
          {latestOrderbookTs !== null && (
            <span style={{ marginLeft: 'auto', color: 'var(--fg-dimmer)' }}>
              {formatHms(latestOrderbookTs)}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function formatHms(t_ms: number): string {
  const d = new Date(t_ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
```

> **Engineer note:** The `useLivePageStore` field name for the current date may differ (`activeDate`, `selectedDate`, etc.). Read `frontend/src/state/livePage.ts` and use whatever exists. If no current `date` is held there, hoist it from `LivePage` via prop drilling — but check first.

- [ ] **Step 4: Run tests**

```bash
cd frontend && npx vitest run src/live/LiveSidebar.test.tsx
```

Expected: all pass (latest cases + new spot cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveSidebar.tsx frontend/src/live/LiveSidebar.test.tsx
git commit -m "feat(live): LiveSidebar cursor branching + SPOT header + Auction Mask (ADR-0044)"
```

---

## Task 15 — Frontend type sync + full test sweep

**Files:**
- Modify: `frontend/src/api/types.ts` — add `SourceName` type, add `source: SourceName` to the two named response types (`OrderbookResponse:56`, `BrokerSeriesResponse:78`). Trades response is inline in callers (no named type today), so the `source` field is added inline by Task 11's hook.

- [ ] **Step 1: Add `SourceName` type and extend named response types**

In `frontend/src/api/types.ts`:

```typescript
export type SourceName = 'hogaplay' | 'kis_live';
```

Then update `OrderbookResponse` (line 56) and `BrokerSeriesResponse` (line 78) to add the new field:

```typescript
export type OrderbookResponse = {
  available_from: number | null;
  snapshot: OrderbookSnapshot | null;
  source: SourceName;
};

export type BrokerSeriesResponse = {
  date: string;
  brokers: BrokerSeriesEntry[];
  source: SourceName;
};
```

- [ ] **Step 2: Run full frontend type-check + unit tests**

```bash
cd frontend && npm run build && npx vitest run
```

Expected: build passes, all unit tests pass.

- [ ] **Step 3: Run full backend test suite**

```bash
uv run pytest
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(types): add source field to spot response shapes"
```

---

## Task 16 — Manual smoke test via `/browse`

**Files:** none (verification only).

- [ ] **Step 1: Start backend with hot reload**

```bash
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

- [ ] **Step 2: Start frontend dev server**

```bash
cd frontend && npm run dev
```

- [ ] **Step 3: Use `/browse` to walk the feature**

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B snapshot -i                # capture interactive map
$B network                    # confirm no /api/orderbook calls in latest mode
# pick a watchlist code, switch to 1m timeframe in toolbar
# move mouse onto the candle area programmatically:
$B js "const el = document.querySelector('[data-testid=\"live-chart-root\"] div'); el.dispatchEvent(new MouseEvent('mousemove', {clientX: 400, clientY: 200, bubbles: true}));"
$B text                       # confirm SPOT @ HH:MM:SS appears in sidebar header
$B network | tail -20         # confirm /api/orderbook, /api/trades, /api/brokers/series fired with source_pref
# move mouse off chart
$B js "document.dispatchEvent(new MouseEvent('mouseleave', {bubbles: true}));"
$B text                       # confirm LIVE● is back
```

- [ ] **Step 4: Verify edge cases**

  - Switch to `D` timeframe → hover over chart → no spot mode (no fetch), pulse stays.
  - Toggle source preference in replay Settings (the same store backs `/live`) → spot fetches reissue with new `source_pref`.
  - Hover during 15:25 (closing auction window) on a minute timeframe → `TotalQtyBar` shows the "Auction" label (replace fill).

- [ ] **Step 5: Final commit (note in CHANGELOG if the project uses one)**

```bash
git status
# only the docs/superpowers/plans/2026-05-28-... file should be unstaged at this point
# (or untouched if you committed it earlier in the brainstorming flow)
```

No code commit for smoke test — the verification is the deliverable.

---

## Verification gate (rerun before declaring done)

```bash
uv run pytest
cd frontend && npm run build
```

Both must be green. If either fails, debug with `superpowers:systematic-debugging` and fix-forward.

## Deferred review notes

(Empty at plan creation — populated by Task 4 of the full-flow pipeline when plan reviews run.)
