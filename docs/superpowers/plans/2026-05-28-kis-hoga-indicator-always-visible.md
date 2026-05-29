---
scope: both
spec: docs/superpowers/specs/2026-05-28-kis-hoga-indicator-always-visible-design.md
related_adrs: [ADR-0037, ADR-0038, ADR-0039, ADR-0040, ADR-0043]
---

# KIS 호가 보조지표 — `/replay`·`/live`에서 끊김 없이 구현 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KIS 폴러가 받은 호가 데이터를 `/replay`·`/live` 양쪽에서 끊김 없이 호가 보조지표 패널로 볼 수 있게 한다. 두 독립 버그를 함께 해결: (1) 오늘 jsonl이 promote 안 돼 차트에 안 보임 (2) source 공존일에 데이터 슬라이스가 source-unaware fallback으로 손상 데이터 노출.

**Architecture:** 백엔드 — `promote_today()`를 5분 주기 asyncio task로 추가해 오늘 jsonl을 parquet으로 incremental overwrite. `/api/range`의 슬라이스 빌더 4개에 `source` 인자를 명시 전달해 source-aware data path 일관성 회복. 프런트 — `buildLiveBundle.ts`의 binary 분기를 timestamp-based dedup으로 교체.

**Tech Stack:** Python 3.13 + FastAPI + polars + DuckDB (백엔드), TypeScript + React + Zustand + lightweight-charts (프런트). 테스트는 pytest + vitest.

---

## 파일 구조

| 파일 | 책임 | 변경 종류 |
|---|---|---|
| `hoga/api/_atomic_write.py` | atomic_write 헬퍼 (JSON + Parquet) | 함수 1개 추가 (`atomic_write_parquet`) |
| `hoga/live/promote.py` | jsonl→parquet 변환 cold path | 헬퍼 추출 + 함수 1개 추가 + 가드 1줄 |
| `hoga/live/lifecycle.py` | Live Capture 라이프사이클 + accessor | accessor 1개 + task 1개 추가 |
| `hoga/api/app.py` | FastAPI lifespan | task wire 추가 |
| `hoga/api/bundle.py` | `/api/range` 본체 | 4개 슬라이스 빌더에 source 인자 + 메인 루프 갱신 |
| `frontend/src/live/buildLiveBundle.ts` | 라이브 번들 머지 | 분기 1곳 dedup으로 교체 |
| `tests/unit/api/test_atomic_write.py` | `atomic_write_parquet` 테스트 | 신규 파일 |
| `tests/unit/live/test_promote.py` | promote_one 회귀 + parse_jsonl 단위 | 기존 파일 확장 (없으면 신규) |
| `tests/unit/live/test_promote_today.py` | promote_today 단위 6개 | 신규 |
| `tests/unit/live/test_today_promoter.py` | start_today_promoter 단위 4개 | 신규 |
| `tests/unit/api/test_bundle_source_aware.py` | 5/27 source-aware 시나리오 4개 | 신규 |
| `frontend/src/live/buildLiveBundle.test.ts` | dedup 테스트 3개 | 기존 파일 확장 |

각 task는 TDD 5-step 패턴: 실패 테스트 작성 → 실패 확인 → 구현 → 통과 확인 → commit.

---

## Task 1: `atomic_write_parquet` 헬퍼 추가

**Files:**
- Modify: `hoga/api/_atomic_write.py`
- Test: `tests/unit/api/test_atomic_write.py` (신규)

- [ ] **Step 1: 실패 테스트 작성**

`tests/unit/api/test_atomic_write.py` 생성:

```python
"""Test atomic_write_parquet helper."""
from pathlib import Path

import polars as pl
import pytest

from hoga.api._atomic_write import atomic_write_parquet


def test_atomic_write_parquet_creates_file(tmp_path: Path) -> None:
    path = tmp_path / "snapshots.parquet"
    records = [{"t_ms": 1779800000000, "price": 27000}]
    atomic_write_parquet(path, records)
    assert path.exists()
    df = pl.read_parquet(path)
    assert df.shape == (1, 2)
    assert df["price"][0] == 27000


def test_atomic_write_parquet_overwrites_existing(tmp_path: Path) -> None:
    path = tmp_path / "snapshots.parquet"
    atomic_write_parquet(path, [{"t_ms": 1, "x": 10}])
    atomic_write_parquet(path, [{"t_ms": 2, "x": 20}, {"t_ms": 3, "x": 30}])
    df = pl.read_parquet(path)
    assert df.shape == (2, 2)
    assert df["x"].to_list() == [20, 30]


def test_atomic_write_parquet_creates_parent_dirs(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "dir" / "out.parquet"
    atomic_write_parquet(path, [{"t_ms": 1, "x": 1}])
    assert path.exists()


def test_atomic_write_parquet_empty_records_unlinks(tmp_path: Path) -> None:
    """빈 records → 기존 파일 unlink (downstream DuckDB가 빈 parquet 처리 까다로움)."""
    path = tmp_path / "out.parquet"
    atomic_write_parquet(path, [{"t_ms": 1, "x": 1}])
    assert path.exists()
    atomic_write_parquet(path, [])
    assert not path.exists()


def test_atomic_write_parquet_no_partial_file_on_error(tmp_path: Path, monkeypatch) -> None:
    """write_parquet이 raise하면 target 파일은 그대로 (tempfile만 남아도 OK)."""
    path = tmp_path / "out.parquet"
    atomic_write_parquet(path, [{"t_ms": 1, "x": 1}])
    original_size = path.stat().st_size

    def boom(*args, **kwargs):
        raise OSError("disk full simulation")

    monkeypatch.setattr(pl.DataFrame, "write_parquet", boom)
    with pytest.raises(OSError):
        atomic_write_parquet(path, [{"t_ms": 2, "x": 2}])
    # 기존 파일 보존
    assert path.exists()
    assert path.stat().st_size == original_size
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/api/test_atomic_write.py -v`
Expected: 5 errors — `ImportError: cannot import name 'atomic_write_parquet'`

- [ ] **Step 3: 구현**

`hoga/api/_atomic_write.py`의 `atomic_write_json` 아래에 추가:

```python
def atomic_write_parquet(path: Path, records: list[dict[str, Any]]) -> None:
    """Write ``records`` as Parquet to ``path`` atomically.

    Empty ``records`` → unlink existing file. polars handles empty
    DataFrame poorly, and downstream DuckDB read_parquet errors on
    zero-row files in some configurations — so we represent "no data"
    as "no file" (callers must handle FileNotFoundError on the read
    side, which the standard try/except FileNotFoundError pattern does).

    Pattern: tempfile in target's parent dir → polars write → os.replace.
    The parent dir is created if missing.

    Raises:
        OSError: if disk write fails. On failure the target is unchanged
            (the tempfile may linger; callers can ignore).
    """
    import polars as pl  # local import — heavy module

    path.parent.mkdir(parents=True, exist_ok=True)

    if not records:
        path.unlink(missing_ok=True)
        return

    with tempfile.NamedTemporaryFile(
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        pl.DataFrame(records).write_parquet(tmp_path)
        os.replace(tmp_path, path)
    except Exception:
        # write_parquet raised — tempfile is partial/empty; clean up.
        tmp_path.unlink(missing_ok=True)
        raise
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/api/test_atomic_write.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add hoga/api/_atomic_write.py tests/unit/api/test_atomic_write.py
git commit -m "feat(atomic): add atomic_write_parquet helper for promote_today"
```

---

## Task 2: `_parse_jsonl_to_records` 헬퍼 추출 (promote_one 리팩터)

**Files:**
- Modify: `hoga/live/promote.py:52-156` (promote_one inline 파싱 로직 추출)
- Test: `tests/unit/live/test_promote.py` (회귀; 파일 없으면 신규)

- [ ] **Step 1: 실패 테스트 — 헬퍼 자체 단위 테스트**

`tests/unit/live/test_promote.py` 파일이 없으면 생성, 있으면 다음 추가:

```python
"""Test for _parse_jsonl_to_records helper extracted from promote_one."""
import json
from pathlib import Path

from hoga.live.promote import _parse_jsonl_to_records


def test_parse_jsonl_to_records_basic(tmp_path: Path) -> None:
    jsonl = tmp_path / "in.jsonl"
    rows = [
        {"t_ms": 1, "kind": "ob", "payload": {
            "bids": [{"price": 26800, "qty": 879}],
            "asks": [{"price": 26850, "qty": 6141}],
            "total_bid_qty": 95085, "total_ask_qty": 102768,
        }},
        {"t_ms": 2, "kind": "trade", "payload": {
            "trades": [{"t_ms": 2, "price": 26850, "qty": 10, "side": 1}],
            "phase": "regular",
        }},
        {"t_ms": 3, "kind": "broker", "payload": {
            "buy_top": [{"name": "키움", "qty": 100}],
            "sell_top": [{"name": "신한", "qty": 50}],
        }},
    ]
    jsonl.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    snapshots, trades, broker_rows, meta = _parse_jsonl_to_records(
        jsonl, code="003490", date="20260528",
    )

    assert len(snapshots) == 1
    assert snapshots[0]["bid_p1"] == 26800
    assert snapshots[0]["total_bid_qty"] == 95085
    assert len(trades) == 1
    assert trades[0]["price"] == 26850
    assert len(broker_rows) == 2  # 1 buy + 1 sell
    assert meta["source"] == "kis_live"
    assert meta["code"] == "003490"
    assert meta["row_counts"]["snapshots"] == 1
    assert meta["row_counts"]["trades"] == 1
    assert meta["row_counts"]["brokers"] == 1  # snapshot count, not row count


def test_promote_one_archive_move_regression(tmp_path: Path) -> None:
    """eng-review Suggestion #6 — promote_one refactor 후에도 archive 이동 유지."""
    import asyncio
    from hoga.live.promote import promote_pending
    from datetime import datetime, timezone, timedelta

    kst = timezone(timedelta(hours=9))
    yesterday = (datetime.now(kst) - timedelta(days=1)).strftime("%Y%m%d")
    jsonl = tmp_path / "live" / yesterday / "003490.jsonl"
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    jsonl.write_text(json.dumps({
        "t_ms": 1, "kind": "ob",
        "payload": {"bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")

    asyncio.run(promote_pending(tmp_path))

    # parquet 생성
    assert (tmp_path / "parquet" / yesterday / "003490" / "kis_live" / "meta.json").exists()
    # archive 이동 — 핵심 회귀
    assert not jsonl.exists()
    assert (tmp_path / "live" / "_archive" / yesterday / "003490.jsonl").exists()


def test_parse_jsonl_to_records_skips_torn_line(tmp_path: Path, caplog) -> None:
    jsonl = tmp_path / "in.jsonl"
    good = json.dumps({"t_ms": 1, "kind": "ob", "payload": {
        "bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0,
    }})
    jsonl.write_text(good + "\n{ malformed\n")

    with caplog.at_level("WARNING"):
        snapshots, _, _, meta = _parse_jsonl_to_records(
            jsonl, code="003490", date="20260528",
        )

    assert len(snapshots) == 1
    assert any("partial_line" in r.message for r in caplog.records)
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_promote.py::test_parse_jsonl_to_records_basic -v`
Expected: `ImportError: cannot import name '_parse_jsonl_to_records'`

- [ ] **Step 3: 구현 — promote.py 리팩터**

`hoga/live/promote.py`를 다음과 같이 변경:

```python
# (기존 import 유지)

def _parse_jsonl_to_records(
    jsonl_path: Path,
    *,
    code: str,
    date: str,
) -> tuple[list[dict], list[dict], list[BrokerRow], dict]:
    """Parse one Live Capture JSONL into (snapshots, trades, broker_rows, meta) tuples.

    Shared by promote_one (ADR-0038 daily batch) and promote_today
    (ADR-0043 in-session N-minute overwrite). Torn last lines are skipped
    with a `live.promote.partial_line` warn log.

    `meta` is the JSON dict ready to write to meta.json — caller decides
    when/how to persist it.
    """
    snapshots: list[dict] = []
    trades: list[dict] = []
    broker_rows: list[BrokerRow] = []
    broker_snapshot_count = 0
    broker_seq = 0  # monotonic per stock-date; KIS has no native seq.

    if not jsonl_path.exists():
        # 빈 결과 반환 — caller가 결정
        meta = _build_meta(code, date, snapshots, trades, broker_snapshot_count)
        return snapshots, trades, broker_rows, meta

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
            t_ms = row.get("t_ms")
            p = row.get("payload") or {}
            phase = p.get("phase", "regular")
            if kind == "ob":
                bids = p.get("bids") or []
                asks = p.get("asks") or []
                snap: dict = {"t_ms": t_ms, "phase": phase}
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
                    trades.append({
                        "t_ms": tr.get("t_ms"),
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
                        ts_ms=int(t_ms),
                        seq=broker_seq,
                        side="sell",
                        rank=rank,
                        broker=str(e.get("name") or ""),
                        qty_today=int(e.get("qty") or 0),
                        qty_delta=0,
                    ))
                for rank, e in enumerate(buy[:5], start=1):
                    broker_rows.append(BrokerRow(
                        ts_ms=int(t_ms),
                        seq=broker_seq,
                        side="buy",
                        rank=rank,
                        broker=str(e.get("name") or ""),
                        qty_today=int(e.get("qty") or 0),
                        qty_delta=0,
                    ))

    meta = _build_meta(code, date, snapshots, trades, broker_snapshot_count)
    return snapshots, trades, broker_rows, meta


def _build_meta(
    code: str, date: str, snapshots: list, trades: list, broker_snapshot_count: int,
) -> dict:
    return {
        "source": "kis_live",
        "code": code,
        "date": date,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "row_counts": {
            "snapshots": len(snapshots),
            "trades": len(trades),
            "brokers": broker_snapshot_count,
        },
        # ADR-0003 HHMMSSmmm encoding.
        "regular_session_open_ms": 90000000,    # 09:00:00.000
        "regular_session_close_ms": 153000000,  # 15:30:00.000
    }


async def promote_one(
    jsonl_path: Path,
    parquet_root: Path,
    *,
    code: str,
    date: str,
) -> None:
    """Convert one JSONL file to Parquet artifacts under `parquet/{date}/{code}/kis_live/`.

    Idempotent: if `meta.json` already exists at the target, skip.
    See ADR-0038 (deferred batch promotion) and ADR-0043 (sister Today
    Promotion that this helper coexists with).
    """
    target = parquet_root / date / code / "kis_live"
    meta_path = target / "meta.json"
    if meta_path.exists():
        _log.info(
            "live.promote.skip code=%s date=%s reason=already_promoted", code, date
        )
        return
    if not jsonl_path.exists():
        return

    snapshots, trades, broker_rows, meta = _parse_jsonl_to_records(
        jsonl_path, code=code, date=date,
    )

    target.mkdir(parents=True, exist_ok=True)
    if snapshots:
        pl.DataFrame(snapshots).write_parquet(target / "snapshots.parquet")
    if trades:
        pl.DataFrame(trades).write_parquet(target / "trades.parquet")
    if broker_rows:
        write_brokers_parquet(broker_rows, target / "brokers.parquet")
    meta_path.write_text(json.dumps(meta, indent=2))
    _log.info(
        "live.promote.done code=%s date=%s row_counts=%s",
        code, date, meta["row_counts"],
    )
```

(promote_one의 본문은 헬퍼 호출로 단순화. promote_pending은 다음 task에서 가드 추가하므로 지금은 그대로.)

- [ ] **Step 4: 통과 확인 (헬퍼 + 회귀)**

Run: 
```bash
uv run pytest tests/unit/live/test_promote.py -v
uv run pytest tests/unit/live/ -v  # 기존 promote 관련 회귀
```
Expected: 새 테스트 2개 + 기존 promote_one 회귀 테스트들 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/live/promote.py tests/unit/live/test_promote.py
git commit -m "refactor(live.promote): extract _parse_jsonl_to_records helper"
```

---

## Task 3: `promote_today` 함수 신설

**Files:**
- Modify: `hoga/live/promote.py` (함수 추가)
- Test: `tests/unit/live/test_promote_today.py` (신규)

- [ ] **Step 1: 실패 테스트 6개 작성**

`tests/unit/live/test_promote_today.py`:

```python
"""Tests for promote_today (ADR-0043 — Today Promotion)."""
import asyncio
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

import polars as pl
import pytest

from hoga.live.promote import promote_today

_KST = timezone(timedelta(hours=9))


def _today_kst_yyyymmdd() -> str:
    return datetime.now(_KST).strftime("%Y%m%d")


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


