"""Tests for promote_today (ADR-0043 — Today Promotion)."""
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
