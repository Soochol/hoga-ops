---
scope: both
spec: docs/superpowers/specs/2026-05-28-live-daily-direct-backfill-design.md
adr: docs/adr/0048-live-daily-direct-backfill.md (신설 예정)
---

# /live D-direct Daily Backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 페이지의 일봉(D/W/M) backfill을 KIS daily endpoint (`FHKST03010100`)에서 직접 받아오는 신규 backend endpoint `/api/live/past-daily-candles`를 추가하여, 일봉에서 사용자가 캡 없이 과거로 스크롤할 수 있게 한다.

**Architecture:** ADR-0040의 분봉 path(`/api/live/past-candles`, disk cache)와 *형제 구조*로 일봉 path를 추가. 일봉 cache는 **프로세스 메모리 only** (데이터 양이 작아 디스크 불필요, restart = 자연 invalidation). KIS daily 응답의 OHLC invariant 위반은 `DailyCandleFetchResult.violations`로 핸들러까지 전달되어 wire의 `data_warnings`로 surface. 분봉 path도 본 spec scope 안에서 today negative caching 패치를 받아 두 path가 일관됨.

**Tech Stack:** Python 3.11+ (FastAPI, httpx, pydantic, pytest, pytest-asyncio), TypeScript (React, @tanstack/react-query, vitest, @testing-library/react), KIS Open API REST.

---

## Engineering Review — Applied Patches (2026-05-28)

This plan absorbed two Blocker / Critical findings from `/plan-eng-review`. They
are inline at the relevant tasks; this header summarizes so reviewers see what
changed without diffing the whole file.

- **B-1 (Blocker) — InvariantOutcomesBanner shape mismatch.** Spec D9 assumed
  daily wire `data_warnings` would render in the existing banner. Verified by
  reading code: the banner reads `bundle.data_warnings` (shape
  `{date, warnings[]}`) sourced only from `/api/range`; the new wire shape is
  `{batch, reason, msg}` where `batch` is a date *range*. New Task D0 (before
  D1) adds `date` alongside `batch` for `invariant_violation` warnings in the
  backend handler, updates the wire type, and adapts daily warnings into
  `DateWarning[]` shape inside `useLiveBundle` so the banner surfaces them.
  Batch-level warnings (`kis_rate_limit`, `kis_api_error`) and minute-path
  warnings remain unsurfaced — filed as follow-up; the user should be aware
  the chart will degrade silently on KIS rate-limit until that lands.
- **C-1 (Critical) — Empty-gap + single-day + today-only + today-negative
  tests missing.** New Task B3a adds 4 regression tests covering: KIS
  returning empty for a gap must still cache (else infinite re-fetch),
  single-day past request, single-day today-only request (must skip the gap
  branch via `req_to_past < frm`), and today negative caching honors TTL.
- **C-2 (Critical) — Tri-state "backward-compat wrapper" is a misnomer.** The
  legacy `get_today` in C1 returned the same value for "miss" and "negative",
  hiding the exact bug C2 is fixing. Verified only 1 production caller
  (api.py:214, rewritten by C2) and 3 test assertions remain. Plan now
  deletes the wrapper outright and updates the 3 test assertions to use
  `get_today_tri`.
- **B4 (Suggestion folded in) — `data_dir` already passed.** Verified
  `hoga/api/app.py:181` already calls `build_live_router(..., data_dir=data_dir)`.
  B4 is read-only verification, no commit needed.

See "Engineering review report" section at the very end for the full
categorized findings list (including Suggestion + Nit items not auto-applied).

---

## File Structure

**Backend — 신설**:
- `hoga/live/past_daily_candles_cache.py` — 일봉용 메모리 cache 클래스
- `tests/unit/live/test_past_daily_candles_cache.py`
- `tests/unit/live/test_past_daily_candles_api.py` (또는 `test_api.py`에 섹션 추가)

**Frontend — Banner 수정 (eng-review Blocker B-1로 추가됨)**:
- `frontend/src/api/types.ts` — `DateWarning.date`를 optional + `batch?: string` 추가하거나
  새 `BatchWarning` 타입 도입.
- `frontend/src/replay/InvariantOutcomesBanner.tsx` — `batch` shape도 렌더 (또는
  daily 핸들러가 `{date: gap_from_s, warnings: [{invariant_id, message}]}` 형태로 wire
  방출하도록 backend B3에서 변환). 자세한 결정 기록은 Phase B 끝의 "Banner shape 결정"
  섹션 참고.

**Backend — 수정**:
- `hoga/live/kis_client.py` — `DailyCandleFetchResult`, `DailyInvariantViolation`, `fetch_past_daily_candles` 추가
- `hoga/live/api.py` — `_validate_daily_past_request` + `_get_past_daily_candles` 핸들러, 분봉 `_get_past_candles` today negative cache 호출 추가
- `hoga/live/past_candles_cache.py` — 분봉 cache의 `_today_mem` 타입을 `tuple[float, list[dict] | None]`로 확장 + tri-state get_today
- `hoga/api/app.py` (또는 `create_app` 위치) — `PastDailyCandlesCache` 인스턴스 + `build_router`에 전달

**Frontend — 신설**:
- `frontend/src/api/livePastDailyCandles.ts`
- `frontend/src/api/livePastDailyCandles.test.tsx`

**Frontend — 수정**:
- `frontend/src/live/useLiveBundle.ts` — 분봉/일봉 분기, clampEngaged isMinute 한정
- `frontend/src/live/useLiveBundle.test.tsx` — 분기 회귀 테스트
- `frontend/src/live/aggregateCandles.test.ts` — `aggregateCalendar('D', dailyInput)` identity-ish 회귀

**Docs — 신설**:
- `docs/adr/0048-live-daily-direct-backfill.md`

**Docs — 수정** (코드와 함께 ship):
- `CONTEXT.md` — Live Candle Backfill entry 전체 재작성 + LiveTimeframe 한 문장 교체

---

## Phase A — Backend leaf modules (TDD, no dependencies)

### Task A1: `PastDailyCandlesCache` — 메모리 only cache 클래스

**Files:**
- Create: `hoga/live/past_daily_candles_cache.py`
- Test: `tests/unit/live/test_past_daily_candles_cache.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/unit/live/test_past_daily_candles_cache.py
"""Tests for hoga.live.past_daily_candles_cache (memory-only daily cache)."""
from __future__ import annotations

import time
from datetime import date, timedelta, timezone
from unittest.mock import patch

from hoga.live.past_daily_candles_cache import PastDailyCandlesCache

_KST = timezone(timedelta(hours=9))


def _bar(t_ms: int) -> dict:
    return {"t_ms": t_ms, "open": 100, "high": 110, "low": 95, "close": 105, "volume": 10}


def test_empty_code_returns_no_batches() -> None:
    cache = PastDailyCandlesCache()
    assert cache.list_batches("005930") == []


def test_append_and_read_round_trip() -> None:
    cache = PastDailyCandlesCache()
    bars = [_bar(1000), _bar(2000)]
    cache.append_batch("005930", date(2024, 1, 1), date(2024, 12, 31), bars)
    out = cache.list_batches("005930")
    assert len(out) == 1
    b_from, b_to, b_bars = out[0]
    assert b_from == date(2024, 1, 1)
    assert b_to == date(2024, 12, 31)
    assert b_bars == bars


def test_multiple_batches_kept_in_insertion_order() -> None:
    cache = PastDailyCandlesCache()
    cache.append_batch("005930", date(2024, 1, 1), date(2024, 12, 31), [_bar(1)])
    cache.append_batch("005930", date(2023, 1, 1), date(2023, 12, 31), [_bar(2)])
    out = cache.list_batches("005930")
    assert len(out) == 2
    assert out[0][0] == date(2024, 1, 1)  # appended first
    assert out[1][0] == date(2023, 1, 1)


def test_today_hit_returns_dict() -> None:
    cache = PastDailyCandlesCache()
    bar = _bar(1000)
    cache.store_today("005930", bar)
    state, value = cache.get_today("005930")
    assert state == "hit"
    assert value == bar


def test_today_miss_returns_miss_state() -> None:
    cache = PastDailyCandlesCache()
    state, value = cache.get_today("005930")
    assert state == "miss"
    assert value is None


def test_today_negative_cache() -> None:
    cache = PastDailyCandlesCache()
    cache.store_today("005930", None)
    state, value = cache.get_today("005930")
    assert state == "negative"
    assert value is None


def test_today_ttl_expiry_returns_miss() -> None:
    cache = PastDailyCandlesCache(today_ttl_seconds=10.0)
    cache.store_today("005930", _bar(1000))
    # Fast-forward monotonic clock past TTL.
    with patch("hoga.live.past_daily_candles_cache.time.monotonic",
               return_value=time.monotonic() + 11.0):
        state, value = cache.get_today("005930")
    assert state == "miss"
    assert value is None


def test_negative_cache_ttl_expiry_returns_miss() -> None:
    cache = PastDailyCandlesCache(today_ttl_seconds=10.0)
    cache.store_today("005930", None)
    with patch("hoga.live.past_daily_candles_cache.time.monotonic",
               return_value=time.monotonic() + 11.0):
        state, value = cache.get_today("005930")
    assert state == "miss"
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `uv run pytest tests/unit/live/test_past_daily_candles_cache.py -v`
Expected: ImportError / ModuleNotFoundError on `hoga.live.past_daily_candles_cache`.

- [ ] **Step 3: Implement `PastDailyCandlesCache`**

```python
# hoga/live/past_daily_candles_cache.py
"""Memory-only cache for KIS daily OHLCV results.

Backs GET /api/live/past-daily-candles. Daily data is small enough
(~250 KB per code per 20 years) that disk persistence offers no benefit;
process restart is the natural cache invalidation event.

ADR-0048 — parallel to ADR-0040; daily cache lives in memory only and has
no disk artifact. The minute path's PastCandlesCache keeps disk persistence
because 1-minute data at scale exceeds memory.
"""
from __future__ import annotations

import time
from datetime import date
from typing import Literal

# TTL for today's bar (and negative cache for non-trading-day today).
TODAY_TTL_SECONDS = 60.0

TodayState = Literal["hit", "miss", "negative"]


class PastDailyCandlesCache:
    """In-memory cache for KIS daily candles.

    - Past batches: per-code list of (from_date, to_date, bars) in insertion order.
    - Today: per-code tri-state — "hit" (dict), "miss" (no entry / TTL expired),
      "negative" (fetched, no data — non-trading day).
    """

    def __init__(self, *, today_ttl_seconds: float = TODAY_TTL_SECONDS) -> None:
        self._today_ttl = today_ttl_seconds
        self._per_code: dict[str, list[tuple[date, date, list[dict]]]] = {}
        # value: (fetched_at_monotonic, dict | None)
        self._today_mem: dict[str, tuple[float, dict | None]] = {}

    # --- batches ---

    def list_batches(self, code: str) -> list[tuple[date, date, list[dict]]]:
        return list(self._per_code.get(code, []))

    def append_batch(
        self, code: str, frm: date, to: date, bars: list[dict],
    ) -> None:
        self._per_code.setdefault(code, []).append((frm, to, bars))

    # --- today ---

    def get_today(self, code: str) -> tuple[TodayState, dict | None]:
        entry = self._today_mem.get(code)
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return "miss", None
        if value is None:
            return "negative", None
        return "hit", value

    def store_today(self, code: str, bar: dict | None) -> None:
        self._today_mem[code] = (time.monotonic(), bar)
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/unit/live/test_past_daily_candles_cache.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/past_daily_candles_cache.py tests/unit/live/test_past_daily_candles_cache.py
git commit -m "feat(live): PastDailyCandlesCache — memory-only tri-state today cache"
```

---

### Task A2: `DailyCandleFetchResult` + `DailyInvariantViolation` dataclasses

**Files:**
- Modify: `hoga/live/kis_client.py` (top of file, alongside `KisCandle` import area)
- Test: `tests/unit/live/test_kis_client.py` (no test needed for pure dataclass — covered in A3)

- [ ] **Step 1: Add dataclasses**

Place after the `KisAuthError` / `KisRateLimitError` / `KisApiError` block (currently around line 70):

```python
# hoga/live/kis_client.py — add after the typed error classes

from dataclasses import dataclass, field
from typing import Literal

@dataclass(frozen=True)
class DailyInvariantViolation:
    """A row dropped by fetch_past_daily_candles boundary defense.

    Surfaced to the handler so wire data_warnings can tell operators which
    dates were silently lost — ADR-0040's defensive-parse policy made explicit
    (grill Q3 decision in 2026-05-28 daily backfill spec).
    """
    date_yyyymmdd: str
    reason: Literal[
        "close_nonpositive", "ohlc_inconsistent", "malformed_row", "out_of_range"
    ]
    detail: str


@dataclass(frozen=True)
class DailyCandleFetchResult:
    """Return value of fetch_past_daily_candles.

    `candles` is the cleaned, ASC-sorted result; `violations` is the per-row
    drop log so the caller can surface them to data_warnings.
    """
    candles: list["KisCandle"]
    violations: list[DailyInvariantViolation] = field(default_factory=list)
