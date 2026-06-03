# Screener Factor Backfill (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `factors.parquet` from KIS 수정주가 so `derive_adjusted` produces KIS-exact 수정주가, fixing the measured 64% (572/887) mis-adjusted split stocks — plus reconcile the 원주가 SSOT against KIS and emit an impact report.

**Architecture:** One-time operational ops live in a new `hoga/api/screener_backfill.py`, reusing Phase-1's `screener_factors` (`compute_factor_segments`, `segments_to_frame`, `write_factors`, `read_factors`) and `screener_store` (`append_rows`, `derive_adjusted`, `last_raw_date`). KIS fetches are injected as callables (testable with fakes; production wraps `KisClient.fetch_past_daily_candles`). 원주가 is the append-only SSOT — never mutated except gap-fill; factors are a compact step-function applied at derive time (ADR-0057).

**Tech Stack:** Python, polars, duckdb, asyncio, pytest. Reuses Phase-1 factor store + the KIS daily endpoint (FHKST03010100).

---

## File Structure

- **Modify** `hoga/api/screener_factors.py` — add pure helper `pair_raw_adj` (date-join raw+adj closes → compute_factor_segments input).
- **Create** `hoga/api/screener_backfill.py` — one-time ops: `factor_backfill`, `reconcile_raw`, `build_impact_report`, and the KIS-wired orchestrator `run_backfill`. Kept separate from the daily `screener_store.py`.
- **Modify** `hoga/cli.py` — add `screener-backfill` CLI command (mirrors `screener-seed`).
- **Tests:** `tests/api/test_screener_pair_raw_adj.py`, `tests/api/test_screener_factor_backfill.py`, `tests/api/test_screener_reconcile.py`, `tests/api/test_screener_impact_report.py`.

Conventions for ALL tasks: work from the worktree `/home/dev/code/hoga-ops/.claude/worktrees/rosy-weaving-unicorn`; tests via `uv run --extra dev pytest ...` (bare `uv run pytest` fails); commit with `git add <exact paths> && git commit -F -` (NOT `-A`, NOT `--only`) + a blank line then `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Task 1: `pair_raw_adj` pure helper

**Files:**
- Modify: `hoga/api/screener_factors.py`
- Test: `tests/api/test_screener_pair_raw_adj.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_screener_pair_raw_adj.py
from __future__ import annotations

import datetime as dt

from hoga.api.screener_factors import compute_factor_segments, pair_raw_adj


def test_inner_joins_by_date_sorted():
    raw = [(dt.date(2021, 4, 5), 502000.0), (dt.date(2021, 4, 15), 120500.0)]
    adj = [(dt.date(2021, 4, 15), 120500.0), (dt.date(2021, 4, 5), 100759.0)]  # unsorted
    assert pair_raw_adj(raw, adj) == [
        (dt.date(2021, 4, 5), 502000.0, 100759.0),
        (dt.date(2021, 4, 15), 120500.0, 120500.0),
    ]


def test_drops_dates_missing_on_either_side():
    # raw has an extra older date KIS adj does not reach → dropped from pairing
    raw = [(dt.date(2000, 1, 4), 1000.0), (dt.date(2021, 4, 5), 502000.0)]
    adj = [(dt.date(2021, 4, 5), 100759.0)]
    assert pair_raw_adj(raw, adj) == [(dt.date(2021, 4, 5), 502000.0, 100759.0)]


def test_feeds_compute_factor_segments():
    raw = [(dt.date(2021, 4, 5), 502000.0), (dt.date(2021, 4, 15), 120500.0)]
    adj = [(dt.date(2021, 4, 5), 100759.0), (dt.date(2021, 4, 15), 120500.0)]
    segs = compute_factor_segments(pair_raw_adj(raw, adj))
    assert len(segs) == 2
    assert abs(segs[0].factor - 100759.0 / 502000.0) < 1e-9
    assert segs[1].factor == 1.0


