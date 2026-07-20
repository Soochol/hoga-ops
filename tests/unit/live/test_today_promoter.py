"""Tests for start_today_promoter / stop_today_promoter (ADR-0043, 키움 전담).

KIS 팔(get_active_codes/promote_today)은 KIS live/ 수집 소멸로 상시 no-op 이라
제거됐다(2026-07-20 감사) — 루프 계약 테스트를 키움 콜백 기준으로 이식했다.
"""
import asyncio
from pathlib import Path

import pytest

from hoga.live.lifecycle import start_today_promoter, stop_today_promoter


@pytest.mark.asyncio
async def test_today_promoter_calls_promote_kiwoom_per_cycle(
    tmp_path: Path, monkeypatch,
) -> None:
    """task가 sleep 사이에 promote_kiwoom_today를 매 cycle마다 호출."""
    calls: list[tuple[str, str]] = []

    async def fake_promote(data_dir, *, code):
        calls.append((str(data_dir), code))

    monkeypatch.setattr("hoga.live.lifecycle.promote_kiwoom_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_kiwoom_capture_codes=lambda: ["003490", "058610"],
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

    monkeypatch.setattr("hoga.live.lifecycle.promote_kiwoom_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_kiwoom_capture_codes=lambda: ["003490", "058610"],
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
    """get_kiwoom_capture_codes가 raise해도 다음 cycle 계속."""
    cycle_count = 0

    def flaky_get_codes():
        nonlocal cycle_count
        cycle_count += 1
        if cycle_count == 1:
            raise RuntimeError("simulated")
        return ["003490"]

    async def fake_promote(data_dir, *, code): pass
    monkeypatch.setattr("hoga.live.lifecycle.promote_kiwoom_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_kiwoom_capture_codes=flaky_get_codes,
        interval_s=0.05,
    )
    await asyncio.sleep(0.15)
    await stop_today_promoter(task)

    assert cycle_count >= 2  # 첫 cycle exception 후에도 진행


@pytest.mark.asyncio
async def test_today_promoter_picks_up_target_mutations_per_cycle(
    tmp_path: Path, monkeypatch,
) -> None:
    """eng-review Blocker 2 계승 — 대상 콜백은 매 cycle마다 호출돼서 저장셋
    변경(관심종목/히트맵 편집)을 재시작 없이 즉시 반영."""
    calls: list[str] = []

    async def fake_promote(data_dir, *, code):
        calls.append(code)

    monkeypatch.setattr("hoga.live.lifecycle.promote_kiwoom_today", fake_promote)

    codes_list = ["003490"]
    def dynamic_codes() -> list[str]:
        return list(codes_list)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_kiwoom_capture_codes=dynamic_codes,
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
    """저장셋 비어있으면(키움 미배선/off 포함) promote 호출 안 함."""
    calls: list[str] = []

    async def fake_promote(data_dir, *, code):
        calls.append(code)

    monkeypatch.setattr("hoga.live.lifecycle.promote_kiwoom_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_kiwoom_capture_codes=lambda: [],
        interval_s=0.05,
    )
    await asyncio.sleep(0.15)
    await stop_today_promoter(task)

    assert calls == []


@pytest.mark.asyncio
async def test_today_promoter_callback_omitted_is_noop(
    tmp_path: Path, monkeypatch,
) -> None:
    """콜백 미주입(테스트/특수 기동)이면 promote 호출 없이 루프만 돈다."""
    calls: list[str] = []

    async def fake_promote(data_dir, *, code):
        calls.append(code)

    monkeypatch.setattr("hoga.live.lifecycle.promote_kiwoom_today", fake_promote)

    task = await start_today_promoter(data_dir=tmp_path, interval_s=0.05)
    await asyncio.sleep(0.12)
    await stop_today_promoter(task)

    assert calls == []


@pytest.mark.asyncio
async def test_today_promoter_publishes_only_on_real_promotion(
    tmp_path: Path, monkeypatch,
) -> None:
    """on_promoted fires for a code that actually promoted (→ date), never for a
    skip (→ None). A spurious event would refetch the frontend's today range for
    nothing — 이 발행이 프론트 today 갱신(range.ts livePromotion 스탬프)의 유일한
    소스라 skip 무발행 계약이 특히 중요하다."""
    events: list[dict] = []

    async def fake_promote(data_dir, *, code):
        # 000660 has data to promote; 005930 is a skip (no jsonl this cycle).
        return "20260718" if code == "000660" else None

    monkeypatch.setattr("hoga.live.lifecycle.promote_kiwoom_today", fake_promote)

    task = await start_today_promoter(
        data_dir=tmp_path,
        get_kiwoom_capture_codes=lambda: ["000660", "005930"],
        interval_s=0.05,
        on_promoted=events.append,
    )
    await asyncio.sleep(0.12)
    await stop_today_promoter(task)

    assert events, "expected at least one promotion_completed event"
    assert all(e["type"] == "promotion_completed" for e in events)
    assert {e["code"] for e in events} == {"000660"}  # skip code never published
    assert all(e["date"] == "20260718" for e in events)