```

(Forward-reference `"KisCandle"` is fine — it's defined in `hoga/live/kis_models.py` and already imported at the top of `kis_client.py`.)

- [ ] **Step 2: Verify the module still imports**

Run: `uv run python -c "from hoga.live.kis_client import DailyCandleFetchResult, DailyInvariantViolation; print('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add hoga/live/kis_client.py
git commit -m "feat(live): DailyCandleFetchResult + DailyInvariantViolation dataclasses"
```

---

### Task A3: `KisClient.fetch_past_daily_candles` — KIS daily fetch + invariant defense

**Files:**
- Modify: `hoga/live/kis_client.py` (add method to `KisClient` class)
- Test: `tests/unit/live/test_kis_rest_methods.py` (extend with daily tests)

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/live/test_kis_rest_methods.py`:

```python
# ----------------------------------------------------------------------
# fetch_past_daily_candles (FHKST03010100, inquire-daily-itemchartprice)
# ----------------------------------------------------------------------

import pytest
import httpx
from hoga.live.kis_client import (
    KisClient, KisCredentials, KisRateLimitError,
    DailyCandleFetchResult, DailyInvariantViolation,
)


def _daily_row(date_yyyymmdd: str, *, o=100, h=110, l=95, c=105, v=1000) -> dict:
    return {
        "stck_bsop_date": date_yyyymmdd,
        "stck_oprc": str(o),
        "stck_hgpr": str(h),
        "stck_lwpr": str(l),
        "stck_clpr": str(c),  # daily uses stck_clpr (close), not stck_prpr
        "acml_vol": str(v),
    }


def _ok_daily_body(rows: list[dict]) -> dict:
    return {"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": rows}


@pytest.mark.asyncio
async def test_fetch_past_daily_clean_response(tmp_path) -> None:
    rows = [_daily_row(f"2024010{i}") for i in range(1, 6)]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_cache_path=tmp_path / "tok.json",
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240105")
    assert isinstance(result, DailyCandleFetchResult)
    assert len(result.candles) == 5
    assert result.violations == []
    # ASC sort
    assert all(result.candles[i].t_ms < result.candles[i + 1].t_ms for i in range(4))


@pytest.mark.asyncio
async def test_fetch_past_daily_drops_close_nonpositive_row(tmp_path) -> None:
    rows = [_daily_row("20240101"), _daily_row("20240102", c=0), _daily_row("20240103")]

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_cache_path=tmp_path / "tok.json",
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240103")
    assert len(result.candles) == 2
    assert len(result.violations) == 1
    assert result.violations[0].date_yyyymmdd == "20240102"
    assert result.violations[0].reason == "close_nonpositive"


@pytest.mark.asyncio
async def test_fetch_past_daily_drops_ohlc_inconsistent_row(tmp_path) -> None:
    # high < max(open, close)
    rows = [_daily_row("20240101", o=120, h=100, l=80, c=110)]

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_cache_path=tmp_path / "tok.json",
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240101")
    assert result.candles == []
    assert len(result.violations) == 1
    assert result.violations[0].reason == "ohlc_inconsistent"


@pytest.mark.asyncio
async def test_fetch_past_daily_drops_out_of_range_row(tmp_path) -> None:
    # KIS quirk: returns row outside requested range
    rows = [_daily_row("20240101"), _daily_row("20231231")]  # 2nd is out of range

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_cache_path=tmp_path / "tok.json",
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240105")
    assert len(result.candles) == 1
    assert len(result.violations) == 1
    assert result.violations[0].reason == "out_of_range"


@pytest.mark.asyncio
async def test_fetch_past_daily_drops_malformed_row(tmp_path) -> None:
    rows = [_daily_row("20240101"), {"stck_bsop_date": ""}]  # 2nd is missing fields

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_cache_path=tmp_path / "tok.json",
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240101")
    assert len(result.candles) == 1
    assert len(result.violations) == 1
    assert result.violations[0].reason == "malformed_row"


@pytest.mark.asyncio
async def test_fetch_past_daily_rate_limit_propagates(tmp_path) -> None:
    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json={"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "rate"})

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_cache_path=tmp_path / "tok.json",
        _transport=httpx.MockTransport(handler),
    )
    with pytest.raises(KisRateLimitError):
        await client.fetch_past_daily_candles("005930", "20240101", "20240101")


@pytest.mark.asyncio
async def test_fetch_past_daily_paginates_walk_back(tmp_path) -> None:
    # Page 1: rows for 20240105..20240103 (newest first per KIS convention).
    # Page 2: rows for 20240102..20240101.
    # Page 3: empty → stop.
    page_responses = [
        _ok_daily_body([_daily_row(f"2024010{i}") for i in [5, 4, 3]]),
        _ok_daily_body([_daily_row(f"2024010{i}") for i in [2, 1]]),
        _ok_daily_body([]),
    ]
    call_count = {"n": 0}

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        i = call_count["n"]
        call_count["n"] += 1
        return httpx.Response(200, json=page_responses[i])

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_cache_path=tmp_path / "tok.json",
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240105")
    assert len(result.candles) == 5
    assert all(result.candles[i].t_ms < result.candles[i + 1].t_ms for i in range(4))
    # 2 pages of content + 1 empty page = 3 KIS calls (+1 token)
    assert call_count["n"] == 3
```

- [ ] **Step 2: Run tests, verify all fail**

Run: `uv run pytest tests/unit/live/test_kis_rest_methods.py -v -k "fetch_past_daily"`
Expected: AttributeError on `client.fetch_past_daily_candles`.

- [ ] **Step 3: Implement `fetch_past_daily_candles`**

Append to `hoga/live/kis_client.py` (after `fetch_past_minute_candles`, before `fetch_overtime_orderbook`):

```python
    # ------------------------------------------------------------------
    # fetch_past_daily_candles (FHKST03010100, inquire-daily-itemchartprice)
    # ------------------------------------------------------------------

    async def fetch_past_daily_candles(
        self, code: str, from_yyyymmdd: str, to_yyyymmdd: str
    ) -> DailyCandleFetchResult:
        """Fetch daily OHLCV for *code* across [from, to] (KST).

        KIS TR_ID: FHKST03010100 (inquire-daily-itemchartprice), period='D'.
        KIS retains roughly 20-30 years of daily candles per the portal docs.

        Returns DailyCandleFetchResult with:
        - candles: ASC by t_ms; t_ms anchors at regular_session_open (KST 09:00:00)
          of each trading day. Non-trading days are absent (KIS doesn't emit them).
        - violations: per-row drop reasons (close<=0, OHLC inconsistent, malformed,
          out of requested range). Surfaced to caller for data_warnings.
        """
        path = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"
        tr_id = "FHKST03010100"
        cursor_to = to_yyyymmdd
        seen_dates: set[str] = set()
        all_candles: list[KisCandle] = []
        violations: list[DailyInvariantViolation] = []

        # 60 pages × ~100 bars = ~6,000 bars = ~24 years; well past KIS retention.
        for _ in range(60):
            params = {
                "FID_COND_MRKT_DIV_CODE": "J",
                "FID_INPUT_ISCD": code,
                "FID_INPUT_DATE_1": from_yyyymmdd,
                "FID_INPUT_DATE_2": cursor_to,
                "FID_PERIOD_DIV_CODE": "D",
                "FID_ORG_ADJ_PRC": "0",  # 0 = 수정주가 (split/dividend-adjusted)
            }
            body = await self._get(path=path, tr_id=tr_id, params=params)
            rows = body.get("output2") or []
            page_candles: list[KisCandle] = []
            page_earliest: str | None = None

            for row in rows:
                date_str = row.get("stck_bsop_date") or ""
                if len(date_str) != 8:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str or "(empty)",
                        reason="malformed_row",
                        detail="stck_bsop_date missing or wrong length",
                    ))
                    continue
                if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="out_of_range",
                        detail=f"row date outside [{from_yyyymmdd}, {to_yyyymmdd}]",
                    ))
                    continue
                if date_str in seen_dates:
                    continue
                # Daily endpoint typically uses stck_clpr for close (not stck_prpr).
                try:
                    o = int(row["stck_oprc"])
                    h = int(row["stck_hgpr"])
                    l_ = int(row["stck_lwpr"])
                    c = int(row.get("stck_clpr") or row.get("stck_prpr") or "0")
                    v = int(row.get("acml_vol") or row.get("cntg_vol") or "0")
                except (KeyError, ValueError, TypeError) as e:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="malformed_row",
                        detail=f"OHLCV parse: {e}",
                    ))
                    continue
                if c <= 0:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str, reason="close_nonpositive",
                        detail=f"close={c}",
                    ))
                    continue
                if h < max(o, c) or l_ > min(o, c) or h < l_:
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str, reason="ohlc_inconsistent",
                        detail=f"o={o} h={h} l={l_} c={c}",
                    ))
                    continue

                # t_ms anchored at regular session open (KST 09:00) of date_str.
                from datetime import datetime as _dt
                dt = _dt(
                    int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
                    9, 0, tzinfo=KIS_KST,
                )
                t_ms = int(dt.timestamp() * 1000)
                seen_dates.add(date_str)
                page_candles.append(KisCandle(
                    t_ms=t_ms, open=o, high=h, low=l_, close=c, volume=v,
                ))
                if page_earliest is None or date_str < page_earliest:
                    page_earliest = date_str

            if not page_candles:
                break
            all_candles.extend(page_candles)
            # Stop if we already covered from_yyyymmdd.
            if page_earliest is not None and page_earliest <= from_yyyymmdd:
                break
            # Next cursor = page_earliest - 1 day.
            if page_earliest is None:
                break
            from datetime import datetime as _dt2, timedelta as _td
            earliest_dt = _dt2(
                int(page_earliest[:4]), int(page_earliest[4:6]),
                int(page_earliest[6:8]), tzinfo=KIS_KST,
            )
            cursor_to = (earliest_dt - _td(days=1)).strftime("%Y%m%d")

        all_candles.sort(key=lambda c: c.t_ms)
        return DailyCandleFetchResult(candles=all_candles, violations=violations)
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/unit/live/test_kis_rest_methods.py -v -k "fetch_past_daily"`
Expected: all PASS.

- [ ] **Step 5: Run full kis_rest_methods file to make sure existing tests still pass**

Run: `uv run pytest tests/unit/live/test_kis_rest_methods.py -v`
Expected: all PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_rest_methods.py
git commit -m "feat(live): KisClient.fetch_past_daily_candles (FHKST03010100) with OHLC defense"
```

---

## Phase B — Backend handler + wiring

### Task B1: `_validate_daily_past_request` — request validation helper

**Files:**
- Modify: `hoga/live/api.py` (add helper after existing `_validate_past_request`)
- Test: `tests/unit/live/test_api.py` (add section)

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/live/test_api.py` (top-level test functions, not inside any class):

```python
# ----- /api/live/past-daily-candles validation -----

from hoga.live.api import _validate_daily_past_request
from fastapi import HTTPException


def test_validate_daily_accepts_uncapped_range() -> None:
    # 20-year range should NOT raise — daily has no cap.
    today = _today_kst_yyyymmdd()
    frm, too, today_d = _validate_daily_past_request("005930", "20060101", today)
    assert frm.strftime("%Y%m%d") == "20060101"


def test_validate_daily_rejects_invalid_code() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_daily_past_request("abc", "20240101", "20240102")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_invalid_date() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_daily_past_request("005930", "2024-01-01", "20240102")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_from_after_to() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_daily_past_request("005930", "20240505", "20240101")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_future_to() -> None:
    today = _today_kst_yyyymmdd()
    # to = today + 1 day in YYYYMMDD form via datetime arithmetic
    from datetime import timedelta as _td, datetime as _dt
    kst = datetime.timezone(datetime.timedelta(hours=9))
    tomorrow = (_dt.now(kst) + _td(days=1)).strftime("%Y%m%d")
    with pytest.raises(HTTPException) as exc:
        _validate_daily_past_request("005930", today, tomorrow)
    assert exc.value.status_code == 422
```

Add `import pytest` at the top of the file if not already present.

- [ ] **Step 2: Run tests, verify ImportError**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "validate_daily"`
Expected: ImportError on `_validate_daily_past_request`.

- [ ] **Step 3: Implement validator**

Add to `hoga/live/api.py` right after `_validate_past_request` (around line 80):

```python
def _validate_daily_past_request(
    code: str, from_: str, to: str
) -> tuple[date, date, date]:
    """Validate daily past-candles request, returning parsed (frm, too, today).

    Unlike `_validate_past_request` (250-day cap on minute path), the daily
    path is uncapped — KIS retention (~20-30 years) is the natural ceiling
    and rate-limit handling surfaces partial responses via data_warnings.

    Raises HTTPException(422) on invalid code / date / order / future date.
    """
    if not _CODE_RE.match(code):
        raise HTTPException(422, {"code": "invalid_code", "msg": "code must be 6 digits"})
    frm = _parse_yyyymmdd(from_)
    too = _parse_yyyymmdd(to)
    if frm is None or too is None:
        raise HTTPException(422, {"code": "invalid_date", "msg": "from/to must be YYYYMMDD"})
    if frm > too:
        raise HTTPException(422, {"code": "from_after_to", "msg": "from must be <= to"})
    today_d = _today_kst_date()
    if too > today_d:
        raise HTTPException(422, {"code": "date_in_future", "msg": "to must be <= today_kst"})
    return frm, too, today_d
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "validate_daily"`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "feat(live): _validate_daily_past_request — uncapped daily range validation"
```

