"""Stage 7-α — /api/live router."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_test_app(get_status_fn=None, control_fn=None):
    """Mount the live router on a bare FastAPI for isolated testing."""
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    app = FastAPI()
    app.include_router(
        build_router(
            get_status=get_status_fn or lifecycle.get_status,
            on_control=control_fn,
        )
    )
    return app


def test_get_live_status_returns_running_false_initially() -> None:
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()

    app = _make_test_app()
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        body = r.json()
        assert body["running"] is False
        assert body["watchlist_count"] == 0
        assert body["kis_calls_today"] == 0


def test_post_live_control_dispatches_action() -> None:
    recorded: list[str] = []

    def fake_control(action: str) -> None:
        recorded.append(action)

    app = _make_test_app(control_fn=fake_control)
    with TestClient(app) as c:
        r = c.post("/api/live/control", json={"action": "stop"})
        assert r.status_code == 200
        assert recorded == ["stop"]


def test_post_live_control_rejects_unknown_action() -> None:
    app = _make_test_app(control_fn=lambda action: None)
    with TestClient(app) as c:
        r = c.post("/api/live/control", json={"action": "nuke"})
        assert r.status_code == 422  # pydantic validation error


def test_live_router_registered_on_full_app(tmp_path) -> None:
    """create_app should mount /api/live/status."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        assert r.json()["running"] is False
