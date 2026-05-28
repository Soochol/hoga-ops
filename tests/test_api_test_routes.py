"""Dev test route: gated, copies fixtures, parses, returns 200."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app


@pytest.fixture
def enable_test_endpoints(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")


def test_add_stockdate_disabled_when_env_unset(tmp_path: Path) -> None:
    """Without the env var, the route is not mounted -> 404."""
    app = create_app(data_dir=tmp_path / "data")
    client = TestClient(app)
    r = client.post(
        "/api/test/add-stockdate", params={"code": "005930", "date": "20260520"}
    )
    assert r.status_code == 404


def test_add_stockdate_copies_and_parses(
    enable_test_endpoints: None, tmp_path: Path
) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir=data_dir)
    client = TestClient(app)
    with client:
        r = client.post(
            "/api/test/add-stockdate",
            params={"code": "005930", "date": "20260520"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body == {"ok": True, "code": "005930", "date": "20260520"}
        # Verify the parquet directory was created
        assert (
            data_dir / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json"
        ).exists()
        # And inventory now sees it
        inv = client.get("/api/stock-dates").json()
        assert any(
            e["code"] == "005930" and e["date"] == "20260520" for e in inv
        )


def test_add_stockdate_unknown_code_returns_404(
    enable_test_endpoints: None, tmp_path: Path
) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir=data_dir)
    client = TestClient(app)
    r = client.post(
        "/api/test/add-stockdate",
        params={"code": "999999", "date": "20260520"},
    )
    assert r.status_code == 404


def test_cookie_expire_at_configures_fake(
    enable_test_endpoints: None, tmp_path: Path
) -> None:
    """The /api/test/cookie_expire_at hook wires through to the fake's
    failure-injection state. Verifies the route accepts a positive index
    and a negative-disable value.
    """
    from hoga.api import captures_fake

    app = create_app(data_dir=tmp_path / "data")
    client = TestClient(app)
    try:
        r = client.post("/api/test/cookie_expire_at", json={"index": 3})
        assert r.status_code == 200
        assert captures_fake._raise_on_request_index == 3

        r = client.post("/api/test/cookie_expire_at", json={"index": -1})
        assert r.status_code == 200
        assert captures_fake._raise_on_request_index is None
    finally:
        # Defensive reset: ensure mid-test assertion failure doesn't leak
        # injection state into downstream tests.
        captures_fake.configure_fake_to_raise_on(None)
