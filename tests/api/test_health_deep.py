"""GET /health?deep=1 — readiness probe.

얕은 `/health` 는 liveness 다: 프로세스가 응답하면 200. 그런데 배경 태스크가 전멸해도
얕은 응답은 200 이므로, 감독자가 그것만 물면 **"살아 있지만 아무 일도 안 하는"
프로세스를 영원히 방치**한다 — ADR-0064 가 지목한 실패 모드다. deep 은 조용히 죽은
태스크가 있으면 503 을 내 감독자가 재시작할 수 있게 한다.

핵심 구별: 미기동(env 로 끈 기능·미주입)은 실패가 아니다. 그걸 실패로 세면
`HOGA_LIVE_TODAY_PROMOTE_ENABLED=false` 인 사용자의 프로세스가 무한 재시작된다.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.app import create_app


class _Runtime:
    def __init__(self, tasks: list[dict[str, object]]) -> None:
        self._tasks = tasks

    def supervised_task_health(self) -> list[dict[str, object]]:
        return self._tasks


def _client(tmp_path: Path) -> tuple[TestClient, FastAPI]:
    app = create_app(tmp_path)
    return TestClient(app), app


def test_shallow_health_stays_a_plain_liveness_probe(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


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