---

### Task B2: `_compute_daily_gaps` — gap computation helper

**Files:**
- Modify: `hoga/live/api.py` (add helper near `_validate_daily_past_request`)
- Test: `tests/unit/live/test_api.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/live/test_api.py`:

```python
# ----- _compute_daily_gaps -----

from datetime import date as _date
from hoga.live.api import _compute_daily_gaps


def test_gaps_empty_cache_returns_full_range() -> None:
    gaps = _compute_daily_gaps(_date(2020, 1, 1), _date(2025, 12, 31), existing=[])
    assert gaps == [(_date(2020, 1, 1), _date(2025, 12, 31))]


def test_gaps_full_coverage_returns_empty() -> None:
    existing = [(_date(2020, 1, 1), _date(2025, 12, 31))]
    gaps = _compute_daily_gaps(_date(2021, 1, 1), _date(2024, 12, 31), existing)
    assert gaps == []


def test_gaps_prefix_gap() -> None:
    existing = [(_date(2020, 1, 1), _date(2025, 12, 31))]
    gaps = _compute_daily_gaps(_date(2018, 1, 1), _date(2022, 12, 31), existing)
    assert gaps == [(_date(2018, 1, 1), _date(2019, 12, 31))]


def test_gaps_suffix_gap() -> None:
    existing = [(_date(2020, 1, 1), _date(2022, 12, 31))]
    gaps = _compute_daily_gaps(_date(2020, 1, 1), _date(2024, 12, 31), existing)
    assert gaps == [(_date(2023, 1, 1), _date(2024, 12, 31))]


def test_gaps_middle_gap_between_two_batches() -> None:
    existing = [
        (_date(2020, 1, 1), _date(2022, 12, 31)),
        (_date(2024, 1, 1), _date(2025, 12, 31)),
    ]
    gaps = _compute_daily_gaps(_date(2021, 1, 1), _date(2024, 6, 30), existing)
    assert gaps == [(_date(2023, 1, 1), _date(2023, 12, 31))]


def test_gaps_adjacent_batches_coalesce() -> None:
    existing = [
        (_date(2020, 1, 1), _date(2022, 12, 31)),
        (_date(2023, 1, 1), _date(2025, 12, 31)),  # adjacent, no day gap
    ]
    gaps = _compute_daily_gaps(_date(2018, 1, 1), _date(2025, 12, 31), existing)
    assert gaps == [(_date(2018, 1, 1), _date(2019, 12, 31))]
```

- [ ] **Step 2: Run tests, verify ImportError**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "gaps"`
Expected: ImportError on `_compute_daily_gaps`.

- [ ] **Step 3: Implement gap computation**

Add to `hoga/live/api.py`:

```python
def _compute_daily_gaps(
    frm: date, too: date,
    existing: list[tuple[date, date]],
) -> list[tuple[date, date]]:
    """Compute non-overlapping gap intervals within [frm, too] not covered by
    existing batches.

    Algorithm:
    1. Filter `existing` to entries intersecting [frm, too].
    2. Sort by start.
    3. Merge overlapping/adjacent intervals (touching = same continuous day line).
    4. Walk and emit complement against [frm, too].

    Two existing batches `(a1, a2)` and `(b1, b2)` are *adjacent* when
    `b1 == a2 + 1 day` — in that case no day gap exists between them.
    """
    relevant = [(s, e) for (s, e) in existing if e >= frm and s <= too]
    if not relevant:
        return [(frm, too)]
    relevant.sort()
    merged: list[tuple[date, date]] = [relevant[0]]
    for s, e in relevant[1:]:
        last_s, last_e = merged[-1]
        if s <= last_e + timedelta(days=1):
            merged[-1] = (last_s, max(last_e, e))
        else:
            merged.append((s, e))

    gaps: list[tuple[date, date]] = []
    cursor = frm
    for s, e in merged:
        if s > cursor:
            gap_end = min(s - timedelta(days=1), too)
            if cursor <= gap_end:
                gaps.append((cursor, gap_end))
        cursor = max(cursor, e + timedelta(days=1))
        if cursor > too:
            break
    if cursor <= too:
        gaps.append((cursor, too))
    return gaps
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "gaps"`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "feat(live): _compute_daily_gaps — non-overlapping gap intervals with adjacency coalesce"
```

---

### Task B3: `_get_past_daily_candles` handler — wire it up

**Files:**
- Modify: `hoga/live/api.py` (`build_router` body: instantiate cache, add handler)
- Test: `tests/unit/live/test_api.py` (integration-style tests against `TestClient`)

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/live/test_api.py`:

```python
# ----- /api/live/past-daily-candles -----

from hoga.live.kis_client import DailyCandleFetchResult, DailyInvariantViolation


class _FakeKisForDaily:
    """Stub KIS client returning deterministic daily bars."""

    def __init__(self):
        self.calls: list[tuple[str, str, str]] = []  # (code, from, to)
        self.violations: list[DailyInvariantViolation] = []
        self.raise_rate_limit_on_call: int | None = None  # index to raise on

    async def fetch_past_daily_candles(
        self, code: str, from_yyyymmdd: str, to_yyyymmdd: str
    ) -> DailyCandleFetchResult:
        idx = len(self.calls)
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
        if self.raise_rate_limit_on_call is not None and idx == self.raise_rate_limit_on_call:
            from hoga.live.kis_client import KisRateLimitError
            raise KisRateLimitError("simulated rate limit")
        # One bar per date in range (inclusive).
        from datetime import datetime as _dt, timedelta as _td
        kst = datetime.timezone(datetime.timedelta(hours=9))
        y, m, d = int(from_yyyymmdd[:4]), int(from_yyyymmdd[4:6]), int(from_yyyymmdd[6:8])
        ye, me, de = int(to_yyyymmdd[:4]), int(to_yyyymmdd[4:6]), int(to_yyyymmdd[6:8])
        start = _dt(y, m, d, 9, 0, tzinfo=kst)
        end = _dt(ye, me, de, 9, 0, tzinfo=kst)
        candles = []
        cur = start
        while cur <= end:
            candles.append(KisCandle(
                t_ms=int(cur.timestamp() * 1000),
                open=100, high=110, low=95, close=105, volume=10,
            ))
            cur = cur + _td(days=1)
        return DailyCandleFetchResult(candles=candles, violations=list(self.violations))


def _daily_app(tmp_path, fake_kis):
    """Same shape as `_past_app` but exposes the daily endpoint too."""
    from fastapi import FastAPI
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    lifecycle.set_kis_client(fake_kis)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            get_kis_client=lifecycle.get_kis_client,
            data_dir=tmp_path,
        )
    )
    return app


