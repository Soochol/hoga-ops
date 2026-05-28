"""Tests for POST /api/captures/items/{code}/{date}/unblock (ADR-0042)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from hoga.api import captures
from hoga.api.captures_persistence import load_manifest


def _build_test_app(monkeypatch, tmp_path):
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")
    from hoga.api.app import create_app
    return create_app(tmp_path)


def _no_workers(monkeypatch):
    monkeypatch.setattr(captures, "start_workers", lambda *a, **k: [], raising=True)


def test_unblock_clears_counter(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    captures.reset_state_for_tests()
    captures._fail_streaks["005930|20260520"] = 5
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items/005930/20260520/unblock")
        assert r.status_code == 200
        assert r.json() == {
            "code": "005930", "date": "20260520",
            "fail_streak": 0, "action": "unblocked",
        }


def test_unblock_already_zero_is_noop(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    captures.reset_state_for_tests()
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items/005930/20260520/unblock")
        assert r.status_code == 200
        assert r.json() == {
            "code": "005930", "date": "20260520",
            "fail_streak": 0, "action": "noop",
        }


def test_unblock_persists_to_manifest(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    captures.reset_state_for_tests()
    captures._fail_streaks["005930|20260520"] = 4
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        c.post("/api/captures/items/005930/20260520/unblock")
    persisted = load_manifest(tmp_path)
    assert persisted is not None
    assert "005930|20260520" not in persisted.fail_streaks


def test_unblock_does_not_touch_other_keys(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    captures.reset_state_for_tests()
    captures._fail_streaks["005930|20260520"] = 5
    captures._fail_streaks["003490|20260319"] = 3
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        c.post("/api/captures/items/005930/20260520/unblock")
    persisted = load_manifest(tmp_path)
    assert persisted is not None
    assert persisted.fail_streaks == {"003490|20260319": 3}


def test_unblock_then_enqueue_succeeds(monkeypatch, tmp_path):
    """End-to-end: a blocked pair becomes enqueueable after unblock."""
    _no_workers(monkeypatch)
    captures.reset_state_for_tests()
    captures._fail_streaks["005930|20260520"] = 5
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        c.post("/api/captures/items/005930/20260520/unblock")
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        assert r.status_code == 201
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["blocked"] == []


def test_unblock_invalid_code_returns_422(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    captures.reset_state_for_tests()
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items/INVALID/20260520/unblock")
        assert r.status_code == 422


def test_unblock_invalid_date_returns_422(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    captures.reset_state_for_tests()
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items/005930/2026XXXX/unblock")
        assert r.status_code == 422
