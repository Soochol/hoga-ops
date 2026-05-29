# kis_live `ts_ms` 인코딩 정합화 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

```yaml
scope: both
spec: docs/superpowers/specs/2026-05-29-kis-live-ts-ms-encoding-design.md
adr: docs/adr/0049-promotion-writer-honors-ts-ms-encoding.md
```

**Goal:** `kis_live` Source의 promoted Parquet `ts_ms` 컬럼을 HHMMSSmmm로 정규화하여 `/api/range`가 day-window 안의 timestamp만 반환하도록 복원하고, 17개 corrupted 디렉토리를 재-promote하며, 프런트엔드 dedup 가드에 sanity clip을 추가한다.

**Architecture:** Writer-side normalization — `_parse_jsonl_to_records`가 Unix ms `t_ms`를 `unix_ms_to_hhmmssms(date, t_ms)`로 변환해서 `ts_ms` 컬럼에 저장. 모든 reader는 변경 없음 (ADR-0010 invariant 회복). 일회성 스크립트로 과거 일자 재-promote. 프런트엔드는 `pastMaxQrT`를 `todaySession.close_ms`로 clip해서 backend corruption 시에도 SSE 라이브가 막히지 않게 함.

**Tech Stack:** Python 3.13 + DuckDB + Polars + pyarrow (backend), TypeScript + Vite + Vitest (frontend), pytest, asyncio.

---

## File Structure

**Modify (4):**
- `hoga/live/promote.py` — `_parse_jsonl_to_records` 안 세 곳(line 81 / 93 / 107·117)에 Unix ms → HHMMSSmmm 변환 + 자정 race row skip.
- `tests/unit/live/test_promote.py` — 기존 promote 테스트가 raw Unix ms를 기대하던 부분을 HHMMSSmmm 기대로 갱신 + 자정 race skip 회귀 테스트 추가.
- `frontend/src/live/buildLiveBundle.ts` — `pastMaxQrT` / `pastMaxFsT`를 `todaySession.close_ms`로 clip.
- `frontend/src/live/buildLiveBundle.test.ts` — sanity clip 회귀 테스트 추가.

**Create (3):**
- `tests/unit/api/test_bundle_day_window_invariant.py` — `build_quote_ratio_slice` / `build_fill_strength_slice`가 day-window 안의 t만 반환하는지 lock-down.
- `scripts/repromote_kis_live.py` — 디렉토리 삭제 + JSONL 재-promote 일회성 스크립트 (live/ 또는 _archive/ 폴백).
- `tests/unit/test_repromote_script.py` — 스크립트 동작 검증 (archive 폴백 포함).

**Not changed:**
- `hoga/api/bundle.py` — reader 코드 변경 없음 (writer fix로 invariant 회복).
- `hoga/api/timeenc.py` — `_date_unix_ms_at_kst_midnight`는 그대로 private; 테스트는 같은 module-private 사용 (Python 내부 테스트의 표준 패턴).
- `hoga/api/routes.py` — `/api/orderbook`, `/api/brokers/series` 자동 회복.

---

## Task 1: Backend writer normalization (`_parse_jsonl_to_records`)

**Files:**
- Modify: `hoga/live/promote.py` (line 31-127, `_parse_jsonl_to_records`)
- Modify: `tests/unit/live/test_promote.py`

- [ ] **Step 1: Survey ALL pre-existing tests that build JSONL fixtures**

Run: `grep -n 'def test_\|"t_ms":' tests/unit/live/test_promote.py | head -40`

Identify every test that constructs JSONL rows. The critical ones to watch:

- `test_promote_one_writes_parquet_and_meta` (~line 17-96) — uses Unix-ms `t_ms` (e.g. `1748332800000`), already a valid in-window Unix ms for 20260527.
- `test_parse_jsonl_to_records_basic` / `test_parse_jsonl_to_records_skips_torn_line` (~lines 236-285) — these use **`t_ms=1,2,3`** against `date="20260528"`. After the writer fix, these tiny `t_ms` values fall outside the KST day window and trigger `midnight_race_skip` → drop, making assertions like `len(snapshots) == 1` fail with empty lists. **This is the eng-review Blocker.** Step 7 below explicitly rewrites these fixtures.

- [ ] **Step 2: Add a new failing test for the HHMMSSmmm conversion contract**

Add this test to `tests/unit/live/test_promote.py` after the existing `test_promote_one_writes_parquet_and_meta`:

```python
def test_parse_jsonl_converts_t_ms_to_hhmmssms(tmp_path: Path) -> None:
    """ADR-0049 — kis_live Promotion writes ts_ms as HHMMSSmmm (not Unix ms).

    Live Snapshot t_ms is Unix ms per ADR-0003. Promotion writes it to ts_ms
    column which the schema (ADR-0010) defines as HHMMSSmmm packed decimal.
    """
    from hoga.api.timeenc import hhmmssms_to_unix_ms

    date = "20260529"
    # 09:00:00.000 KST on 20260529 = 2026-05-29 00:00 UTC
    # Compute Unix ms for 10:30:45.123 KST that day.
    # 10:30:45.123 KST = 09:00:00 + 1h 30m 45s 123ms after open
    unix_ms_at_open = 1779926400000  # 2026-05-29 00:00 UTC = 09:00 KST
    sample_unix_ms = unix_ms_at_open + (1 * 3600 + 30 * 60 + 45) * 1000 + 123
    expected_hhmmssms = 103045123  # 10:30:45.123

    jsonl = tmp_path / f"{date}" / "005930.jsonl"
    jsonl.parent.mkdir(parents=True)
    jsonl.write_text(json.dumps({
        "t_ms": sample_unix_ms,
        "kind": "ob",
        "payload": {"code": "005930", "t_ms": sample_unix_ms,
                    "bids": [], "asks": [],
                    "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")

    snapshots, trades, broker_rows, meta = _parse_jsonl_to_records(
        jsonl, code="005930", date=date,
    )

    assert len(snapshots) == 1
    assert snapshots[0]["ts_ms"] == expected_hhmmssms, (
        f"Promotion writer must convert Unix ms → HHMMSSmmm. "
        f"Got {snapshots[0]['ts_ms']}, expected {expected_hhmmssms}."
    )
    # Round-trip: decoding the stored value should yield the original Unix ms.
    assert hhmmssms_to_unix_ms(date, snapshots[0]["ts_ms"]) == sample_unix_ms


def test_parse_jsonl_converts_t_ms_for_trade_and_broker(tmp_path: Path) -> None:
    """ADR-0049 — trade row + broker row also get HHMMSSmmm encoding.

    Pins the spec §Design 1 decision to use the OUTER t_ms (not the
    inner trade row's t_ms) so all three kinds emit a uniform ts_ms
    per polling cycle. A future "fix" that reverts trade to
    tr.get("t_ms") raw would silently break this; the test guards it.
    """
    from hoga.api.timeenc import unix_ms_to_hhmmssms

    date = "20260529"
    unix_ms_at_open = 1779926400000
    sample_unix_ms = unix_ms_at_open + (1 * 3600 + 30 * 60 + 45) * 1000 + 123
    expected_hhmmssms = 103045123

    jsonl = tmp_path / date / "005930.jsonl"
    jsonl.parent.mkdir(parents=True)
    lines = [
        json.dumps({"t_ms": sample_unix_ms, "kind": "trade", "payload": {
            "trades": [{"t_ms": sample_unix_ms, "price": 100, "qty": 5,
                        "side": 1, "side_source": "inferred"}],
        }}),
        json.dumps({"t_ms": sample_unix_ms, "kind": "broker", "payload": {
            "code": "005930", "t_ms": sample_unix_ms,
            "buy_top": [{"name": "삼성증권", "qty": 10}],
            "sell_top": [{"name": "키움증권", "qty": 20}],
        }}),
    ]
    jsonl.write_text("\n".join(lines) + "\n")

    _snapshots, trades, broker_rows, _meta = _parse_jsonl_to_records(
        jsonl, code="005930", date=date,
    )
    assert len(trades) == 1
    assert trades[0]["ts_ms"] == expected_hhmmssms
    assert len(broker_rows) == 2  # one buy + one sell
    for br in broker_rows:
        assert br.ts_ms == expected_hhmmssms
```