def test_past_daily_cache_miss_calls_kis(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        body = r.json()
        # 5 daily bars
        assert len(body["candles"]) == 5
        assert "20240101__20240105" in body["fresh_batches"]
        assert body["cached_batches"] == []
        assert len(fake.calls) == 1


def test_past_daily_cache_hit_skips_kis(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r1 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r1.status_code == 200
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        body = r2.json()
        assert "20240101__20240105" in body["cached_batches"]
        assert body["fresh_batches"] == []
        # KIS called only the first time
        assert len(fake.calls) == 1


def test_past_daily_partial_hit_gap_fill(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        c.get("/api/live/past-daily-candles?code=005930&from=20240301&to=20240501")
        # Subsequent request extends backward — only the gap should be fetched.
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240501")
        body = r2.json()
        assert len(fake.calls) == 2
        # Second KIS call covers the gap [20240101, 20240229]
        _, gap_from, gap_to = fake.calls[1]
        assert gap_from == "20240101"
        assert gap_to == "20240229"
        # candles span the full requested range, ASC, no dup t_ms
        ts = [c["t_ms"] for c in body["candles"]]
        assert ts == sorted(set(ts))


def test_past_daily_rate_limit_surfaces_data_warning(tmp_path) -> None:
    fake = _FakeKisForDaily()
    fake.raise_rate_limit_on_call = 1  # first call OK, second (gap) raises
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        c.get("/api/live/past-daily-candles?code=005930&from=20240301&to=20240501")
        # Second request hits gap and rate-limits on the gap fetch.
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240501")
        body = r2.json()
        assert any(w["reason"] == "kis_rate_limit" for w in body["data_warnings"])


def test_past_daily_violation_surfaces_to_wire(tmp_path) -> None:
    fake = _FakeKisForDaily()
    fake.violations = [DailyInvariantViolation(
        date_yyyymmdd="20240103", reason="close_nonpositive", detail="close=0",
    )]
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        body = r.json()
        warn = [w for w in body["data_warnings"] if w["reason"] == "invariant_violation"]
        assert len(warn) == 1
        assert "20240103" in warn[0]["msg"]


def test_past_daily_dedupes_and_sorts_overlapping_batches(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        # Two requests with overlapping ranges → two batches in cache.
        c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        c.get("/api/live/past-daily-candles?code=005930&from=20240103&to=20240107")
        r3 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240107")
        body = r3.json()
        ts = [c["t_ms"] for c in body["candles"]]
        assert ts == sorted(set(ts))
        assert len(ts) == 7  # 7 distinct dates


def test_past_daily_validation_404_when_kis_not_wired(tmp_path) -> None:
    from fastapi import FastAPI
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    lifecycle.set_kis_client(None)
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        get_kis_client=lifecycle.get_kis_client,
        data_dir=tmp_path,
    ))
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r.status_code == 503
```

- [ ] **Step 2: Run tests, verify all fail (404 on unknown route)**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "past_daily"`
Expected: 404 from `TestClient` (route not registered).

- [ ] **Step 3: Add cache wiring + handler to `build_router`**

In `hoga/live/api.py`, near the existing `cache_instance = PastCandlesCache(...)` line (around line 163), add:

```python
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache  # add to imports

# inside build_router(), beside cache_instance:
daily_cache_instance: PastDailyCandlesCache | None = (
    PastDailyCandlesCache() if data_dir is not None else None
)
```

Note: even though daily cache uses no disk, we tie its instantiation to `data_dir is not None` so the wiring story stays parallel with the minute cache — both are created together in the same lifecycle.

Then add the handler (immediately after `_get_past_candles`):

```python
    @router.get("/past-daily-candles")
    async def _get_past_daily_candles(
        code: str = Query(...),
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
    ) -> dict:
        frm, too, today_d = _validate_daily_past_request(code, from_, to)
        today_s = today_d.strftime("%Y%m%d")
        from_s = frm.strftime("%Y%m%d")
        to_s = too.strftime("%Y%m%d")

        if get_kis_client is None:
            raise HTTPException(503, "KIS client not wired")
        kis = get_kis_client()
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        if daily_cache_instance is None:
            raise HTTPException(503, "past-daily-candles cache not wired (data_dir missing)")
        cache = daily_cache_instance

        warnings: list[dict] = []
        cached_batches: list[str] = []
        fresh_batches: list[str] = []
        loaded_bars: list[dict] = []

        # 1+2. Read existing batches, filter to those intersecting request.
        existing_all = cache.list_batches(code)
        existing_relevant: list[tuple[date, date]] = []
        for b_from, b_to, b_bars in existing_all:
            if b_to < frm or b_from > too:
                continue
            existing_relevant.append((b_from, b_to))
            loaded_bars.extend(b_bars)
            cached_batches.append(
                f"{b_from.strftime('%Y%m%d')}__{b_to.strftime('%Y%m%d')}"
            )

        # 3. Compute gaps (past-only — today handled separately).
        req_to_past = min(too, today_d - timedelta(days=1))
        if frm <= req_to_past:
            gaps = _compute_daily_gaps(frm, req_to_past, existing_relevant)
            for gap_from, gap_to in gaps:
                gap_from_s = gap_from.strftime("%Y%m%d")
                gap_to_s = gap_to.strftime("%Y%m%d")
                label = f"{gap_from_s}__{gap_to_s}"
                try:
                    result = await kis.fetch_past_daily_candles(
                        code, gap_from_s, gap_to_s,
                    )
                except KisRateLimitError as e:
                    warnings.append({
                        "batch": label, "reason": "kis_rate_limit", "msg": str(e),
                    })
                    break  # don't hammer KIS — matches minute aborted pattern
                except KisApiError as e:
                    warnings.append({
                        "batch": label, "reason": "kis_api_error", "msg": e.msg_cd,
                    })
                    continue
                # Cache clean part (violations don't block caching — see spec D3.4).
                bars_dicts = [_candle_to_dict(c) for c in result.candles]
                cache.append_batch(code, gap_from, gap_to, bars_dicts)
                loaded_bars.extend(bars_dicts)
                fresh_batches.append(label)
                for v in result.violations:
                    warnings.append({
                        "batch": label,
                        "reason": "invariant_violation",
                        "msg": f"{v.date_yyyymmdd}: {v.reason} ({v.detail})",
                    })

        # 5. Today handling (separate from past — memory only, tri-state).
        if too >= today_d:
            state, today_bar = cache.get_today(code)
            if state == "hit":
                loaded_bars.append(today_bar)  # type: ignore[arg-type]
                cached_batches.append(f"{today_s}__{today_s}")
            elif state == "negative":
                pass  # known non-trading day; skip KIS, no row
            else:  # miss
                try:
                    result = await kis.fetch_past_daily_candles(code, today_s, today_s)
                    if result.candles:
                        today_bar = _candle_to_dict(result.candles[0])
                        cache.store_today(code, today_bar)
                        loaded_bars.append(today_bar)
                        fresh_batches.append(f"{today_s}__{today_s}")
                    else:
                        # Non-trading day for today — negative cache for 60s.
                        cache.store_today(code, None)
                    for v in result.violations:
                        warnings.append({
                            "batch": f"{today_s}__{today_s}",
                            "reason": "invariant_violation",
                            "msg": f"{v.date_yyyymmdd}: {v.reason} ({v.detail})",
                        })
                except KisRateLimitError as e:
                    warnings.append({
                        "batch": f"{today_s}__{today_s}",
                        "reason": "kis_rate_limit", "msg": str(e),
                    })
                except KisApiError as e:
                    warnings.append({
                        "batch": f"{today_s}__{today_s}",
                        "reason": "kis_api_error", "msg": e.msg_cd,
                    })

        # 6. Dedupe by t_ms, sort, filter to [frm, too].
        from datetime import datetime as _dt, time as _time
        frm_ms = int(_dt.combine(frm, _time(0, 0), tzinfo=_KST).timestamp() * 1000)
        too_ms = int(_dt.combine(too, _time(23, 59, 59), tzinfo=_KST).timestamp() * 1000)
        by_ts: dict[int, dict] = {}
        for bar in loaded_bars:
            ts = bar.get("t_ms")
            if isinstance(ts, int):
                by_ts[ts] = bar  # last-write-wins
        candles_all = sorted(
            (b for ts, b in by_ts.items() if frm_ms <= ts <= too_ms),
            key=lambda b: b["t_ms"],
        )

        return {
            "code": code,
            "from": from_s,
            "to": to_s,
            "candles": candles_all,
            "cached_batches": cached_batches,
            "fresh_batches": fresh_batches,
            "data_warnings": warnings,
        }
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "past_daily"`
Expected: all PASS.

- [ ] **Step 5: Run full live api test file to check for regressions**

Run: `uv run pytest tests/unit/live/test_api.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "feat(live): GET /api/live/past-daily-candles handler + memory cache wiring"
```

---

### Task B3a (eng-review Critical added): Additional regression tests

Add to `tests/unit/live/test_api.py` (same _daily_app fixture):

```python
def test_past_daily_empty_gap_caches_and_does_not_refetch(tmp_path) -> None:
    """KIS returning [] for a gap (range fully non-trading) must still cache
    the empty batch so a follow-up request inside that range hits the cache
    instead of re-calling KIS. Prevents infinite re-fetch on holiday ranges."""

    class _EmptyKis(_FakeKisForDaily):
        async def fetch_past_daily_candles(self, code, from_yyyymmdd, to_yyyymmdd):
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            from hoga.live.kis_client import DailyCandleFetchResult
            return DailyCandleFetchResult(candles=[], violations=[])

    fake = _EmptyKis()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        # First call: gap fetched, empty result cached.
        r1 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r1.status_code == 200
        assert len(fake.calls) == 1
        # Second call (same range): hits cached empty batch, no KIS call.
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r2.status_code == 200
        body = r2.json()
        assert "20240101__20240105" in body["cached_batches"]
        assert body["fresh_batches"] == []
        assert len(fake.calls) == 1  # KIS NOT called second time


def test_past_daily_single_day_past_request(tmp_path) -> None:
    """frm == too < today should fetch a 1-day gap and cache it."""
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240101")
        assert r.status_code == 200
        body = r.json()
        assert len(body["candles"]) == 1
        assert len(fake.calls) == 1
        _, gap_from, gap_to = fake.calls[0]
        assert gap_from == "20240101" and gap_to == "20240101"


def test_past_daily_today_only_request_skips_gap_branch(tmp_path) -> None:
    """frm == too == today must NOT enter the gap branch (req_to_past=today-1
    < frm). All work happens in the today branch."""
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    today = _today_kst_yyyymmdd()
    with TestClient(app) as c:
        r = c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        assert r.status_code == 200
        # Exactly one KIS call — for today, not for a phantom "gap".
        assert len(fake.calls) == 1
        _, call_from, call_to = fake.calls[0]
        assert call_from == today and call_to == today


def test_past_daily_today_negative_cache_skips_kis_within_ttl(tmp_path) -> None:
    """When today is non-trading (KIS returns empty), negative-cache it so
    a second request within TTL skips KIS."""

    class _EmptyTodayKis(_FakeKisForDaily):
        async def fetch_past_daily_candles(self, code, from_yyyymmdd, to_yyyymmdd):
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            from hoga.live.kis_client import DailyCandleFetchResult
            return DailyCandleFetchResult(candles=[], violations=[])

    fake = _EmptyTodayKis()
    app = _daily_app(tmp_path, fake)
    today = _today_kst_yyyymmdd()
    with TestClient(app) as c:
        c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        assert len(fake.calls) == 1  # second call skipped via negative cache
```

Run: `uv run pytest tests/unit/live/test_api.py -v -k "past_daily"`. All PASS.

Commit:

```bash
git add tests/unit/live/test_api.py
git commit -m "test(live): /past-daily-candles edge cases — empty gap, single day, today-only, today negative"
```

---

### Task B3b (eng-review Critical added): Surface today's `fresh_batches` correctly

The B3 handler appends `f"{today_s}__{today_s}"` to `fresh_batches` only when
the today fetch returned a non-empty `result.candles`. For consistency with
gap fetches (which append the label even for empty results — see B3a empty-gap
test) and for operator visibility, also append the today label when the
negative cache path runs:

```python
            else:  # miss
                try:
                    result = await kis.fetch_past_daily_candles(code, today_s, today_s)
                    if result.candles:
                        today_bar = _candle_to_dict(result.candles[0])
                        cache.store_today(code, today_bar)
                        loaded_bars.append(today_bar)
                        fresh_batches.append(f"{today_s}__{today_s}")
                    else:
                        # Non-trading day — negative cache, still record the fetch
                        # in fresh_batches so the wire faithfully reflects the
                        # KIS round-trip (matches gap-branch behavior).
                        cache.store_today(code, None)
                        fresh_batches.append(f"{today_s}__{today_s}")
                    # ... violations loop unchanged ...
```

---

### Task B4: App-level wiring — verify `data_dir` already passes to `build_router`

**Files:**
- Modify: `hoga/api/app.py` (the lone call site)

**eng-review note:** Verified `build_live_router(...)` at `hoga/api/app.py:181` already
passes `data_dir=data_dir`. No change required — `PastDailyCandlesCache` is
instantiated inside `build_router` when `data_dir is not None` (Task B3). Tests
use the same parameter via `_past_app(tmp_path, fake_kis)` / `_daily_app(...)`.

- [ ] **Step 1: Confirm `build_router` call site (read-only check)**

Run: `grep -rn "build_live_router\|build_router(" hoga/api/app.py hoga/live/api.py`
Expected: a single `build_live_router(..., data_dir=data_dir)` call in `hoga/api/app.py`.

- [ ] **Step 2: Smoke-test the wiring**

Run: `uv run pytest tests/integration/live/ -v` (and any other integration tests that exercise `build_router`).
Expected: all PASS.

- [ ] **Step 3: Commit if any change was made**

```bash
git add hoga/api/app.py  # adjust path
git commit -m "feat(live): wire PastDailyCandlesCache via existing data_dir param"
```

(Skip this commit if no change was needed.)

---

## Phase C — Minute path parity (today negative caching)

### Task C1: `PastCandlesCache.store_today / get_today` tri-state extension

**Files:**
- Modify: `hoga/live/past_candles_cache.py`
- Test: `tests/unit/live/test_past_candles_cache.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/live/test_past_candles_cache.py`:

```python
# ----- today negative caching -----


def test_today_hit_returns_hit_state(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    bars = _bars_for("20260520", n=3)
    cache.store_today("005930", bars)
    state, value = cache.get_today_tri("005930")
    assert state == "hit"
    assert value == bars


def test_today_miss_returns_miss_state(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    state, value = cache.get_today_tri("005930")
    assert state == "miss"
    assert value is None


def test_today_negative_cache(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_today("005930", None)
    state, value = cache.get_today_tri("005930")
    assert state == "negative"
    assert value is None


def test_today_negative_cache_ttl_expiry(tmp_path: Path) -> None:
    cache = PastCandlesCache(data_dir=tmp_path, today_ttl_seconds=10.0)
    cache.store_today("005930", None)
    with patch("hoga.live.past_candles_cache.time.monotonic",
               return_value=time.monotonic() + 11.0):
        state, _ = cache.get_today_tri("005930")
    assert state == "miss"
```

Add `from unittest.mock import patch` at the top of the file.

- [ ] **Step 2: Run tests, verify they fail**

Run: `uv run pytest tests/unit/live/test_past_candles_cache.py -v -k "today"`
Expected: AttributeError on `get_today_tri` (the new tri-state accessor).

- [ ] **Step 3: Extend `PastCandlesCache` with tri-state today**

**eng-review Critical (C-2) note:** The original plan claimed the legacy
`get_today(code)` delegating wrapper preserves "backward compatibility" and
"behavior stays consistent". Verified via `grep get_today hoga/ tests/`: the
only production caller of the legacy `get_today` is `_get_past_candles` at
`hoga/live/api.py:214`, which Task C2 rewrites to use `get_today_tri`. The
only remaining callers are 3 test assertions in
`tests/unit/live/test_past_candles_cache.py:53-62`. Those tests pass with
the wrapper but the wrapper IS a semantic regression in disguise — it maps
"negative cache" to the same return as "miss", which is exactly the bug the
plan is fixing for the handler. Therefore: **delete the legacy `get_today`
in C1 Step 3** (instead of keeping a delegating wrapper), and update the 3
test assertions to call `get_today_tri` directly. This way no future caller
can ever silently observe negative-cache-as-miss again.

In `hoga/live/past_candles_cache.py`:

```python
# Replace the existing today methods. DROP the legacy get_today — see eng-review
# Critical C-2 above. C2 migrates the only production caller; the tests are
# updated alongside.

from typing import Literal

TodayState = Literal["hit", "miss", "negative"]


class PastCandlesCache:
    # ... existing __init__ stays, but change the type:
    # self._today_mem: dict[str, tuple[float, list[dict] | None]] = {}

    # Replace store_today signature:
    def store_today(self, code: str, bars: list[dict] | None) -> None:
        """Store *bars* (or None for negative cache — non-trading-day today)
        with monotonic-clock TTL stamp."""
        self._today_mem[code] = (time.monotonic(), bars)

    # Add tri-state accessor (new):
    def get_today_tri(self, code: str) -> tuple[TodayState, list[dict] | None]:
        entry = self._today_mem.get(code)
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return "miss", None
        if value is None:
            return "negative", None
        return "hit", value

    # Legacy get_today() is removed (eng-review C-2). Callers must use
    # get_today_tri() and explicitly handle the "negative" state.
```

Also update `tests/unit/live/test_past_candles_cache.py` lines 53, 55, 62
(the only remaining `get_today` callers) to use `get_today_tri` and assert on
the `(state, value)` tuple. The 3 existing tests stay in place; only the
assertion shape changes.

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/unit/live/test_past_candles_cache.py -v`
Expected: all PASS (including pre-existing tests — backward compatibility preserved).

- [ ] **Step 5: Commit**

```bash
git add hoga/live/past_candles_cache.py tests/unit/live/test_past_candles_cache.py
git commit -m "feat(live): PastCandlesCache tri-state today + negative cache support"
```

---

### Task C2: Minute handler `_get_past_candles` — use tri-state, store negative cache

**Files:**
- Modify: `hoga/live/api.py` (`_get_past_candles` today branch)
- Test: `tests/unit/live/test_api.py`

- [ ] **Step 1: Write failing test**

Append to `tests/unit/live/test_api.py`:

```python
def test_minute_today_non_trading_day_negative_caches(tmp_path) -> None:
    """When today's KIS minute fetch returns empty, the cache stores a
    negative sentinel so a follow-up request within the TTL skips KIS."""

    class _EmptyTodayKis:
        def __init__(self):
            self.calls = 0

        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            self.calls += 1
            return []  # simulate Saturday / holiday today

    fake = _EmptyTodayKis()
    app = _past_app(tmp_path, fake)
    today = _today_kst_yyyymmdd()
    with TestClient(app) as c:
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == 1  # second call skipped via negative cache
```

- [ ] **Step 2: Run test, verify it fails**

Run: `uv run pytest tests/unit/live/test_api.py -v -k "negative_caches"`
Expected: FAIL — `fake.calls == 2` (current code calls KIS every time for today).

- [ ] **Step 3: Modify `_get_past_candles` today branch**

In `hoga/live/api.py`, locate the today branch inside `_get_past_candles` (currently around line 213-222):

```python
                else:  # date_s == today_s
                    state, today_bars = cache.get_today_tri(code)
                    if state == "hit":
                        bars = today_bars  # type: ignore[assignment]
                    elif state == "negative":
                        bars = []  # known empty today (non-trading day)
                    else:  # miss
                        raw = await kis.fetch_past_minute_candles(code, date_s)
                        bars = [_candle_to_dict(c) for c in raw]
                        if bars:
                            cache.store_today(code, bars)
                            fresh_dates.append(date_s)
                        else:
                            # Negative cache: known non-trading day, skip KIS for TTL.
                            cache.store_today(code, None)
                    if state == "hit":
                        cached_dates.append(date_s)
                    elif state == "negative":
                        # We have *no data* but it's not an error — surface as warning
                        # so the frontend can distinguish "missing because non-trading"
                        # from "missing because we haven't fetched yet".
                        pass
                candles_all.extend(bars)
```

(Adjust the existing if/else cleanly. The key invariant: when state is `"negative"`, we add nothing to `candles_all` and don't call KIS.)

- [ ] **Step 4: Run tests, verify they pass**

Run: `uv run pytest tests/unit/live/test_api.py -v`
Expected: all PASS (including new + existing past-candles tests).

- [ ] **Step 5: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "feat(live): minute /past-candles today branch uses tri-state + negative cache"
```

---

## Phase D — Frontend wire + hook

### Task D0 (eng-review Blocker B-1): InvariantOutcomesBanner shape mismatch

**Files:**
- Read: `frontend/src/replay/InvariantOutcomesBanner.tsx`,
  `frontend/src/live/LiveWorkarea.tsx`, `frontend/src/api/types.ts`
- Modify: `hoga/live/api.py` (`_get_past_daily_candles` warnings shape) OR
  `frontend/src/api/types.ts` + `InvariantOutcomesBanner.tsx`

**Problem (verified by reading the code):**

The spec section D9 claims `data_warnings` from `/past-daily-candles` will render
in `InvariantOutcomesBanner` via the existing wiring. That is false in two ways:

1. The banner consumes `bundle.data_warnings` (a `DateWarning[]` with shape
   `{date: YYYYMMDD, warnings: ViolationWire[]}`) which is sourced from
   `pastBundle?.data_warnings` in `buildLiveBundle.ts:142` — i.e. the
   `/api/range` RangeBundle, NOT the past-candles wire. The minute path's
   `/api/live/past-candles` `data_warnings` (shape `{date, reason, msg}`) is
   already not surfaced anywhere. This is a pre-existing gap inherited, not
   introduced.
2. The new daily wire's `data_warnings` shape is `{batch, reason, msg}` —
   `batch` is a date *range* string like `"20240101__20240229"`, not a single
   YYYYMMDD. Even if we wired daily warnings into the bundle, the banner's
   `fmtMD(yyyymmdd.slice(4, 6))` would slice into the `__` separator and
   render garbage.

**Decision (engineering recommendation):** keep the `{batch, reason, msg}` wire
shape (it's semantically correct — gap fetches return a range, not a date) and
do BOTH of the following:

a) In the backend handler, when a violation has a `date_yyyymmdd`, emit it as
   a *second* `date` field alongside `batch` so the most useful info is
   immediately accessible:

```python
warnings.append({
    "batch": label,
    "date": v.date_yyyymmdd,           # NEW — single-day violations
    "reason": "invariant_violation",
    "msg": f"{v.reason} ({v.detail})",
})
```

   `kis_rate_limit` / `kis_api_error` warnings still omit `date` because they
   apply to the whole batch.

b) Wire daily warnings into the bundle by adapting them in the
   `useLiveBundle` daily branch (D3) to `DateWarning[]` shape:

```ts
const dailyWarningsAsDate: DateWarning[] = (pastDailyCandlesQuery.data?.data_warnings ?? [])
  .filter((w) => w.date != null)
  .map((w) => ({
    date: w.date as string,
    warnings: [{ invariant_id: w.reason, message: w.msg }],
  }));
```

   Then thread `dailyWarningsAsDate` into the bundle's `data_warnings`. The
   banner stays untouched (no Frontend type widening).

**Out of scope acknowledgement:** batch-level warnings (`kis_rate_limit`,
`kis_api_error`) and minute-path `data_warnings` are NOT surfaced by this
patch. Tracked as follow-up: "InvariantOutcomesBanner: support batch + reason
warnings (minute + daily)". The user should be aware that today, if KIS
rate-limits in the middle of a backfill, the chart degrades silently — the
chart shows partial data with no UI explanation. Filing this follow-up is
strongly recommended.

- [ ] **Step 1: Add `date` field to handler warnings in Task B3**

When implementing B3, emit `date=v.date_yyyymmdd` alongside `batch` for
`invariant_violation` warnings. Update B3's
`test_past_daily_violation_surfaces_to_wire` to assert `warn[0]["date"] == "20240103"`.

- [ ] **Step 2: Update `livePastDailyCandles.ts` wire type (Task D1)**

```ts
export interface LivePastDailyCandlesWarning {
  batch: string;
  date?: string;  // present when the warning is per-row (invariant_violation)
  reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation';
  msg: string;
}
```

- [ ] **Step 3: In Task D3 (`useLiveBundle`), merge daily warnings into bundle**

Map daily wire warnings with a `date` field into `DateWarning[]` and add to
the bundle so the existing `InvariantOutcomesBanner` surfaces them. Add a
test: render with one `invariant_violation` warning and assert the banner
shows the corresponding MM/DD.

- [ ] **Step 4: File follow-up issue**

Title: "InvariantOutcomesBanner: support batch + reason warnings (live
past-candles minute + daily)". Body: link this plan. Don't block Phase F on it.

