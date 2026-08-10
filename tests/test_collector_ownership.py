"""공유 data_dir writer 의 단일 소유권 (ADR-0094 확장, 2026-08-10).

`data_dir` 이 머신 전역이라 워크트리 백엔드가 메인 `.env` 를 상속해 뜨면 같은 파일에
백그라운드 writer 가 두 벌 쓴다 — 수급 수집기에서 70분간 실제로 발생했다(:8001 ·
표본이 두 위상으로 교차 기록). 이 파일이 지키는 것은 **두 번째 프로세스가 그 일을
시작하지 않는다** 이다.

⚠ 락이 프로세스 전역이라 `conftest._reset_collector_ownership` 이 매 테스트 앞에서
해제한다. 그게 없으면 먼저 잡은 테스트 때문에 뒤 테스트가 위양성으로 통과한다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api import ownership, scheduler
from hoga.api.ownership import (
    collectors_lock_path,
    daily_lock_path,
    lock_path,
    try_acquire_collector_ownership,
    ws_writers_lock_path,
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


def test_every_writer_has_its_own_lock_file(tmp_path: Path):
    """**락 파일이 writer 마다 다르다** — 하나로 묶으면 안 되는 이유가 있다.

    전제 조건이 서로 다르다(큐는 무조건 · 수집기는 REST 자격 · WS writer 는 살아
    있는 키움 세션). 한 프로세스가 어떤 일에는 맞고 다른 일에는 안 맞을 수 있으므로,
    "내가 주인이다" 플래그 하나로 뭉치면 자격 있는 쪽이 굶는다.
    """
    paths = {
        lock_path(tmp_path),
        collectors_lock_path(tmp_path),
        ws_writers_lock_path(tmp_path),
        daily_lock_path(tmp_path),
    }
    assert len(paths) == 4


def test_registry_covers_every_guarded_writer():
    """레지스트리 키가 곧 `/api/live/status.writers` 의 키다.

    writer 를 추가하고 등록을 잊으면 **관측면에서만 조용히 사라진다** — 락은 걸리는데
    상태가 안 보이는 것이 이 프로젝트가 싫어하는 "무증상 강등" 이다.
    """
    assert set(ownership.ownership_state()) == {"collectors", "ws", "daily"}


def test_queue_and_collector_locks_are_independent(tmp_path: Path):
    """큐 경쟁에서 진 프로세스가 수집기로는 맞을 수 있다."""
    from hoga.api.ownership import try_acquire_queue_ownership

    queue = try_acquire_queue_ownership(tmp_path)
    assert queue is not None
    try:
        collectors = try_acquire_collector_ownership(tmp_path)
        assert collectors is not None, "큐 락이 수집기 락을 막으면 안 된다"
        collectors.release()
    finally:
        queue.release()


def test_uncredentialed_acquire_does_not_touch_the_lock(tmp_path: Path):
    """**무자격은 락을 선점하지 않는다** — 넷 모두에 걸리는 규칙이다.

    워크트리가 빈 `.env` 로(관례대로) 먼저 뜨고 사용자 dev 서버가 나중에 뜨는 순서는
    정상이고 흔하다. 무자격이 락을 쥐면 그 순서에서 **그 일이 통째로 멎는다** —
    가드가 막으려던 것보다 나쁜 결과다.
    """
    for name in ("collectors", "ws", "daily"):
        assert ownership.acquire(name, tmp_path, available=False) is False
        assert ownership.ownership_state()[name] == {
            "owned": False, "reason": "no_credentials",
        }

    # 락 파일을 실제로 쥐지 않았다 — 자격 있는 후임이 바로 잡을 수 있어야 한다.
    successor = try_acquire_collector_ownership(tmp_path)
    assert successor is not None, "무자격 인스턴스가 락을 선점했다"
    successor.release()


def test_state_distinguishes_three_situations(tmp_path: Path):
    """`null`(미시도) · `no_credentials` · `held_by_other` 는 **다른 상태**다.

    하나로 뭉치면 관측면이 거짓말을 한다 — 부팅 직후의 정상이 "뺏김" 으로 읽힌다.
    """
    assert ownership.ownership_state()["daily"]["owned"] is None

    holder = try_acquire_collector_ownership(tmp_path)
    assert holder is not None
    try:
        assert ownership.acquire("collectors", tmp_path) is False
        assert ownership.ownership_state()["collectors"]["reason"] == "held_by_other"
    finally:
        holder.release()

    assert ownership.acquire("ws", tmp_path, available=False) is False
    assert ownership.ownership_state()["ws"]["reason"] == "no_credentials"


def _credentialed(monkeypatch: pytest.MonkeyPatch) -> None:
    """자격이 있는 것처럼 만든다 — 락은 **자격이 있을 때만** 잡기 때문이다."""
    from hoga.live import deriv_flow_runtime, investor_flow_runtime

    monkeypatch.setattr(investor_flow_runtime, "is_available", lambda *_a, **_k: True)
    monkeypatch.setattr(deriv_flow_runtime, "is_available", lambda *_a, **_k: True)
    monkeypatch.setattr(scheduler, "_kiwoom_credentialed", lambda *_a, **_k: True)


def _stub_collectors(monkeypatch: pytest.MonkeyPatch) -> list[str]:
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
    return calls


@pytest.mark.asyncio
async def test_non_owner_does_not_start_collectors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """**이 파일의 핵심.** 락을 남이 쥐고 있으면 수집기를 만들지도 않는다.

    `make_collector` 를 호출조차 하지 않는지 본다 — 만들고 나서 `start()` 를 건너뛰는
    구현이면 벤더 클라이언트·토큰이 이미 생긴 뒤라 #1088 위험이 남는다.
    """
    _credentialed(monkeypatch)
    calls = _stub_collectors(monkeypatch)
    holder = try_acquire_collector_ownership(tmp_path)
    assert holder is not None
    tasks: list = []
    try:
        tasks = scheduler.start_scheduler(tmp_path)
        assert calls == [], f"비소유자가 수집기를 만들었다: {calls}"
        assert ownership.ownership_state()["collectors"]["owned"] is False
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
    calls = _stub_collectors(monkeypatch)

    tasks = scheduler.start_scheduler(tmp_path)
    try:
        assert calls == ["investor", "deriv"]
        assert ownership.ownership_state()["collectors"]["owned"] is True
    finally:
        for t in tasks:
            t.cancel()


@pytest.mark.asyncio
async def test_non_owner_does_not_run_the_daily_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """일일 배치도 소유자만 돈다.

    `scheduler_state.json` 마커가 하루 1회를 맡지만 **읽고-쓰기**라 같은 몇 초 안에
    틱한 두 인스턴스가 둘 다 통과한다. 락이 그 창을 닫는다.
    """
    _credentialed(monkeypatch)
    _stub_collectors(monkeypatch)
    from hoga.api.ownership import try_acquire_daily_ownership

    holder = try_acquire_daily_ownership(tmp_path)
    assert holder is not None
    tasks: list = []
    try:
        tasks = scheduler.start_scheduler(tmp_path)
        names = {t.get_name() for t in tasks}
        assert "watchlist-daily-loop" not in names, f"비소유자가 일일 루프를 띄웠다: {names}"
        assert ownership.ownership_state()["daily"]["reason"] == "held_by_other"
    finally:
        for t in tasks:
            t.cancel()
        holder.release()


@pytest.mark.asyncio
async def test_owner_does_run_the_daily_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """짝 테스트 — 위가 "루프가 원래 안 뜬다" 로 통과하는 게 아님을 고정한다."""
    _credentialed(monkeypatch)
    _stub_collectors(monkeypatch)

    tasks = scheduler.start_scheduler(tmp_path)
    try:
        assert "watchlist-daily-loop" in {t.get_name() for t in tasks}
        assert ownership.ownership_state()["daily"]["owned"] is True
    finally:
        for t in tasks:
            t.cancel()


def test_release_all_clears_every_lock(tmp_path: Path):
    """셧다운 해제가 **전부** 놓는지 — 하나만 남아도 후임이 그 일을 못 한다."""
    for name in ("collectors", "ws", "daily"):
        assert ownership.acquire(name, tmp_path) is True

    ownership.release_all()

    assert all(v["owned"] is None for v in ownership.ownership_state().values())
    # 실제로 파일 락이 풀렸는지 — 상태만 지우고 fd 를 안 놓는 구현을 걸러낸다.
    successor = try_acquire_collector_ownership(tmp_path)
    assert successor is not None
    successor.release()