- [ ] **Step 3: Run the new test to verify it FAILS**

Run: `uv run pytest tests/unit/live/test_promote.py::test_parse_jsonl_converts_t_ms_to_hhmmssms -v`
Expected: FAIL with `AssertionError: Promotion writer must convert Unix ms → HHMMSSmmm. Got 1779931845123, expected 103045123.` (current code stores raw Unix ms.)

- [ ] **Step 4: Add a failing test for the midnight-race row skip**

Add to `tests/unit/live/test_promote.py`:

```python
def test_parse_jsonl_skips_row_outside_date_window(tmp_path: Path, caplog) -> None:
    """ADR-0049 — t_ms that falls outside the date's KST day window is skipped.

    Midnight race: Live Capture row was received just before midnight but
    promotion runs after midnight. unix_ms_to_hhmmssms raises ValueError;
    we drop the row + log live.promote.midnight_race_skip instead of
    silently writing a corrupted timestamp.
    """
    import logging

    date = "20260529"
    # A t_ms that belongs to the NEXT day (20260530 00:30 KST).
    next_day_unix_ms = 1779926400000 + 86_400_000 + 30 * 60 * 1000

    jsonl = tmp_path / date / "005930.jsonl"
    jsonl.parent.mkdir(parents=True)
    jsonl.write_text(json.dumps({
        "t_ms": next_day_unix_ms,
        "kind": "ob",
        "payload": {"bids": [], "asks": [],
                    "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")

    with caplog.at_level(logging.WARNING, logger="hoga.live.promote"):
        snapshots, trades, broker_rows, _meta = _parse_jsonl_to_records(
            jsonl, code="005930", date=date,
        )

    assert snapshots == [], "Out-of-window row must be dropped, not encoded silently."
    assert any(
        "midnight_race_skip" in rec.message for rec in caplog.records
    ), "Drop must be logged at WARNING level."
```

- [ ] **Step 5: Run new tests to verify they FAIL**

Run: `uv run pytest tests/unit/live/test_promote.py -k "converts_t_ms or skips_row_outside" -v`
Expected: all three (`test_parse_jsonl_converts_t_ms_to_hhmmssms`, `test_parse_jsonl_converts_t_ms_for_trade_and_broker`, `test_parse_jsonl_skips_row_outside_date_window`) FAIL — first/second with wrong values (raw Unix ms stored), third because current code writes the out-of-window row without skip.

- [ ] **Step 6: Implement the writer normalization in `_parse_jsonl_to_records`**

Edit `hoga/live/promote.py`. Change the `for raw in f:` block (currently line 59-124) so that the `t_ms` extracted at line 72 is converted via `unix_ms_to_hhmmssms(date, t_ms)` with a try/except, and the encoded value is used in all three kind branches.

```python
# Add at top of file with other imports
from hoga.api.timeenc import unix_ms_to_hhmmssms

# Replace the body of the for-loop with this pattern:
    with jsonl_path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                _log.warning(
                    "live.promote.partial_line code=%s date=%s", code, date
                )
                continue
            kind = row.get("kind")
            t_ms_raw = row.get("t_ms")
            # ADR-0049: convert Unix ms → HHMMSSmmm so the on-disk `ts_ms`
            # column honors the ADR-0010 invariant (series-builder SQL
            # decodes ts_ms as HHMMSSmmm via hhmmssms_to_intra_ms_sql).
            try:
                ts_ms_encoded = unix_ms_to_hhmmssms(date, int(t_ms_raw))
            except (ValueError, TypeError):
                _log.warning(
                    "live.promote.midnight_race_skip code=%s date=%s t_ms=%s",
                    code, date, t_ms_raw,
                )
                continue
            p = row.get("payload") or {}
            phase = p.get("phase", "regular")
            if kind == "ob":
                bids = p.get("bids") or []
                asks = p.get("asks") or []
                snap: dict = {"ts_ms": ts_ms_encoded, "phase": phase}
                for i in range(10):
                    snap[f"bid_p{i + 1}"] = bids[i]["price"] if i < len(bids) else 0
                    snap[f"bid_q{i + 1}"] = bids[i]["qty"] if i < len(bids) else 0
                    snap[f"ask_p{i + 1}"] = asks[i]["price"] if i < len(asks) else 0
                    snap[f"ask_q{i + 1}"] = asks[i]["qty"] if i < len(asks) else 0
                snap["total_bid_qty"] = p.get("total_bid_qty", 0)
                snap["total_ask_qty"] = p.get("total_ask_qty", 0)
                snapshots.append(snap)
            elif kind == "trade":
                for tr in p.get("trades") or []:
                    # Inner trade's t_ms can drift micro-seconds from the outer
                    # tick. We use the outer ts_ms_encoded so the entire row's
                    # encoding is uniform per cycle (drift below 1 second is
                    # absorbed by the same HHMMSSmmm bucket). If inner-vs-outer
                    # divergence ever matters, revisit at that signal.
                    trades.append({
                        "ts_ms": ts_ms_encoded,
                        "price": tr.get("price"),
                        "qty": tr.get("qty"),
                        "side": tr.get("side"),
                        "side_source": tr.get("side_source", "inferred"),
                        "phase": phase,
                    })
            elif kind == "broker":
                buy = p.get("buy_top") or []
                sell = p.get("sell_top") or []
                broker_snapshot_count += 1
                broker_seq += 1
                for rank, e in enumerate(sell[:5], start=1):
                    broker_rows.append(BrokerRow(
                        ts_ms=ts_ms_encoded,
                        seq=broker_seq,
                        side="sell",
                        rank=rank,
                        broker=str(e.get("name") or ""),
                        qty_today=int(e.get("qty") or 0),
                        qty_delta=0,
                    ))
                for rank, e in enumerate(buy[:5], start=1):
                    broker_rows.append(BrokerRow(
                        ts_ms=ts_ms_encoded,
                        seq=broker_seq,
                        side="buy",
                        rank=rank,
                        broker=str(e.get("name") or ""),
                        qty_today=int(e.get("qty") or 0),
                        qty_delta=0,
                    ))
```

Also update the misleading comment block above the `snap` dict (currently line 78-80):