def test_empty_when_no_overlap():
    assert pair_raw_adj([(dt.date(2020, 1, 1), 1.0)], []) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/api/test_screener_pair_raw_adj.py -v`
Expected: FAIL — `ImportError: cannot import name 'pair_raw_adj'`

- [ ] **Step 3: Add `pair_raw_adj` to `hoga/api/screener_factors.py`**

Append (near `compute_factor_segments`; it produces that function's input):

```python
def pair_raw_adj(
    raw_close: list[tuple[dt.date, float]],
    adj_close: list[tuple[dt.date, float]],
) -> list[tuple[dt.date, float, float]]:
    """원주가·수정주가 종가를 날짜로 inner-join → compute_factor_segments 입력.

    양쪽에 모두 있는 날짜만, date ASC 정렬해 (date, raw_close, adj_close) 로 반환.
    KIS 수정주가가 원주가만큼 과거로 안 닿는 날짜는 자연히 제외(그 깊은 구간은
    apply_factors 의 extend-backward 가 최古 계수로 채운다, ADR-0057).
    """
    adj_by = dict(adj_close)
    return [
        (d, rc, adj_by[d]) for d, rc in sorted(raw_close) if d in adj_by
    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/api/test_screener_pair_raw_adj.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_factors.py tests/api/test_screener_pair_raw_adj.py
git commit -F - <<'EOF'
feat(screener): pair_raw_adj — 원주가·수정주가 date-join for factor compute

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: `factor_backfill` — build factors.parquet (resumable, injected fetch)

**Files:**
- Create: `hoga/api/screener_backfill.py`
- Test: `tests/api/test_screener_factor_backfill.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_screener_factor_backfill.py
from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_backfill import factor_backfill
from hoga.api.screener_factors import read_factors

_UNADJ_SCHEMA = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64,
                 "high": pl.Float64, "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


def _seed_unadjusted(sdir: Path):
    sdir.mkdir(parents=True, exist_ok=True)
    rows = []
    # 035720: split — pre 502000, post 120500
    for d, c in [(dt.date(2021, 4, 5), 502000.0), (dt.date(2021, 4, 15), 120500.0)]:
        rows.append({"code": "035720", "date": d, "open": c, "high": c, "low": c, "close": c, "volume": 100})
    # 000001: no split — flat
    for d in (dt.date(2021, 4, 5), dt.date(2021, 4, 15)):
        rows.append({"code": "000001", "date": d, "open": 1000.0, "high": 1000.0, "low": 1000.0, "close": 1000.0, "volume": 5})
    pl.DataFrame(rows, schema=_UNADJ_SCHEMA).write_parquet(sdir / "daily_unadjusted.parquet")


def _fake_fetch_adj(adj_close_by_code):
    async def fetch(code: str, frm: str, to: str):
        return adj_close_by_code.get(code, [])
    return fetch


def test_backfill_writes_factor_segments(tmp_path: Path):
    sdir = tmp_path / "screener"
    _seed_unadjusted(sdir)
    fetch = _fake_fetch_adj({
        "035720": [(dt.date(2021, 4, 5), 100759.0), (dt.date(2021, 4, 15), 120500.0)],  # split factor
        "000001": [(dt.date(2021, 4, 5), 1000.0), (dt.date(2021, 4, 15), 1000.0)],      # factor 1.0
    })
    n = asyncio.run(factor_backfill(sdir, fetch_adj=fetch))
    assert n == 2
    f = read_factors(sdir / "factors.parquet")
    assert f is not None
    assert set(f["code"].unique().to_list()) == {"035720", "000001"}
    kakao = f.filter(pl.col("code") == "035720").sort("seg_start")
    assert kakao.height == 2  # pre-split factor segment + post-split 1.0
    assert abs(kakao["factor"][0] - 100759.0 / 502000.0) < 1e-9
    assert kakao["factor"][1] == 1.0


def test_backfill_resumable_skips_done_codes(tmp_path: Path):
    sdir = tmp_path / "screener"
    _seed_unadjusted(sdir)
    calls: list[str] = []

    async def counting_fetch(code: str, frm: str, to: str):
        calls.append(code)
        return [(dt.date(2021, 4, 5), 1000.0), (dt.date(2021, 4, 15), 1000.0)]

    asyncio.run(factor_backfill(sdir, fetch_adj=counting_fetch, codes=["000001"]))
    assert calls == ["000001"]
    # second run with both codes: 000001 already in factors.parquet → skipped
    asyncio.run(factor_backfill(sdir, fetch_adj=counting_fetch, codes=["000001", "035720"]))
    assert calls == ["000001", "035720"]  # 000001 not re-fetched
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/api/test_screener_factor_backfill.py -v`
Expected: FAIL — `ModuleNotFoundError: hoga.api.screener_backfill`

- [ ] **Step 3: Create `hoga/api/screener_backfill.py` with `factor_backfill`**

```python
"""Screener Phase-2 one-time ops: KIS factor backfill, 원주가 reconcile, impact report.

Reuses the Phase-1 factor store (screener_factors) and daily store (screener_store).
KIS fetches are injected so the logic is unit-testable without live calls (ADR-0057).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

import polars as pl

from hoga.api import screener_factors

log = logging.getLogger(__name__)

# (code, from_yyyymmdd, to_yyyymmdd) -> [(date, adj_close)] ASC-ish (order-agnostic; pair_raw_adj sorts)
FetchAdj = Callable[[str, str, str], Awaitable[list[tuple[dt.date, float]]]]

_BACKFILL_CONCURRENCY = 8  # KIS _get caps HTTP at 15/s; this just fills the bucket


def _raw_close_by_code(unadjusted: pl.DataFrame) -> dict[str, list[tuple[dt.date, float]]]:
    """daily_unadjusted → {code: [(date, close), ...]} (sorted by date)."""
    out: dict[str, list[tuple[dt.date, float]]] = {}
    for code, sub in unadjusted.select(["code", "date", "close"]).sort(["code", "date"]).group_by(
        "code", maintain_order=True
    ):
        out[code[0] if isinstance(code, tuple) else code] = list(
            zip(sub["date"].to_list(), sub["close"].to_list())
        )
    return out


async def factor_backfill(
    sdir: Path, *, fetch_adj: FetchAdj, codes: list[str] | None = None,
    batch: int = 200, concurrency: int = _BACKFILL_CONCURRENCY,
) -> int:
    """전 종목 KIS 수정주가로 factors.parquet 구축. 이미 있는 종목은 skip(resumable).

    각 종목: 원주가 종가 + KIS 수정주가 종가를 date-join(pair_raw_adj) → compute_factor_segments.
    batch 마다 (기존 ∪ 신규) 를 원자적으로 기록 → 중단돼도 완료분 보존. 신규 추가 종목 수 반환.
    """
    up = sdir / "daily_unadjusted.parquet"
    fpath = sdir / "factors.parquet"
    raw_by_code = _raw_close_by_code(pl.read_parquet(up))
    all_codes = codes if codes is not None else sorted(raw_by_code)

    existing = screener_factors.read_factors(fpath)
    done = set(existing["code"].unique().to_list()) if existing is not None else set()
    todo = [c for c in all_codes if c in raw_by_code and c not in done]

    sem = asyncio.Semaphore(concurrency)
    new_by_code: dict[str, list[screener_factors.FactorSegment]] = {}

    async def _one(code: str):
        rr = raw_by_code[code]
        async with sem:
            adj = await fetch_adj(code, rr[0][0].strftime("%Y%m%d"), rr[-1][0].strftime("%Y%m%d"))
        return code, screener_factors.compute_factor_segments(screener_factors.pair_raw_adj(rr, adj))

    def _flush() -> None:
        frame = screener_factors.segments_to_frame(new_by_code)
        if existing is not None and existing.height:
            frame = pl.concat([existing.select(frame.columns), frame])
        screener_factors.write_factors(frame, fpath)

    for i in range(0, len(todo), batch):
        results = await asyncio.gather(*(_one(c) for c in todo[i:i + batch]))
        for code, segs in results:
            if segs:
                new_by_code[code] = segs
        _flush()  # incremental atomic write (resumable)
    return len(new_by_code)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/api/test_screener_factor_backfill.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_backfill.py tests/api/test_screener_factor_backfill.py
git commit -F - <<'EOF'
feat(screener): factor_backfill — build factors.parquet from KIS 수정주가 (resumable)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: `reconcile_raw` — verify 원주가 vs KIS + gap-fill (union)

**Files:**
- Modify: `hoga/api/screener_backfill.py`
- Test: `tests/api/test_screener_reconcile.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_screener_reconcile.py
from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_backfill import ReconcileReport, reconcile_raw

_S = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
      "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


def _row(code, d, c):
    return {"code": code, "date": d, "open": c, "high": c, "low": c, "close": c, "volume": 10}


def _seed(sdir: Path, rows):
    sdir.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows, schema=_S).write_parquet(sdir / "daily_unadjusted.parquet")