---

### Task D1: `livePastDailyCandles.ts` — wire types + react-query hook

**Files:**
- Create: `frontend/src/api/livePastDailyCandles.ts`
- Test: `frontend/src/api/livePastDailyCandles.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
// frontend/src/api/livePastDailyCandles.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLivePastDailyCandles, type LivePastDailyCandlesResponse } from './livePastDailyCandles';
import * as client from './client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const RESPONSE: LivePastDailyCandlesResponse = {
  code: '005930',
  from: '20240101',
  to: '20240105',
  candles: [{ t_ms: 1, open: 100, high: 110, low: 95, close: 105, volume: 10 }],
  cached_batches: [],
  fresh_batches: ['20240101__20240105'],
  data_warnings: [],
};

describe('useLivePastDailyCandles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches daily bars for given code+from+to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastDailyCandles('005930', '20240101', '20240105'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith(
      '/api/live/past-daily-candles?code=005930&from=20240101&to=20240105',
    );
  });

  it('does not fetch when code is null', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastDailyCandles(null, '20240101', '20240105'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fetch when from > to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastDailyCandles('005930', '20240105', '20240101'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd frontend && npm test -- livePastDailyCandles`
Expected: FAIL with import error on `useLivePastDailyCandles`.

- [ ] **Step 3: Implement the hook**

```ts
// frontend/src/api/livePastDailyCandles.ts
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiCall } from './client';

export interface LivePastDailyCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LivePastDailyCandlesWarning {
  batch: string;
  reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation';
  msg: string;
}

export interface LivePastDailyCandlesResponse {
  code: string;
  from: string;
  to: string;
  candles: LivePastDailyCandle[];
  cached_batches: string[];
  fresh_batches: string[];
  data_warnings: LivePastDailyCandlesWarning[];
}

export function useLivePastDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-daily-candles', code, from, to] as const,
    queryFn: () =>
      apiCall<LivePastDailyCandlesResponse>(
        `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}`,
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd frontend && npm test -- livePastDailyCandles`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/livePastDailyCandles.ts frontend/src/api/livePastDailyCandles.test.tsx
git commit -m "feat(live): useLivePastDailyCandles hook + wire types"
```

---

### Task D2: `aggregateCalendar('D', dailyInput)` identity-ish regression test

**Files:**
- Modify: `frontend/src/live/aggregateCandles.test.ts`

- [ ] **Step 1: Write the regression test**

Append to `frontend/src/live/aggregateCandles.test.ts`:

```ts
// Regression for ADR-0048 / D-direct spec D7:
// aggregateCalendar('D', dailyInput) must be identity-ish — input is
// already daily bars, one per trading day, so each bar gets its own
// bucket and the OHLCV is preserved verbatim.
describe("aggregateCalendar('D') with already-daily input", () => {
  it('passes daily bars through unchanged (one bucket per bar)', () => {
    const kst = (y: number, m: number, d: number) => {
      // 09:00 KST → UTC ms
      const utc = Date.UTC(y, m - 1, d, 0, 0); // 09:00 KST = 00:00 UTC
      return utc;
    };
    const input = [
      { t_ms: kst(2024, 1, 2), open: 100, high: 110, low: 95, close: 105, volume: 1000 },
      { t_ms: kst(2024, 1, 3), open: 105, high: 115, low: 100, close: 112, volume: 2000 },
      { t_ms: kst(2024, 1, 4), open: 112, high: 120, low: 108, close: 118, volume: 1500 },
    ];
    const out = aggregateCalendar(input, 'D');
    expect(out).toHaveLength(3);
    out.forEach((bar, i) => {
      expect(bar.t_ms).toBe(input[i].t_ms);
      expect(bar.open).toBe(input[i].open);
      expect(bar.high).toBe(input[i].high);
      expect(bar.low).toBe(input[i].low);
      expect(bar.close).toBe(input[i].close);
      expect(bar.volume).toBe(input[i].volume);
    });
  });

  it('aggregateCalendar(W) with daily bars within one ISO week → single bucket', () => {
    const kst = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 0, 0);
    // Mon 2024-01-01 through Fri 2024-01-05 — all same week.
    const input = [
      { t_ms: kst(2024, 1, 1), open: 100, high: 110, low: 90, close: 105, volume: 100 },
      { t_ms: kst(2024, 1, 2), open: 105, high: 120, low: 100, close: 115, volume: 200 },
      { t_ms: kst(2024, 1, 3), open: 115, high: 125, low: 110, close: 120, volume: 150 },
      { t_ms: kst(2024, 1, 4), open: 120, high: 130, low: 115, close: 125, volume: 175 },
      { t_ms: kst(2024, 1, 5), open: 125, high: 135, low: 120, close: 130, volume: 225 },
    ];
    const out = aggregateCalendar(input, 'W');
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(100);     // first bar's open
    expect(out[0].close).toBe(130);    // last bar's close
    expect(out[0].high).toBe(135);     // max of highs
    expect(out[0].low).toBe(90);       // min of lows
    expect(out[0].volume).toBe(850);   // sum of volumes
  });
});
```

- [ ] **Step 2: Run, verify both tests pass without source changes**

Run: `cd frontend && npm test -- aggregateCandles`
Expected: all PASS (the function is already correct for daily input; this test pins that behavior).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/live/aggregateCandles.test.ts
git commit -m "test(live): regression — aggregateCalendar identity-ish for daily input (ADR-0048)"
```

---

### Task D3: `useLiveBundle` — branch on isMinute, route to daily hook for D/W/M

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`

- [ ] **Step 1: Write failing tests**

Open `frontend/src/live/useLiveBundle.test.tsx` and append (adjust imports as needed):

```tsx
// ADR-0048 / D-direct spec D6:
// - D/W/M timeframe enables useLivePastDailyCandles only
// - minute timeframe enables useLivePastCandles only
// - clampEngaged is false for D/W/M regardless of historicalFromDate

import * as minuteHookMod from '../api/livePastCandles';
import * as dailyHookMod from '../api/livePastDailyCandles';

describe('useLiveBundle daily/minute branching (ADR-0048)', () => {
  it('D timeframe enables daily hook, disables minute hook', async () => {
    const dailySpy = vi.spyOn(dailyHookMod, 'useLivePastDailyCandles');
    const minuteSpy = vi.spyOn(minuteHookMod, 'useLivePastCandles');
    // render useLiveBundle with timeframe='D' — adjust to the test file's
    // existing wrapper pattern (QueryClient, store init, etc.)
    // ... existing harness ...
    // After render:
    expect(dailySpy).toHaveBeenCalledWith('005930', expect.any(String), expect.any(String));
    // Minute hook still called with nulls (gating via enabled flag inside hook):
    const lastMinuteCall = minuteSpy.mock.calls[minuteSpy.mock.calls.length - 1];
    expect(lastMinuteCall[0]).toBeNull(); // code arg is null when isMinute=false
  });

  it('1m timeframe enables minute hook, disables daily hook', async () => {
    // Mirror of the above, swapped.
  });

  it('clampEngaged is false on D when historicalFromDate is very old', async () => {
    // Render with timeframe='D', historicalFromDate='20100101', verify clampEngaged === false
  });

  it('clampEngaged is true on 1m when historicalFromDate is older than 250d', async () => {
    // Render with timeframe='1m', historicalFromDate='20100101', verify clampEngaged === true
  });
});
```

(The exact test structure depends on the existing `useLiveBundle.test.tsx` harness — adapt to match.)

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd frontend && npm test -- useLiveBundle`
Expected: FAIL — daily hook not called.