```python
# Replace lines 78-80 comment with:
                # ADR-0010 invariant: parquet `ts_ms` column = HHMMSSmmm packed-decimal.
                # ADR-0049: kis_live writer converts JSONL's Unix-ms `t_ms` to
                # HHMMSSmmm at promote time so reader-side decoding is source-uniform.
```

- [ ] **Step 7: Rewrite pre-existing fixtures that use unrealistic Unix-ms values**

Two classes of edits to `tests/unit/live/test_promote.py`:

**(a) Tests that already use in-window Unix ms but assert raw ts_ms** (e.g. `test_promote_one_writes_parquet_and_meta` uses `1748332800000` which is 2026-05-27 00:00 UTC = 09:00 KST, valid for date `20260527`). For these, update the assertion only:

```python
# Before — somewhere in the test:
#   assert snaps_df["ts_ms"][0] == 1748332800000
# After:
from hoga.api.timeenc import unix_ms_to_hhmmssms
expected = unix_ms_to_hhmmssms("20260527", 1748332800000)
assert snaps_df["ts_ms"][0] == expected
```

**(b) Tests using sentinel values (`t_ms=1,2,3`) against a real `date`.** These FAIL post-fix because `unix_ms_to_hhmmssms("20260528", 1)` raises `ValueError`. Tests in this class:
  - `test_parse_jsonl_to_records_basic` (~line 236)
  - `test_parse_jsonl_to_records_skips_torn_line` (~line 270)
  - Any other test that uses `"t_ms": 1` / `"t_ms": 2` / similar with a real date.

For each, replace the sentinel `t_ms` with `_date_unix_ms_at_kst_midnight(date) + 9*3600*1000 + tick` (= 09:00:00.000 KST + tick seconds), and keep the rest of the assertions unchanged. Concrete pattern:

```python
# Before:
#   lines.append(json.dumps({"t_ms": 1, "kind": "ob", "payload": {...}}))
# After:
from hoga.api.timeenc import _date_unix_ms_at_kst_midnight
base = _date_unix_ms_at_kst_midnight("20260528") + 9 * 3600 * 1000  # 09:00 KST
for tick in range(N):
    lines.append(json.dumps({"t_ms": base + tick * 1000, "kind": "ob", "payload": {...}}))
```

Find all sentinel usages first:
```bash
grep -nE '"t_ms": [0-9]\b' tests/unit/live/test_promote.py
```
Update every match. The plan author independently verified `_date_unix_ms_at_kst_midnight` is importable from `hoga.api.timeenc` (it's module-private but Python tests import private helpers by convention).

- [ ] **Step 8: Run the entire promote test module — verify all green**

Run: `uv run pytest tests/unit/live/test_promote.py -v`
Expected: all tests PASS, including the two new ones and the updated existing ones.

- [ ] **Step 9: Run promote_today tests to ensure no regression**

Run: `uv run pytest tests/unit/live/test_promote_today.py tests/unit/live/test_today_promoter.py -v`
Expected: all PASS. (If any test fails because it asserts on raw t_ms in the resulting parquet, apply the same diff as Step 7.)

- [ ] **Step 10: Commit**

```bash
git add hoga/live/promote.py tests/unit/live/test_promote.py tests/unit/live/test_promote_today.py tests/unit/live/test_today_promoter.py
git commit -m "$(cat <<'EOF'
fix(live/promote): convert Unix ms t_ms → HHMMSSmmm at write time

_parse_jsonl_to_records now encodes the JSONL row's t_ms into the
ts_ms column via unix_ms_to_hhmmssms(date, t_ms), so the on-disk
parquet honors the ADR-0010 invariant that all readers assume.
Rows whose t_ms falls outside the date's KST day window (midnight
race) are dropped with a midnight_race_skip warning instead of
silently writing a corrupted value.

ADR-0049 — Promotion writer honors parquet ts_ms HHMMSSmmm encoding.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend day-window invariant regression test

**Files:**
- Create: `tests/unit/api/test_bundle_day_window_invariant.py`

This locks ADR-0049's invariant (writer normalization holds end-to-end) by exercising `build_quote_ratio_slice` and `build_fill_strength_slice` against a kis_live-Source parquet fixture and asserting all output `t` values fall inside the day window.

- [ ] **Step 1: Read the existing source-aware bundle test to learn the fixture helpers**

Run: `cat tests/unit/api/test_bundle_source_aware.py | head -80`

Note: it uses `_write_meta`, `_snap`, and a parquet write helper. We'll mirror that pattern.

- [ ] **Step 2: Write the failing day-window invariant test**

Create `tests/unit/api/test_bundle_day_window_invariant.py`:

```python
"""ADR-0049 regression — series builders must return t in the date's day window.

Locks the invariant that no encoding regression (writer-side or reader-side)
can cause quote_ratio.points[*].t or fill_strength.points[*].t to escape
the [KST_midnight(date), KST_midnight(date) + 86_400_000) range.
"""
from __future__ import annotations

import json
from pathlib import Path

import polars as pl
import pytest

from hoga.api.bundle import build_quote_ratio_slice, build_fill_strength_slice
from hoga.api.queries import QueryEngine
from hoga.api.timeenc import (
    _date_unix_ms_at_kst_midnight,
    unix_ms_to_hhmmssms,
)


DATE = "20260529"
CODE = "005930"
DAY_START = _date_unix_ms_at_kst_midnight(DATE)
DAY_END = DAY_START + 86_400_000


def _meta_dict() -> dict:
    return {
        "source": "kis_live",
        "code": CODE,
        "date": DATE,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
        "collection_complete": True,
        "is_partial": False,
        "row_counts": {"snapshots": 3, "trades": 3, "brokers": 0},
    }


def _write_snapshot_parquet(path: Path, unix_ms_list: list[int]) -> None:
    """Write snapshots.parquet with ts_ms encoded as HHMMSSmmm (ADR-0049 contract)."""
    rows = []
    for ts_unix_ms in unix_ms_list:
        row = {"ts_ms": unix_ms_to_hhmmssms(DATE, ts_unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"bid_q{i}"] = 10
            row[f"ask_p{i}"] = 101
            row[f"ask_q{i}"] = 10
        row["total_bid_qty"] = 100
        row["total_ask_qty"] = 100
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _write_trade_parquet(path: Path, unix_ms_list: list[int]) -> None:
    rows = [
        {
            "ts_ms": unix_ms_to_hhmmssms(DATE, ts_unix_ms),
            "price": 100,
            "qty": 10,
            "side": 1,
            "side_source": "inferred",
            "phase": "regular",
        }
        for ts_unix_ms in unix_ms_list
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


@pytest.fixture
def kis_live_fixture(tmp_path: Path) -> Path:
    """A kis_live Source dir with a few rows spanning 09:00-10:00:30 KST.

    Returns the data_dir (parent of parquet/) so callers can construct
    QueryEngine(data_dir) — established pattern from
    tests/unit/api/test_bundle_source.py:27.
    """
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True, exist_ok=True)
    (code_dir / "meta.json").write_text(json.dumps(_meta_dict()))
    sample_unix = [
        DAY_START + (9 * 3600 + 0) * 1000,    # 09:00:00 KST
        DAY_START + (10 * 3600 + 0) * 1000,   # 10:00:00 KST
        DAY_START + (10 * 3600 + 30) * 1000,  # 10:00:30 KST
    ]
    _write_snapshot_parquet(code_dir / "snapshots.parquet", sample_unix)
    _write_trade_parquet(code_dir / "trades.parquet", sample_unix)
    return tmp_path


def test_quote_ratio_t_within_day_window(kis_live_fixture: Path) -> None:
    """All quote_ratio.points[*].t must fall in [DAY_START, DAY_END)."""
    engine = QueryEngine(kis_live_fixture)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=60_000, source="kis_live",
    )
    assert len(qr.points) > 0, "fixture should produce at least one point"
    for p in qr.points:
        assert DAY_START <= p.t < DAY_END, (
            f"point t={p.t} outside day window [{DAY_START}, {DAY_END}) for {DATE}. "
            f"This is the ADR-0049 / spec invariant 3 regression."
        )


def test_fill_strength_t_within_day_window(kis_live_fixture: Path) -> None:
    """All fill_strength.points[*].t must fall in [DAY_START, DAY_END)."""
    engine = QueryEngine(kis_live_fixture)
    fs = build_fill_strength_slice(
        engine, code=CODE, date=DATE, bucket_ms=60_000, source="kis_live",
    )
    assert len(fs.points) > 0, "fixture should produce at least one point"
    for p in fs.points:
        assert DAY_START <= p.t < DAY_END, (
            f"point t={p.t} outside day window [{DAY_START}, {DAY_END}) for {DATE}. "
            f"This is the ADR-0049 / spec invariant 3 regression."
        )


def test_quote_ratio_breaks_when_writer_skips_encoding(tmp_path: Path) -> None:
    """Proof that this test would have caught the original bug.

    If we deliberately write Unix ms (NOT HHMMSSmmm) into ts_ms — the exact
    bug ADR-0049 fixes — the day-window assertion must fail.
    """
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True, exist_ok=True)
    (code_dir / "meta.json").write_text(json.dumps(_meta_dict()))
    sample_unix = [
        DAY_START + (10 * 3600 + 0) * 1000,
        DAY_START + (10 * 3600 + 30) * 1000,
    ]
    # Bug simulation: write Unix ms directly (skipping the HHMMSSmmm conversion).
    rows = []
    for ts_unix_ms in sample_unix:
        row = {"ts_ms": ts_unix_ms, "phase": "regular"}  # ← the bug
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"bid_q{i}"] = 10
            row[f"ask_p{i}"] = 101
            row[f"ask_q{i}"] = 10
        row["total_bid_qty"] = 100
        row["total_ask_qty"] = 100
        rows.append(row)
    pl.DataFrame(rows).write_parquet(code_dir / "snapshots.parquet")

    engine = QueryEngine(tmp_path)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=60_000, source="kis_live",
    )
    # All resulting t values should be outside the day window because Unix ms
    # decoded-as-HHMMSSmmm lands in year 2046.
    outside = [p for p in qr.points if not (DAY_START <= p.t < DAY_END)]
    assert outside, (
        "Bug-simulation fixture should produce out-of-window t values. "
        "If this assertion fails, the day-window guard isn't actually catching the bug."
    )