def _fetch(raw_by_code):
    async def f(code, frm, to):
        return raw_by_code.get(code, [])
    return f


def test_value_match_and_gap_fill(tmp_path: Path):
    sdir = tmp_path / "screener"
    # disk has 000660 only from 2015; KIS also has 2014 (a coverage gap to fill)
    _seed(sdir, [_row("000660", dt.date(2015, 1, 2), 30000.0)])
    fetch = _fetch({"000660": [_row("000660", dt.date(2014, 1, 2), 25000.0),
                               _row("000660", dt.date(2015, 1, 2), 30000.0)]})
    rep = asyncio.run(reconcile_raw(sdir, fetch_raw=fetch, codes=["000660"]))
    assert isinstance(rep, ReconcileReport)
    assert rep.value_mismatches == 0
    assert rep.filled_rows == 1  # the 2014 row added
    merged = pl.read_parquet(sdir / "daily_unadjusted.parquet").sort("date")
    assert merged["date"].to_list() == [dt.date(2014, 1, 2), dt.date(2015, 1, 2)]


def test_value_mismatch_recorded_not_overwritten(tmp_path: Path):
    sdir = tmp_path / "screener"
    _seed(sdir, [_row("005930", dt.date(2024, 1, 2), 70000.0)])
    fetch = _fetch({"005930": [_row("005930", dt.date(2024, 1, 2), 71000.0)]})  # differs
    rep = asyncio.run(reconcile_raw(sdir, fetch_raw=fetch, codes=["005930"]))
    assert rep.value_mismatches == 1
    assert rep.filled_rows == 0
    # existing value preserved (reconcile reports, does not overwrite disagreements)
    assert pl.read_parquet(sdir / "daily_unadjusted.parquet")["close"][0] == 70000.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/api/test_screener_reconcile.py -v`
Expected: FAIL — `ImportError: cannot import name 'ReconcileReport'`

- [ ] **Step 3: Add `ReconcileReport` + `reconcile_raw` to `screener_backfill.py`**

```python
from dataclasses import dataclass

