"""마지막 호가 영속화 — **재시작이 화면을 비우지 않게** 하는 경로.

이 값은 프로세스 메모리에만 있어서 재시작에 전 종목이 함께 죽었다(2026-08-27 실측:
장 마감 후 기동한 백엔드에서 005930 포함 전 종목 0 건). 그래서 여기서 재는 것은
"왕복이 되는가" 와 "**바뀐 게 없으면 안 쓰는가**" 둘이다 — 후자가 없으면 장이 끝난
뒤에도 밤새 같은 값을 주기마다 다시 쓴다.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from hoga.live import last_ob_store, lifecycle
from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def _ob(t_ms: int, venue: str | None = None) -> LiveSnapshot:
    payload: dict = {"asks": [{"price": 100, "qty": 1}], "bids": []}
    if venue is not None:
        payload["venue"] = venue
    return LiveSnapshot(t_ms=t_ms, kind=SnapshotKind.OB, payload=payload)


# ── 저장 모듈 ────────────────────────────────────────────────────────────────

def test_store_roundtrip(tmp_path: Path) -> None:
    entries = {
        ("005930", "KRX"): {"t_ms": 1, "kind": "ob", "asks": [{"price": 100}]},
        ("005930", "NXT"): {"t_ms": 2, "kind": "ob", "asks": []},
        ("000660", "KRX"): {"t_ms": 3, "kind": "ob", "asks": []},
    }
    last_ob_store.save(tmp_path, entries)
    assert last_ob_store.load(tmp_path) == entries


def test_store_missing_file_is_empty(tmp_path: Path) -> None:
    assert last_ob_store.load(tmp_path) == {}


def test_store_empty_input_does_not_erase(tmp_path: Path) -> None:
    """"쓸 것이 없다" 와 "비우라" 는 다른 뜻이다.

    기동 직후처럼 메모리가 아직 비어 있는 순간에 빈 입력으로 호출되면, 애써 남긴
    어제 값을 날리게 된다.
    """
    last_ob_store.save(tmp_path, {("005930", "KRX"): {"t_ms": 1}})
    last_ob_store.save(tmp_path, {})
    assert last_ob_store.load(tmp_path) != {}


def test_store_overwrites_whole_file(tmp_path: Path) -> None:
    """병합이 아니라 **전체 덮어쓰기**다 — 구독에서 빠진 종목이 파일에서도 사라져야
    파일이 무한히 자라지 않는다(`after_hours_store` 의 병합과 반대인 이유)."""
    last_ob_store.save(tmp_path, {("005930", "KRX"): {"t_ms": 1}})
    last_ob_store.save(tmp_path, {("000660", "KRX"): {"t_ms": 2}})
    assert set(last_ob_store.load(tmp_path)) == {("000660", "KRX")}


def test_store_corrupt_file_reads_as_empty(tmp_path: Path) -> None:
    (tmp_path / "last_ob.json").write_text("{ not json", encoding="utf-8")
    assert last_ob_store.load(tmp_path) == {}


def test_store_malformed_row_drops_only_that_entry(tmp_path: Path) -> None:
    import json
    last_ob_store.save(tmp_path, {("005930", "KRX"): {"t_ms": 1}})
    p = tmp_path / "last_ob.json"
    doc = json.loads(p.read_text(encoding="utf-8"))
    doc["codes"]["000660"] = {"KRX": "not-a-dict"}
    p.write_text(json.dumps(doc), encoding="utf-8")
    loaded = last_ob_store.load(tmp_path)
    assert ("005930", "KRX") in loaded
    assert ("000660", "KRX") not in loaded


def test_store_write_is_atomic(tmp_path: Path) -> None:
    last_ob_store.save(tmp_path, {("005930", "KRX"): {"t_ms": 1}})
    assert list(tmp_path.glob("*.tmp")) == []


# ── 버퍼 접근자 ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_snapshot_carries_version_that_rises_with_frames() -> None:
    buf = LiveBuffer()
    _, v0 = await buf.last_ob_snapshot()
    await buf.publish("005930", [_ob(1)], now_ms=1)
    entries, v1 = await buf.last_ob_snapshot()
    assert v1 > v0
    assert ("005930", "KRX") in entries  # 태그 부재 → KRX 승격


@pytest.mark.asyncio
async def test_version_does_not_move_without_ob_frames() -> None:
    """⚠ 이 성질이 "장이 끝나면 쓰기가 0" 의 근거다.

    호가가 아닌 프레임(체결 등)은 마지막 호가를 바꾸지 않으므로 버전도 그대로여야
    한다 — 아니면 체결만 흐르는 15:40–16:00 에 같은 호가를 계속 다시 쓴다.
    """
    buf = LiveBuffer()
    await buf.publish("005930", [_ob(1)], now_ms=1)
    _, before = await buf.last_ob_snapshot()
    await buf.publish(
        "005930",
        [LiveSnapshot(t_ms=2, kind=SnapshotKind.TRADE, payload={"trades": []})],
        now_ms=2,
    )
    _, after = await buf.last_ob_snapshot()
    assert after == before


@pytest.mark.asyncio
async def test_snapshot_separates_venues() -> None:
    buf = LiveBuffer()
    await buf.publish("005930", [_ob(1, "KRX")], now_ms=1)
    await buf.publish("005930", [_ob(2, "NXT")], now_ms=2)
    entries, _ = await buf.last_ob_snapshot()
    assert entries[("005930", "KRX")]["t_ms"] == 1
    assert entries[("005930", "NXT")]["t_ms"] == 2


@pytest.mark.asyncio
async def test_restore_fills_empty_buffer() -> None:
    buf = LiveBuffer()
    restored = await buf.restore_last_ob({("005930", "KRX"): {"t_ms": 9, "kind": "ob"}})
    assert restored == 1
    assert (await buf.get_last_ob("005930", "KRX"))["t_ms"] == 9


@pytest.mark.asyncio
async def test_restore_never_overwrites_live_values() -> None:
    """살아 있는 WS 값이 **항상** 이긴다 — 복원이 수신보다 늦게 끝나도 안전해야 한다."""
    buf = LiveBuffer()
    await buf.publish("005930", [_ob(100)], now_ms=100)
    restored = await buf.restore_last_ob({("005930", "KRX"): {"t_ms": 1, "kind": "ob"}})
    assert restored == 0
    assert (await buf.get_last_ob("005930", "KRX"))["t_ms"] == 100


@pytest.mark.asyncio
async def test_restore_does_not_bump_version() -> None:
    """복원은 디스크에 있는 것을 메모리로 옮긴 것뿐이라 되쓸 이유가 없다.

    버전을 올리면 기동 직후 매번 같은 내용을 한 번 더 쓴다.
    """
    buf = LiveBuffer()
    _, before = await buf.last_ob_snapshot()
    await buf.restore_last_ob({("005930", "KRX"): {"t_ms": 9}})
    _, after = await buf.last_ob_snapshot()
    assert after == before


# ── flusher ─────────────────────────────────────────────────────────────────

async def _run_flusher_cycles(tmp_path: Path, monkeypatch, *, cycles: int = 3) -> list[int]:
    """flusher 를 몇 주기 돌리고 **실제 쓰기 횟수**를 센다."""
    writes: list[int] = []
    real_save = last_ob_store.save

    def counting_save(dd, entries):
        writes.append(len(entries))
        real_save(dd, entries)

    monkeypatch.setattr(lifecycle.last_ob_store, "save", counting_save)
    task = lifecycle.start_last_ob_flusher(tmp_path, interval_s=0)
    for _ in range(cycles * 20):
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    return writes


@pytest.mark.asyncio
async def test_flusher_writes_once_then_stops_when_nothing_changes(tmp_path, monkeypatch):
    """⚠ **이것이 "장이 끝나면 쓰기가 0" 의 실측이다.**

    KRX 전용 종목은 15:30 에 `0D` 가 끊겨 그 뒤로 프레임이 없다. 버전이 안 오르므로
    flusher 도 쓰지 않아야 한다 — 아니면 밤새 같은 값을 주기마다 다시 쓴다.
    """
    lifecycle.reset_for_tests()
    await lifecycle.get_buffer().publish("005930", [_ob(1)], now_ms=1)
    writes = await _run_flusher_cycles(tmp_path, monkeypatch)
    assert writes == [1], f"프레임이 멎었는데 {len(writes)}회 썼다"
    assert last_ob_store.load(tmp_path) != {}


@pytest.mark.asyncio
async def test_flusher_writes_again_after_a_new_frame(tmp_path, monkeypatch):
    lifecycle.reset_for_tests()
    buf = lifecycle.get_buffer()
    await buf.publish("005930", [_ob(1)], now_ms=1)
    writes: list[int] = []
    real_save = last_ob_store.save

    def counting_save(dd, entries):
        writes.append(len(entries))
        real_save(dd, entries)

    monkeypatch.setattr(lifecycle.last_ob_store, "save", counting_save)
    task = lifecycle.start_last_ob_flusher(tmp_path, interval_s=0)
    for _ in range(20):
        await asyncio.sleep(0)
    await buf.publish("000660", [_ob(2)], now_ms=2)  # 새 프레임 → 버전 상승
    for _ in range(20):
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(writes) == 2
    assert writes[-1] == 2  # 두 종목이 함께 실린다


@pytest.mark.asyncio
async def test_restore_from_disk_repopulates_the_buffer(tmp_path):
    """재시작 시나리오 전체 — 저장 → 버퍼 초기화 → 복원."""
    lifecycle.reset_for_tests()
    await lifecycle.get_buffer().publish("005930", [_ob(42)], now_ms=42)
    entries, _ = await lifecycle.get_buffer().last_ob_snapshot()
    last_ob_store.save(tmp_path, entries)

    lifecycle.reset_for_tests()  # ← 재시작에 해당
    assert await lifecycle.get_buffer().get_last_ob("005930", "KRX") is None

    restored = await lifecycle.restore_last_ob_from_disk(tmp_path)
    assert restored == 1
    assert (await lifecycle.get_buffer().get_last_ob("005930", "KRX"))["t_ms"] == 42


@pytest.mark.asyncio
async def test_restore_from_disk_with_no_file_is_noop(tmp_path):
    lifecycle.reset_for_tests()
    assert await lifecycle.restore_last_ob_from_disk(tmp_path) == 0