```

- [ ] **Step 3: Run the new tests — first two PASS (writer is fixed in Task 1), third PASS as bug-simulation**

Run: `uv run pytest tests/unit/api/test_bundle_day_window_invariant.py -v`
Expected: all 3 PASS. If `test_quote_ratio_t_within_day_window` fails, Task 1's writer fix didn't fully take — re-verify Task 1 step 8.

- [ ] **Step 4: Verify the test runs in isolation (sanity)**

`QueryEngine(data_dir)` was already verified in plan authoring — it's the constructor used at `tests/unit/api/test_bundle_source.py:27`. The fixture returns `tmp_path` (data_dir, parent of `parquet/`) and the engine's `parquet_dir()` walks down internally. No alternative constructor needed.

Run: `uv run pytest tests/unit/api/test_bundle_day_window_invariant.py::test_quote_ratio_breaks_when_writer_skips_encoding -v`
Expected: PASS — the bug-simulation case proves the day-window guard is sensitive enough to catch the original bug.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/api/test_bundle_day_window_invariant.py
git commit -m "$(cat <<'EOF'
test(api/bundle): lock day-window invariant for quote_ratio / fill_strength

Asserts that build_quote_ratio_slice and build_fill_strength_slice
return t values strictly inside the date's KST day window for any
source. Third test simulates the pre-fix bug (Unix ms written into
ts_ms instead of HHMMSSmmm) and verifies the guard would have caught
the encoding regression at the bundle layer.

Refs ADR-0049, spec invariant 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Frontend sanity clip on `pastMaxQrT` / `pastMaxFsT`

**Files:**
- Modify: `frontend/src/live/buildLiveBundle.ts` (lines 59-68)
- Modify: `frontend/src/live/buildLiveBundle.test.ts` (append after existing `describe('buildLiveBundle dedup ...')`)

- [ ] **Step 1: Write the failing test for sanity clip**

Append to `frontend/src/live/buildLiveBundle.test.ts` (after the last `describe` block):

```typescript
describe('buildLiveBundle sanity clip (ADR-0049 / spec §3)', () => {
  const TODAY = '20260529';
  const TODAY_OPEN = Date.UTC(2026, 4, 29, 0, 0, 0);
  const TODAY_CLOSE = TODAY_OPEN + 6.5 * 3600 * 1000;
  // ADR-0044 / CONTEXT.md "Live Session": After-Hours runs 15:30–16:00 KST.
  const AFTER_HOURS_END = TODAY_CLOSE + 30 * 60 * 1000;

  it('clips pastMaxQrT to live session end when past contains a future timestamp', () => {
    // Simulate the actual production failure mode: Unix ms decoded as
    // HHMMSSmmm lands deterministically in year 2046 (~20 years past today).
    // Without the clip, this would block all SSE merges because
    // incrementalQR.filter(p => p.t > pastMaxQrT) rejects every 2026-era
    // SSE point.
    const futureCorruptT = TODAY_CLOSE + 20 * 365 * 24 * 3600 * 1000; // ~2046
    const pastBundle: RangeBundle = emptyRangeBundle({
      segments: [{
        date: '20260528',
        session_open_ms: TODAY_OPEN - 86_400_000,
        session_close_ms: TODAY_CLOSE - 86_400_000,
        source: 'hogaplay',
      }],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [
          { t: TODAY_OPEN - 86_400_000 + 3600_000, bid_total: 10, ask_total: 10 },
          { t: futureCorruptT, bid_total: 99, ask_total: 99 }, // corrupt tail
        ],
      },
    });

    const sseTAt = TODAY_OPEN + 30 * 60_000; // 09:30 KST today
    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle,
      sseOb: [{ t_ms: sseTAt, total_ask_qty: 50, total_bid_qty: 40 }],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });

    const sseMerged = bundle.quote_ratio.points.some(
      (p) => p.t === sseTAt && p.bid_total === 40 && p.ask_total === 50,
    );
    expect(sseMerged).toBe(true);
  });

  it('preserves dedup for after-hours data (15:30-16:00 KST, Live Session end)', () => {
    // Design-review B1 regression: clip ceiling must include After-Hours
    // (Live Session end = close_ms + 30min, CONTEXT.md "Live Session").
    // If we clipped at close_ms (15:30 KST), past-tail at 15:45 KST would
    // get reduced to 15:30, letting an SSE point at 15:45 with the SAME
    // timestamp as a past entry slip through and overwrite the past value.
    const pastTailT = TODAY_CLOSE + 15 * 60_000; // 15:45 KST (After-Hours)
    const pastBundle: RangeBundle = emptyRangeBundle({
      segments: [{
        date: TODAY,
        session_open_ms: TODAY_OPEN,
        session_close_ms: TODAY_CLOSE,
        source: 'kis_live',
      }],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [{ t: pastTailT, bid_total: 10, ask_total: 10 }],
      },
    });

    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle,
      sseOb: [
        { t_ms: pastTailT, total_ask_qty: 999, total_bid_qty: 999 }, // boundary dup
      ],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });

    const atTail = bundle.quote_ratio.points.find((p) => p.t === pastTailT);
    expect(atTail?.bid_total).toBe(10); // past value wins, SSE dup rejected
  });

  it('does NOT clip when past timestamps are all within regular session (normal case)', () => {
    // Regression guard: when past data is sane, the existing dedup must
    // still reject SSE buckets that share a timestamp with past tail.
    const pastTailT = TODAY_OPEN + 60_000; // 09:01 KST today
    const pastBundle: RangeBundle = emptyRangeBundle({
      segments: [{
        date: TODAY,
        session_open_ms: TODAY_OPEN,
        session_close_ms: TODAY_CLOSE,
        source: 'kis_live',
      }],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [
          { t: TODAY_OPEN, bid_total: 5, ask_total: 5 },
          { t: pastTailT, bid_total: 10, ask_total: 10 },
        ],
      },
    });

    const bundle = buildLiveBundle({
      code: '005930',
      todayDate: TODAY,
      todaySession: { open_ms: TODAY_OPEN, close_ms: TODAY_CLOSE },
      pastBundle,
      sseOb: [
        { t_ms: pastTailT, total_ask_qty: 999, total_bid_qty: 999 }, // boundary dup
        { t_ms: pastTailT + 60_000, total_ask_qty: 50, total_bid_qty: 40 }, // new
      ],
      sseTrade: [],
      kisCandles: [],
      bucketMs: 60_000,
    });

    // The boundary-dup SSE point must NOT overwrite past's value 10.
    const atPastTail = bundle.quote_ratio.points.find((p) => p.t === pastTailT);
    expect(atPastTail?.bid_total).toBe(10);
    // The strictly-greater SSE point must pass through.
    const after = bundle.quote_ratio.points.find((p) => p.t === pastTailT + 60_000);
    expect(after?.bid_total).toBe(40);
  });
});
```

- [ ] **Step 2: Run the new tests — first should FAIL, second should PASS**

Run: `cd frontend && npm test -- buildLiveBundle.test.ts`
Expected:
- `clips pastMaxQrT to todaySession.close_ms when past contains a future timestamp` → **FAIL** (current code lets futureCorruptT through as pastMaxQrT, blocking SSE merge).
- `does NOT clip when past timestamps are all within today close (normal case)` → **PASS** (no regression).

- [ ] **Step 3: Implement the sanity clip in `buildLiveBundle.ts`**

Edit `frontend/src/live/buildLiveBundle.ts`. Replace lines 59-68 (the `pastMaxQrT` / `pastMaxFsT` + `sseBuckets` block) with:

```typescript
  // ADR-0049 / spec §3 — **filter** (not clip) past points whose t escapes
  // the Live Session end so a backend encoding regression cannot block SSE
  // merge. Why filter not Math.min: clipping leaves pastMaxQrT at close+30min,
  // which is strictly greater than every legitimate SSE timestamp during the
  // session, so `incrementalQR.filter(p => p.t > pastMaxQrT)` would reject
  // ALL SSE points. Filter drops corrupt past entries from pastMax calc AND
  // from the wire output, so SSE merges naturally and renders stay consistent
  // with VirtualAxis (which filters out-of-segment points anyway).
  // Ceiling = close_ms + 30min (Live Session end incl. After-Hours Trading,
  // ADR-0044 / CONTEXT.md "Live Session"). Healthy past always passes.
  const AFTER_HOURS_END_MS = todaySession.close_ms + 30 * 60 * 1000;
  const validPastQR = pastQRPoints.filter((p) => p.t <= AFTER_HOURS_END_MS);
  const validPastFS = pastFSPoints.filter((p) => p.t <= AFTER_HOURS_END_MS);
  const pastMaxQrT = validPastQR.length > 0
    ? validPastQR[validPastQR.length - 1].t
    : 0;
  const pastMaxFsT = validPastFS.length > 0
    ? validPastFS[validPastFS.length - 1].t
    : 0;

  const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs);
  const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > pastMaxQrT);
  const incrementalFS = sseBuckets.fillStrengthPoints.filter((p) => p.t > pastMaxFsT);

  // Final wire output also uses validPastQR / validPastFS so corrupt points
  // are excluded from rendering as well. Replace the original
  // `points: [...pastQRPoints, ...incrementalQR]` lines further down with:
  //   points: [...validPastQR, ...incrementalQR]
  //   points: [...validPastFS, ...incrementalFS]
