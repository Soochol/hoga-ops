# Live Investor Trend Estimate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/live` sidebar card below 거래원 that shows the current active stock's KIS intraday foreign/institution estimated quantity history.

**Architecture:** Keep this as a display-only REST feature, separate from websocket, `LiveBuffer`, capture, and chart bundle paths. Backend fetches KIS through the existing `background` account role, normalizes rows, applies a 60-second process-local cache, and only accumulates rows when KIS returns latest-only data. Frontend uses a React Query hook with immediate fetch on code change and 60-second regular-session polling, then renders a separate Live Investor Estimate card below the existing `CursorSidebar` shell.

**Tech Stack:** Python 3.11, FastAPI, Pydantic, existing `KisClient`, pytest, React, TypeScript, TanStack Query, Vitest, Testing Library.

---

## Scope And Boundaries

Implement the approved spec in `docs/superpowers/specs/2026-06-16-live-investor-trend-estimate-design.md`.

Do not modify these areas:

- `LiveBuffer`, websocket frame parsing, SSE series transport, capture writer, or chart bundle construction.
- Daily confirmed investor net-buy pane behavior under `/api/live/past-investor-net`.
- Account-role routing semantics beyond calling `kis_access.kis_for_role("background", data_dir)` for this new route.

Use these canonical names:

- Feature/domain: Live Investor Estimate.
- UI title: `외인·기관 추정`.
- API route: `/api/live/investor-trend-estimate`.
- KIS method: `fetch_investor_trend_estimate`.

## Files

- Create: `scripts/probe_investor_trend_estimate.py` - manual live characterization probe.
- Create: `docs/superpowers/measurements/2026-06-16-investor-trend-estimate/README.md` - probe result note.
- Create: `docs/superpowers/measurements/2026-06-16-investor-trend-estimate/005930-redacted.json` - redacted probe fixture, only after a live probe can run.
- Modify: `hoga/live/kis_models.py` - add KIS-normalized `InvestorTrendEstimateRow`.
- Modify: `hoga/live/kis_client.py` - add KIS REST method and parsing helpers.
- Modify: `tests/unit/live/test_kis_rest_methods.py` - add KIS method tests.
- Modify: `hoga/live/api.py` - add wire models, fetcher/cache/accumulator, route.
- Modify: `tests/unit/live/test_api.py` - add backend route/fetcher tests.
- Create: `frontend/src/api/liveInvestorTrendEstimate.ts` - React Query hook and wire types.
- Create: `frontend/src/api/liveInvestorTrendEstimate.test.tsx` - hook tests.
- Create: `frontend/src/sidebar/InvestorTrendEstimateCard.tsx` - sidebar card UI.
- Create: `frontend/src/sidebar/InvestorTrendEstimateCard.test.tsx` - card rendering tests.
- Modify: `frontend/src/live/LiveSidebar.tsx` - mount card below `CursorSidebar`.
- Modify: `frontend/src/live/LiveSidebar.test.tsx` - verify placement and hook wiring.

## Baseline Already Verified

From worktree `/home/dev/code/hoga-ops/.worktrees/feature-live-investor-trend-estimate`:

```bash
uv run --extra dev pytest tests/unit/live/test_kis_rest_methods.py tests/unit/live/test_api.py tests/unit/live/test_live_quotes_route.py -q
```

Expected baseline: pass.

```bash
cd frontend
npx vitest run src/api/liveQuotes.test.tsx src/live/LiveSidebar.test.tsx src/api/livePastCandles.test.tsx src/api/livePastDailyCandles.test.tsx
```

Expected baseline: pass.

---

### Task 1: Manual KIS Characterization Probe

**Files:**
- Create: `scripts/probe_investor_trend_estimate.py`
- Create after live run: `docs/superpowers/measurements/2026-06-16-investor-trend-estimate/README.md`
- Create after live run: `docs/superpowers/measurements/2026-06-16-investor-trend-estimate/005930-redacted.json`

- [ ] **Step 1: Add the probe script**

Create `scripts/probe_investor_trend_estimate.py`:

```python
#!/usr/bin/env python3
"""Probe KIS investor-trend-estimate and print redacted row-shape data.

Run manually during regular KRX session after at least the 11:20 KST input
window. This script must not persist credentials, headers, tokens, or account
identifiers.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

from hoga.live import kis_access

_KST = timezone(timedelta(hours=9))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", default="005930")
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    kis = kis_access.kis_for_role("background", data_dir)
    if kis is None:
        raise SystemExit("KIS background client is not initialized")

    rows = await kis.fetch_investor_trend_estimate(args.code)
    payload = {
        "probed_at_kst": datetime.now(_KST).isoformat(),
        "code": args.code,
        "row_count": len(rows),
        "rows": [row.model_dump() for row in rows],
        "shape": "full_history" if len(rows) > 1 else "latest_only_or_empty",
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Run syntax check**

```bash
uv run python -m py_compile scripts/probe_investor_trend_estimate.py
```

Expected: command exits 0.

- [ ] **Step 3: Run live probe during market hours**

Run only during a regular KRX session after at least 11:20 KST:

```bash
uv run python scripts/probe_investor_trend_estimate.py \
  --code 005930 \
  --data-dir data \
  --out docs/superpowers/measurements/2026-06-16-investor-trend-estimate/005930-redacted.json