from hoga.api.screener_store import DailyBar, _DAILY_PL_SCHEMA, append_rows

# (code, from, to) -> list[DailyBar] (full 원주가 rows)
FetchRaw = Callable[[str, str, str], Awaitable[list["DailyBar"]]]


@dataclass(frozen=True)
class ReconcileReport:
    codes_checked: int
    value_matches: int
    value_mismatches: int
    filled_rows: int
    mismatch_sample: list[tuple[str, str]]  # (code, YYYY-MM-DD) up to 20


async def reconcile_raw(
    sdir: Path, *, fetch_raw: FetchRaw, codes: list[str] | None = None,
    concurrency: int = _BACKFILL_CONCURRENCY,
) -> ReconcileReport:
    """기존 원주가를 KIS(원주가)와 대조: 겹치는 날 값 검증 + 디스크 결측일을 KIS로 보충(합집합).

    값 불일치는 '기록만' 하고 덮어쓰지 않는다(디스크 SSOT 보존, 의심 종목은 사람이 판단).
    결측일(KIS엔 있고 디스크엔 없음)만 append_rows 로 union — append_rows 의 (code,date) 멱등이
    중복을 막는다. 원자적 기록.
    """
    up = sdir / "daily_unadjusted.parquet"
    disk = pl.read_parquet(up)
    disk_keys = {(c, d) for c, d in zip(disk["code"].to_list(), disk["date"].to_list())}
    disk_close = {(c, d): cl for c, d, cl in
                  zip(disk["code"].to_list(), disk["date"].to_list(), disk["close"].to_list())}
    all_codes = codes if codes is not None else sorted(disk["code"].unique().to_list())

    sem = asyncio.Semaphore(concurrency)

    async def _one(code: str) -> list[DailyBar]:
        first = disk.filter(pl.col("code") == code)["date"].min()
        last = disk.filter(pl.col("code") == code)["date"].max()
        frm = (first or dt.date(1999, 1, 1)).strftime("%Y%m%d")
        to = (last or dt.date.today()).strftime("%Y%m%d")  # NOTE: caller passes today via wrapper in prod
        async with sem:
            return await fetch_raw(code, frm, to)

    fetched = await asyncio.gather(*(_one(c) for c in all_codes))

    matches = mismatches = 0
    sample: list[tuple[str, str]] = []
    fill: list[DailyBar] = []
    for bars in fetched:
        for b in bars:
            key = (b.code, b.date)
            if key in disk_keys:
                if abs(disk_close[key] - b.close) < 1e-6:
                    matches += 1
                else:
                    mismatches += 1
                    if len(sample) < 20:
                        sample.append((b.code, b.date.strftime("%Y-%m-%d")))
            else:
                fill.append(b)

    filled = 0
    if fill:
        new = pl.DataFrame([vars(b) for b in fill], schema=_DAILY_PL_SCHEMA)
        n_before = disk.height
        _, _, merged = append_rows(up, new)
        filled = merged.height - n_before

    return ReconcileReport(
        codes_checked=len(all_codes), value_matches=matches, value_mismatches=mismatches,
        filled_rows=filled, mismatch_sample=sample,
    )