```

- [ ] **Step 4: Run all buildLiveBundle tests — verify all green**

Run: `cd frontend && npm test -- buildLiveBundle.test.ts`
Expected: all PASS, including both new cases and the pre-existing dedup tests.

- [ ] **Step 5: Run the frontend build to catch any TS error**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/buildLiveBundle.ts frontend/src/live/buildLiveBundle.test.ts
git commit -m "$(cat <<'EOF'
fix(live/bundle): clip pastMaxQrT/FsT to today close for SSE merge safety

Independent defense-in-depth against backend encoding regressions:
when pastQRPoints / pastFSPoints tail contains a t > today close
(e.g. year-2046 corruption from Unix ms decoded as HHMMSSmmm), the
incremental SSE filter would otherwise reject every 2026-era SSE
point. Clipping the dedup ceiling to todaySession.close_ms preserves
the boundary-dedup semantic for healthy bundles while keeping live
data flowing through corruption events.

Refs ADR-0049, spec §3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: One-shot re-promote script + archive fallback

**Files:**
- Create: `scripts/repromote_kis_live.py`
- Create: `tests/unit/test_repromote_script.py`

- [ ] **Step 1: Write a failing test that exercises the script's helper function**

Create `tests/unit/test_repromote_script.py`:

```python
"""Tests for scripts/repromote_kis_live.py.

The script's job: for each JSONL under live/{date}/ OR live/_archive/{date}/,
delete the existing kis_live parquet dir and call promote_one again so it
re-encodes ts_ms with the ADR-0049 contract.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import polars as pl
import pytest

from hoga.api.timeenc import unix_ms_to_hhmmssms


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "repromote_kis_live.py"


def _load_script_module():
    spec = importlib.util.spec_from_file_location("repromote_kis_live", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["repromote_kis_live"] = module
    spec.loader.exec_module(module)
    return module


def _seed_jsonl(path: Path, code: str, date: str, *, unix_ms: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({
        "t_ms": unix_ms,
        "kind": "ob",
        "payload": {"code": code, "t_ms": unix_ms,
                    "bids": [], "asks": [],
                    "total_bid_qty": 0, "total_ask_qty": 0},
    })
    path.write_text(line + "\n")


def _seed_corrupt_parquet(target_dir: Path, code: str, date: str) -> None:
    """Pre-existing kis_live dir with the OLD (corrupted) encoding — Unix ms in ts_ms."""
    target_dir.mkdir(parents=True, exist_ok=True)
    rows = [{"ts_ms": 1779931845123, "phase": "regular"}]  # Unix ms — the bug
    for i in range(1, 11):
        rows[0][f"bid_p{i}"] = 0
        rows[0][f"bid_q{i}"] = 0
        rows[0][f"ask_p{i}"] = 0
        rows[0][f"ask_q{i}"] = 0
    rows[0]["total_bid_qty"] = 0
    rows[0]["total_ask_qty"] = 0
    pl.DataFrame(rows).write_parquet(target_dir / "snapshots.parquet")
    pl.DataFrame([]).write_parquet(target_dir / "trades.parquet")
    (target_dir / "meta.json").write_text(json.dumps({
        "source": "kis_live", "code": code, "date": date,
        "row_counts": {"snapshots": 1, "trades": 0, "brokers": 0},
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }))


def test_repromote_uses_live_jsonl_when_present(tmp_path: Path) -> None:
    """Live/{date}/{code}.jsonl present → delete kis_live dir + re-promote from it."""
    date = "20260527"
    code = "005930"
    unix_ms = 1779931845123  # 2026-05-29 10:30:45.123 KST … wait, recompute per date
    # Use 20260527 09:00:00 KST
    unix_ms = 1748304000000  # 2026-05-27 00:00 UTC = 09:00 KST
    data_dir = tmp_path
    parquet_root = data_dir / "parquet"
    live_dir = data_dir / "live"

    _seed_corrupt_parquet(parquet_root / date / code / "kis_live", code, date)
    _seed_jsonl(live_dir / date / f"{code}.jsonl", code, date, unix_ms=unix_ms)

    mod = _load_script_module()
    asyncio.run(mod.repromote(data_dir, date=date, code=code))

    # Re-promoted parquet must use HHMMSSmmm encoding (90000000 = 09:00:00.000).
    df = pl.read_parquet(parquet_root / date / code / "kis_live" / "snapshots.parquet")
    assert df["ts_ms"][0] == unix_ms_to_hhmmssms(date, unix_ms), (
        "re-promoted parquet must honor ADR-0049 encoding contract"
    )


def test_repromote_falls_back_to_archive_when_live_jsonl_missing(tmp_path: Path) -> None:
    """live/_archive/{date}/{code}.jsonl is used when live/{date}/ has no JSONL."""
    date = "20260527"
    code = "005930"
    unix_ms = 1748304000000
    data_dir = tmp_path
    parquet_root = data_dir / "parquet"
    archive_dir = data_dir / "live" / "_archive"

    _seed_corrupt_parquet(parquet_root / date / code / "kis_live", code, date)
    _seed_jsonl(archive_dir / date / f"{code}.jsonl", code, date, unix_ms=unix_ms)

    mod = _load_script_module()
    asyncio.run(mod.repromote(data_dir, date=date, code=code))

    df = pl.read_parquet(parquet_root / date / code / "kis_live" / "snapshots.parquet")
    assert df["ts_ms"][0] == unix_ms_to_hhmmssms(date, unix_ms)


def test_repromote_reports_skip_when_no_jsonl_anywhere(tmp_path: Path, capsys) -> None:
    """Neither live/{date}/ nor _archive has the JSONL → report and continue."""
    date = "20260527"
    code = "005930"
    data_dir = tmp_path
    mod = _load_script_module()
    asyncio.run(mod.repromote(data_dir, date=date, code=code))
    captured = capsys.readouterr()
    assert "no JSONL" in captured.out or "skip" in captured.out
```

- [ ] **Step 2: Run the test to verify it FAILS with `FileNotFoundError` (script doesn't exist yet)**

Run: `uv run pytest tests/unit/test_repromote_script.py -v`
Expected: FAIL with `FileNotFoundError: scripts/repromote_kis_live.py`.

- [ ] **Step 3: Create the script**

Create `scripts/repromote_kis_live.py`:

```python
"""One-shot: delete kis_live/ parquet dirs and re-promote from preserved JSONL.

