"""GET /health?deep=1 — readiness probe.

얕은 `/health` 는 liveness 다: 프로세스가 응답하면 200. 그런데 배경 태스크가 전멸해도
얕은 응답은 200 이므로, 감독자가 그것만 물면 **"살아 있지만 아무 일도 안 하는"
프로세스를 영원히 방치**한다 — ADR-0064 가 지목한 실패 모드다. deep 은 조용히 죽은
태스크가 있으면 503 을 내 감독자가 재시작할 수 있게 한다.

핵심 구별: 미기동(env 로 끈 기능·미주입)은 실패가 아니다. 그걸 실패로 세면
`HOGA_LIVE_TODAY_PROMOTE_ENABLED=false` 인 사용자의 프로세스가 무한 재시작된다.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.app import APP_COMMIT, APP_VERSION, create_app


class _Runtime:
    def __init__(self, tasks: list[dict[str, object]]) -> None:
        self._tasks = tasks

    def supervised_task_health(self) -> list[dict[str, object]]:
        return self._tasks


def _client(tmp_path: Path) -> tuple[TestClient, FastAPI]:
    app = create_app(tmp_path)
    return TestClient(app), app


def test_shallow_health_is_liveness_plus_version(tmp_path: Path) -> None:
    """얕은 쪽은 liveness + 인스턴스 식별(#998) — dev/prod 2대에서 "이 포트의
    코드가 무엇인가" 는 살아있냐 만큼 자주 묻는 질문이라 얕은 쪽에 싣는다."""
    client, _ = _client(tmp_path)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ok", "version": APP_VERSION, "commit": APP_COMMIT,
    }
    # VERSION 파일이 읽혔다면 하드코딩 시절('0.1.0')이 아니어야 한다.
    assert APP_VERSION not in ("", "0.1.0")


def test_health_carries_the_running_commit(tmp_path: Path) -> None:
    """업그레이드 성공 판정의 실제 신호는 commit 이다.

    VERSION 은 사람이 릴리스 때 올리는 값이라 갱신을 빠뜨리면 '항상 같은 값'이
    되고, 러닝북의 유일한 검증 단계가 restart 실패·git pull 누락을 성공과
    구별하지 못한다(2026-08-03). 여기서는 git 체크아웃에서 돌므로 실제 SHA 여야
    한다 — unknown 이면 식별이 다시 무신호로 돌아간 것이다.
    """
    client, _ = _client(tmp_path)
    commit = client.get("/health").json()["commit"]
    assert commit != "unknown"
    assert re.fullmatch(r"[0-9a-f]{7,40}", commit), commit


def test_deep_health_is_ok_when_all_tasks_run(tmp_path: Path) -> None:
    client, app = _client(tmp_path)
    app.state.startup_runtime = _Runtime([
        {"name": "watchlist-daily-loop", "running": True, "state": "running"},
        {"name": "capture-worker-0", "running": True, "state": "running"},
    ])

    resp = client.get("/health?deep=1")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    assert resp.json()["dead_tasks"] == []


def test_deep_health_does_not_fail_on_disabled_features(tmp_path: Path) -> None:
    """미기동은 죽음이 아니다 — 이걸 503 으로 내면 감독자가 무한 재시작한다."""
    client, app = _client(tmp_path)
    app.state.startup_runtime = _Runtime([
        {"name": "watchlist-daily-loop", "running": True, "state": "running"},
        {"name": "today-promoter", "running": False, "state": "not_started"},
        {"name": "kiwoom-session-watchdog", "running": False, "state": "not_started"},
    ])

    resp = client.get("/health?deep=1")
    assert resp.status_code == 200
    assert resp.json()["dead_tasks"] == []


def test_deep_health_reports_503_with_the_dead_task_names(tmp_path: Path) -> None:
    client, app = _client(tmp_path)
    app.state.startup_runtime = _Runtime([
        {"name": "watchlist-daily-loop", "running": True, "state": "running"},
        {"name": "capture-worker-1", "running": False, "state": "dead"},
        {"name": "program-trade-collector", "running": False, "state": "dead"},
    ])

    resp = client.get("/health?deep=1")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    # 이름을 실어야 감독자 로그·운영자가 무엇이 죽었는지 안다.
    assert body["dead_tasks"] == ["capture-worker-1", "program-trade-collector"]


def test_deep_health_is_ok_outside_lifespan(tmp_path: Path) -> None:
    """부팅 중·종료 중에는 판정 근거가 없다 — 미확정을 실패로 오해시키면 안 된다."""
    client, app = _client(tmp_path)
    app.state.startup_runtime = None

    resp = client.get("/health?deep=1")
    assert resp.status_code == 200
    assert resp.json()["checks"]["supervised_tasks"] == "unknown"


_RUNNING = [{"name": "watchlist-daily-loop", "running": True, "state": "running"}]


def test_deep_health_carries_version_and_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#998: version(인스턴스 식별)과 disk(잠식 관측)가 deep 에 실린다.

    disk 는 관측 전용 — low 여도 503 이 아니어야 한다: 503 은 워치독의 재시작
    신호인데 재시작은 디스크를 비우지 못한다.
    """
    from hoga.api import captures

    monkeypatch.setattr(captures, "_queue_owned", True)
    client, app = _client(tmp_path)
    app.state.startup_runtime = _Runtime(list(_RUNNING))

    resp = client.get("/health?deep=1")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == APP_VERSION
    disk = body["disk"]
    assert disk is not None
    assert set(disk) == {"free_pct", "free_gib", "low"}
    assert 0.0 <= disk["free_pct"] <= 100.0


def test_deep_health_flags_unowned_queue_as_degraded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#998 핵심: 비소유 부팅(ADR-0094 flock 패배)은 이전엔 deep 어디에도 안
    드러났다 — 워커 행이 'dead' 가 아니라 **생략**되는 형태라 감독자가 read-only
    prod 를 영원히 방치했다. env 옵트아웃이 아닌 비소유는 503 이어야 워치독이
    회수한다."""
    from hoga.api import captures

    monkeypatch.delenv("HOGA_CAPTURE_QUEUE_DISABLED", raising=False)
    monkeypatch.setattr(captures, "_queue_owned", False)
    client, app = _client(tmp_path)
    app.state.startup_runtime = _Runtime(list(_RUNNING))

    resp = client.get("/health?deep=1")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["queue"] == {"owned": False, "disabled_by_env": False}
    assert body["dead_tasks"] == []  # 태스크는 멀쩡 — 큐 축이 독립 판정임을 고정


def test_deep_health_env_optout_queue_is_not_a_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """의도된 read-only(HOGA_CAPTURE_QUEUE_DISABLED=1 도그푸딩)는 실패가 아니다 —
    실패로 세면 그 인스턴스가 무한 재시작된다(미기동≠죽음 원칙과 동일)."""
    from hoga.api import captures

    monkeypatch.setenv("HOGA_CAPTURE_QUEUE_DISABLED", "1")
    monkeypatch.setattr(captures, "_queue_owned", False)
    client, app = _client(tmp_path)
    app.state.startup_runtime = _Runtime(list(_RUNNING))

    resp = client.get("/health?deep=1")
    assert resp.status_code == 200
    assert resp.json()["queue"] == {"owned": False, "disabled_by_env": True}