```

Expected: JSON output with only `slot`, `foreign_qty`, `institution_qty`, and `sum_qty` row fields. If credentials or market timing are unavailable, skip this step and record that it could not be run in the final verification notes.

- [ ] **Step 4: Write the measurement README**

Create `docs/superpowers/measurements/2026-06-16-investor-trend-estimate/README.md`:

```markdown
# KIS Investor Trend Estimate Probe

Date: 2026-06-16
Code: 005930
API: /uapi/domestic-stock/v1/quotations/investor-trend-estimate
TR ID: HHPTJ04160200

This directory stores redacted shape-only output for the Live Investor Estimate implementation.
The fixture must not contain credentials, headers, tokens, account IDs, or raw HTTP metadata.

Observed shape:

- `full_history`: KIS returned more than one estimate slot in a single response.
- `latest_only_or_empty`: KIS returned one or zero rows; runtime code still keeps the backend same-day accumulator fallback.
```

- [ ] **Step 5: Commit probe artifacts**

If the live fixture exists:

```bash
git add scripts/probe_investor_trend_estimate.py docs/superpowers/measurements/2026-06-16-investor-trend-estimate/README.md docs/superpowers/measurements/2026-06-16-investor-trend-estimate/005930-redacted.json
git commit -m "test(live): characterize investor trend estimate shape"
```

If the live fixture could not be produced:

```bash
git add scripts/probe_investor_trend_estimate.py docs/superpowers/measurements/2026-06-16-investor-trend-estimate/README.md
git commit -m "test(live): add investor trend estimate probe"
```

---

### Task 2: KIS Client Method

**Files:**
- Modify: `hoga/live/kis_models.py`
- Modify: `hoga/live/kis_client.py`
- Modify: `tests/unit/live/test_kis_rest_methods.py`

- [ ] **Step 1: Write failing KIS method tests**

Append tests to `tests/unit/live/test_kis_rest_methods.py`:

```python
def _estimate_row(slot: str, *, frgn: str, orgn: str, total: str) -> dict:
    return {
        "bsop_hour_gb": slot,
        "frgn_fake_ntby_qty": frgn,
        "orgn_fake_ntby_qty": orgn,
        "sum_fake_ntby_qty": total,
    }


def _ok_estimate_body(rows: list[dict], *, key: str = "output2") -> dict:
    return {"rt_cd": "0", "msg_cd": "MCA00000", "msg1": "정상처리 되었습니다.", key: rows}


def _estimate_handler(rows: list[dict], *, key: str = "output2"):
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/uapi/domestic-stock/v1/quotations/investor-trend-estimate"
        assert request.url.params["MKSC_SHRN_ISCD"] == "005930"
        assert request.headers["tr_id"] == "HHPTJ04160200"
        return httpx.Response(200, json=_ok_estimate_body(rows, key=key))

    return handler


@pytest.mark.anyio
async def test_fetch_investor_trend_estimate_parses_qty_rows(tmp_path) -> None:
    client = _make_client(
        _estimate_handler([
            _estimate_row("0930", frgn="1,234", orgn="-200", total="1,034"),
            _estimate_row("1120", frgn="", orgn="bad", total="0"),
        ]),
        tmp_path,
    )

    rows = await client.fetch_investor_trend_estimate("005930")

    assert [r.slot for r in rows] == ["0930", "1120"]
    assert rows[0].foreign_qty == 1234
    assert rows[0].institution_qty == -200
    assert rows[0].sum_qty == 1034
    assert rows[1].foreign_qty is None
    assert rows[1].institution_qty is None
    assert rows[1].sum_qty == 0


@pytest.mark.anyio
async def test_fetch_investor_trend_estimate_accepts_output_fallback(tmp_path) -> None:
    client = _make_client(
        _estimate_handler([_estimate_row("1430", frgn="5", orgn="6", total="11")], key="output"),
        tmp_path,
    )

    rows = await client.fetch_investor_trend_estimate("005930")

    assert len(rows) == 1
    assert rows[0].slot == "1430"
```

- [ ] **Step 2: Run tests and verify failure**

```bash
uv run --extra dev pytest tests/unit/live/test_kis_rest_methods.py -q
```

Expected: failure because `KisClient.fetch_investor_trend_estimate` and `InvestorTrendEstimateRow` do not exist.

- [ ] **Step 3: Add the KIS row model**

Add to `hoga/live/kis_models.py`:

```python
class InvestorTrendEstimateRow(BaseModel):
    """Intraday KIS estimated foreign/institution quantity row for one slot."""

    slot: str
    foreign_qty: int | None
    institution_qty: int | None
    sum_qty: int | None