Use after deploying the ADR-0049 encoding fix (hoga/live/promote.py) to
restore historical dates that the today_promoter won't touch (it only
handles today).

DO NOT run for today — today_promoter is actively writing today's
kis_live dir via atomic_write_parquet (tempfile + rename). This script's
shutil.rmtree can interleave with the promoter's mkdir/rename and
produce a transient FileNotFoundError or partial dir. For today, use:
    rm -rf data/parquet/{today}/*/kis_live
and let the next 5-min today_promoter cycle rebuild from scratch.

Usage:
    uv run python scripts/repromote_kis_live.py --date 20260527
    uv run python scripts/repromote_kis_live.py --date 20260527 --code 005930

JSONL source resolution (in order):
    1. <data_dir>/live/{date}/{code}.jsonl              (not yet archived)
    2. <data_dir>/live/_archive/{date}/{code}.jsonl     (Daily Promotion 이후)
"""
from __future__ import annotations

import argparse
import asyncio
import shutil
from pathlib import Path

from hoga.config import resolve_data_dir
from hoga.live.promote import promote_one


def _resolve_jsonl(data_dir: Path, date: str, code: str) -> Path | None:
    """Find the JSONL for (date, code), preferring the live dir over archive."""
    live = data_dir / "live" / date / f"{code}.jsonl"
    if live.exists():
        return live
    archive = data_dir / "live" / "_archive" / date / f"{code}.jsonl"
    if archive.exists():
        return archive
    return None


async def repromote(data_dir: Path, *, date: str, code: str | None) -> None:
    """Re-promote (date, code) — or every code with a JSONL on that date.

    Steps per code:
      1. Resolve JSONL via _resolve_jsonl (live > archive).
      2. Delete existing kis_live parquet dir (this bypasses promote_one's
         meta.json idempotency guard — intentional, per ADR-0049 spec).
      3. Call promote_one which re-encodes ts_ms per the new contract.

    Per-code errors are caught + logged; the loop continues so a single
    bad JSONL doesn't leave the batch half-recovered. Exits non-zero if
    any code failed.
    """
    parquet_root = data_dir / "parquet"
    live_dir = data_dir / "live" / date
    archive_dir = data_dir / "live" / "_archive" / date

    if code is not None:
        codes = [code]
    else:
        seen: set[str] = set()
        for d in (live_dir, archive_dir):
            if d.exists():
                for p in d.glob("*.jsonl"):
                    seen.add(p.stem)
        codes = sorted(seen)

    if not codes:
        print(f"no JSONL found for date={date} (live or archive)")
        return

    total = len(codes)
    recovered = 0
    skipped = 0
    failures: list[tuple[str, str]] = []

    for idx, c in enumerate(codes, start=1):
        prefix = f"[{idx}/{total}]"
        jsonl = _resolve_jsonl(data_dir, date, c)
        if jsonl is None:
            print(f"{prefix} skip {c}: no JSONL")
            skipped += 1
            continue
        target = parquet_root / date / c / "kis_live"
        try:
            if target.exists():
                print(f"{prefix} delete {target}")
                shutil.rmtree(target)
            print(f"{prefix} promote {date}/{c} from {jsonl}")
            await promote_one(jsonl, parquet_root, code=c, date=date)
            recovered += 1
        except Exception as e:  # noqa: BLE001 — one bad JSONL must not abort batch
            print(f"{prefix} FAILED {c}: {type(e).__name__}: {e}")
            failures.append((c, f"{type(e).__name__}: {e}"))

    print(
        f"\nrecovered={recovered} skipped={skipped} failed={len(failures)} "
        f"total={total}"
    )
    if failures:
        print("failures:")
        for c, msg in failures:
            print(f"  {c}: {msg}")
        raise SystemExit(1)


def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="YYYYMMDD")
    parser.add_argument("--code", help="6-digit Code; if omitted, all codes with JSONL on that date")
    parser.add_argument(
        "--data-dir",
        default=None,
        help="Override data dir (default: resolve_data_dir())",
    )
    args = parser.parse_args()
    data_dir = Path(args.data_dir) if args.data_dir else resolve_data_dir()
    asyncio.run(repromote(data_dir, date=args.date, code=args.code))


if __name__ == "__main__":
    _main()
```

- [ ] **Step 4: Sanity-check the import path (already verified in plan authoring)**

Run: `grep -n "def resolve_data_dir" hoga/config.py`
Expected: prints `14:def resolve_data_dir() -> Path:`. The script imports from `hoga.config` (NOT `hoga.api.disk_state` — the function lives in `hoga/config.py`). Returns `Path` directly, no `Path(...)` wrapping needed.

Also extend the test to assert per-code error handling. Add to `tests/unit/test_repromote_script.py`:

```python
def test_repromote_continues_on_single_code_failure(tmp_path: Path, capsys) -> None:
    """One bad JSONL must not abort the batch; failures are reported."""
    date = "20260527"
    good_code = "005930"
    bad_code = "000660"
    unix_ms = 1748304000000
    data_dir = tmp_path
    parquet_root = data_dir / "parquet"

    # Good code: real JSONL + corrupt parquet to recover.
    _seed_corrupt_parquet(parquet_root / date / good_code / "kis_live", good_code, date)
    _seed_jsonl(data_dir / "live" / date / f"{good_code}.jsonl", good_code, date, unix_ms=unix_ms)
    # Bad code: malformed JSONL to trigger promote_one failure.
    bad_jsonl = data_dir / "live" / date / f"{bad_code}.jsonl"
    bad_jsonl.parent.mkdir(parents=True, exist_ok=True)
    bad_jsonl.write_text("{not valid json\n")

    mod = _load_script_module()
    with pytest.raises(SystemExit) as excinfo:
        asyncio.run(mod.repromote(data_dir, date=date, code=None))
    assert excinfo.value.code == 1

    captured = capsys.readouterr()
    assert "FAILED" in captured.out
    assert good_code in captured.out
    assert "recovered=1" in captured.out
    # Good code's parquet still got recovered despite bad code's failure.
    df = pl.read_parquet(parquet_root / date / good_code / "kis_live" / "snapshots.parquet")
    assert df["ts_ms"][0] == unix_ms_to_hhmmssms(date, unix_ms)
```

Note: `promote_one`'s `_parse_jsonl_to_records` actually swallows JSONDecodeError (line 64-69 of promote.py) with a partial_line warning; it does NOT raise. To force a real failure, the test seeds a structurally fine but encoding-defying value — change the `bad_jsonl.write_text(...)` line to:
```python
bad_jsonl.write_text(json.dumps({
    "t_ms": "not-a-number",  # int() in promote.py will TypeError
    "kind": "ob", "payload": {"bids": [], "asks": [],
                              "total_bid_qty": 0, "total_ask_qty": 0},
}) + "\n")
```
Actually verify: post-fix, `_parse_jsonl_to_records` catches `(ValueError, TypeError)` from `unix_ms_to_hhmmssms` and just skips the row, returning empty results — NOT raising. So `promote_one` itself never raises on bad JSONL content; it just produces an empty parquet. The "failures" path of the script is therefore reserved for I/O errors (disk full, permission denied), not data errors. Adjust the test by patching `promote_one` to raise via `monkeypatch.setattr(mod, "promote_one", lambda **_: _ for _ in ()).throw(RuntimeError("simulated"))`:

```python
def test_repromote_continues_on_single_code_failure(tmp_path, capsys, monkeypatch) -> None:
    date = "20260527"
    good_code = "005930"
    bad_code = "000660"
    unix_ms = 1748304000000
    data_dir = tmp_path
    parquet_root = data_dir / "parquet"

    _seed_corrupt_parquet(parquet_root / date / good_code / "kis_live", good_code, date)
    _seed_jsonl(data_dir / "live" / date / f"{good_code}.jsonl", good_code, date, unix_ms=unix_ms)
    _seed_jsonl(data_dir / "live" / date / f"{bad_code}.jsonl", bad_code, date, unix_ms=unix_ms)

    mod = _load_script_module()
    real_promote = mod.promote_one
    async def patched(*args, **kw):
        if kw.get("code") == bad_code:
            raise RuntimeError("simulated promote_one failure")
        await real_promote(*args, **kw)
    monkeypatch.setattr(mod, "promote_one", patched)

    with pytest.raises(SystemExit) as excinfo:
        asyncio.run(mod.repromote(data_dir, date=date, code=None))
    assert excinfo.value.code == 1

    captured = capsys.readouterr()
    assert "FAILED" in captured.out
    assert bad_code in captured.out
    assert "recovered=1" in captured.out
    df = pl.read_parquet(parquet_root / date / good_code / "kis_live" / "snapshots.parquet")
    assert df["ts_ms"][0] == unix_ms_to_hhmmssms(date, unix_ms)
```

- [ ] **Step 5: Run the script tests — verify all PASS**

Run: `uv run pytest tests/unit/test_repromote_script.py -v`
Expected: all 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/repromote_kis_live.py tests/unit/test_repromote_script.py
git commit -m "$(cat <<'EOF'
chore(scripts): add one-shot kis_live re-promote with archive fallback

Restores kis_live parquet directories that were promoted before the
ADR-0049 encoding fix landed. For each (date, code) the script:
  1. Resolves the JSONL (live dir first, then _archive — Daily
     Promotion may have moved it).
  2. Deletes the existing kis_live parquet dir (bypassing
     promote_one's meta.json idempotency guard — intentional).
  3. Calls promote_one which now writes HHMMSSmmm ts_ms.

For today's date, prefer rm -rf the dirs and let today_promoter
rebuild on the next 5-minute cycle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Operational data recovery (manual runbook)

This task is NOT committed code. It documents the steps a human runs once after merging Tasks 1-4. Add a brief runbook section to the spec so future readers find it.

- [ ] **Step 1: Verify backend deploys with new encoding (smoke)**

After Tasks 1-4 land, the dev server reloads automatically (`uvicorn --reload`). Verify the new code is active:

```bash
curl -s 'http://127.0.0.1:8000/api/range?code=058610&from=20260529&to=20260529&bucket_ms=60000&source_pref=hogaplay' | python3 -c "
import sys, json
from datetime import datetime, timezone, timedelta
KST = timezone(timedelta(hours=9))
d = json.load(sys.stdin)
qr = d['quote_ratio']['points']
years = {datetime.fromtimestamp(p['t']/1000, KST).year for p in qr}
print('quote_ratio years:', years)
print('point count:', len(qr))
"
```
Expected before recovery: still mixed (2026 + 2046) because the parquet dirs on disk are still from the old writer. The new writer only affects future Today Promotion cycles. **This confirms recovery is needed.**

- [ ] **Step 2: Recover today (20260529) — delete corrupted dir, let today_promoter rebuild**

```bash
rm -rf /home/dev/.local/share/hoga-ops/data/parquet/20260529/*/kis_live
```

**Heads-up to the operator**: between this `rm -rf` and the next `today_promoter` cycle (up to 5 minutes), `/live` shows hoga panes (Ratio, QuoteTotals, FillStrength) **completely empty for today** — past dates still render. This window is temporarily *worse* than the pre-fix state (which at least showed partial year-2046 data getting filtered). Tell the user if they're watching. The SSE buffer keeps the chart's live tick stream alive throughout, only the past-derived indicator series go blank.

Wait up to 5 minutes for `today_promoter` (ADR-0043) to repopulate. Verify with the same curl from Step 1 — quote_ratio years should now show `{2026}` only.

- [ ] **Step 3: Recover past dates (20260527, 20260528)**

```bash
uv run python scripts/repromote_kis_live.py --date 20260527
uv run python scripts/repromote_kis_live.py --date 20260528
```

Each invocation prints `delete .../kis_live` then `promote 20260527/005930 from .../jsonl` for every code with a JSONL on that date.

- [ ] **Step 4: Verify recovery end-to-end**

```bash
curl -s 'http://127.0.0.1:8000/api/range?code=058610&from=20260527&to=20260529&bucket_ms=60000&source_pref=hogaplay' | python3 -c "
import sys, json
from collections import Counter
from datetime import datetime, timezone, timedelta
KST = timezone(timedelta(hours=9))
d = json.load(sys.stdin)
qr = d['quote_ratio']['points']
years = Counter(datetime.fromtimestamp(p['t']/1000, KST).year for p in qr)
print('quote_ratio year distribution:', dict(years))
assert set(years) == {2026}, f'recovery incomplete: {years}'
print('OK')
"
```
Expected: `quote_ratio year distribution: {2026: N}` followed by `OK`.

- [ ] **Step 5: Manual UI verification in `/live`**

Open `http://localhost:5173/live` in a browser. Select 058610 (or any watchlist code). Confirm:
- Candle chart renders for today (20260529).
- The three hoga panes below (Ratio, QuoteTotals, FillStrength) **show data lines for today** — this was empty before the fix.
- After waiting ~10 seconds, watch new SSE ticks add points to the right edge of each hoga pane.

