"""ADR-0115 — backfill_live_meta: retro-fit completeness fields onto already
promoted kis_live/kis_api meta.json files."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from hoga.api.disk_state import (
    DiskState,
    _hhmmssms_to_intra_ms,
    _intra_ms_to_hhmmssms,
    check_disk_state,
)
from hoga.api.timeenc import HogaMs
from hoga.live.meta_backfill import backfill_live_meta
from hoga.tables.snapshots import Orderbook, write_parquet as write_snapshots

_KST = timezone(timedelta(hours=9))
_NOW = datetime(2026, 7, 16, 12, 0, tzinfo=_KST)


def _write_dense_snapshots(path: Path) -> None:
    t = _hhmmssms_to_intra_ms(HogaMs(90000000))
    end = _hhmmssms_to_intra_ms(HogaMs(153000000)) - 10 * 60 * 1000
    snaps = []
    seq = 0
    while t < end:
        seq += 1
        snaps.append(Orderbook(
            ts_ms=int(_intra_ms_to_hhmmssms(t)), seq=seq,
            ask_p=(0,) * 10, ask_q=(0,) * 10, ask_d=(0,) * 10,
            bid_p=(0,) * 10, bid_q=(0,) * 10, bid_d=(0,) * 10,
            tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
        ))
        t += 30_000
    path.parent.mkdir(parents=True, exist_ok=True)
    write_snapshots(snaps, path)


def _stale_meta(src_dir: Path) -> None:
    src_dir.mkdir(parents=True, exist_ok=True)
    (src_dir / "meta.json").write_text(json.dumps({
        "source": src_dir.name, "code": "005930", "date": "20260715",
        "row_counts": {"snapshots": 760},
    }))


def test_backfill_finalizes_past_kis_live(tmp_path: Path) -> None:
    src = tmp_path / "parquet" / "20260715" / "005930" / "kis_live"
    _stale_meta(src)
    _write_dense_snapshots(src / "snapshots.parquet")

    # Before: no completeness fields → CLIENT_INCOMPLETE.
    assert check_disk_state(tmp_path, "005930", "20260715").state == DiskState.CLIENT_INCOMPLETE

    res = backfill_live_meta(tmp_path, now=_NOW)
    assert (res.scanned, res.updated, res.skipped) == (1, 1, 0)

    meta = json.loads((src / "meta.json").read_text())
    assert meta["collection_complete"] is True
    assert meta["is_partial"] is False
    # Dense stream → COMPLETE aggregate; hogaplay-gated → still NONE.
    assert check_disk_state(tmp_path, "005930", "20260715").state == DiskState.COMPLETE
    assert check_disk_state(
        tmp_path, "005930", "20260715", source="hogaplay",
    ).state == DiskState.NONE


def test_backfill_is_idempotent(tmp_path: Path) -> None:
    src = tmp_path / "parquet" / "20260715" / "005930" / "kis_live"
    _stale_meta(src)
    _write_dense_snapshots(src / "snapshots.parquet")
    backfill_live_meta(tmp_path, now=_NOW)
    res2 = backfill_live_meta(tmp_path, now=_NOW)
    assert (res2.scanned, res2.updated, res2.skipped) == (1, 0, 1)


def test_backfill_skips_today(tmp_path: Path) -> None:
    """Today's Stock-Date is owned by the Today Promoter — never touched."""
    src = tmp_path / "parquet" / "20260716" / "005930" / "kis_live"
    _stale_meta(src)
    _write_dense_snapshots(src / "snapshots.parquet")
    res = backfill_live_meta(tmp_path, now=_NOW)
    assert (res.scanned, res.updated, res.skipped) == (0, 0, 0)
    meta = json.loads((src / "meta.json").read_text())
    assert "collection_complete" not in meta


def test_backfill_dry_run_writes_nothing(tmp_path: Path) -> None:
    src = tmp_path / "parquet" / "20260715" / "005930" / "kis_live"
    _stale_meta(src)
    _write_dense_snapshots(src / "snapshots.parquet")
    res = backfill_live_meta(tmp_path, dry_run=True, now=_NOW)
    assert res.updated == 1
    meta = json.loads((src / "meta.json").read_text())
    assert "collection_complete" not in meta


def test_backfill_missing_snapshots_marks_partial(tmp_path: Path) -> None:
    """No snapshots.parquet → whole-window gap → is_partial=True (but complete)."""
    src = tmp_path / "parquet" / "20260715" / "005930" / "kis_api"
    _stale_meta(src)  # no snapshots.parquet written
    res = backfill_live_meta(tmp_path, now=_NOW)
    assert res.updated == 1
    meta = json.loads((src / "meta.json").read_text())
    assert meta["collection_complete"] is True
    assert meta["is_partial"] is True