- [ ] **Step 3: Modify `useLiveBundle.ts`**

Edit `frontend/src/live/useLiveBundle.ts`:

```ts
// Add import:
import { useLivePastDailyCandles } from '../api/livePastDailyCandles';

// Inside useLiveBundle(), replace the existing past-candles + kisCandles blocks:

const isMinute = isMinuteTimeframe(timeframe);

// Minute path — preserved exactly as before, gated by isMinute.
const seedFrom = historicalFromDate ?? subtractDaysKst(todayKstYyyymmdd, INITIAL_HISTORICAL_DAYS);
const earliestAllowedMinute = subtractDaysKst(todayKstYyyymmdd, PAST_CANDLES_MAX_DAYS - 1);
const minutePastFrom = laterDate(seedFrom, earliestAllowedMinute);
const minutePastTo = todayKstYyyymmdd;

const enableMinute = !!(code && isMinute && minutePastFrom <= minutePastTo);
const pastCandlesQuery = useLivePastCandles(
  enableMinute ? code : null,
  enableMinute ? minutePastFrom : null,
  enableMinute ? minutePastTo : null,
);

// Daily path — new, no clamp, gated by !isMinute.
const enableDaily = !!(code && !isMinute);
const dailyPastFrom = seedFrom;   // no clamp — user can scroll back uncapped
const dailyPastTo = todayKstYyyymmdd;
const pastDailyCandlesQuery = useLivePastDailyCandles(
  enableDaily ? code : null,
  enableDaily ? dailyPastFrom : null,
  enableDaily ? dailyPastTo : null,
);

// hoga indicators (/api/range) — minute only, unchanged.
const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;
const enableRange = !!(code && isMinute && minutePastFrom <= minutePastTo);
const past = useRange(
  enableRange ? code : null,
  enableRange ? minutePastFrom : null,
  enableRange ? minutePastTo : null,
  enableRange ? (timeframe as Timeframe) : null,
);

const kisCandles = useMemo<Candle[]>(() => {
  if (isMinute) {
    const raw = pastCandlesQuery.data?.candles ?? [];
    if (raw.length === 0) return [];
    const bars = aggregateCandles(raw, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000);
    return bars.map(kisBarToCandle);
  }
  // Daily path: D = raw bars, W/M = aggregateCalendar over already-daily input.
  const raw = pastDailyCandlesQuery.data?.candles ?? [];
  if (raw.length === 0) return [];
  const bars = timeframe === 'D' ? raw : aggregateCalendar(raw, timeframe as 'W' | 'M');
  return bars.map(kisBarToCandle);
}, [
  isMinute, timeframe,
  pastCandlesQuery.data, pastDailyCandlesQuery.data,
]);

// clampEngaged: minute only.
const clampEngaged = isMinute
  && historicalFromDate != null
  && historicalFromDate < earliestAllowedMinute;

return {
  bundle,  // existing computation below this block, unchanged
  isLoading: live.isLoading || past.isLoading
    || pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading,
  error: live.error ?? past.error
    ?? pastCandlesQuery.error ?? pastDailyCandlesQuery.error ?? null,
  clampEngaged,
  isPastCandlesLoading:
    pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading,
};
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd frontend && npm test -- useLiveBundle`
Expected: all PASS.

- [ ] **Step 5: Run the full frontend live test suite for regressions**

Run: `cd frontend && npm test -- live`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/useLiveBundle.ts frontend/src/live/useLiveBundle.test.tsx
git commit -m "feat(live): useLiveBundle routes D/W/M through new daily endpoint (ADR-0048)"
```

---

## Phase E — Docs

### Task E1: ADR-0048 — Live Daily Direct Backfill

**Files:**
- Create: `docs/adr/0048-live-daily-direct-backfill.md`

- [ ] **Step 1: Write ADR**

```markdown
# 0047 — /live D-direct daily backfill: 별도 endpoint + 메모리 cache, ADR-0040과 병렬

**Status:** accepted (2026-05-28)

**Related:**
- ADR-0013 (RangeBundle single read-path)
- ADR-0020 (invariant catalog)
- ADR-0040 (Live Candle Backfill 별도 cache + 별도 wire)
- ADR-0045 (spec declares invariants)
- `docs/superpowers/specs/2026-05-28-live-daily-direct-backfill-design.md`

## Decision

`/live` 페이지의 일봉(D/W/M) backfill 은 신규 endpoint
`GET /api/live/past-daily-candles` 가 서비스한다. 분봉 endpoint
`GET /api/live/past-candles` 와 형제 구조:

1. **별도 endpoint + 별도 wire**. `LivePastDailyCandlesResponse` 모델,
   `cached_batches` / `fresh_batches` per-batch metadata.
2. **메모리 only cache** (디스크 안 둠). 일봉 데이터는 작아서 (~250 KB / code /
   20년) 디스크가 불필요. process restart 가 자연 invalidation.
3. **별도 KIS client method**. `fetch_past_daily_candles` (TR_ID `FHKST03010100`,
   period_div_code='D'). 반환 타입 `DailyCandleFetchResult` 가 invariant
   violation 을 caller 로 surface.
4. **Cap 없음**. 분봉의 250-day cap 과 달리 D-direct 는 무제한;
   rate-limit/api-error 는 partial response + data_warnings 로 처리.

본 ADR 은 ADR-0040 과 *병렬 supersede 아님*. 두 균열은 같은 `/live` 도메인 안에
갇혀 있다 — ADR-0013 의 spirit 과의 균열이 두 개로 늘어났지만 *지역성*은 보존.

## Why

분봉 250 일 캡의 본질은 *payload 보호*. 캡 없이 5년치 일봉을 1분봉 경유로 전송하면
N × ~96,000 bars JSON 으로 폭발. D-direct 는 같은 비용을 ~1/390 로 줄여 캡을 자연
무관하게 만든다.

W/M 는 별도 backend serving 하지 않는다 — D 는 한 종목 5년치 ~1,250 bars 로
client 의 `aggregateCalendar` 비용 무시 수준. cache 1개로 충분.

메모리 only 정당화: 분봉의 disk cache 는 *데이터 양* (~300 MB worst case) 때문에
필요. 일봉은 ~12 MB worst case → 메모리에 다 들어감. 디스크 file format / atomic
write / corrupt file handling / "operator deletes cache file to refresh" 같은
복잡도가 모두 사라짐. restart 시 cold start ~10-30 초는 단일 사용자 로컬 dev tool
에서 수용 가능 (사용자 동의).

## Trade-offs

- **(채택) 메모리 only.** restart = 자연 invalidation. dev workflow 의 `--reload
  --reload-dir hoga` 가 자주 restart 를 트리거하므로 dev iteration 비용 있음;
  견디기 어려우면 future spec 으로 optional disk persistence 추가.
- **(거부) disk persistence (분봉 패턴 답습).** 일봉의 작은 데이터 양에서 disk
  cache 의 *복잡도 비용 > 영속성 이득*. cache 가 stale 한 상태로 영속할 위험
  (KIS data 정정 시) 도 자동 제거.
- **(채택) 무제한 cap.** KIS 보유 기간 ~20-30 년이 자연 상한. rate-limit 은
  partial response 로 처리.
- **(거부) `bucket=D` query 분기.** 한 endpoint 가 두 응답 스키마를 갖는 비용 >
  두 endpoint 비용.
- **(채택) `DailyCandleFetchResult` 로 violation surface.** 분봉의 silently-skip
  패턴과 달리, 일봉은 violation 을 caller 로 명시 전달하여 wire `data_warnings`
  surface. KIS data 이상이 cache 안에 영구 묻히는 위험 회피 (grill Q3).

## Consequences

- ADR-0013 의 spirit 은 두 번째 균열을 흡수. read-path 단일성 정책은 이제
  *RangeBundle 도메인 한정* + *분봉 / 일봉 wire 는 별개 도메인* 으로 재독해.
- CONTEXT.md "Live Candle Backfill" entry 가 두 endpoint (분봉 + 일봉) 를 모두
  설명하도록 갱신. LiveTimeframe entry 의 "D/W/M is frontend-only" 도 함께 갱신.
- ADR-0040 의 Trigger Conditions 는 그대로 — 본 ADR 은 그 조건을 발동시키지 않음.
- `clampEngaged` 의미가 timeframe 별로 분기됨: 분봉은 250 d 한도 지표, 일봉은
  항상 false.
- 분봉 path 의 `PastCandlesCache` 도 본 spec 의 scope 안에서 tri-state today
  + negative caching 으로 확장 (wire/namespace zero diff). 두 cache 가 같은
  tri-state 패턴을 공유.

## Trigger Conditions

(미래에 본 ADR 을 supersede 할 조건)

- 메모리 cache 가 자주 cold start 되어 KIS 호출 양이 의미있는 비용이 되면 →
  optional disk persistence 추가 (본 ADR 의 trade-off 재평가).
- `/replay` 페이지가 KIS daily candle 을 필요로 함 → unified path 필요성 강화.
- per-batch overlap 이 메모리 사용량에서 의미있는 비중을 차지 (~10 MB 이상 / code).
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0048-live-daily-direct-backfill.md
git commit -m "docs(adr): 0047 — /live D-direct daily backfill, parallel to ADR-0040"
```

---

### Task E2: CONTEXT.md — Live Candle Backfill entry rewrite + LiveTimeframe fix

**Files:**
- Modify: `CONTEXT.md` (lines 303-305 Live Candle Backfill entry; line 225 LiveTimeframe entry)

- [ ] **Step 1: Replace Live Candle Backfill entry**

Replace the entry at lines 303-305 with:

```markdown
**Live Candle Backfill**:
`/live` 페이지가 KIS REST 를 직접 호출해서 받아온 OHLCV 캔들. 두 KIS endpoint 를 사용한다:
- **분봉** (1m/3m/5m/10m/15m/30m timeframe): `GET /api/live/past-candles` → KIS `inquire-time-dailychartprice` (TR_ID `FHKST03010230`). 응답은 1분봉, 백엔드가 disk 에 per-Stock-Date 캐시 (`~/.local/share/hoga-ops/kis-past-candles/<code>/<YYYYMMDD>.json`). 250-day hard cap (payload 보호 — 1년치 일봉을 분봉으로 보내면 ~5MB). 프론트는 3m/5m/.../30m 을 1분봉에서 client-aggregate.
- **일봉** (D/W/M timeframe): `GET /api/live/past-daily-candles` → KIS `inquire-daily-itemchartprice` (TR_ID `FHKST03010100`, period_div_code='D'). 응답은 일봉, 백엔드가 **프로세스 메모리** 에만 캐시 (디스크 안 둠 — 데이터 양이 매우 작아서 메모리 충분; restart = 자연 invalidation). cap 없음 (KIS 보유 기간 ~20-30 년이 자연 상한). 프론트는 D 를 그대로, W/M 는 client-aggregate.

둘 다 **Live Capture** (10초 폴링으로 snapshot/trade/broker raw 이벤트 수집) 와 다른 호출 — KIS 의 *pre-aggregated candle* endpoint 만 사용하는 on-demand 호출. 두 캐시는 서로 독립 (한쪽이 분봉, 다른쪽이 일봉이라 같은 데이터가 양쪽에 중복될 수 없음). `/api/range` 의 promoted Parquet 호출과도 독립 — promoted Parquet 은 snapshots/trades/brokers 만 담고 candle 은 안 담기 때문. /replay 는 둘 다 안 쓴다 (RangeBundle 한 길로만). ADR-0040 (분봉) + ADR-0048 (일봉) 두 결정으로 둘 다 *별도 cache + 별도 endpoint* 를 갖는다.
_Avoid_: "past candles" 단독 (소스를 잃음 — KIS-specific), "historical candles" (replay candle wire 와 중첩), "candle backfill" 단독 ("Live" 페이지 scope 누락).
```

- [ ] **Step 2: Patch LiveTimeframe entry**

In `CONTEXT.md` line 225 (LiveTimeframe entry), find:

> "The calendar subset (D/W/M) is **frontend-only** — `/api/live/past-candles` returns 1-minute bars and the page client-aggregates them via `aggregateCalendar(raw, 'D'|'W'|'M')`, bucketing by KST date / Monday-anchored week / calendar month."

Replace with:

> "The calendar subset (D/W/M) uses a **separate backend endpoint** — `GET /api/live/past-daily-candles` returns daily bars directly (no client-side minute→daily aggregation needed); the page renders D as-is and client-aggregates D→W/M via `aggregateCalendar(rawDaily, 'W'|'M')`, bucketing by Monday-anchored week / calendar month."

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(context): Live Candle Backfill + LiveTimeframe entries reflect D-direct (ADR-0048)"
```

---

## Phase F — Final verification

### Task F1: Run all tests + frontend build

- [ ] **Step 1: Backend test suite**

Run: `uv run pytest tests/unit/live/ tests/integration/live/ -v`
Expected: all PASS. Then run the full suite once to confirm no cross-module regressions: `uv run pytest`.