If the panes are still empty for today but populated for 20260528, check that Task 3's clip landed — `cd frontend && npm test -- buildLiveBundle.test.ts` should pass all sanity-clip cases.

- [ ] **Step 6: Document the recovery completion**

Run:
```bash
ls /home/dev/.local/share/hoga-ops/data/parquet/{20260527,20260528,20260529}/*/kis_live 2>/dev/null | wc -l
```
Expected: matches the count from before recovery (17 dirs). If any dir is missing, the JSONL may not have existed — check `data/live/{date}/` and `data/live/_archive/{date}/` for that code.

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing task |
|---|---|
| §Design 1 (Writer 정규화) | Task 1 |
| §Design 2 (데이터 복구 script + archive 폴백) | Task 4 + Task 5 |
| §Design 3 (frontend sanity clip) | Task 3 |
| §Design 4 (회귀 테스트 backend) | Task 2 |
| §Design 4 (회귀 테스트 frontend) | Task 3 (sanity clip tests double as the invariant 4 regression) |
| §Risk (자정 race row skip) | Task 1 Step 4 test + Step 6 try/except |
| §Risk (운영 미스 / archive fallback) | Task 4 Step 1 test 2 |
| Invariant 1 (`ts_ms` = HHMMSSmmm) | Task 1 |
| Invariant 2 (reader 디코딩 가정) | Task 2 verifies end-to-end |
| Invariant 3 (day-window) | Task 2 |
| Invariant 4 (pastMaxQrT clip + monotonicity) | Task 3 |