```

(Note: `append_rows` returns `(n_codes, last, merged)` per Phase-1 fix #6; `_DAILY_PL_SCHEMA`/`DailyBar` are in `screener_store`. Verify those names before relying on them.)

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/api/test_screener_reconcile.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_backfill.py tests/api/test_screener_reconcile.py
git commit -F - <<'EOF'
feat(screener): reconcile_raw — verify 원주가 vs KIS + gap-fill union

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: `build_impact_report` — old(heuristic) vs new(KIS) adjusted diff

**Files:**
- Modify: `hoga/api/screener_backfill.py`
- Test: `tests/api/test_screener_impact_report.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_screener_impact_report.py
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import polars as pl

from hoga.api.screener_backfill import build_impact_report

_A = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
      "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


def _adj(rows):
    return pl.DataFrame(rows, schema=_A)


def _r(code, d, close, vol):
    return {"code": code, "date": d, "open": close, "high": close, "low": close, "close": close, "volume": vol}


def test_report_lists_changed_codes(tmp_path: Path):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True)
    # old (heuristic) left 035720 unadjusted; new (KIS) adjusted it; 000001 unchanged
    old = _adj([_r("035720", dt.date(2021, 4, 5), 502000.0, 100), _r("000001", dt.date(2021, 4, 5), 1000.0, 5)])
    new = _adj([_r("035720", dt.date(2021, 4, 5), 100759.0, 498), _r("000001", dt.date(2021, 4, 5), 1000.0, 5)])
    old.write_parquet(sdir / "daily_adjusted.old.parquet")
    new.write_parquet(sdir / "daily_adjusted.parquet")

    rep = build_impact_report(sdir, old_path=sdir / "daily_adjusted.old.parquet")
    assert rep["changed_codes"] == 1
    assert "035720" in rep["changed_code_sample"]
    assert "000001" not in rep["changed_code_sample"]
    # artifact written
    written = json.loads((sdir / "impact-report.json").read_text())
    assert written["changed_codes"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/api/test_screener_impact_report.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_impact_report'`

- [ ] **Step 3: Add `build_impact_report` to `screener_backfill.py`**

```python
import json

from hoga.api._atomic_write import atomic_write_json


def build_impact_report(sdir: Path, *, old_path: Path) -> dict:
    """구(휴리스틱) vs 신(KIS 계수) 수정주가를 종목별로 비교 → 어떤 종목이 바뀌었는지.

    new = 현재 daily_adjusted.parquet (factor_backfill 후 derive_adjusted 가 재생성한 것).
    old = 백필 전 보관해둔 사본(old_path). (code,date) 기준 close 가 달라진 종목을 센다.
    screener/impact-report.json 으로 산출. 반환은 같은 dict.
    """
    new = pl.read_parquet(sdir / "daily_adjusted.parquet").select(["code", "date", "close"])
    old = pl.read_parquet(old_path).select(["code", "date", "close"]).rename({"close": "old_close"})
    joined = new.join(old, on=["code", "date"], how="inner")
    changed = joined.filter((pl.col("close") - pl.col("old_close")).abs() > 1e-6)
    changed_codes = sorted(changed["code"].unique().to_list())
    report = {
        "rows_compared": joined.height,
        "changed_rows": changed.height,
        "changed_codes": len(changed_codes),
        "changed_code_sample": changed_codes[:50],
    }
    atomic_write_json(sdir / "impact-report.json", report)
    return report
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/api/test_screener_impact_report.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_backfill.py tests/api/test_screener_impact_report.py
git commit -F - <<'EOF'
feat(screener): build_impact_report — 구·신 수정주가 diff → impact-report.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: `run_backfill` orchestrator + `screener-backfill` CLI

**Files:**
- Modify: `hoga/api/screener_backfill.py` (orchestrator), `hoga/cli.py` (command)
- Test: `tests/api/test_screener_backfill_run.py`

- [ ] **Step 1: Write the failing test (orchestrator wiring with fakes)**

```python
# tests/api/test_screener_backfill_run.py
from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_backfill import run_backfill_with
from hoga.api.screener_factors import read_factors
from hoga.api.screener_store import DailyBar

_S = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
      "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


def test_run_backfill_produces_factors_and_report(tmp_path: Path):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True)
    # seed unadjusted + an OLD heuristic daily_adjusted that left 035720 unadjusted
    un = pl.DataFrame([
        {"code": "035720", "date": dt.date(2021, 4, 5), "open": 502000.0, "high": 502000.0,
         "low": 502000.0, "close": 502000.0, "volume": 100},
        {"code": "035720", "date": dt.date(2021, 4, 15), "open": 120500.0, "high": 120500.0,
         "low": 120500.0, "close": 120500.0, "volume": 100},
    ], schema=_S)
    un.write_parquet(sdir / "daily_unadjusted.parquet")
    un.write_parquet(sdir / "daily_adjusted.parquet")  # old == unadjusted (heuristic miss)

    async def fetch_adj(code, frm, to):
        return [(dt.date(2021, 4, 5), 100759.0), (dt.date(2021, 4, 15), 120500.0)]

    async def fetch_raw(code, frm, to):
        return [DailyBar(code, dt.date(2021, 4, 5), 502000.0, 502000.0, 502000.0, 502000.0, 100),
                DailyBar(code, dt.date(2021, 4, 15), 120500.0, 120500.0, 120500.0, 120500.0, 100)]

    report = asyncio.run(run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw))

    # factors built, adjusted regenerated with KIS factor, impact report shows the fix
    assert read_factors(sdir / "factors.parquet") is not None
    adj = pl.read_parquet(sdir / "daily_adjusted.parquet").filter(
        (pl.col("code") == "035720") & (pl.col("date") == dt.date(2021, 4, 5)))
    assert abs(adj["close"][0] - 100759.0) < 1.0  # now KIS-adjusted, not 502000
    assert report["impact"]["changed_codes"] >= 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/api/test_screener_backfill_run.py -v`
Expected: FAIL — `ImportError: cannot import name 'run_backfill_with'`

- [ ] **Step 3: Add `run_backfill_with` (testable core) to `screener_backfill.py`**

```python
import shutil
import time

