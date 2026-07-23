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
from hoga.live.meta_backfill import backfill_hogaplay_meta, backfill_live_meta
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


# --- ADR-0126: hogaplay is_partial/gap_ranges rewrite -----------------------


def _write_late_snapshots(path: Path) -> None:
    """Dense stream that starts at 14:43 (AM lost to the ~18h upstream window)."""
    t = _hhmmssms_to_intra_ms(HogaMs(144318939))
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


def _stale_hogaplay_meta(src_dir: Path, **over: object) -> None:
    """hogaplay meta written with anchor_edges=False — a leading gap recorded
    as is_partial=false. open_ms=0 mirrors the real un-normalized value."""
    src_dir.mkdir(parents=True, exist_ok=True)
    (src_dir / "meta.json").write_text(json.dumps({
        "code": "005930", "date": "20260715", "name": "",
        "regular_session_open_ms": 0,
        "regular_session_close_ms": 153000000,
        "collection_complete": True,
        "is_partial": False,
        "gap_ranges": [],
        "total_unique_events": 5966,  # a field that must survive the rewrite
        **over,
    }))


def test_backfill_hogaplay_rewrites_leading_gap(tmp_path: Path) -> None:
    src = tmp_path / "parquet" / "20260715" / "005930" / "hogaplay"
    _stale_hogaplay_meta(src)
    _write_late_snapshots(src / "snapshots.parquet")

    # Before: stale is_partial=false → COMPLETE (the mis-ranking bug).
    before = check_disk_state(tmp_path, "005930", "20260715", source="hogaplay")
    assert before.state == DiskState.COMPLETE

    res = backfill_hogaplay_meta(tmp_path, now=_NOW)
    assert (res.scanned, res.updated, res.skipped) == (1, 1, 0)

    meta = json.loads((src / "meta.json").read_text())
    assert meta["is_partial"] is True
    assert meta["gap_ranges"]  # leading gap now recorded
    assert meta["collection_complete"] is True   # preserved
    assert meta["total_unique_events"] == 5966   # preserved
    # After: SOURCE_PARTIAL with a confirmed upstream-boundary (leading) gap.
    cls = check_disk_state(tmp_path, "005930", "20260715", source="hogaplay")
    assert cls.state == DiskState.SOURCE_PARTIAL
    assert cls.upstream_gap_confirmed is True


def test_backfill_hogaplay_idempotent(tmp_path: Path) -> None:
    src = tmp_path / "parquet" / "20260715" / "005930" / "hogaplay"
    _stale_hogaplay_meta(src)
    _write_late_snapshots(src / "snapshots.parquet")
    backfill_hogaplay_meta(tmp_path, now=_NOW)
    res2 = backfill_hogaplay_meta(tmp_path, now=_NOW)
    assert (res2.scanned, res2.updated, res2.skipped) == (1, 0, 1)


def test_backfill_hogaplay_dense_stream_no_diff_skips(tmp_path: Path) -> None:
    """A hogaplay meta already honest (dense full-session, is_partial=true-free)
    isn't rewritten — no diff."""
    src = tmp_path / "parquet" / "20260715" / "005930" / "hogaplay"
    _write_dense_snapshots(src / "snapshots.parquet")
    # A dense stream recomputes to is_partial=False, gap_ranges=[] — matches.
    _stale_hogaplay_meta(src, is_partial=False, gap_ranges=[])
    res = backfill_hogaplay_meta(tmp_path, now=_NOW)
    assert (res.scanned, res.updated, res.skipped) == (1, 0, 1)


def test_backfill_hogaplay_skips_today(tmp_path: Path) -> None:
    src = tmp_path / "parquet" / "20260716" / "005930" / "hogaplay"
    _stale_hogaplay_meta(src)
    _write_late_snapshots(src / "snapshots.parquet")
    res = backfill_hogaplay_meta(tmp_path, now=_NOW)
    assert (res.scanned, res.updated, res.skipped) == (0, 0, 0)