All spec sections have at least one task.

**Placeholder scan:** No "TBD", no "implement later", no "similar to Task N" without code, every step has the exact code or command. Test cases in every Task have full assertions.

**Type consistency:**
- `_parse_jsonl_to_records` signature unchanged across all tasks (Task 1 modifies the body only).
- `repromote(data_dir, *, date, code)` consistent between script body and test imports (Task 4).
- `buildLiveBundle` input signature unchanged (Task 3 only modifies internals).
- `unix_ms_to_hhmmssms(date, t_ms)` and `hhmmssms_to_unix_ms(date, ts_ms)` used consistently per `hoga/api/timeenc.py`.
- `QueryEngine` constructor — Task 2 Step 4 explicitly verifies the actual constructor name; if `from_parquet_root` doesn't exist, the test imports the real one. This is a known unknown handled inline.

---

## Deferred review notes

Plan review (2026-05-29) accepted the following as **Suggestions / Nits** that don't block landing this PR but should be noted:

- **Inventory exclusion follow-up** (eng-review). [hoga/api/queries.py:155-166](../../../hoga/api/queries.py)'s `_find_winning_meta` docstring says "kis_live is intentionally EXCLUDED — its snapshots.parquet uses `t_ms` (Unix ms)". After ADR-0049 lands, that rationale evaporates. The exclusion itself is out-of-scope for this PR (no Inventory UI change shipped), but the docstring is now misleading. Open a follow-up issue: "Inventory: integrate kis_live Source now that ts_ms encoding is unified (post-ADR-0049)".

- **Writer assertion alternative** (eng-review nit). ADR-0049 §"Why not enforce via schema" considered `assert 0 <= ts_ms < 240_000_000` at writer time as a runtime guard, and rejected it in favor of the day-window regression test in Task 2. The decision is documented in the ADR; no plan change. If the regression test ever gets disabled or skipped, revisit the writer assertion.

- **Recovery script progress indicator** (design-review S3). Plan Task 4 Step 3 already emits `[i/N] promote ...` lines per code, addressing this.

- **Year 2126 → year 2046 in clip test** (design-review N1). Already addressed in Task 3 Step 1 (test uses `20 * 365 * 24 * 3600 * 1000` offset to match the production failure mode).

- **Design tokens / CSS untouched** (design-review N2). Confirmed — plan touches no `frontend/src/styles/`, no `.css`, no `DESIGN.md` tokens. No verification step needed.