```

- [ ] **Step 4: Add parsing helper and KIS method**

In `hoga/live/kis_client.py`, import `InvestorTrendEstimateRow` from `hoga.live.kis_models`. Add this helper near the existing investor parsing helpers:

```python
def _parse_optional_int(value: object) -> int | None:
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if text == "":
        return None
    try:
        return int(text)
    except ValueError:
        return None
```

Add this method to `KisClient`:

```python
    async def fetch_investor_trend_estimate(
        self, code: str
    ) -> list[InvestorTrendEstimateRow]:
        """Fetch intraday estimated foreign/institution net-buy quantities.

        KIS TR_ID: HHPTJ04160200 (investor-trend-estimate, 종목별 외인기관 추정가집계).
        Quantities are signed where positive means net buy and negative means
        net sell. Empty or malformed quantity fields become None.
        """
        path = "/uapi/domestic-stock/v1/quotations/investor-trend-estimate"
        body = await self._get(
            path=path,
            tr_id="HHPTJ04160200",
            params={"MKSC_SHRN_ISCD": code},
        )
        raw_rows = body.get("output2")
        if raw_rows is None:
            raw_rows = body.get("output")
        if not isinstance(raw_rows, list):
            return []

        rows: list[InvestorTrendEstimateRow] = []
        for raw in raw_rows:
            if not isinstance(raw, dict):
                continue
            slot = str(raw.get("bsop_hour_gb") or "").strip()
            if not slot:
                continue
            rows.append(
                InvestorTrendEstimateRow(
                    slot=slot,
                    foreign_qty=_parse_optional_int(raw.get("frgn_fake_ntby_qty")),
                    institution_qty=_parse_optional_int(raw.get("orgn_fake_ntby_qty")),
                    sum_qty=_parse_optional_int(raw.get("sum_fake_ntby_qty")),
                )
            )
        return rows
```

- [ ] **Step 5: Run KIS method tests**

```bash
uv run --extra dev pytest tests/unit/live/test_kis_rest_methods.py -q
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add hoga/live/kis_models.py hoga/live/kis_client.py tests/unit/live/test_kis_rest_methods.py
git commit -m "feat(live): fetch investor trend estimate from KIS"
```

---

### Task 3: Backend Route, Cache, And Accumulator

**Files:**
- Modify: `hoga/live/api.py`
- Modify: `tests/unit/live/test_api.py`

- [ ] **Step 1: Write failing fetcher and route tests**

Append to `tests/unit/live/test_api.py`:

```python
class _TrendFakeKis:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[str] = []

    async def fetch_investor_trend_estimate(self, code: str):
        self.calls.append(code)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def _trend_row(slot: str, foreign: int | None, institution: int | None, total: int | None):
    from hoga.live.kis_models import InvestorTrendEstimateRow

    return InvestorTrendEstimateRow(
        slot=slot,
        foreign_qty=foreign,
        institution_qty=institution,
        sum_qty=total,
    )


def test_live_investor_estimate_fetcher_full_history_replaces_accumulator() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _TrendFakeKis([
        [_trend_row("1120", 10, 20, 30)],
        [_trend_row("0930", 1, 2, 3), _trend_row("1120", 11, 22, 33)],
    ])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    first = asyncio.run(fetcher.fetch(fake, "005930"))
    second = asyncio.run(fetcher.fetch(fake, "005930"))

    assert [r.slot for r in first.rows] == ["1120"]
    assert [r.slot for r in second.rows] == ["0930", "1120"]
    assert second.latest is not None
    assert second.latest.slot == "1120"


def test_live_investor_estimate_fetcher_latest_only_accumulates_same_day() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _TrendFakeKis([
        [_trend_row("0930", 1, 2, 3)],
        [_trend_row("1120", 10, 20, 30)],
        [_trend_row("1120", 11, 22, 33)],
    ])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    asyncio.run(fetcher.fetch(fake, "005930"))
    second = asyncio.run(fetcher.fetch(fake, "005930"))
    third = asyncio.run(fetcher.fetch(fake, "005930"))

    assert [(r.slot, r.foreign_qty) for r in second.rows] == [("0930", 1), ("1120", 10)]
    assert [(r.slot, r.foreign_qty) for r in third.rows] == [("0930", 1), ("1120", 11)]


def test_live_investor_estimate_fetcher_ttl_coalesces_calls() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _TrendFakeKis([[_trend_row("0930", 1, 2, 3)]])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=60, today_fn=lambda: "20260616")

    first = asyncio.run(fetcher.fetch(fake, "005930"))
    second = asyncio.run(fetcher.fetch(fake, "005930"))

    assert first.rows == second.rows
    assert fake.calls == ["005930"]