def _ob_event(t_ms: int, bid1_qty: int = 100, ask1_qty: int = 200) -> dict:
    return {
        "t_ms": t_ms, "kind": "ob",
        "payload": {
            "bids": [{"price": 26800, "qty": bid1_qty}],
            "asks": [{"price": 26850, "qty": ask1_qty}],
            "total_bid_qty": bid1_qty * 10,
            "total_ask_qty": ask1_qty * 10,
            "phase": "regular",
        },
    }


@pytest.mark.asyncio
async def test_promote_today_creates_parquet_from_jsonl(tmp_path: Path) -> None:
    today = _today_kst_yyyymmdd()
    jsonl = tmp_path / "live" / today / "003490.jsonl"
    _write_jsonl(jsonl, [_ob_event(1779800000000)])

    await promote_today(tmp_path, code="003490")

    target = tmp_path / "parquet" / today / "003490" / "kis_live"
    assert (target / "snapshots.parquet").exists()
    assert (target / "meta.json").exists()
    meta = json.loads((target / "meta.json").read_text())
    assert meta["source"] == "kis_live"
    assert meta["row_counts"]["snapshots"] == 1


@pytest.mark.asyncio
async def test_promote_today_overwrites_existing(tmp_path: Path) -> None:
    today = _today_kst_yyyymmdd()
    jsonl = tmp_path / "live" / today / "003490.jsonl"

    _write_jsonl(jsonl, [_ob_event(1779800000000, bid1_qty=100)])
    await promote_today(tmp_path, code="003490")

    # 새 줄 append
    with jsonl.open("a") as f:
        f.write(json.dumps(_ob_event(1779800010000, bid1_qty=200)) + "\n")

    await promote_today(tmp_path, code="003490")
    meta = json.loads((tmp_path / "parquet" / today / "003490" / "kis_live" / "meta.json").read_text())
    assert meta["row_counts"]["snapshots"] == 2

    # parquet 내용도 갱신됨
    df = pl.read_parquet(tmp_path / "parquet" / today / "003490" / "kis_live" / "snapshots.parquet")
    assert df.shape[0] == 2


@pytest.mark.asyncio
async def test_promote_today_does_not_move_to_archive(tmp_path: Path) -> None:
    today = _today_kst_yyyymmdd()
    jsonl = tmp_path / "live" / today / "003490.jsonl"
    _write_jsonl(jsonl, [_ob_event(1779800000000)])

    await promote_today(tmp_path, code="003490")

    # jsonl 그대로 살아있음
    assert jsonl.exists()
    # _archive로 안 옮겨짐
    archive = tmp_path / "live" / "_archive" / today / "003490.jsonl"
    assert not archive.exists()