from hoga.api.screener_store import derive_adjusted, last_raw_date, write_status


async def run_backfill_with(sdir: Path, *, fetch_adj: FetchAdj, fetch_raw: FetchRaw,
                            now_ms: int | None = None) -> dict:
    """Plan-2 1회 백필 오케스트레이션(주입된 fetch — 테스트/프로덕션 공용).

    순서: ① reconcile_raw(원주가 검증+결측 보충) ② factor_backfill(factors.parquet)
    ③ 기존 daily_adjusted 사본 보관 ④ derive_adjusted(이제 factors 적용→ KIS 정확 수정주가)
    ⑤ build_impact_report. 반환: {reconcile, factors_added, impact}.
    """
    now_ms = now_ms or int(time.time() * 1000)
    rec = await reconcile_raw(sdir, fetch_raw=fetch_raw)
    added = await factor_backfill(sdir, fetch_adj=fetch_adj)

    old_path = sdir / "daily_adjusted.prebackfill.parquet"
    if (sdir / "daily_adjusted.parquet").exists():
        shutil.copyfile(sdir / "daily_adjusted.parquet", old_path)

    derive_adjusted(sdir / "daily_unadjusted.parquet", sdir / "daily_adjusted.parquet",
                    factors_path=sdir / "factors.parquet")
    write_status(sdir / "status.json",
                 last_raw_date=last_raw_date(sdir / "daily_unadjusted.parquet"),
                 universe_size=pl.read_parquet(sdir / "daily_unadjusted.parquet")["code"].n_unique(),
                 derive_ms=0, now_ms=now_ms)

    impact = build_impact_report(sdir, old_path=old_path) if old_path.exists() else {"changed_codes": 0}
    return {"reconcile": rec, "factors_added": added, "impact": impact}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/api/test_screener_backfill_run.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Add the production KIS wiring + CLI command**