def test_live_investor_estimate_fetcher_error_returns_previous_rows() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _TrendFakeKis([
        [_trend_row("0930", 1, 2, 3)],
        KisApiError("EGW00000", "temporary"),
    ])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    asyncio.run(fetcher.fetch(fake, "005930"))
    degraded = asyncio.run(fetcher.fetch(fake, "005930"))

    assert degraded.status == "error"
    assert degraded.rows[0].slot == "0930"
    assert degraded.data_warning is not None
    assert degraded.data_warning.reason == "kis_api_error"


def test_live_investor_trend_estimate_route_uses_background_role(tmp_path, monkeypatch) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from hoga.live.api import build_router
    from hoga.live.lifecycle import LiveStatus
    from hoga.live import kis_access

    fake = _TrendFakeKis([[_trend_row("0930", 1, 2, 3)]])
    roles: list[str] = []
    monkeypatch.setattr(kis_access, "kis_for_role", lambda role, data_dir: roles.append(role) or fake)
    app = FastAPI()
    app.include_router(
        build_router(
            lambda: LiveStatus(running=False, paused=False, latest_ts_ms=None, symbols=[]),
            data_dir=tmp_path,
        )
    )

    with TestClient(app) as c:
        r = c.get("/api/live/investor-trend-estimate?code=005930")

    assert r.status_code == 200
    assert roles == ["background"]
    assert r.json()["rows"][0]["slot"] == "0930"


def test_live_investor_trend_estimate_rejects_invalid_code(tmp_path) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from hoga.live.api import build_router
    from hoga.live.lifecycle import LiveStatus

    app = FastAPI()
    app.include_router(
        build_router(
            lambda: LiveStatus(running=False, paused=False, latest_ts_ms=None, symbols=[]),
            data_dir=tmp_path,
        )
    )

    with TestClient(app) as c:
        r = c.get("/api/live/investor-trend-estimate?code=ABC")

    assert r.status_code == 422
```

- [ ] **Step 2: Run backend tests and verify failure**

```bash
uv run --extra dev pytest tests/unit/live/test_api.py -q
```

Expected: failure because `LiveInvestorEstimateFetcher` and the route do not exist.

- [ ] **Step 3: Add API wire models and helpers**

In `hoga/live/api.py`, import `time` under a non-conflicting alias:

```python
import time as monotonic_time
```

Import the KIS row model:

```python
from hoga.live.kis_models import InvestorTrendEstimateRow
```

Add models near the existing response models:

```python
InvestorEstimateWarningReason = Literal[
    "kis_credentials_missing",
    "kis_rate_limit",
    "kis_api_error",
    "parse_error",
]


class LiveInvestorTrendEstimateWarning(BaseModel):
    reason: InvestorEstimateWarningReason
    msg: str


class LiveInvestorTrendEstimateRow(BaseModel):
    slot: str
    foreign_qty: int | None
    institution_qty: int | None
    sum_qty: int | None


class LiveInvestorTrendEstimateResponse(BaseModel):
    code: str
    trading_day: str
    fetched_at_ms: int | None
    rows: list[LiveInvestorTrendEstimateRow]
    latest: LiveInvestorTrendEstimateRow | None
    source: Literal["kis"]
    status: Literal["ok", "empty", "error"]
    data_warning: LiveInvestorTrendEstimateWarning | None
```

Add helpers:

```python
def _today_kst_yyyymmdd() -> str:
    return _today_kst_date().strftime("%Y%m%d")


def _estimate_row_to_wire(row: InvestorTrendEstimateRow) -> LiveInvestorTrendEstimateRow:
    return LiveInvestorTrendEstimateRow(
        slot=row.slot,
        foreign_qty=row.foreign_qty,
        institution_qty=row.institution_qty,
        sum_qty=row.sum_qty,
    )


def _estimate_has_value(row: LiveInvestorTrendEstimateRow) -> bool:
    return (
        row.foreign_qty is not None
        or row.institution_qty is not None
        or row.sum_qty is not None
    )


def _estimate_latest(rows: list[LiveInvestorTrendEstimateRow]) -> LiveInvestorTrendEstimateRow | None:
    valued = [row for row in rows if _estimate_has_value(row)]
    if not valued:
        return None
    numeric = []
    for index, row in enumerate(valued):
        try:
            numeric.append((int(row.slot), index, row))
        except ValueError:
            continue
    if numeric:
        return max(numeric, key=lambda item: (item[0], item[1]))[2]
    return valued[-1]
