"""수급 수집기 단일 소유권 (ADR-0094 확장, 2026-08-10).

`data_dir` 이 머신 전역이라 워크트리 백엔드가 메인 `.env` 를 상속해 뜨면 같은 파일에
수집기가 두 벌 쓴다 — 2026-08-10 에 70분간 실제로 발생했다(:8001 · 표본이 두 위상으로
교차 기록). 이 파일이 지키는 것은 **두 번째 프로세스가 수집기를 안 띄운다** 이다.

⚠ 락이 프로세스 전역이라 `conftest._reset_collector_ownership` 이 매 테스트 앞에서
해제한다. 그게 없으면 먼저 잡은 테스트 때문에 뒤 테스트가 위양성으로 통과한다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api import scheduler
from hoga.api.ownership import (
    collectors_lock_path,
    lock_path,
    try_acquire_collector_ownership,
)


def test_second_acquirer_is_denied(tmp_path: Path):
    first = try_acquire_collector_ownership(tmp_path)
    assert first is not None
    try:
        assert try_acquire_collector_ownership(tmp_path) is None
    finally:
        first.release()


def test_release_lets_a_successor_in(tmp_path: Path):
    """--reload 재기동이 이 경로를 탄다 — 해제 뒤 후임이 즉시 잡아야 한다."""
    first = try_acquire_collector_ownership(tmp_path)
    assert first is not None
    first.release()
    second = try_acquire_collector_ownership(tmp_path)
    assert second is not None
    second.release()


def test_queue_and_collector_locks_are_independent(tmp_path: Path):
    """**별개 파일**이다 — 큐 경쟁에서 진 프로세스가 수집기로는 맞을 수 있다.

    하나로 묶으면 큐를 쥔 인스턴스가 자격증명이 없을 때 수집이 통째로 멎는다.
    """
    assert lock_path(tmp_path) != collectors_lock_path(tmp_path)
    from hoga.api.ownership import try_acquire_queue_ownership

    queue = try_acquire_queue_ownership(tmp_path)
    assert queue is not None
    try:
        collectors = try_acquire_collector_ownership(tmp_path)
        assert collectors is not None, "큐 락이 수집기 락을 막으면 안 된다"
        collectors.release()
    finally:
        queue.release()


def _credentialed(monkeypatch: pytest.MonkeyPatch) -> None:
    """자격이 있는 것처럼 만든다 — 락은 **자격이 있을 때만** 잡기 때문이다."""
    from hoga.live import deriv_flow_runtime, investor_flow_runtime

    monkeypatch.setattr(investor_flow_runtime, "is_available", lambda *_a, **_k: True)
    monkeypatch.setattr(deriv_flow_runtime, "is_available", lambda *_a, **_k: True)


@pytest.mark.asyncio
async def test_uncredentialed_instance_does_not_take_the_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """**무자격은 락을 선점하지 않는다.**

    워크트리가 빈 `.env` 로(관례대로) 먼저 뜨고 사용자 dev 서버가 나중에 뜨는 순서는
    정상이고 흔하다. 무자격이 락을 쥐면 그 순서에서 **수집이 통째로 멎는다** —
    가드가 막으려던 것보다 나쁜 결과다.
    """
    from hoga.live import deriv_flow_runtime, investor_flow_runtime

    monkeypatch.setattr(investor_flow_runtime, "is_available", lambda *_a, **_k: False)
    monkeypatch.setattr(deriv_flow_runtime, "is_available", lambda *_a, **_k: False)

    tasks = scheduler.start_scheduler(tmp_path)
    try:
        state = scheduler.collector_ownership_state()
        assert state["owned"] is False
        assert state["reason"] == "no_credentials"
        # 락 파일을 실제로 쥐지 않았다 — 자격 있는 후임이 바로 잡을 수 있어야 한다.
        successor = try_acquire_collector_ownership(tmp_path)
        assert successor is not None, "무자격 인스턴스가 락을 선점했다"
        successor.release()
    finally:
        for t in tasks:
            t.cancel()
        scheduler.release_collector_ownership()


@pytest.mark.asyncio
async def test_non_owner_does_not_start_collectors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """**이 파일의 핵심.** 락을 남이 쥐고 있으면 수집기를 만들지도 않는다.

    `make_collector` 를 호출조차 하지 않는지 본다 — 만들고 나서 `start()` 를 건너뛰는
    구현이면 벤더 클라이언트·토큰이 이미 생긴 뒤라 #1088 위험이 남는다.
    """
    _credentialed(monkeypatch)
    holder = try_acquire_collector_ownership(tmp_path)
    assert holder is not None
    tasks: list = []

    from hoga.live import deriv_flow_runtime, investor_flow_runtime

    calls: list[str] = []
    monkeypatch.setattr(
        investor_flow_runtime, "make_collector",
        lambda *_a, **_k: calls.append("investor") or None,
    )
    monkeypatch.setattr(
        deriv_flow_runtime, "make_collector",
        lambda *_a, **_k: calls.append("deriv") or None,
    )

    try:
        tasks = scheduler.start_scheduler(tmp_path)
        assert calls == [], f"비소유자가 수집기를 만들었다: {calls}"
        assert scheduler.collector_ownership_state()["owned"] is False
    finally:
        for t in tasks:
            t.cancel()
        holder.release()


@pytest.mark.asyncio
async def test_owner_does_start_collectors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """짝 테스트 — 위 단언이 "항상 0건" 이라서 통과하는 게 아님을 고정한다.

    이게 없으면 `make_collector` 이름을 오타 내도 위 테스트가 초록이다.
    """
    _credentialed(monkeypatch)
    from hoga.live import deriv_flow_runtime, investor_flow_runtime

    calls: list[str] = []
    monkeypatch.setattr(
        investor_flow_runtime, "make_collector",
        lambda *_a, **_k: calls.append("investor") or None,
    )
    monkeypatch.setattr(
        deriv_flow_runtime, "make_collector",
        lambda *_a, **_k: calls.append("deriv") or None,
    )

    tasks = scheduler.start_scheduler(tmp_path)
    try:
        assert calls == ["investor", "deriv"]
        assert scheduler.collector_ownership_state()["owned"] is True
    finally:
        for t in tasks:
            t.cancel()
        scheduler.release_collector_ownership()


def test_state_is_null_before_the_scheduler_runs():
    """`owned=null` 은 "소유권 없음" 이 아니라 "스케줄러 미기동" 이다.

    둘을 같은 값으로 표현하면 관측면이 거짓말을 한다 — 부팅 직후의 정상 상태가
    "다른 프로세스에 뺏김" 으로 읽힌다.
    """
    scheduler.release_collector_ownership()
    assert scheduler.collector_ownership_state()["owned"] is None