Append to `screener_backfill.py` (mirrors `screener.py:_kis_fetch_one`):

```python
async def run_backfill(data_dir: Path) -> dict:
    """프로덕션 진입: KIS 클라이언트로 fetch_adj/fetch_raw 를 묶어 run_backfill_with 실행."""
    from datetime import datetime

    from hoga.live import lifecycle
    from hoga.live.kis_client import KIS_KST
    from hoga.api.screener_store import DailyBar

    sdir = data_dir / "screener"
    client = lifecycle.ensure_kis_client_from_env(data_dir)
    if client is None:
        raise RuntimeError("KIS creds missing (KIS_APP_KEY/SECRET) — cannot backfill")

    async def fetch_adj(code: str, frm: str, to: str):
        res = await client.fetch_past_daily_candles(code, frm, to, adjust=True)   # 수정주가
        return [(datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).date(), float(c.close))
                for c in res.candles]

    async def fetch_raw(code: str, frm: str, to: str):
        res = await client.fetch_past_daily_candles(code, frm, to, adjust=False)  # 원주가
        return [DailyBar(code, datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).date(),
                         float(c.open), float(c.high), float(c.low), float(c.close), c.volume)
                for c in res.candles]

    return await run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw)
```

Add to `hoga/cli.py` (mirror `screener_seed` at ~line 96):

```python
@app.command(name="screener-backfill")
def screener_backfill() -> None:
    """Plan-2 1회 백필: KIS 수정주가로 factors.parquet 구축 + 원주가 reconcile + 수정주가 재파생.

    ~2-4h, resumable(중단 후 재실행하면 완료 종목 skip). KIS_APP_KEY/SECRET 필요.
    """
    import asyncio
    import time

    from hoga.api.screener_backfill import run_backfill

    t0 = time.time()
    rep = asyncio.run(run_backfill(resolve_data_dir()))
    print(f"backfill done in {time.time() - t0:.0f}s: "
          f"factors_added={rep['factors_added']}, "
          f"reconcile(match={rep['reconcile'].value_matches}, "
          f"mismatch={rep['reconcile'].value_mismatches}, filled={rep['reconcile'].filled_rows}), "
          f"impact(changed_codes={rep['impact']['changed_codes']})")
```

- [ ] **Step 6: Run the run-orchestrator test + full screener sweep**

Run: `uv run --extra dev pytest tests/api/test_screener_backfill_run.py tests/api/ -k screener -q`
Expected: PASS (all)

- [ ] **Step 7: Commit**

```bash
git add hoga/api/screener_backfill.py hoga/cli.py tests/api/test_screener_backfill_run.py
git commit -F - <<'EOF'
feat(screener): run_backfill orchestrator + screener-backfill CLI (Plan 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Phase 2 완료 기준
- `factor_backfill`이 KIS 수정주가로 `factors.parquet`을 구축(resumable) → `derive_adjusted`가 KIS 정확 계수 적용 → 측정된 64% 미보정이 복구됨.
- `reconcile_raw`가 원주가를 KIS와 검증(값 불일치는 기록만, 덮어쓰지 않음) + 결측일 보충(union).
- `build_impact_report`가 구·신 수정주가 diff를 `impact-report.json`으로 산출.
- `screener-backfill` CLI로 운영 1회 실행(실제 KIS, ~2-4h).

## 운영 메모 (실행 시)
- 실제 실행은 **이 플랜 코드가 머지·배포된 뒤** `hoga screener-backfill` 1회. resumable이라 중단/재개 안전.
- KIS 미도달 깊은 역사(예: 1999~2002)는 factors가 안 닿아도 `apply_factors`의 extend-backward(Phase-1 fix #4)가 최古 계수로 채움 — 별도 처리 불요.
- 백필 후 일일 갱신(`trigger_update`)은 그대로 동작(원주가 append → derive 가 이제 factors 적용). **단 새 분할 자동 반영은 Plan 3 전까지 수동**(`screener-backfill` 재실행)이 필요 — Plan 3가 이를 자동화.

## 다음 (별도 플랜)
- **Plan 3**: action_detector(±30% 감지) + factor_refresh(분할 종목만 KIS 재수신, 월 순환) + 16:00 장중 가드 + stocks 메타 갱신. → 백필 상태를 사람 손 안 대고 유지.