```

- [ ] **Step 4: Add the fetcher**

Add to `hoga/live/api.py` before `build_router`:

```python
class LiveInvestorEstimateFetcher:
    def __init__(
        self,
        *,
        ttl_seconds: float = 60.0,
        today_fn: Callable[[], str] = _today_kst_yyyymmdd,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._today_fn = today_fn
        self._cache: dict[tuple[str, str], tuple[float, LiveInvestorTrendEstimateResponse]] = {}
        self._accumulator: dict[tuple[str, str], dict[str, LiveInvestorTrendEstimateRow]] = {}

    async def fetch(self, kis: "KisClient", code: str) -> LiveInvestorTrendEstimateResponse:
        trading_day = self._today_fn()
        key = (trading_day, code)
        now = monotonic_time.monotonic()
        cached = self._cache.get(key)
        if cached is not None:
            cached_at, response = cached
            if now - cached_at < self._ttl_seconds:
                return response

        try:
            raw_rows = await kis.fetch_investor_trend_estimate(code)
        except KisRateLimitError as e:
            return self._error_response(code, trading_day, "kis_rate_limit", str(e))
        except (KisApiError, KisTransportError) as e:
            msg = e.msg_cd if isinstance(e, KisApiError) else str(e)
            return self._error_response(code, trading_day, "kis_api_error", msg)

        rows = [_estimate_row_to_wire(row) for row in raw_rows]
        if len(rows) <= 1:
            bucket = self._accumulator.setdefault(key, {})
            for row in rows:
                bucket[row.slot] = row
            rows = sorted(bucket.values(), key=lambda row: (int(row.slot) if row.slot.isdigit() else 999999, row.slot))
        else:
            self._accumulator[key] = {row.slot: row for row in rows}

        status: Literal["ok", "empty"] = "ok" if rows else "empty"
        response = LiveInvestorTrendEstimateResponse(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=int(datetime.now(timezone.utc).timestamp() * 1000),
            rows=rows,
            latest=_estimate_latest(rows),
            source="kis",
            status=status,
            data_warning=None,
        )
        self._cache[key] = (now, response)
        return response

    def credentials_missing(self, code: str) -> LiveInvestorTrendEstimateResponse:
        return self._error_response(
            code,
            self._today_fn(),
            "kis_credentials_missing",
            "KIS background client is not initialized",
        )

    def _error_response(
        self,
        code: str,
        trading_day: str,
        reason: InvestorEstimateWarningReason,
        msg: str,
    ) -> LiveInvestorTrendEstimateResponse:
        key = (trading_day, code)
        previous = self._cache.get(key)
        rows = previous[1].rows if previous is not None else []
        latest = previous[1].latest if previous is not None else None
        return LiveInvestorTrendEstimateResponse(
            code=code,
            trading_day=trading_day,
            fetched_at_ms=None,
            rows=rows,
            latest=latest,
            source="kis",
            status="error",
            data_warning=LiveInvestorTrendEstimateWarning(reason=reason, msg=msg),
        )
```

- [ ] **Step 5: Add route in `build_router`**

Instantiate next to `_quote_fetcher`:

```python
    _investor_estimate_fetcher = LiveInvestorEstimateFetcher()
```

Add route after `/quotes`:

```python
    @router.get("/investor-trend-estimate", response_model=LiveInvestorTrendEstimateResponse)
    async def _get_investor_trend_estimate(
        code: str = Query(...),
    ) -> LiveInvestorTrendEstimateResponse:
        if not _CODE_RE.match(code):
            raise HTTPException(422, {"code": "invalid_code", "msg": "code must be 6 digits"})
        kis = _kis_for_background()
        if kis is None:
            return _investor_estimate_fetcher.credentials_missing(code)
        return await _investor_estimate_fetcher.fetch(kis, code)
```

- [ ] **Step 6: Run backend tests**

```bash
uv run --extra dev pytest tests/unit/live/test_api.py tests/unit/live/test_kis_rest_methods.py tests/unit/live/test_live_quotes_route.py -q
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_api.py
git commit -m "feat(live): serve investor trend estimate"
```

---

### Task 4: Frontend React Query Hook

**Files:**
- Create: `frontend/src/api/liveInvestorTrendEstimate.ts`
- Create: `frontend/src/api/liveInvestorTrendEstimate.test.tsx`

- [ ] **Step 1: Write failing hook tests**

Create `frontend/src/api/liveInvestorTrendEstimate.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../live/liveDateTime', () => ({
  isKrxRegularSessionNow: vi.fn(() => true),
}));

