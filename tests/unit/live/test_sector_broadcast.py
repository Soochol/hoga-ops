"""0J/0U 오버레이 브로드캐스트 — **변경분만 보낸다**는 계약.

이 태스크는 죽어도 화면이 안 비므로(폴링 baseline) 실패가 무증상이다. 그래서
"보냈나" 보다 **"안 보내야 할 때 안 보내나"** 가 더 중요한 테스트다 — 매초 68코드를
통째로 미는 회귀는 조용히 트래픽만 늘린다.
"""
from __future__ import annotations

import asyncio
import contextlib

import pytest

from hoga.live import lifecycle


class _FakeSession:
    def __init__(self, snap: dict[str, dict]) -> None:
        self._snap = snap

    def sector_snapshot(self) -> dict[str, dict]:
        return dict(self._snap)

    def set(self, snap: dict[str, dict]) -> None:
        self._snap = snap


async def _stop(task: asyncio.Task) -> None:
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def _run_once(monkeypatch, session, sent: list[dict], *, ticks: int = 1) -> None:
    """브로드캐스트 루프를 `ticks` 번 돌리고 멈춘다."""
    monkeypatch.setattr(lifecycle._state, "kiwoom_session", session, raising=False)
    task = await lifecycle.start_sector_broadcast(sent.append, interval_s=0.01)
    await asyncio.sleep(0.015 * ticks + 0.01)
    await _stop(task)


@pytest.mark.asyncio
async def test_publishes_only_display_fields(monkeypatch):
    """시고저·누적거래량은 싣지 않는다 — 어느 카드도 안 쓴다."""
    session = _FakeSession({"001": {
        "value": 6250.5, "change_pct": -0.3, "rising": 359,
        "open": 6300.0, "high": 6320.0, "low": 6240.0, "cum_volume": 161020,
    }})
    sent: list[dict] = []
    await _run_once(monkeypatch, session, sent)

    assert sent, "첫 스냅샷은 보내야 한다"
    wire = sent[0]["sectors"]["001"]
    assert wire == {"value": 6250.5, "change_pct": -0.3, "rising": 359}


@pytest.mark.asyncio
async def test_unchanged_snapshot_is_not_republished(monkeypatch):
    """값이 그대로면 침묵한다 — 마감 후처럼 안 변하는 구간의 트래픽이 0 이 된다."""
    session = _FakeSession({"001": {"value": 6250.5}})
    sent: list[dict] = []
    await _run_once(monkeypatch, session, sent, ticks=4)

    assert len(sent) == 1


@pytest.mark.asyncio
async def test_only_changed_codes_are_sent(monkeypatch):
    """한 코드가 바뀌었다고 68개를 다 보내지 않는다."""
    session = _FakeSession({"001": {"value": 6250.5}, "101": {"value": 780.0}})
    sent: list[dict] = []
    monkeypatch.setattr(lifecycle._state, "kiwoom_session", session, raising=False)
    task = await lifecycle.start_sector_broadcast(sent.append, interval_s=0.01)
    await asyncio.sleep(0.025)
    session.set({"001": {"value": 6251.0}, "101": {"value": 780.0}})
    await asyncio.sleep(0.03)
    await _stop(task)

    assert len(sent) >= 2
    assert set(sent[0]["sectors"]) == {"001", "101"}
    assert set(sent[-1]["sectors"]) == {"001"}   # 안 바뀐 101 은 빠진다


@pytest.mark.asyncio
async def test_real_frames_flow_from_ws_hook_to_wire(monkeypatch):
    """**파이프 전체**: WS row → `_on_sector_row` → 스냅샷 → 브로드캐스트 wire.

    조각별 테스트(파서·병합·브로드캐스트)는 각자 초록이면서 이음매가 끊겨 있을 수
    있다 — 특히 `_SECTOR_WIRE_FIELDS` 의 이름이 `SectorTick` 속성명과 어긋나면
    **전부 통과한 채** 실전에서 `codes_with_data: 0` 이 된다. 그 증상은 벤더 구독
    실패와 구별되지 않아 디버깅이 엉뚱한 데로 간다.
    """
    from hoga.live.kiwoom_session import KiwoomSessionManager

    mgr = KiwoomSessionManager(
        buffer=object(), data_dir=object(), date_fn=lambda: "20260807",
        now_fn=lambda: 1_786_000_000_000,
    )
    # 실측 원본 그대로(0J 는 하락이라 레벨에 `-` 접두가 붙어 있다).
    mgr._on_sector_row({
        "type": "0J", "item": "150",
        "values": {"20": "105602", "10": "-1327.93", "11": "-43.69", "12": "-3.19",
                   "13": "28264", "14": "1272796", "16": "+1383.62"},
    }, 1_786_000_000_000)
    mgr._on_sector_row({
        "type": "0U", "item": "001",
        "values": {"20": "105700", "252": "359", "255": "510", "253": "39",
                   "251": "3", "254": "0", "10": "-6200.89", "12": "-1.52",
                   "14": "12180438"},
    }, 1_786_000_000_001)

    snap = mgr.sector_snapshot()
    assert snap["150"]["value"] == 1327.93      # 부호가 벗겨져 세션까지 왔다
    assert snap["001"]["rising"] == 359

    health = mgr.sector_health()
    assert health["tick_count"] == 2
    assert health["codes_with_data"] == 2
    assert health["subscribed_codes"] > 60      # 시드 전체를 구독한다

    # 그 스냅샷이 실제로 wire 로 나가는가 — 필드명이 어긋나면 여기서 빈다.
    sent: list[dict] = []
    await _run_once(monkeypatch, mgr, sent)
    assert sent, "스냅샷이 있는데 브로드캐스트가 비었다 = 이음매가 끊겼다"
    assert sent[0]["sectors"]["150"]["value"] == 1327.93
    assert sent[0]["sectors"]["001"]["rising"] == 359


@pytest.mark.asyncio
async def test_no_session_is_a_noop_not_a_crash(monkeypatch):
    """무자격 dev·부팅 전에는 세션이 없다 — 그게 정상 경로다(ADR-0134)."""
    sent: list[dict] = []
    monkeypatch.setattr(lifecycle._state, "kiwoom_session", None, raising=False)
    task = await lifecycle.start_sector_broadcast(sent.append, interval_s=0.01)
    await asyncio.sleep(0.03)
    await _stop(task)

    assert sent == []
    assert task.cancelled() or task.done()