@pytest.mark.asyncio
async def test_promote_today_handles_torn_last_line(tmp_path: Path, caplog) -> None:
    today = _today_kst_yyyymmdd()
    jsonl = tmp_path / "live" / today / "003490.jsonl"
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    good = json.dumps(_ob_event(1779800000000))
    jsonl.write_text(good + "\n{ partial line\n")

    with caplog.at_level("WARNING"):
        await promote_today(tmp_path, code="003490")

    meta = json.loads((tmp_path / "parquet" / today / "003490" / "kis_live" / "meta.json").read_text())
    assert meta["row_counts"]["snapshots"] == 1
    assert any("partial_line" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_promote_today_returns_when_jsonl_missing(tmp_path: Path) -> None:
    # jsonl 자체가 없는 상태 (첫 폴링 전)
    await promote_today(tmp_path, code="003490")
    today = _today_kst_yyyymmdd()
    target = tmp_path / "parquet" / today / "003490" / "kis_live"
    # parquet 안 만듦
    assert not target.exists()


@pytest.mark.asyncio
async def test_promote_today_midnight_race_picks_today_once(
    tmp_path: Path, monkeypatch,
) -> None:
    """eng-review Blocker 1 — today_kst를 함수 진입 시 한 번만 evaluate.

    promote_today 실행 중 자정이 지나도 같은 today를 계속 사용. 다음 사이클이
    새 today를 picking.
    """
    from hoga.live import promote as promote_mod

    # 첫 호출 시 5/27, 두 번째 호출 시 5/28을 반환하는 mock
    dates = iter(["20260527", "20260528"])
    monkeypatch.setattr(promote_mod, "_today_kst_yyyymmdd", lambda: next(dates))

    jsonl = tmp_path / "live" / "20260527" / "003490.jsonl"
    _write_jsonl(jsonl, [_ob_event(1779800000000)])

    # 첫 호출 — 5/27 처리
    await promote_today(tmp_path, code="003490")
    assert (tmp_path / "parquet" / "20260527" / "003490" / "kis_live" / "meta.json").exists()

    # 두 번째 호출 — 5/28 (jsonl 없으므로 noop)
    await promote_today(tmp_path, code="003490")
    # 5/28 parquet 안 만들어짐 (jsonl 없으므로)
    assert not (tmp_path / "parquet" / "20260528" / "003490").exists()


@pytest.mark.asyncio
async def test_promote_today_does_not_create_candles_parquet(tmp_path: Path) -> None:
    """ADR-0040/0043 invariant — promote_today는 candles.parquet 안 만듦.

    Candles는 Live Candle Backfill의 별도 캐시(`~/.local/.../kis-past-candles/`)가
    담당. promote_today가 candles.parquet을 만들면 read path가 어느 source를
    신뢰해야 할지 모호해짐.
    """
    today = _today_kst_yyyymmdd()
    jsonl = tmp_path / "live" / today / "003490.jsonl"
    _write_jsonl(jsonl, [_ob_event(1779800000000)])

    await promote_today(tmp_path, code="003490")

    target = tmp_path / "parquet" / today / "003490" / "kis_live"
    assert (target / "snapshots.parquet").exists()
    assert not (target / "candles.parquet").exists()
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_promote_today.py -v`
Expected: 6 errors — `ImportError: cannot import name 'promote_today'`

- [ ] **Step 3: 구현 — `promote_today` 추가 (midnight race fix 포함)**

`hoga/live/promote.py`에 `promote_one` 함수 위에 추가 (또는 `promote_pending` 위쪽):

```python
def _today_kst_yyyymmdd() -> str:
    """오늘 날짜 YYYYMMDD KST."""
    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


async def promote_today(data_dir: Path, *, code: str) -> None:
    """ADR-0043 Today Promotion — overwrite, no archive move.

    promote_one과 다른 점:
      - idempotent skip 안 함 (meta.json 있어도 다시 처리)
      - archive 이동 안 함 (jsonl 계속 polling 중)
      - parquet 파일들은 atomic_write_parquet으로 원자 교체

    Midnight race protection (eng-review Blocker 1):
      - today_kst를 함수 진입 시점에 한 번만 evaluate.
      - 그 시점 이후 자정이 지나도 이 사이클은 "yesterday" jsonl을 처리.
      - 다음 사이클(5분 후)이 새 today_kst를 picking → 어제는 Daily Promotion 담당.
      - 자정 직후 5분 windows에서 한 사이클이 늦게 끝나도 promote_pending은
        today-skip 가드(Task 4)로 그 jsonl 안 건드림.

    Candles invariant (ADR-0040): snapshots/trades/brokers.parquet만 생성.
    candles는 Live Candle Backfill의 별도 캐시가 담당하므로 절대 생성하지 않는다.
    """
    from hoga.api._atomic_write import atomic_write_parquet, atomic_write_json

    # CRITICAL: today_kst를 한 번만 evaluate해서 자정 race 회피
    today = _today_kst_yyyymmdd()
    jsonl_path = data_dir / "live" / today / f"{code}.jsonl"
    parquet_root = data_dir / "parquet"
    target = parquet_root / today / code / "kis_live"

    if not jsonl_path.exists():
        return

    start_ms = int(time.time() * 1000)
    _log.info("live.today_promote.start code=%s date=%s", code, today)

    try:
        snapshots, trades, broker_rows, meta = _parse_jsonl_to_records(
            jsonl_path, code=code, date=today,
        )
    except Exception:
        _log.exception(
            "live.today_promote.parse_failed code=%s date=%s", code, today,
        )
        raise

    target.mkdir(parents=True, exist_ok=True)
    try:
        atomic_write_parquet(target / "snapshots.parquet", snapshots)
        atomic_write_parquet(target / "trades.parquet", trades)
        # brokers는 BrokerRow dataclass 리스트 → dict 리스트로 변환
        atomic_write_parquet(
            target / "brokers.parquet",
            [
                {
                    "ts_ms": r.ts_ms, "seq": r.seq, "side": r.side,
                    "rank": r.rank, "broker": r.broker,
                    "qty_today": r.qty_today, "qty_delta": r.qty_delta,
                }
                for r in broker_rows
            ],
        )
        atomic_write_json(target / "meta.json", meta, indent=2)
    except OSError as e:
        _log.warning(
            "live.today_promote.write_failed code=%s date=%s reason=%s",
            code, today, e,
        )
        raise

    elapsed = int(time.time() * 1000) - start_ms
    _log.info(
        "live.today_promote.done code=%s date=%s row_counts=%s elapsed_ms=%d",
        code, today, meta["row_counts"], elapsed,
    )

    # design-review B2 — 사용자가 /api/live/status에서 마지막 promote 시각 확인 가능
    from hoga.live import lifecycle
    lifecycle.record_today_promote_success(code, int(time.time() * 1000))
```

(`lifecycle.record_today_promote_success` 헬퍼는 Task 5에 함께 추가됨 — 단순한 dict 갱신 함수)

추가로 파일 상단 import에 `time`이 이미 있는지 확인 (없으면 추가).

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/live/test_promote_today.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add hoga/live/promote.py tests/unit/live/test_promote_today.py
git commit -m "feat(live.promote): add promote_today for in-session Parquet overwrite (ADR-0043)"
```

---

## Task 4: `promote_pending` today-skip 가드

**Files:**
- Modify: `hoga/live/promote.py:163-186` (promote_pending 루프)
- Test: `tests/unit/live/test_promote.py` (확장)

- [ ] **Step 1: 실패 테스트 추가**

`tests/unit/live/test_promote.py`에 추가:

```python
import asyncio
from datetime import datetime, timezone, timedelta

@pytest.mark.asyncio
async def test_promote_pending_skips_today(tmp_path: Path) -> None:
    """ADR-0043 invariant — promote_pending은 오늘 날짜를 건드리지 않음.

    오늘 jsonl이 archive로 옮겨지면 Today Promotion이 빈 jsonl을 만지게 됨.
    """
    from hoga.live.promote import promote_pending

    kst = timezone(timedelta(hours=9))
    today = datetime.now(kst).strftime("%Y%m%d")

    # 오늘 jsonl
    today_jsonl = tmp_path / "live" / today / "003490.jsonl"
    today_jsonl.parent.mkdir(parents=True, exist_ok=True)
    today_jsonl.write_text(json.dumps({
        "t_ms": 1, "kind": "ob",
        "payload": {"bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")

    # 어제 jsonl (정상 promote 대상)
    yesterday = (datetime.now(kst) - timedelta(days=1)).strftime("%Y%m%d")
    yesterday_jsonl = tmp_path / "live" / yesterday / "003490.jsonl"
    yesterday_jsonl.parent.mkdir(parents=True, exist_ok=True)
    yesterday_jsonl.write_text(json.dumps({
        "t_ms": 1, "kind": "ob",
        "payload": {"bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")

    await promote_pending(tmp_path)

    # 오늘은 live/에 그대로
    assert today_jsonl.exists()
    assert not (tmp_path / "live" / "_archive" / today / "003490.jsonl").exists()

    # 어제는 archive로 이동
    assert not yesterday_jsonl.exists()
    assert (tmp_path / "live" / "_archive" / yesterday / "003490.jsonl").exists()
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_promote.py::test_promote_pending_skips_today -v`
Expected: FAIL — `today_jsonl`이 archive로 옮겨졌거나, parquet/{today}가 만들어짐

- [ ] **Step 3: 구현 — `promote_pending`에 today-skip 가드 한 줄 추가**

`hoga/live/promote.py:163` 근처 `promote_pending` 함수 안 루프를 변경:

```python
async def promote_pending(data_dir: Path) -> None:
    """Walk `<data_dir>/live/{date}/*.jsonl` and promote each, then archive.

    Excludes:
    - `_archive/` subdirectory (we don't re-promote our own backup).
    - **Today's date** (ADR-0043 — owned by Today Promotion task).
    - Non-jsonl files.
    - (date, code) pairs already promoted (handled by promote_one's idempotency).
    """
    import shutil

    today = _today_kst_yyyymmdd()
    live_root = data_dir / "live"
    archive_root = live_root / "_archive"
    parquet_root = data_dir / "parquet"

    if not live_root.is_dir():
        return
    for date_dir in sorted(live_root.iterdir()):
        if not date_dir.is_dir() or date_dir.name == "_archive":
            continue
        if date_dir.name == today:    # ADR-0043 — owned by Today Promotion
            continue
        for jsonl in date_dir.iterdir():
            if jsonl.suffix != ".jsonl" or not jsonl.is_file():
                continue
            code = jsonl.stem
            await promote_one(jsonl, parquet_root, code=code, date=date_dir.name)
            arch_target = archive_root / date_dir.name / jsonl.name
            arch_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(jsonl), str(arch_target))
```

(기존 promote_pending의 다른 줄은 유지)

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/live/test_promote.py -v`
Expected: 모두 PASS (기존 promote_pending 테스트도 함께 통과)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/promote.py tests/unit/live/test_promote.py
git commit -m "feat(live.promote): promote_pending skips today (ADR-0043 invariant)"
```

---

## Task 5: `get_active_codes` accessor in lifecycle.py

**Files:**
- Modify: `hoga/live/lifecycle.py`
- Test: 기존 `tests/unit/live/test_lifecycle.py` (없으면 신규)

- [ ] **Step 1: 실패 테스트**

`tests/unit/live/test_lifecycle.py`에 추가 (없으면 신규):

```python
"""Test get_active_codes accessor (ADR-0043)."""
from hoga.live.lifecycle import get_active_codes, reset_for_tests


def setup_function() -> None:
    reset_for_tests()


def test_get_active_codes_empty_when_poller_not_started() -> None:
    assert get_active_codes() == []


def test_get_active_codes_returns_watchlist_codes_after_start(monkeypatch) -> None:
    """start_live_poller가 watchlist_codes로 채운 후 accessor가 그걸 반환."""
    from hoga.live import lifecycle
    from hoga.live.lifecycle import _State

    # poller 시작 모킹 — 실제 KIS 호출 없이 _state만 설정
    lifecycle._state = _State(
        started_at_ms=1,
        watchlist_codes=("003490", "058610"),
        poller_task=None,
        poller_obj=None,
    )

    assert get_active_codes() == ["003490", "058610"]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_lifecycle.py -v`
Expected: `ImportError: cannot import name 'get_active_codes'`

- [ ] **Step 3: 구현 — `get_active_codes` 추가**

`hoga/live/lifecycle.py`에 `get_status` 근처(line 112 부근) 다음 추가:

```python
# design-review B2 — last successful promote_today timestamps (in-memory, per code)
_today_promote_last_ms: dict[str, int] = {}


def record_today_promote_success(code: str, t_ms: int) -> None:
    """Called by promote_today on success; surfaced via LiveStatus."""
    _today_promote_last_ms[code] = t_ms


def get_today_promote_last_ms() -> dict[str, int]:
    """Snapshot of last successful Today Promotion epoch_ms per code."""
    return dict(_today_promote_last_ms)


def get_active_codes() -> list[str]:
    """Return the currently active watchlist codes the poller is iterating.

    Empty list if poller hasn't started or has stopped.

    **Contract (eng-review Blocker 2)**: callers receive a snapshot at call
    time — the accessor reads `_state.watchlist_codes` synchronously. The
    `start_today_promoter` task (ADR-0043) calls this each cycle (every
    `interval_s` seconds), so watchlist mutations through `start_live_poller`
    (which rebuilds `_state`) **propagate immediately** to the next cycle —
    no caching layer, no closure capture of stale codes.

    If the watchlist changes mid-cycle and you don't want to wait for the
    current cycle to drain, call `start_live_poller` again (it's idempotent
    + already restarts the poller task).
    """
    return list(_state.watchlist_codes)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/live/test_lifecycle.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_lifecycle.py
git commit -m "feat(live.lifecycle): add get_active_codes accessor for Today Promotion"
```

---

## Task 6: `start_today_promoter` asyncio task

**Files:**
- Modify: `hoga/live/lifecycle.py` (task 추가)
- Test: `tests/unit/live/test_today_promoter.py` (신규)

- [ ] **Step 1: 실패 테스트 4개**

`tests/unit/live/test_today_promoter.py`:

```python
"""Tests for start_today_promoter task (ADR-0043)."""
import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from hoga.live.lifecycle import start_today_promoter, stop_today_promoter


@pytest.mark.asyncio
async def test_today_promoter_calls_promote_today_per_cycle(
    tmp_path: Path, monkeypatch,
) -> None:
    """task가 sleep 사이에 promote_today를 매 cycle마다 호출."""
    calls: list[tuple[str, str]] = []

    async def fake_promote(data_dir, *, code):
        calls.append((str(data_dir), code))

    monkeypatch.setattr("hoga.live.lifecycle.promote_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_active_codes=lambda: ["003490", "058610"],
        interval_s=0.05,
    )
    await asyncio.sleep(0.18)  # ~3 cycles
    await stop_today_promoter(task)

    # 각 cycle마다 2종목 × 최소 2~3 cycles = 4건 이상
    assert len(calls) >= 4
    codes = {c for _, c in calls}
    assert codes == {"003490", "058610"}


@pytest.mark.asyncio
async def test_today_promoter_survives_code_exception(
    tmp_path: Path, monkeypatch,
) -> None:
    """한 종목 promote가 raise해도 다음 종목 / 다음 cycle 계속."""
    calls: list[str] = []

    async def fake_promote(data_dir, *, code):
        calls.append(code)
        if code == "003490":
            raise RuntimeError("simulated")

    monkeypatch.setattr("hoga.live.lifecycle.promote_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_active_codes=lambda: ["003490", "058610"],
        interval_s=0.05,
    )
    await asyncio.sleep(0.15)
    await stop_today_promoter(task)

    # 058610은 여러 번 호출됨 (003490 raise 후에도)
    assert calls.count("058610") >= 2


@pytest.mark.asyncio
async def test_today_promoter_survives_cycle_exception(
    tmp_path: Path, monkeypatch,
) -> None:
    """get_active_codes가 raise해도 다음 cycle 계속."""
    cycle_count = 0

    def flaky_get_codes():
        nonlocal cycle_count
        cycle_count += 1
        if cycle_count == 1:
            raise RuntimeError("simulated")
        return ["003490"]

    async def fake_promote(data_dir, *, code): pass
    monkeypatch.setattr("hoga.live.lifecycle.promote_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_active_codes=flaky_get_codes,
        interval_s=0.05,
    )
    await asyncio.sleep(0.15)
    await stop_today_promoter(task)

    assert cycle_count >= 2  # 첫 cycle exception 후에도 진행


@pytest.mark.asyncio
async def test_today_promoter_picks_up_watchlist_mutations_per_cycle(
    tmp_path: Path, monkeypatch,
) -> None:
    """eng-review Blocker 2 — get_active_codes는 매 cycle마다 호출돼서 watchlist 변경을 즉시 반영."""
    calls: list[str] = []

    async def fake_promote(data_dir, *, code):
        calls.append(code)

    monkeypatch.setattr("hoga.live.lifecycle.promote_today", fake_promote)

    codes_list = ["003490"]
    def dynamic_codes() -> list[str]:
        return list(codes_list)  # mutable closure

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_active_codes=dynamic_codes,
        interval_s=0.05,
    )
    await asyncio.sleep(0.07)  # 1+ cycle with original list
    codes_list.append("058610")  # mutate mid-loop
    await asyncio.sleep(0.12)  # 2+ more cycles with mutated list
    await stop_today_promoter(task)

    assert "003490" in calls
    assert "058610" in calls  # mutation propagated within seconds, no restart needed


@pytest.mark.asyncio
async def test_today_promoter_empty_codes_no_promote_calls(
    tmp_path: Path, monkeypatch,
) -> None:
    """watchlist 비어있으면 promote_today 호출 안 함."""
    calls: list[str] = []

    async def fake_promote(data_dir, *, code):
        calls.append(code)

    monkeypatch.setattr("hoga.live.lifecycle.promote_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_active_codes=lambda: [],
        interval_s=0.05,
    )
    await asyncio.sleep(0.15)
    await stop_today_promoter(task)

    assert calls == []
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_today_promoter.py -v`
Expected: `ImportError: cannot import name 'start_today_promoter'`

- [ ] **Step 3: 구현**

`hoga/live/lifecycle.py`에 추가 (`get_active_codes` 근처):

```python
from typing import Callable

# 위에 import 추가
from hoga.live.promote import promote_today


async def start_today_promoter(
    *,
    data_dir: Path,
    get_active_codes: Callable[[], list[str]],
    interval_s: float = 300.0,
) -> asyncio.Task:
    """Start the ADR-0043 Today Promotion loop.

    Polls `get_active_codes()` each `interval_s` seconds and calls
    `promote_today(data_dir, code=...)` for each. Per-code exceptions
    are caught and logged so one bad code doesn't break the cycle.
    The outer try/except prevents the loop itself from dying on a
    transient get_active_codes failure.

    Returns the created asyncio.Task; caller (lifespan) is responsible
    for cancelling on shutdown via `stop_today_promoter`.
    """
    async def loop() -> None:
        log = logging.getLogger(__name__)
        while True:
            try:
                codes = get_active_codes()
                for code in codes:
                    try:
                        await promote_today(data_dir, code=code)
                    except Exception:
                        log.exception(
                            "live.today_promote.code_failed code=%s", code,
                        )
            except Exception:
                log.exception("live.today_promote.cycle_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="today-promoter")


async def stop_today_promoter(task: asyncio.Task | None) -> None:
    """Cancel the Today Promoter task and await its completion."""
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
```

상단에 `import logging`이 없다면 추가.

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/live/test_today_promoter.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_today_promoter.py
git commit -m "feat(live.lifecycle): add start_today_promoter task (ADR-0043)"
```

---

## Task 7: app.py lifespan wire + env 변수

**Files:**
- Modify: `hoga/api/app.py` (lifespan)
- Test: 기존 통합 테스트가 lifespan 띄움 — 회귀로 충분

- [ ] **Step 1: 실패 테스트 (optional 회귀)**

이 단계는 통합 테스트가 lifespan을 띄우는지 확인하는 회귀 성격. 기존 `tests/unit/live/test_api.py` 또는 `tests/integration/`이 lifespan을 통과해야 함. 명시적 추가 테스트는 없음 — 다음 단계에서 직접 확인.

- [ ] **Step 2: 현재 상태 확인 (skip)**

(env 변수가 없으니 기본 동작 그대로)

- [ ] **Step 2.5: LiveStatus 모델 확장 (design-review B2)**

`hoga/live/lifecycle.py`의 `LiveStatus` model에 필드 추가:

```python
class LiveStatus(BaseModel):
    # ... 기존 필드들
    today_promote_last_ms: dict[str, int] = Field(
        default_factory=dict,
        description="code → last successful promote_today epoch_ms (ADR-0043)",
    )
```

`get_status()` 함수에서 `_today_promote_last_ms` 포함하도록:

```python
def get_status() -> LiveStatus:
    return LiveStatus(
        # ... 기존 필드들
        today_promote_last_ms=get_today_promote_last_ms(),
    )
```

`reset_for_tests()`에 `_today_promote_last_ms.clear()` 추가.

- [ ] **Step 3: 구현 — `hoga/api/app.py` 변경**

`lifespan` 함수 내부에서 `start_live_poller` 호출 직후 다음 추가:

```python
# ADR-0043: Today Promotion task — promote today's jsonl to parquet every
# N minutes so /api/range covers today without waiting for 18:00 batch.
# Optional kill-switch via HOGA_LIVE_TODAY_PROMOTE_ENABLED=false.
from hoga.live.lifecycle import start_today_promoter, stop_today_promoter, get_active_codes

today_promoter_task = None
if os.environ.get("HOGA_LIVE_TODAY_PROMOTE_ENABLED", "true").lower() != "false":
    interval_s = float(os.environ.get("HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S", "300"))
    today_promoter_task = await start_today_promoter(
        data_dir=data_dir,
        get_active_codes=get_active_codes,
        interval_s=interval_s,
    )
```

그리고 `finally` 블록의 `stop_live_poller()` 호출 **이후** (poller 정지 후 task 정지) 다음 추가:

```python
            # ADR-0043: stop Today Promotion task before scheduler / pool.
            await stop_today_promoter(today_promoter_task)
```

import 라인은 lifespan 내부 또는 파일 상단 둘 다 OK (기존 패턴 따름).

- [ ] **Step 4: 통과 확인 — lifespan 회귀**

Run: 
```bash
uv run pytest tests/ -k "lifespan or app or live" -v
```
Expected: lifespan 관련 테스트 통과 (KIS 환경변수 없으면 today_promoter도 시작 안 됨 — get_active_codes() == [] 이지만 task 자체는 도는 게 정상; promote 호출 자체는 noop).

수동 확인 (optional): 
```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000
# 로그에 "today-promoter" task 시작 확인
# Ctrl+C 후 graceful shutdown 확인
```

- [ ] **Step 5: Commit**

```bash
git add hoga/api/app.py
git commit -m "feat(api): wire today promoter task into lifespan (ADR-0043)"
```

---

## Task 8: bundle.py 슬라이스 빌더에 source 인자 추가 (5/27 fix)

**Files:**
- Modify: `hoga/api/bundle.py` (4개 슬라이스 빌더 + 메인 루프 + build_volume_profile_range)
- Test: `tests/unit/api/test_bundle_source_aware.py` (신규)

- [ ] **Step 1: 실패 테스트 4개**

`tests/unit/api/test_bundle_source_aware.py`:

```python
"""ADR-0037 source-aware data slice 회귀 테스트 (5/27 버그)."""
import json
from pathlib import Path

import polars as pl
import pytest

from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine


def _write_meta(path: Path, **kwargs) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    default = {
        "source": "kis_live",
        "code": "003490",
        "date": "20260527",
        "promoted_at": "2026-05-28T09:00:00+00:00",
        "row_counts": {"snapshots": 1, "trades": 0, "brokers": 0},
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }
    default.update(kwargs)
    path.write_text(json.dumps(default, indent=2))


def _write_snapshots(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # snapshots.parquet 최소 스키마
    pl.DataFrame(rows).write_parquet(path)


def _snap(t_hhmmssms: int, total_bid: int, total_ask: int) -> dict:
    base = {f"bid_p{i}": 0 for i in range(1, 11)}
    base.update({f"bid_q{i}": 0 for i in range(1, 11)})
    base.update({f"ask_p{i}": 0 for i in range(1, 11)})
    base.update({f"ask_q{i}": 0 for i in range(1, 11)})
    base.update({
        "t_ms": t_hhmmssms,
        "phase": "regular",
        "total_bid_qty": total_bid,
        "total_ask_qty": total_ask,
    })
    return base


def test_dual_source_5_27_scenario(tmp_path: Path) -> None:
    """5/27 시나리오: 손상된 top-level hogaplay + 정상 kis_live/.

    Expected: source preference가 hogaplay여도 hogaplay/ 가 없으므로 kis_live
    fallback. 그리고 슬라이스가 kis_live/snapshots.parquet 만 읽음 (top-level
    snapshots.parquet은 안 읽힘 — 손상된 hogaplay 잔재).
    """
    code = "003490"
    date = "20260527"
    sd_dir = tmp_path / "parquet" / date / code

    # 손상된 top-level meta + parquet (실제 5/27 환경 재현)
    sd_dir.mkdir(parents=True)
    (sd_dir / "meta.json").write_text(json.dumps({
        "source": "hogaplay",
        "code": code, "date": date,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 0,  # 손상값 (invariant 위반)
    }))
    _write_snapshots(sd_dir / "snapshots.parquet", [
        _snap(90000000, 99999, 99999)  # 손상 데이터 — kis_live와 다른 값
    ])

    # 정상 kis_live/ 서브디렉터리
    _write_meta(sd_dir / "kis_live" / "meta.json")
    _write_snapshots(sd_dir / "kis_live" / "snapshots.parquet", [
        _snap(100000000, 12345, 67890),  # 진짜 데이터
    ])

    engine = QueryEngine(tmp_path)
    bundle = build_range_bundle(
        engine, code=code, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="hogaplay",
    )

    assert len(bundle.segments) == 1
    assert bundle.segments[0].source == "kis_live"  # fallback 발동
    points = bundle.quote_ratio.points
    assert len(points) >= 1
    # kis_live 데이터가 노출됨 (top-level 손상 데이터 99999 아니라 12345)
    assert any(p.bid_total == 12345 for p in points)
    assert not any(p.bid_total == 99999 for p in points)


def test_legacy_flat_layout_still_works(tmp_path: Path) -> None:
    """진짜 legacy flat-only layout (source 서브디렉터리 없음).

    resolve_source_dir의 legacy fallback이 정상 동작해야 함.
    """
    code = "003490"
    date = "20260501"
    sd_dir = tmp_path / "parquet" / date / code

    sd_dir.mkdir(parents=True)
    _write_meta(sd_dir / "meta.json", date=date, source="hogaplay")
    _write_snapshots(sd_dir / "snapshots.parquet", [_snap(100000000, 11111, 22222)])

    engine = QueryEngine(tmp_path)
    bundle = build_range_bundle(
        engine, code=code, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="hogaplay",
    )

    assert len(bundle.segments) == 1
    assert any(p.bid_total == 11111 for p in bundle.quote_ratio.points)


def test_source_pref_strict_when_pref_present_but_sparse(tmp_path: Path) -> None:
    """선호 source가 있으면 sparse여도 fallback 안 함."""
    code = "003490"
    date = "20260527"
    sd_dir = tmp_path / "parquet" / date / code

    # 정상 hogaplay/ (풍부)
    _write_meta(sd_dir / "hogaplay" / "meta.json", source="hogaplay")
    _write_snapshots(sd_dir / "hogaplay" / "snapshots.parquet", [
        _snap(100000000, 10000, 20000),
        _snap(100100000, 11000, 21000),
        _snap(100200000, 12000, 22000),
    ])

    # 정상 kis_live/ (sparse — 1건만)
    _write_meta(sd_dir / "kis_live" / "meta.json")
    _write_snapshots(sd_dir / "kis_live" / "snapshots.parquet", [
        _snap(165000000, 55555, 66666),
    ])

    engine = QueryEngine(tmp_path)
    bundle = build_range_bundle(
        engine, code=code, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="kis_live",
    )

    # kis_live가 있으니 그것만 — sparse(1건)여도
    assert bundle.segments[0].source == "kis_live"
    bid_totals = [p.bid_total for p in bundle.quote_ratio.points]
    assert 55555 in bid_totals
    assert 10000 not in bid_totals  # hogaplay 데이터는 안 섞임


def test_source_pref_fallback_when_pref_missing(tmp_path: Path) -> None:
    """선호 source가 없으면 다른 source로 fallback."""
    code = "003490"
    date = "20260527"
    sd_dir = tmp_path / "parquet" / date / code

    # kis_live/ 만 존재 (hogaplay/ 없음)
    _write_meta(sd_dir / "kis_live" / "meta.json")
    _write_snapshots(sd_dir / "kis_live" / "snapshots.parquet", [
        _snap(100000000, 33333, 44444),
    ])

    engine = QueryEngine(tmp_path)
    bundle = build_range_bundle(
        engine, code=code, from_date=date, to_date=date,
        bucket_ms=60_000, source_pref="hogaplay",  # 없으니 kis_live fallback
    )

    assert bundle.segments[0].source == "kis_live"
    assert any(p.bid_total == 33333 for p in bundle.quote_ratio.points)
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/api/test_bundle_source_aware.py -v`
Expected: `test_dual_source_5_27_scenario` FAIL — 손상된 top-level 데이터가 노출됨 (이게 우리가 고칠 버그).

- [ ] **Step 3: 구현 — 4개 슬라이스 빌더에 source 인자 추가**

`hoga/api/bundle.py`의 4개 함수 시그니처 + 호출부 변경:

```python
# build_candles_slice (line 96 근처)
def build_candles_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    source: str = "hogaplay",   # ← 추가
) -> list[ApiCandle]:
    path = engine.parquet_dir(date, code, source) / "candles.parquet"  # ← source 전달
    rows = candles_tbl.query_all(engine.conn, path=path)
    return [
        r.model_copy(update={"ts_ms": ms_from_midnight_to_unix_ms(date, r.ts_ms)})
        for r in rows
    ]


# build_quote_ratio_slice (line 107 근처)
def build_quote_ratio_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int = 1000,
    source: str = "hogaplay",   # ← 추가
) -> QuoteRatio:
    path = str(engine.parquet_dir(date, code, source) / "snapshots.parquet")
    # ... 나머지 동일


# build_volume_profile_slice (line 153 근처)
def build_volume_profile_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    price_min: int | None = None,
    price_max: int | None = None,
    source: str = "hogaplay",   # ← 추가
) -> VolumeProfile:
    code_dir = engine.parquet_dir(date, code, source)  # ← source 전달
    # ... 나머지 동일


# build_fill_strength_slice (line 268 근처)
def build_fill_strength_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int = 1000,
    source: str = "hogaplay",   # ← 추가
) -> FillStrength:
    path = str(engine.parquet_dir(date, code, source) / "trades.parquet")
    # ... 나머지 동일
```

`build_volume_profile_range` 시그니처 변경:

```python
def build_volume_profile_range(
    engine: QueryEngine,
    *,
    code: str,
    dates_with_sources: list[tuple[str, str]],  # ← 변경 (date, source) 페어
    price_min: int | None = None,
    price_max: int | None = None,
) -> VolumeProfile:
    if not dates_with_sources:
        return VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])
    paths = [
        str(engine.parquet_dir(d, code, src) / "trades.parquet")
        for d, src in dates_with_sources
    ]
    # ... 기존 본문 동일 (paths만 source-aware)
```

`build_range_bundle` 메인 루프 변경 (line 412 근처):

```python
for d in dates:
    source = _resolve_source(engine, d, code, source_pref)
    try:
        meta = engine.get_meta(d, code, source)
    except (FileNotFoundError, StockDateNotFound):
        continue
    c = classify_from_meta(meta)
    if c.state == DiskState.INVALID:
        excluded.append(ExcludedDate(
            date=d, violations=[v.to_model() for v in c.errors],
        ))
        continue
    if c.warnings:
        warnings_list.append(DateWarning(
            date=d, warnings=[v.to_model() for v in c.warnings],
        ))

    raw_candles = build_candles_slice(engine, code=code, date=d, source=source)
    candles_d = downsample_candles(raw_candles, bucket_ms=bucket_ms)
    qr_d = build_quote_ratio_slice(engine, code=code, date=d, bucket_ms=bucket_ms, source=source)
    fs_d = build_fill_strength_slice(engine, code=code, date=d, bucket_ms=bucket_ms, source=source)
    vp_d = build_volume_profile_slice(engine, code=code, date=d, source=source)

    segments.append(RangeSegment(
        date=d,
        session_open_ms=hhmmssms_to_unix_ms(d, meta["regular_session_open_ms"]),
        session_close_ms=hhmmssms_to_unix_ms(d, meta["regular_session_close_ms"]),
        source=source,
    ))
    candles.extend(candles_d)
    ratio_pts.extend(qr_d.points)
    fill_pts.extend(fs_d.points)
    profiles_by_day.append(vp_d)
```

`build_range_bundle`의 `build_volume_profile_range` 호출부 (line 458 근처):

```python
dates_with_sources = [(s.date, s.source) for s in segments]
profile_range = build_volume_profile_range(
    engine, code=code, dates_with_sources=dates_with_sources,
)
```

- [ ] **Step 4: 통과 확인**

Run: 
```bash
uv run pytest tests/unit/api/test_bundle_source_aware.py -v
uv run pytest tests/unit/api/ -v  # 회귀
```
Expected: 4 신규 passed + 기존 bundle 테스트 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py tests/unit/api/test_bundle_source_aware.py
git commit -m "fix(api.bundle): pass resolved source to data slice builders (5/27 bug)"
```

---

## Task 9: 프런트엔드 `buildLiveBundle` dedup 변경

**Files:**
- Modify: `frontend/src/live/buildLiveBundle.ts:53-77` (머지 로직)
- Test: `frontend/src/live/buildLiveBundle.test.ts` (기존 확장)

- [ ] **Step 1: 실패 테스트 3개 추가**

`frontend/src/live/buildLiveBundle.test.ts`에 추가:

```typescript
import { describe, it, expect } from 'vitest';
import { buildLiveBundle } from './buildLiveBundle';
import type { RangeBundle } from '../api/types';

const MINUTE_MS = 60_000;

function makeRangeBundle(qrPoints: { t: number; bid_total: number; ask_total: number }[]): RangeBundle {
  return {
    code: '003490',
    from_date: '20260527',
    to_date: '20260528',
    bucket_ms: MINUTE_MS,
    segments: [{
      date: '20260527',
      session_open_ms: 1779840000000,
      session_close_ms: 1779863400000,
      source: 'kis_live',
    }],
    candles: [],
    quote_ratio: { bucket_ms: MINUTE_MS, points: qrPoints },
    fill_strength: { bucket_ms: MINUTE_MS, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
  };
}

describe('buildLiveBundle dedup', () => {
  const todayDate = '20260528';
  const todaySession = { open_ms: 1779926400000, close_ms: 1779949800000 };

  it('dedupes SSE buckets that share timestamp with parquet tail', () => {
    const pastTailT = 1779926400000;  // 5/28 09:00 KST
    const past = makeRangeBundle([
      { t: pastTailT, bid_total: 1000, ask_total: 2000 },
    ]);

    const sseOb = [
      // 같은 t값 — parquet이 이김
      { t_ms: pastTailT + 1000, total_bid_qty: 9999, total_ask_qty: 9999 },
      // 새 timestamp — SSE가 들어감
      { t_ms: pastTailT + 60_000 + 1000, total_bid_qty: 1100, total_ask_qty: 2100 },
    ];

    const bundle = buildLiveBundle({
      code: '003490',
      todayDate,
      todaySession,
      pastBundle: past,
      sseOb,
      sseTrade: [],
      kisCandles: [],
      bucketMs: MINUTE_MS,
    });

    const ts = bundle.quote_ratio.points.map((p) => p.t);
    expect(ts).toContain(pastTailT);
    expect(ts).toContain(pastTailT + 60_000);
    expect(ts).toHaveLength(2);
    // pastTailT 위치는 parquet 값 유지
    expect(bundle.quote_ratio.points.find((p) => p.t === pastTailT)?.bid_total).toBe(1000);
  });

  it('uses all SSE buckets when past bundle is empty', () => {
    const sseOb = [
      { t_ms: 1779926401000, total_bid_qty: 100, total_ask_qty: 200 },
      { t_ms: 1779926461000, total_bid_qty: 110, total_ask_qty: 210 },
    ];

    const bundle = buildLiveBundle({
      code: '003490',
      todayDate,
      todaySession,
      pastBundle: null,
      sseOb,
      sseTrade: [],
      kisCandles: [],
      bucketMs: MINUTE_MS,
    });

    expect(bundle.quote_ratio.points.length).toBe(2);
  });

  it('appends only timestamps strictly greater than past tail', () => {
    const pastTailT = 1779926400000;
    const past = makeRangeBundle([
      { t: pastTailT, bid_total: 1000, ask_total: 2000 },
    ]);

    const sseOb = [
      // pastTailT - 60s: 더 옛것 (버려져야 함)
      { t_ms: pastTailT - 60_000 + 1000, total_bid_qty: 50, total_ask_qty: 50 },
      // pastTailT: 동일 (parquet이 이김)
      { t_ms: pastTailT + 1000, total_bid_qty: 999, total_ask_qty: 999 },
      // pastTailT + 60s: 새것 (들어감)
      { t_ms: pastTailT + 60_000 + 1000, total_bid_qty: 1100, total_ask_qty: 2100 },
    ];

    const bundle = buildLiveBundle({
      code: '003490',
      todayDate,
      todaySession,
      pastBundle: past,
      sseOb,
      sseTrade: [],
      kisCandles: [],
      bucketMs: MINUTE_MS,
    });

    const ts = bundle.quote_ratio.points.map((p) => p.t).sort((a, b) => a - b);
    expect(ts).toEqual([pastTailT, pastTailT + 60_000]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npm test -- buildLiveBundle.test.ts`
Expected: 3 failing tests — 현재 binary 분기는 SSE 전부 버리거나 전부 사용

- [ ] **Step 3: 구현 — `frontend/src/live/buildLiveBundle.ts` 변경**

기존 line 53-77 부분을 다음으로 교체:

```typescript
  const pastQRPoints = pastBundle?.quote_ratio.points ?? [];
  const pastFSPoints = pastBundle?.fill_strength.points ?? [];

  // parquet이 cover한 마지막 timestamp — SSE는 이보다 strict greater인 t만 추가
  // (boundary timestamp는 parquet이 이김; dedup 방지)
  const pastMaxQrT = pastQRPoints.length > 0
    ? pastQRPoints[pastQRPoints.length - 1].t
    : 0;
  const pastMaxFsT = pastFSPoints.length > 0
    ? pastFSPoints[pastFSPoints.length - 1].t
    : 0;

  const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs);
  const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > pastMaxQrT);
  const incrementalFS = sseBuckets.fillStrengthPoints.filter((p) => p.t > pastMaxFsT);

  // Today segment marker — 오늘에 어떤 신호든 있고 pastBundle에 today가 없으면 추가
  const todaySegments: RangeSegment[] = [];
  const pastHasTodaySegment = pastSegments.some((s) => s.date === todayDate);
  if (!pastHasTodaySegment) {
    const hasTodaySignal =
      pastQRPoints.some((p) => realMsToYyyymmdd(p.t) === todayDate) ||
      incrementalQR.length > 0 ||
      sseOb.length > 0 ||
      kisCandles.some((c) => c.ts_ms >= todaySession.open_ms);
    if (hasTodaySignal) {
      todaySegments.push({
        date: todayDate,
        session_open_ms: todaySession.open_ms,
        session_close_ms: todaySession.close_ms,
        source: 'kis_live',
      });
    }
  }
```

그리고 return 값의 quote_ratio / fill_strength 부분도 다음으로 변경:

```typescript
    quote_ratio: {
      bucket_ms: bucketMs,
      points: [...pastQRPoints, ...incrementalQR],
    },
    fill_strength: {
      bucket_ms: bucketMs,
      points: [...pastFSPoints, ...incrementalFS],
    },
```

(`kisOnlySegments` 합성 로직은 기존 그대로 유지)

- [ ] **Step 4: 통과 확인**

Run: 
```bash
cd frontend && npm test -- buildLiveBundle.test.ts
cd frontend && npm test  # 전체 회귀
```
Expected: 신규 3개 + 기존 buildLiveBundle 테스트 PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/buildLiveBundle.ts frontend/src/live/buildLiveBundle.test.ts
git commit -m "fix(live): timestamp-based dedup in buildLiveBundle (replace pastHasToday binary branch)"
```

---

## Task 10: 통합 검증 (수동)

이 task는 코드 변경 없이 수동 검증으로 fix가 실제로 사용자 시나리오를 충족하는지 확인.

- [ ] **Step 1: 백엔드 서버 재시작**

```bash
# 기존 서버 종료 후
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

로그에 `today-promoter` task 시작 확인. KIS 환경변수 없으면 task는 돌지만 promote 호출은 noop.

- [ ] **Step 2: 5/27 시나리오 검증 (백엔드 fix)**

```bash
curl -s "http://127.0.0.1:8000/api/range?code=003490&from=20260527&to=20260527&bucket_ms=60000&source_pref=hogaplay" | python3 -c "
import json, sys
b = json.load(sys.stdin)
for s in b.get('segments', []):
    print(f\"segment date={s['date']} source={s['source']}\")
print(f\"quote_ratio points: {len(b.get('quote_ratio', {}).get('points', []))}\")"
```

Expected: 
- segment의 source가 `kis_live` (fallback)
- quote_ratio points 수가 손상된 top-level 21개가 아니라 kis_live의 2건 또는 그 이하 — 손상 데이터 노출 안 됨

- [ ] **Step 3: 프런트엔드 dev 서버 + 차트 확인**

```bash
cd frontend && npm run dev
```

브라우저에서 http://localhost:5173/replay:
- 5/27 선택, Settings에서 source=hogaplay → 차트 호가 패널 — sparse 데이터(2건)만 표시
- Settings에서 source=kis_live → 동일 (kis_live가 실 source)

http://localhost:5173/live:
- 003490 watchlist 선택
- 호가 지표 패널 — 오늘 데이터가 5분 이내 보이는지 확인 (KIS env 설정된 경우)
- 차트 zoom out 시 어제(5/27) 호가 지표 정상 표시

- [ ] **Step 4: 회귀 종합**

```bash
uv run pytest  # 전체 백엔드
cd frontend && npm test   # 전체 프런트
cd frontend && npm run build  # 빌드
```

Expected: 모두 통과.

- [ ] **Step 5: Commit (변경 없으면 skip)**

수동 검증만 한 경우 commit 안 함. 검증 중 사소한 버그 발견 시 fix-forward 후 별도 commit.

---

## 완료 체크리스트

- [ ] Task 1: `atomic_write_parquet` 헬퍼 + 5 단위 테스트
- [ ] Task 2: `_parse_jsonl_to_records` 헬퍼 추출 + 2 단위 테스트
- [ ] Task 3: `promote_today` 함수 + 6 단위 테스트
- [ ] Task 4: `promote_pending` today-skip 가드 + 1 단위 테스트
- [ ] Task 5: `get_active_codes` accessor + 2 단위 테스트
- [ ] Task 6: `start_today_promoter` task + 4 단위 테스트
- [ ] Task 7: app.py lifespan wire + 환경 변수 처리
- [ ] Task 8: bundle.py slice builders source 인자 + 4 단위 테스트 (5/27 fix)
- [ ] Task 9: 프런트 `buildLiveBundle` dedup + 3 단위 테스트
- [ ] Task 10: 통합 수동 검증

**총 신규 테스트**: ~30개 (백엔드 25 + 프런트 3 + 통합 검증 2)

---

## Deferred review notes

이 plan에 반영하지 않은 review suggestion / nit들 — landing 후 follow-up issue로 처리.

### Eng review

- **Suggestion #3** — 슬라이스 빌더의 `FileNotFoundError` 처리 회귀: Task 8에 4개 builder 각각 "missing parquet returns empty slice, no exception" 단위 테스트 추가 권장. 현재 plan은 source-aware 시나리오만 다룸. 첫 빈 cycle (오늘 polling 직후 atomic_write_parquet이 빈 리스트로 unlink) 케이스에서 `/api/range`가 500 안 내는지 확인 필요.
- **Suggestion #5** — Task 2 step 3 (`promote_one` 100 LOC 리팩터)와 Task 8 step 3 (4개 signature 동시 변경)는 5분 단위를 넘어선다. bisect 용이성을 위해 task 분할 고려. 현재 plan은 한 commit에 모음 — fix-forward 시 git revert 단위가 큼.
- **Suggestion #7** — `atomic_write_parquet`의 `os.replace` 실패 시 tempfile leak. 크로스 파일시스템 케이스에서 발생 가능. 현재 구현은 try/except로 cleanup하지만 `os.replace`만 별도 wrap 안 함. 운영 중 디스크 bloat 신호 보일 때 fix.
- **Nit #8** — Task 7의 step 1/2가 "skip / optional"이라 TDD 5-step 패턴 깨짐. lifespan smoke test (`app.state.today_promoter_task` 존재 + cancel 확인) 추가하면 정합성 회복.
- **Nit #9** — Task 9의 dedup이 `points[-1].t`(last)를 사용. backend가 정렬한다는 invariant 가정. unsorted past input 회귀 테스트 추가하면 명시적.
- **Nit #10** — Task 6의 timing-based 테스트 (`asyncio.sleep(0.18)`)는 slow CI에서 flaky 가능. event-driven assertion으로 교체 권장.

### Design review

- **Suggestion S1** — 빈 vs 에러 vs sparse 호가 패널 상태 시각 구분: `<panel-empty-state>` "오늘 호가 없음 · 09:00 시작", `<panel-error-state>` retry 버튼. 현재 plan은 frontend UI 변경 없음 정책이라 미반영. 사용자가 헷갈리는 incident 보일 때 별도 spec.
- **Suggestion S2** — 차트 첫 mount 시 `fitContent`가 오늘 끝으로 잡혀 5/27 호가가 off-screen일 수 있음 (이전 진단 회귀 위험). 현재는 promote_today + source-aware fix로 오늘에도 호가 있어서 자연 해결되지만, 일부 종목/날짜에선 여전히 일어날 수 있음. visible-range 명시 설정은 별도 fix.
- **Nit N1** — boundary minute에서 SSE가 lag되면 indicator 1 bar plateau — cosmetic, 알려진 동작으로 문서화만.
- **Nit N2** — Task 9에서 today segment의 `source='kis_live'` 하드코딩. 미래 multi-source-today를 위해 주석 강화 권장.