- [ ] **Step 2: Frontend build + test suite**

Run: `cd frontend && npm run build && npm test`
Expected: build succeeds, all tests PASS.

- [ ] **Step 3: Manual verification — open `/live` in browser**

1. Start backend: `uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga`
2. Start frontend: `cd frontend && npm run dev`
3. Open http://localhost:5173/live
4. Pick a stock (e.g. 005930).
5. Switch timeframe to **D**.
6. Scroll the chart leftward repeatedly — verify:
   - No clamp message appears (vs. the old 250-day clamp on D).
   - Chart extends progressively back in time.
   - Browser network tab shows `/api/live/past-daily-candles` requests, not `/api/live/past-candles`.
7. Switch to **W** — verify weekly bars render and the same daily endpoint is reused (no new request unless range extends).
8. Switch to **1m** — verify clamp behavior still kicks in around 250 days back, and `/api/live/past-candles` (minute) is used.
9. Open `/replay` — verify zero behavior change (sanity).
10. (Optional) Open backend on a Saturday (or stub today): verify the today negative cache prevents repeated KIS calls.

- [ ] **Step 4: Report back**

If all steps pass, the implementation is complete. If any step fails, file a small follow-up task (do *not* modify scope of this plan mid-execution — escalate or commit the partial fix).

---

## Out of Scope (Backlog from Spec)

- 분봉 cap 점진 상향
- D-direct 응답에 분할/배당 metadata 추가
- WebSocket 기반 today 일봉 실시간 갱신
- D-direct path 의 promoted Parquet 통합
- W/M backend 직접 서빙
- 분봉 path 의 `MinuteCandleFetchResult` violation surface 패턴 (별도 follow-up)
- **InvariantOutcomesBanner: batch + reason warnings (live past-candles minute
  + daily)** — added by eng-review B-1. Today's rate-limit / api-error fallouts
  silently degrade the chart; per-row violation rendering is in scope of this
  plan via D0, but batch-level reasons need banner widening.

---

## Phase D — Design Review Patches (2026-05-28, auto-applied)

`/plan-design-review` 가 Phase D 를 검토한 결과. **Blocker / Critical** 만 plan
에 인라인 반영 (Suggestion / Nit 는 본 섹션 끝의 Findings 표 참고). Phase D 의
D1/D2/D3 step body 와 함께 읽고, 본 섹션이 우선.

eng-review 의 D0 가 `invariant_violation` warnings 의 banner 라우팅을 해결했지만,
**batch-grained warnings (`kis_rate_limit`, `kis_api_error`) 은 여전히 UI 에서
silent**. 이게 사용자가 가장 자주 마주칠 failure mode (5년치 일봉 스크롤 백 중
KIS rate-limit) 이라 design 관점에서 못 넘어감.

### Blocker B1' — Batch-grained warnings (`kis_rate_limit` / `kis_api_error`) UI silent

**문제.** D0 의 매핑은 `data_warnings.filter((w) => w.date != null)` 로 per-row
violation 만 banner 로 surface. `kis_rate_limit` / `kis_api_error` 는 `date` 가
없어서 filter 에서 빠짐 → 차트는 부분 데이터만 보이는데 *왜 데이터가 끊겼는지*
UI 표시 없음. 사용자가 5년치 일봉 스크롤 백 중 rate-limit 에 걸리면 "데이터가 더
있는데 backend 가 안 주는 건지, 정말 없는 건지" 구분 불가. D0 의 acknowledgement
("KIS rate-limits in the middle of a backfill, the chart degrades silently") 가
정확히 이 hole. plan 안에서 해결하지 않으면 spec D3.4 의 "violation surface" 약속이
반쪽짜리.

**해결.** D0 의 banner 라우팅 옆에 batch-grained warnings 전용 stripe 추가
(`InvariantOutcomesBanner` 는 손대지 않고 별도 컴포넌트):

- [ ] **Step B1'.1: `LiveDailyBatchWarningsStripe` 신설**

```tsx
// frontend/src/live/LiveDailyBatchWarningsStripe.tsx (신설)
import type { LivePastDailyCandlesWarning } from '../api/livePastDailyCandles';

const REASON_LABEL: Record<LivePastDailyCandlesWarning['reason'], string> = {
  kis_rate_limit: '레이트 리밋',
  kis_api_error: 'API 오류',
  invariant_violation: '데이터 결함',
};

/** Batch-grained warnings ({batch, reason, msg}, date 없음) 전용 stripe.
 * Per-row invariant_violation 은 D0 가 InvariantOutcomesBanner 로 라우팅하므로
 * 본 컴포넌트는 date 가 없는 batch-level 만 보여준다. */
export function LiveDailyBatchWarningsStripe({
  warnings,
}: { warnings: LivePastDailyCandlesWarning[] }) {
  const batchOnly = warnings.filter((w) => w.date == null);
  if (batchOnly.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="live-daily-batch-warnings-stripe"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm border-b"
      style={{ background: 'rgba(245,158,11,0.10)', color: 'var(--warn)' }}
    >
      <span className="font-medium">일봉 부분 응답:</span>
      {batchOnly.map((w, i) => (
        <span key={`${w.batch}-${i}`} title={w.msg}>
          {w.batch}
          <span className="ml-1 text-xs opacity-70">({REASON_LABEL[w.reason]})</span>
        </span>
      ))}
    </div>
  );
}
```

DESIGN.md 정합: `--warn` 토큰 + `text-sm` + `border-b` 가 기존 banner 의 warn
stripe 와 동일. 신규 토큰 없음. `role="status"` = 비파괴 알림.

- [ ] **Step B1'.2: `useLiveBundle` 에서 batch warnings 별도 expose**

D0 의 `dailyWarningsAsDate` 매핑 옆에 raw warnings 도 export:

```ts
export interface UseLiveBundleResult {
  // ... existing ...
  /** ADR-0048 — daily endpoint 의 batch-grained warnings.
   * D0 의 invariant_violation 라우팅과 별개로, kis_rate_limit / kis_api_error
   * 처럼 batch 전체에 걸린 알림을 UI 에 surface. 분봉 timeframe 에서는 항상
   * 빈 배열. */
  dailyBatchWarnings: LivePastDailyCandlesWarning[];
}

// useLiveBundle return:
return {
  // ... existing fields ...
  dailyBatchWarnings: pastDailyCandlesQuery.data?.data_warnings ?? [],
};
```

- [ ] **Step B1'.3: `LiveWorkarea` props + stripe 합류**

```tsx
// LiveWorkarea props 에 추가:
dailyBatchWarnings: LivePastDailyCandlesWarning[];

// return 의 bundle 분기:
{bundle && (
  <>
    <InvariantOutcomesBanner
      excluded={bundle.excluded_dates ?? []}
      warnings={bundle.data_warnings ?? []}
    />
    <LiveDailyBatchWarningsStripe warnings={dailyBatchWarnings} />
  </>
)}
```

`LivePage.tsx` 에서 `dailyBatchWarnings` destructure 해서 `LiveWorkarea` 로 전달.
Mock prop 추가 (`LivePage.test.tsx`, `LiveWorkarea.test.tsx`,
`LiveChartRoot.test.tsx`).

- [ ] **Step B1'.4: 회귀 테스트**

```tsx
// LiveWorkarea.test.tsx
it('renders batch warnings stripe with kis_rate_limit reason', () => {
  // render with dailyBatchWarnings=[{batch:'20240101__20240229', reason:'kis_rate_limit', msg:'rate'}]
  expect(screen.getByTestId('live-daily-batch-warnings-stripe')).toBeInTheDocument();
  expect(screen.getByText('일봉 부분 응답:')).toBeInTheDocument();
  expect(screen.getByText(/레이트 리밋/)).toBeInTheDocument();
});

it('filters out per-row invariant_violation warnings (D0 handles those)', () => {
  // render with dailyBatchWarnings=[{batch:'20240101__20240105', date:'20240103', reason:'invariant_violation', msg:'close=0'}]
  expect(screen.queryByTestId('live-daily-batch-warnings-stripe')).toBeNull();
});
```

**Out of scope (다음 plan).** 분봉 path 의 `kis_rate_limit` warnings 도 동일한
silent failure — 형제 stripe 가 필요하지만 본 plan scope 밖. 이미 "Out of Scope"
표에 eng-review 가 같은 follow-up 을 적어둠 — 본 patch 가 그 follow-up 의 일봉
부분만 선제 해결.

---

### Blocker B2 — 로딩 노트 텍스트가 일봉 timeframe 에서 거짓말

**문제.** `LiveChartRoot.tsx:388` 의 로딩 오버레이 텍스트가 하드코딩된
`"분봉 불러오는 중…"`. 사용자가 D/W/M 에서 처음 데이터를 로딩할 때 "분봉
(minute candles)" 단어가 보여 혼란 — "내가 일봉 골랐는데 왜 분봉 로딩?".
Don Norman 의 system status visibility 원칙은 *정확한* 상태를 보여줄 때만
유효함.

**해결.** `LiveChartRoot` 가 이미 `timeframe: LiveTimeframe` prop 을 받음.
텍스트를 timeframe 기반으로 분기:

```tsx
// frontend/src/live/LiveChartRoot.tsx, line ~378-390
{isPastCandlesLoading && (!bundle || bundle.candles.length === 0) && (
  <div data-testid="past-candles-loading-note" style={{ /* unchanged */ }}>
    {isMinuteTimeframe(timeframe) ? '분봉 불러오는 중…' : '일봉 불러오는 중…'}
  </div>
)}
```

`isMinuteTimeframe` 은 `../state/livePage` 에서 이미 export 됨 (`useLiveBundle.ts`
와 동일 import path).

회귀 테스트 (`LiveChartRoot.test.tsx`):

```tsx
it('shows "분봉 불러오는 중…" when timeframe is minute and past candles loading', () => {
  // render with timeframe='1m', isPastCandlesLoading=true, bundle=null
  expect(screen.getByText('분봉 불러오는 중…')).toBeInTheDocument();
});

it('shows "일봉 불러오는 중…" when timeframe is D and past candles loading', () => {
  // render with timeframe='D', isPastCandlesLoading=true, bundle=null
  expect(screen.getByText('일봉 불러오는 중…')).toBeInTheDocument();
});
```

---

### Blocker B3 — 일봉 초기 seed 가 60일짜리 (빈약한 첫 paint)

