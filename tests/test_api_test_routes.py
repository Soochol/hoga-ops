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


def test_whoami_reports_this_checkout_and_data_dir(
    enable_test_endpoints: None, tmp_path: Path
) -> None:
    """`whoami` 는 **경로**를 돌려준다 — e2e 가 "지금 붙은 백엔드가 내 워크트리 것인가"
    를 판별하는 근거다.

    `/health` 의 version·commit 으로는 안 된다: 같은 커밋에서 딴 브랜치를 딴
    워크트리들은 그 값이 똑같다. 포트가 겹쳐 남의 서버에 붙어도 구별이 안 된다.
    """
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir=data_dir)
    client = TestClient(app)
    with client:
        body = client.get("/api/test/whoami").json()

    assert body["data_dir"] == str(data_dir.resolve())
    # 리포 루트 = `hoga/api/test_routes.py` 에서 둘 위. 하드코딩하지 않고 이 테스트
    # 파일 위치에서 독립적으로 계산해 대조한다 — 양쪽이 같은 실수를 하면 무의미하다.
    assert body["repo_root"] == str(Path(__file__).resolve().parents[1])


def test_whoami_disabled_when_env_unset(tmp_path: Path) -> None:
    """경로를 흘리는 라우트다 — 게이트 밖으로 새면 안 된다."""
    app = create_app(data_dir=tmp_path / "data")
    assert TestClient(app).get("/api/test/whoami").status_code == 404


def test_reset_stockdate_removes_raw_and_parquet(
    enable_test_endpoints: None, tmp_path: Path
) -> None:
    """`reset-stockdate` 는 `add-stockdate` 를 되돌린다 — 그래야 e2e 스펙이
    "이 날짜는 아직 캡처된 적 없다" 를 스스로 만들 수 있다.

    **양쪽 트리를 다 지우는지**가 요점이다. parquet 만 지우면 `check_disk_state`
    가 raw 만 보고 CLIENT_INCOMPLETE 로 분류해 `decide_capture` 가 `resume=True`
    로 이어 붙인다 — 백지가 아니다.
    """
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir=data_dir)
    client = TestClient(app)
    raw = data_dir / "raw" / "20260520" / "005930"
    parquet = data_dir / "parquet" / "20260520" / "005930"
    with client:
        client.post(
            "/api/test/add-stockdate",
            params={"code": "005930", "date": "20260520"},
        )
        assert raw.is_dir() and parquet.is_dir()

        r = client.post(
            "/api/test/reset-stockdate",
            params={"code": "005930", "date": "20260520"},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {
            "ok": True, "code": "005930", "date": "20260520",
            "removed": ["raw", "parquet"],
        }
        assert not raw.exists()
        assert not parquet.exists()
        assert client.get("/api/stock-dates").json() == []


def test_reset_stockdate_is_idempotent(
    enable_test_endpoints: None, tmp_path: Path
) -> None:
    """없는 Stock-Date 를 지워도 200 — 스펙은 직전 실행이 **어떻게 죽었든**
    무조건 부르므로, 부재가 실패면 그 자체가 새 flake 원인이 된다."""
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir=data_dir)
    client = TestClient(app)
    with client:
        r = client.post(
            "/api/test/reset-stockdate",
            params={"code": "005930", "date": "20260520"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["removed"] == []


def test_reset_stockdate_disabled_when_env_unset(tmp_path: Path) -> None:
    """게이트는 `add-stockdate` 와 같은 것을 공유한다 — 프로덕션엔 붙지 않는다."""
    app = create_app(data_dir=tmp_path / "data")
    client = TestClient(app)
    r = client.post(
        "/api/test/reset-stockdate", params={"code": "005930", "date": "20260520"}
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
