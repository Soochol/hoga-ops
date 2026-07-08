"""Tests for start_today_promoter / stop_today_promoter (ADR-0043)."""
import asyncio
from pathlib import Path

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
        return list(codes_list)

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
    assert "058610" in calls  # mutation propagated without restart


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


@pytest.mark.asyncio
async def test_today_promoter_publishes_only_on_real_promotion(
    tmp_path: Path, monkeypatch,
) -> None:
    """on_promoted fires for a code that actually promoted (promote_today → date),
    never for a skip (promote_today → None). A spurious event would refetch the
    frontend's today range for nothing (WS 푸시 승격 무효화)."""
    events: list[dict] = []

    async def fake_promote(data_dir, *, code):
        # 003490 has data to promote; 058610 is a skip (no jsonl this cycle).
        return "20260708" if code == "003490" else None

    monkeypatch.setattr("hoga.live.lifecycle.promote_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_active_codes=lambda: ["003490", "058610"],
        interval_s=0.05,
        on_promoted=events.append,
    )
    await asyncio.sleep(0.12)
    await stop_today_promoter(task)

    assert events, "expected at least one promotion_completed event"
    assert all(e["type"] == "promotion_completed" for e in events)
    published_codes = {e["code"] for e in events}
    assert published_codes == {"003490"}  # skip code never published
    assert all(e["date"] == "20260708" for e in events)


@pytest.mark.asyncio
async def test_today_promoter_promotes_ws_and_api_targets(
    tmp_path: Path, monkeypatch,
) -> None:
    """WS live JSONL and REST 30s JSONL must both become readable parquet."""
    live_calls: list[str] = []
    api_calls: list[str] = []

    async def fake_promote(data_dir, *, code):
        live_calls.append(code)

    async def fake_promote_api(data_dir, *, code):
        api_calls.append(code)

    monkeypatch.setattr("hoga.live.lifecycle.promote_today", fake_promote)
    monkeypatch.setattr("hoga.live.lifecycle.promote_api_today", fake_promote_api)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_active_codes=lambda: ["005930"],
        get_api_capture_codes=lambda: ["000660"],
        interval_s=0.05,
    )
    await asyncio.sleep(0.12)
    await stop_today_promoter(task)

    assert "005930" in live_calls
    assert "000660" in api_calls