**문제.** Task D3 의 `seedFrom = historicalFromDate ?? subtractDaysKst(today, INITIAL_HISTORICAL_DAYS)`.
`INITIAL_HISTORICAL_DAYS` 는 분봉 기준 상수 (60). 사용자가 처음 D 를 누르면 ~60일
일봉 (= ~45 trading bars) 만 로드. plan F1 step 6 ("Chart extends progressively
back in time") 약속과 어긋남 — 한 번 더 스크롤 백 해야 의미 있는 일봉 차트가 나옴.
"daily 는 cap 없이 무한 backfill" 이라는 plan 의 핵심 가치가 *initial paint 가
빈약함* 으로 가려짐. Norman emotional design 의 visceral level (첫 5초) 실패.

**해결.** 일봉용 초기 seed 상수 분리:

```ts
// frontend/src/live/liveDateTime.ts — 신규 export
/** ADR-0048 — 일봉 첫 paint 의 default range. 2년 = ~500 trading bars 로
 * 의미 있는 차트가 한 번에 보임. 메모리 cache (PastDailyCandlesCache) 가
 * cold-start 비용을 흡수. */
export const INITIAL_HISTORICAL_DAYS_DAILY = 365 * 2;
```

`useLiveBundle.ts`:

```ts
import {
  INITIAL_HISTORICAL_DAYS,
  INITIAL_HISTORICAL_DAYS_DAILY,
} from './liveDateTime';

const seedFromMinute = historicalFromDate
  ?? subtractDaysKst(todayKstYyyymmdd, INITIAL_HISTORICAL_DAYS);
const seedFromDaily = historicalFromDate
  ?? subtractDaysKst(todayKstYyyymmdd, INITIAL_HISTORICAL_DAYS_DAILY);

const earliestAllowedMinute = subtractDaysKst(
  todayKstYyyymmdd, PAST_CANDLES_MAX_DAYS - 1,
);
const minutePastFrom = laterDate(seedFromMinute, earliestAllowedMinute);
const minutePastTo = todayKstYyyymmdd;

const dailyPastFrom = seedFromDaily;  // no clamp
const dailyPastTo = todayKstYyyymmdd;
```

회귀는 C2 patch 의 "D timeframe with historicalFromDate=null seeds 2-year range"
테스트로 커버.

---

### Critical C1 — Timeframe 전환 첫 paint 깜빡임 정책 명시

**문제.** `useLivePastDailyCandles` 의 `placeholderData: keepPreviousData` (D1
step 3) 는 사용자가 1m → D 로 전환할 때 *처음* 발사되는 daily query 의 placeholder
가 비어 있음 (이전 daily 데이터 없음) → `kisCandles = []` → 1 frame 빈 차트 →
daily fetch 완료 후 다시 그려짐. 사용자가 직접 요청한 "깜빡임 없는지" 의 핵심.

**해결 — 디자인 결정 (명시).** 잘못된 timeframe 의 bar (직전 1m candles) 를 잠깐
보여주는 것이 빈 차트보다 더 나쁘다 (사용자 혼란: "왜 D 인데 1분봉 모양?"). 따라서
plan 의 현재 동작 (`pastDailyCandlesQuery.data?.candles ?? []` 로 명시적 빈 배열)
이 **올바른 디자인 결정**임을 plan 에 박아 두고, 빈 차트 동안 B2 의 "일봉
불러오는 중…" 오버레이가 보여야 함을 회귀 테스트로 보장:

`useLiveBundle.ts` 의 `kisCandles` memo 위 주석:

```ts
// Timeframe 전환 시 깜빡임 정책 (ADR-0048, C1):
// 일봉 query 가 처음 발사될 때 빈 candles 를 반환해서 LiveChartRoot 의
// "일봉 불러오는 중…" 오버레이 (B2) 가 표시되도록 한다. 이전 timeframe 의
// candles 를 1 frame 보여주는 wrong-timeframe flash 보다 명시적 로딩 상태가
// 정직하다 — Don Norman "system status visibility" 원칙. 두 번째 전환부터는
// react-query 의 placeholderData: keepPreviousData (livePastDailyCandles.ts)
// 가 직전 daily 응답을 즉시 반환해서 깜빡임 자체가 없다.
```

회귀는 C2 patch 의 "1m → D switch returns empty candles while daily query
first-fires" 테스트로 커버.

---

### Critical C2 — D3 의 D/W/M 테스트가 pseudo-code

**문제.** Task D3 Step 1 의 4 개 테스트 중 3 개가 `// ... existing harness ...`
주석으로 끝남. TDD 약속 위반 + design-review 의 "engineer ships unimplemented
behavior" failure mode.

**해결.** D3 Step 1 의 테스트 블록을 아래 구체 버전으로 교체. 기존
`useLiveBundle.test.tsx` 의 mock 패턴 (`livePastCandlesSpy`, `useRangeSpy`) 그대로
이어서 `livePastDailyCandlesSpy` 추가. B1' / B3 / C1 의 회귀도 함께 포함:

```tsx
// frontend/src/live/useLiveBundle.test.tsx — D3 회귀 블록

const livePastDailyCandlesSpy = vi.fn(() => ({
  data: {
    code: '005930', from: '', to: '',
    candles: [
      { t_ms: 1704153600000, open: 70000, high: 70100, low: 69900,
        close: 70050, volume: 1000 },
    ],
    cached_batches: [], fresh_batches: [], data_warnings: [],
  },
  isLoading: false, error: null,
}));
vi.mock('../api/livePastDailyCandles', () => ({
  useLivePastDailyCandles: (...args: unknown[]) =>
    livePastDailyCandlesSpy(...args as []),
}));

describe('useLiveBundle daily/minute branching (ADR-0048)', () => {
  beforeEach(() => {
    livePastCandlesSpy.mockClear();
    livePastDailyCandlesSpy.mockClear();
  });

  it('D timeframe calls daily hook with non-null args, minute hook with null code', () => {
    renderHook(() => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    expect(livePastDailyCandlesSpy)
      .toHaveBeenCalledWith('005930', expect.any(String), '20260527');
    const lastMinuteCall = livePastCandlesSpy.mock.calls.at(-1)!;
    expect(lastMinuteCall[0]).toBeNull();
  });

  it('1m timeframe calls minute hook with non-null args, daily hook with null code', () => {
    renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    expect(livePastCandlesSpy)
      .toHaveBeenCalledWith('005930', expect.any(String), '20260527');
    const lastDailyCall = livePastDailyCandlesSpy.mock.calls.at(-1)!;
    expect(lastDailyCall[0]).toBeNull();
  });

  it('clampEngaged is false on D even when historicalFromDate is very old', () => {
    useLivePageStore.setState({ historicalFromDate: '20100101' });
    const { result } = renderHook(
      () => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    expect(result.current.clampEngaged).toBe(false);
  });

  it('clampEngaged is true on 1m when historicalFromDate is older than 250d', () => {
    useLivePageStore.setState({ historicalFromDate: '20100101' });
    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    expect(result.current.clampEngaged).toBe(true);
  });

  it('D timeframe with historicalFromDate=null seeds 2-year range (B3)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    renderHook(() => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    const lastCall = livePastDailyCandlesSpy.mock.calls.at(-1)!;
    // from ~= 2024-05-28 (2년 전), to = 20260527
    expect((lastCall[1] as string) < '20240601').toBe(true);
  });

  it('dailyBatchWarnings surfaces from daily query (B1 prime)', () => {
    livePastDailyCandlesSpy.mockReturnValueOnce({
      data: {
        code: '005930', from: '', to: '', candles: [],
        cached_batches: [], fresh_batches: [],
        data_warnings: [{ batch: '20240101__20240229',
          reason: 'kis_rate_limit', msg: 'rate' }],
      },
      isLoading: false, error: null,
    });
    const { result } = renderHook(
      () => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    expect(result.current.dailyBatchWarnings).toHaveLength(1);
    expect(result.current.dailyBatchWarnings[0].reason)
      .toBe('kis_rate_limit');
  });

  it('1m → D switch returns empty candles while daily query first-fires (C1)', () => {
    livePastDailyCandlesSpy.mockReturnValueOnce({
      data: undefined, isLoading: true, error: null,
    });
    const { result } = renderHook(
      () => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    expect(result.current.bundle?.candles ?? []).toHaveLength(0);
    expect(result.current.isPastCandlesLoading).toBe(true);
  });
});
```

---

### Findings 분류 요약 (design-review)

| # | Severity | Area | Auto-applied? |
|---|----------|------|---------------|
| B1 | Blocker | data_warnings unrouted (per-row invariant_violation) | (eng-review D0 이 처리) |
| B1' | Blocker | batch-grained warnings (rate_limit/api_error) UI silent | yes — section above |
| B2 | Blocker | 로딩 노트 텍스트 "분봉 불러오는 중…" 거짓말 | yes — section above |
| B3 | Blocker | 일봉 initial seed 60일 (빈약한 첫 paint) | yes — section above |
| C1 | Critical | timeframe 전환 첫 paint 깜빡임 정책 미명시 | yes — section above |
| C2 | Critical | D3 의 D/W/M 테스트 pseudo-code | yes — section above |
| S1 | Suggestion | D2 KST anchoring fixture 주석 헷갈림 → `kstOpenMs()` 헬퍼 | review report |
| S2 | Suggestion | D1 'queryKey changes split cache' 회귀 누락 (분봉 형제 테스트 비대칭) | review report |
| S3 | Suggestion | D 에서 `bucketMs=60_000` placeholder 안전성 주석 | review report |
| N1 | Nit | 변수명 `pastCandlesQuery` → `minutePastQuery` | review report |
| N2 | Nit | 기존 clamp chip 텍스트 "최대 60일까지" 가 250일 상수와 안 맞음 (pre-existing, 본 plan 무관) | review report |

---

## Engineering review report (full categorized findings)

Generated 2026-05-28 by `/plan-eng-review`. Blocker + Critical items are
already absorbed into the plan above; Suggestion + Nit items are listed here
for the implementer's discretion.

### Blocker (auto-applied)

- **B-1 — InvariantOutcomesBanner shape mismatch.** See plan header + Task D0.
  Without this fix, every daily `invariant_violation` reaches the wire but
  vanishes before the user sees it. Verified by reading `LiveWorkarea.tsx`,
  `InvariantOutcomesBanner.tsx`, `buildLiveBundle.ts:142`, and
  `api/types.ts:425-428`.

### Critical (auto-applied)

- **C-1 — Empty-gap, single-day, today-only, today-negative tests missing.**
  See Task B3a. The handler's caching behavior for these edge cases is
  load-bearing (without empty-gap caching, a request for a holiday-only
  range would re-call KIS forever) but the plan's test list has zero
  coverage. Added 4 new tests pinning each behavior.
- **C-2 — Tri-state "legacy wrapper" hides the bug C2 fixes.** See Task C1.
  The original delegating `get_today` returned identical values for "miss"
  and "negative" — exactly the behavior the negative-cache extension exists
  to disambiguate. Removed the wrapper; verified only 1 production caller
  + 3 test assertions need updating.

### Suggestion (not auto-applied, deferred to implementer)

- **S-1 — `_compute_daily_gaps` correctness on single-day requests.** The
  algorithm handles single-day correctly (traced manually: `frm == too`,
  `existing == []` → returns `[(frm, too)]`), but the test list doesn't
  exercise it. B3a's `test_past_daily_single_day_past_request` covers the
  handler-level case; consider adding `_compute_daily_gaps` unit tests for
  `frm == too` with empty / overlapping / adjacent existing batches if the
  implementer wants belt-and-suspenders.
- **S-2 — `fetch_past_daily_candles` pagination cursor stop condition.** The
  loop breaks when `page_earliest <= from_yyyymmdd`. If KIS returns the
  exact `from_yyyymmdd` as `page_earliest`, the loop correctly exits with
  that page included (string comparison on `YYYYMMDD` is lexicographic =
  date comparison). Consider an explicit comment to that effect — the
  implementer will be tempted to "tighten" to `<` and break the boundary
  case.
- **S-3 — `DailyInvariantViolation.reason` adjacent to minute pattern.** The
  reason taxonomy (`close_nonpositive`, `ohlc_inconsistent`, `malformed_row`,
  `out_of_range`) is daily-specific. The Risks section mentions a future
  `MinuteCandleFetchResult` pattern. Consider naming the dataclass file or
  the reason `Literal` such that the minute version can be a sibling
  (e.g. a shared `CandleInvariantViolation` lives in `kis_models.py`) so
  the follow-up has a low-friction landing spot. Not blocking — adding a
  parallel `MinuteInvariantViolation` later is also fine.
- **S-4 — `aggregateCalendar('D', dailyInput)` identity-ish — verify session
  open alignment.** Spec D7 marks this as "⚠ confirm". Read
  `aggregateCalendar`: it groups by `calendarBucketKey(t_ms, 'D')` which
  hashes by KST date and emits the first input bar's `t_ms` per bucket. For
  D-direct input where every input bar has `t_ms = sessionOpenKst(date)`,
  the output IS identity in OHLCV and t_ms. The test in D2 pins it. No code
  change needed; suggesting that D2's test comment cite the
  `calendarBucketKey` mechanism explicitly so future readers understand WHY
  identity holds.
- **S-5 — Today bar consistency across timeframes.** The minute path includes
  today by polling SSE + KIS. The daily path fetches today as a single bar
  with `t_ms = session_open_kst`. If the regular session is mid-trading
  (10:30 KST), the daily wire emits today's bar with the *intraday-so-far*
  OHLCV; the next 60s the cached value is stale (the bar's close has moved).
  The 60s TTL is consistent with the minute path's today-cache TTL, so this
  is acceptable, but the plan should document that the today daily bar can
  lag 0-60s during regular session. Add a one-liner to the ADR's
  Consequences section.

### Nit (cosmetic, optional)

- **N-1 — Task A2 import duplication.** `hoga/live/kis_client.py:13` already
  imports `dataclass`. Task A2's snippet adds a second
  `from dataclasses import dataclass, field` block. Edit the existing line
  in place: `from dataclasses import dataclass, field`. Same for the inline
  `from datetime import datetime as _dt` inside `fetch_past_daily_candles`
  — module-level `datetime` is already imported.
- **N-2 — Test file fixture duplication.** `_daily_app(tmp_path, fake_kis)`
  in B3 is byte-identical to `_past_app(tmp_path, fake_kis)` except the
  fixture name. Either reuse `_past_app` or refactor both into one helper
  with a comment. Cosmetic; current state is fine if the implementer wants
  to keep the two test sections independent.
- **N-3 — `from_` parameter name shadowing.** Both handlers use
  `from_: str = Query(..., alias="from")`. The trailing underscore is a
  long-standing project pattern (consistent with `_validate_past_request`
  signature), so keep it. Nit only because the variable shadows the
  built-in `from` keyword visually; alias makes it correct wire-wise.
- **N-4 — Test list in spec section "Unit tests (backend)" is out of date.**
  The spec table (around lines 540-565) references some tests the plan
  doesn't implement (e.g. "today TTL refresh" for daily) and the plan
  implements some the spec table doesn't list (B3a's empty-gap and today-
  only tests, post-review). Update the spec table after this plan lands —
  not blocking.

### Verified correct (no action)

- Gap algorithm: single-day, adjacent-coalesce, prefix/suffix/middle gaps
  all traced manually and match `_compute_daily_gaps` test expectations.
- B4 wiring: `hoga/api/app.py:181` already passes `data_dir=data_dir` to
  `build_live_router`. No change needed.
- Sibling structure with minute path: handler, cache class, KIS method, and
  wire are cleanly parallel. ADR-0040 is preserved untouched. `/replay`
  zero diff confirmed (the new endpoint is `/api/live/*`).
- ADR-0013 single read-path: the new endpoint is `/live`-scoped (not
  `/api/range`); ADR-0040's locality argument extends naturally to the
  parallel ADR-0048.
