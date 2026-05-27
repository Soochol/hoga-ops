"""Stage 3 / Task 3.1 — JSONL writer tests (ADR-0038)."""
import asyncio
import json
from pathlib import Path

import pytest

from hoga.live.snapshot import LiveSnapshot, SnapshotKind
from hoga.live.writer import LiveWriter


@pytest.mark.asyncio
async def test_append_writes_one_line_per_snapshot(tmp_path: Path) -> None:
    writer = LiveWriter(tmp_path / "live")
    snap_ob = LiveSnapshot(t_ms=1, kind=SnapshotKind.OB, payload={"bids": [], "asks": []})
    snap_tr = LiveSnapshot(
        t_ms=2, kind=SnapshotKind.TRADE,
        payload={"price": 75000, "qty": 1, "side": 1},
    )
    await writer.append("20260527", "005930", [snap_ob, snap_tr])
    await writer.fsync_all()

    out = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    assert len(out) == 2
    assert json.loads(out[0]) == {"t_ms": 1, "kind": "ob", "payload": {"bids": [], "asks": []}}
    assert json.loads(out[1])["kind"] == "trade"


@pytest.mark.asyncio
async def test_concurrent_append_same_code_is_serialized(tmp_path: Path) -> None:
    writer = LiveWriter(tmp_path / "live")
    snaps = [LiveSnapshot(t_ms=i, kind=SnapshotKind.OB, payload={"i": i}) for i in range(100)]
    await asyncio.gather(*(writer.append("20260527", "005930", [s]) for s in snaps))
    await writer.fsync_all()
    lines = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    assert len(lines) == 100


@pytest.mark.asyncio
async def test_append_creates_date_directory(tmp_path: Path) -> None:
    """Writer must create parent dirs on demand."""
    writer = LiveWriter(tmp_path / "live")
    await writer.append("20260528", "000660", [LiveSnapshot(t_ms=1, kind=SnapshotKind.BROKER, payload={})])
    await writer.fsync_all()
    assert (tmp_path / "live" / "20260528" / "000660.jsonl").exists()


@pytest.mark.asyncio
async def test_append_empty_iterable_is_noop(tmp_path: Path) -> None:
    """Empty snapshot list should not create the file."""
    writer = LiveWriter(tmp_path / "live")
    await writer.append("20260527", "005930", [])
    await writer.fsync_all()
    # Should NOT create the file
    assert not (tmp_path / "live" / "20260527" / "005930.jsonl").exists()


@pytest.mark.asyncio
async def test_korean_text_in_payload_is_utf8_not_escaped(tmp_path: Path) -> None:
    """ensure_ascii=False — Korean broker names like '미래에셋증권' stay readable."""
    writer = LiveWriter(tmp_path / "live")
    snap = LiveSnapshot(t_ms=1, kind=SnapshotKind.BROKER, payload={"name": "미래에셋증권"})
    await writer.append("20260527", "005930", [snap])
    await writer.fsync_all()
    raw = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text()
    assert "미래에셋증권" in raw
    assert "\\u" not in raw  # not escaped