import { isKrxRegularSessionNow } from '../live/liveDateTime';
import {
  liveInvestorTrendEstimateQueryOptions,
  useLiveInvestorTrendEstimate,
} from './liveInvestorTrendEstimate';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useLiveInvestorTrendEstimate', () => {
  it('fetches the active code immediately', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: '005930',
          trading_day: '20260616',
          fetched_at_ms: 1,
          rows: [{ slot: '0930', foreign_qty: 1, institution_qty: 2, sum_qty: 3 }],
          latest: { slot: '0930', foreign_qty: 1, institution_qty: 2, sum_qty: 3 },
          source: 'kis',
          status: 'ok',
          data_warning: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { result } = renderHook(() => useLiveInvestorTrendEstimate('005930'), { wrapper });

    await waitFor(() => expect(result.current.data?.rows).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith(
      '/api/live/investor-trend-estimate?code=005930',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not fetch when code is null', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderHook(() => useLiveInvestorTrendEstimate(null), { wrapper });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses a 60 second interval only during regular session', () => {
    vi.mocked(isKrxRegularSessionNow).mockReturnValue(true);
    const q1 = liveInvestorTrendEstimateQueryOptions('005930');
    expect(q1.refetchInterval?.({} as never)).toBe(60_000);

    vi.mocked(isKrxRegularSessionNow).mockReturnValue(false);
    const q2 = liveInvestorTrendEstimateQueryOptions('005930');
    expect(q2.refetchInterval?.({} as never)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test and verify failure**

```bash
cd frontend
npx vitest run src/api/liveInvestorTrendEstimate.test.tsx
```

Expected: failure because the hook module does not exist.

- [ ] **Step 3: Implement hook and types**

Create `frontend/src/api/liveInvestorTrendEstimate.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { isKrxRegularSessionNow } from '../live/liveDateTime';

export interface LiveInvestorTrendEstimateRow {
  slot: string;
  foreign_qty: number | null;
  institution_qty: number | null;
  sum_qty: number | null;
}

export interface LiveInvestorTrendEstimateWarning {
  reason: 'kis_credentials_missing' | 'kis_rate_limit' | 'kis_api_error' | 'parse_error';
  msg: string;
}

export interface LiveInvestorTrendEstimateResponse {
  code: string;
  trading_day: string;
  fetched_at_ms: number | null;
  rows: LiveInvestorTrendEstimateRow[];
  latest: LiveInvestorTrendEstimateRow | null;
  source: 'kis';
  status: 'ok' | 'empty' | 'error';
  data_warning: LiveInvestorTrendEstimateWarning | null;
}

export function liveInvestorTrendEstimateQueryOptions(code: string | null) {
  return {
    queryKey: ['live', 'investor-trend-estimate', code] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      apiCall<LiveInvestorTrendEstimateResponse>(
        `/api/live/investor-trend-estimate?code=${code}`,
        { signal },
      ),
    enabled: !!code,
    staleTime: 60_000,
    refetchInterval: () => (isKrxRegularSessionNow() ? 60_000 : false),
    placeholderData: (prev: LiveInvestorTrendEstimateResponse | undefined) =>
      prev && prev.code === code ? prev : undefined,
  };
}

export function useLiveInvestorTrendEstimate(code: string | null) {
  return useQuery(liveInvestorTrendEstimateQueryOptions(code));
}
```

- [ ] **Step 4: Run hook tests**

```bash
cd frontend
npx vitest run src/api/liveInvestorTrendEstimate.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/liveInvestorTrendEstimate.ts frontend/src/api/liveInvestorTrendEstimate.test.tsx
git commit -m "feat(live): add investor estimate query hook"
```

---

### Task 5: Sidebar Card UI

**Files:**
- Create: `frontend/src/sidebar/InvestorTrendEstimateCard.tsx`
- Create: `frontend/src/sidebar/InvestorTrendEstimateCard.test.tsx`
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Modify: `frontend/src/live/LiveSidebar.test.tsx`

- [ ] **Step 1: Write failing card tests**

Create `frontend/src/sidebar/InvestorTrendEstimateCard.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InvestorTrendEstimateCard } from './InvestorTrendEstimateCard';

describe('InvestorTrendEstimateCard', () => {
  it('renders all rows and highlights latest', () => {
    render(
      <InvestorTrendEstimateCard
        query={{
          isLoading: false,
          data: {
            code: '005930',
            trading_day: '20260616',
            fetched_at_ms: Date.UTC(2026, 5, 16, 2, 20),
            rows: [
              { slot: '0930', foreign_qty: 1500, institution_qty: -200, sum_qty: 1300 },
              { slot: '1120', foreign_qty: null, institution_qty: 0, sum_qty: 0 },
            ],
            latest: { slot: '1120', foreign_qty: null, institution_qty: 0, sum_qty: 0 },
            source: 'kis',
            status: 'ok',
            data_warning: null,
          },
        }}
      />,
    );

    expect(screen.getByText('외인·기관 추정')).toBeInTheDocument();
    expect(screen.getByText('0930')).toBeInTheDocument();
    expect(screen.getByText('+1.5k주')).toBeInTheDocument();
    expect(screen.getByText('-200주')).toBeInTheDocument();
    const latest = screen.getByTestId('investor-estimate-row-latest');
    expect(within(latest).getByText('1120')).toBeInTheDocument();
    expect(screen.getByText('KIS 장중 가집계 · 수량 기준')).toBeInTheDocument();
  });

  it('shows error with previous rows as delayed lookup', () => {
    render(
      <InvestorTrendEstimateCard
        query={{
          isLoading: false,
          data: {
            code: '005930',
            trading_day: '20260616',
            fetched_at_ms: null,
            rows: [{ slot: '0930', foreign_qty: 1, institution_qty: 2, sum_qty: 3 }],
            latest: { slot: '0930', foreign_qty: 1, institution_qty: 2, sum_qty: 3 },
            source: 'kis',
            status: 'error',
            data_warning: { reason: 'kis_api_error', msg: 'temporary' },
          },
        }}
      />,
    );

    expect(screen.getByText('조회 지연')).toBeInTheDocument();
    expect(screen.getByText('0930')).toBeInTheDocument();
  });

  it('shows failure when no previous rows exist', () => {
    render(
      <InvestorTrendEstimateCard
        query={{
          isLoading: false,
          data: {
            code: '005930',
            trading_day: '20260616',
            fetched_at_ms: null,
            rows: [],
            latest: null,
            source: 'kis',
            status: 'error',
            data_warning: { reason: 'kis_credentials_missing', msg: 'missing' },
          },
        }}
      />,
    );

    expect(screen.getByText('조회 실패')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run card tests and verify failure**

```bash
cd frontend
npx vitest run src/sidebar/InvestorTrendEstimateCard.test.tsx
```

Expected: failure because the component does not exist.

- [ ] **Step 3: Implement the card**

Create `frontend/src/sidebar/InvestorTrendEstimateCard.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  LiveInvestorTrendEstimateResponse,
  LiveInvestorTrendEstimateRow,
} from '../api/liveInvestorTrendEstimate';

type QueryLike = Pick<
  UseQueryResult<LiveInvestorTrendEstimateResponse>,
  'data' | 'isLoading'
>;

export function InvestorTrendEstimateCard({ query }: { query: QueryLike }) {
  const data = query.data;
  const rows = data?.rows ?? [];
  const error = data?.status === 'error';
  const statusText = query.isLoading && !data
    ? '조회 중'
    : error && rows.length > 0
      ? '조회 지연'
      : error
        ? '조회 실패'
        : data?.status === 'empty'
          ? '추정 수급 없음'
          : data?.fetched_at_ms
            ? `최근 조회 ${formatTime(data.fetched_at_ms)}`
            : '';

  return (
    <section
      data-testid="investor-trend-estimate-card"
      style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-card)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-xs)',
          padding: 'var(--space-sm) var(--space-md)',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <span style={{ color: 'var(--fg)', fontWeight: 600 }}>외인·기관 추정</span>
        {statusText && <span style={{ color: error ? 'var(--warning)' : 'var(--fg-dimmer)' }}>{statusText}</span>}
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dimmer)', fontSize: 'var(--text-xs)' }}>
          {query.isLoading ? '조회 중' : error ? '조회 실패' : '추정 수급 없음'}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
          <thead>
            <tr style={{ color: 'var(--fg-dimmer)' }}>
              <Th>입력</Th>
              <Th>외국인</Th>
              <Th>기관</Th>
              <Th>합산</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const latest = data?.latest?.slot === row.slot;
              return (
                <tr
                  key={row.slot}
                  data-testid={latest ? 'investor-estimate-row-latest' : 'investor-estimate-row'}
                  style={{
                    background: latest ? 'var(--bg-hover)' : 'transparent',
                  }}
                >
                  <Td mono>{row.slot}</Td>
                  <QtyCell value={row.foreign_qty} />
                  <QtyCell value={row.institution_qty} />
                  <QtyCell value={row.sum_qty} />
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div
        style={{
          padding: 'var(--space-xs) var(--space-md)',
          color: 'var(--fg-dimmer)',
          fontSize: 'var(--text-xs)',
          borderTop: '1px solid var(--border)',
        }}
      >
        KIS 장중 가집계 · 수량 기준
      </div>
    </section>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th style={{ textAlign: 'right', padding: 'var(--space-xs)', fontWeight: 500 }}>{children}</th>;
}

function Td({ children, mono = false, className }: { children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <td
      className={[mono ? 'font-mono' : '', className ?? ''].filter(Boolean).join(' ') || undefined}
      style={{ textAlign: 'right', padding: 'var(--space-xs)', color: 'var(--fg)' }}
    >
      {children}
    </td>
  );
}

function QtyCell({ value }: { value: number | null }) {
  const cls = value === null || value === 0
    ? 'text-fg-dimmer'
    : value > 0
      ? 'text-price-up'
      : 'text-price-down';
  return <Td className={`${cls} font-mono`}>{formatQtyCompact(value)}</Td>;
}

export function formatQtyCompact(value: number | null): string {
  if (value === null) return '-';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : `${abs}`;
  return `${sign}${body}주`;
}

function formatTime(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
```

- [ ] **Step 4: Mount card below `CursorSidebar`**

Modify `frontend/src/live/LiveSidebar.tsx`:

```tsx
import { useLiveInvestorTrendEstimate } from '../api/liveInvestorTrendEstimate';
import { InvestorTrendEstimateCard } from '../sidebar/InvestorTrendEstimateCard';
```

Inside `LiveSidebar`, after `const timeframe = ...`:

```tsx
  const investorEstimate = useLiveInvestorTrendEstimate(code);
```

Render below `CursorSidebar`, inside the scroll container:

```tsx
        <CursorSidebar
          orderbook={...}
          brokers={...}
        />
        <InvestorTrendEstimateCard query={investorEstimate} />
```

- [ ] **Step 5: Add sidebar integration test**

In `frontend/src/live/LiveSidebar.test.tsx`, add the mock before importing `LiveSidebar`:

```tsx
vi.mock('../api/liveInvestorTrendEstimate', () => ({
  useLiveInvestorTrendEstimate: vi.fn(() => ({
    isLoading: false,
    data: {
      code: '005930',
      trading_day: '20260616',
      fetched_at_ms: 1,
      rows: [{ slot: '0930', foreign_qty: 1, institution_qty: 2, sum_qty: 3 }],
      latest: { slot: '0930', foreign_qty: 1, institution_qty: 2, sum_qty: 3 },
      source: 'kis',
      status: 'ok',
      data_warning: null,
    },
  })),
}));
```

Append the test:

```tsx
it('renders investor estimate card below 거래원 shell', () => {
  render(<LiveSidebar code="005930" live={emptyLive} />);

  const sidebar = screen.getByTestId('live-sidebar');
  const brokerCard = screen.getByTestId('card-brokers');
  const estimateCard = screen.getByTestId('investor-trend-estimate-card');

  expect(sidebar).toContainElement(brokerCard);
  expect(sidebar).toContainElement(estimateCard);
  expect(
    brokerCard.compareDocumentPosition(estimateCard) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
```

- [ ] **Step 6: Run frontend sidebar tests**

```bash
cd frontend
npx vitest run src/sidebar/InvestorTrendEstimateCard.test.tsx src/live/LiveSidebar.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/sidebar/InvestorTrendEstimateCard.tsx frontend/src/sidebar/InvestorTrendEstimateCard.test.tsx frontend/src/live/LiveSidebar.tsx frontend/src/live/LiveSidebar.test.tsx
git commit -m "feat(live): render investor estimate sidebar card"
```

---

### Task 6: Final Verification

**Files:**
- No planned source changes. If verification finds a bug, fix the exact file that caused the failure and commit that fix separately.

- [ ] **Step 1: Run focused backend tests**

```bash
uv run --extra dev pytest tests/unit/live/test_kis_rest_methods.py tests/unit/live/test_api.py tests/unit/live/test_live_quotes_route.py -q
```

Expected: pass.

- [ ] **Step 2: Run focused frontend tests**

```bash
cd frontend
npx vitest run src/api/liveInvestorTrendEstimate.test.tsx src/sidebar/InvestorTrendEstimateCard.test.tsx src/live/LiveSidebar.test.tsx src/api/livePastCandles.test.tsx src/api/livePastDailyCandles.test.tsx
```

Expected: pass.

- [ ] **Step 3: Run type/build checks**

```bash
uv run --extra dev pytest tests/unit/live -q
```

Expected: pass.

```bash
cd frontend
npm run build
```

Expected: pass.

- [ ] **Step 4: Inspect diff for forbidden paths**

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Expected: changed files are limited to the files listed in this plan. There should be no changes to websocket, capture writer, chart bundle internals, or daily investor pane behavior except normal imports/tests required by this feature.

- [ ] **Step 5: Final status**

```bash
git status --short
```

Expected: clean worktree. If untracked local runtime artifacts exist, verify they are ignored or intentionally added measurement files from Task 1.

---

## Self-Review Notes

Spec coverage:

- Active stock only: covered by hook key `['live', 'investor-trend-estimate', code]` and route `code` query.
- REST/API only, not websocket: covered by route and explicit forbidden-path verification.
- Background account role: covered by route test asserting `background`.
- 60-second polling: covered by hook test and backend TTL test.
- Show all KIS rows, latest highlighted: covered by card test.
- Full-history vs latest-only ownership: covered by fetcher replacement and accumulator tests.
- Degraded errors with previous rows: covered by fetcher error test and card delayed-state test.
- Validation as HTTP error only: covered by invalid-code route test.

Placeholder scan:

- No placeholder tokens from the planning rubric are intended in this plan.

Type consistency:

- Backend normalized row: `InvestorTrendEstimateRow`.
- Backend wire row: `LiveInvestorTrendEstimateRow`.
- Backend fetcher: `LiveInvestorEstimateFetcher`.
- Frontend wire row: `LiveInvestorTrendEstimateRow`.
- Hook: `useLiveInvestorTrendEstimate`.
- UI component: `InvestorTrendEstimateCard`.
