"""GET /api/live/index-quotes — 하단 시장지표 바 라우트.

계약: 대표지수(enabled) 현재지수+전일대비를 서버 TTL 캐시로 코얼레스해 반환.
실패 지수는 last-good 유지, 자격증명/용량 부재 시 빈 배열(프론트가 바 숨김).
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api, lifecycle
from hoga.live.api import build_router
from hoga.live.kiwoom_errors import KiwoomApiError


def _snapshot(index_id: str, value: float = 2855.67, change: float = 12.3):
    """어댑터 반환 튜플 — (id, value, change, change_rate, t_ms)."""
    return (index_id, value, change, 0.43, 1_782_000_000_000)


def _patch_kiwoom_capacity(monkeypatch, fake_client):
    """키움 시임 **한 곳**을 몽키패치하면 전 호출자가 페이크가 된다(#1010 설계 요구사항).

    KIS 시절에는 `kis_access.run_with_capacity` 가 그 자리였다. PR-C(#1039) 칼
    컷오버로 이 표면이 키움을 쓰므로 시임도 따라 옮긴다.
    """
    scheduler = object()
    calls = []
    monkeypatch.setattr(
        live_api.kiwoom_rest_runtime, "ensure_rest_client", lambda data_dir, account_id=0: object()
    )
    monkeypatch.setattr(live_api.kiwoom_rest_runtime, "ensure_scheduler", lambda: scheduler)

    async def fake_run_with_capacity(scheduler_arg, *, key, api_id, priority, fetch_fn, client):
        calls.append({"key": key, "api_id": api_id, "priority": priority})
        return await fetch_fn(client)

    monkeypatch.setattr(live_api.kiwoom_access, "run_with_capacity", fake_run_with_capacity)
    # 어댑터 자체는 자기 테스트(test_kiwoom_index_rest)가 덮는다. 여기서는 라우트
    # 동작(레지스트리 순서·TTL 코얼레스·last-good 유지)만 본다.
    monkeypatch.setattr(
        live_api.kiwoom_index_rest, "fetch_index_price", fake_client.fetch_index_price
    )
    return scheduler, calls


def test_index_quotes_returns_enabled_indices_in_registry_order(tmp_path, monkeypatch) -> None:
    class FakeKis:
        async def fetch_index_price(self, _client, index):
            return _snapshot(index.id)

    _, calls = _patch_kiwoom_capacity(monkeypatch, FakeKis())

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get("/api/live/index-quotes")

    assert res.status_code == 200
    body = res.json()
    assert [q["id"] for q in body["quotes"]] == [
        "KOSPI", "KOSDAQ", "KOSPI200", "KOSDAQ150", "KRX100",
    ]
    kospi = body["quotes"][0]
    assert kospi == {
        "id": "KOSPI",
        "label": "KOSPI",
        "value": 2855.67,
        "change": 12.3,
        "change_rate": 0.43,
        "t_ms": 1_782_000_000_000,
    }
    # 배경 우선순위로 키움 거버너에 제출된다. `cooldown_scope` 는 계정 차원과 함께
    # 사라졌다 — 키움 유량은 TR별이라 계정을 고를 이유가 없다(#1015).
    assert all(c["api_id"] == "ka20001" for c in calls)
    assert all(c["priority"] == "background" for c in calls)
    assert {c["key"] for c in calls} == {
        ("index-price", "KOSPI"),
        ("index-price", "KOSDAQ"),
        ("index-price", "KOSPI200"),
        ("index-price", "KOSDAQ150"),
        ("index-price", "KRX100"),
    }


def test_index_quotes_second_request_within_ttl_reuses_cache(tmp_path, monkeypatch) -> None:
    fetches = 0

    class FakeKis:
        async def fetch_index_price(self, _client, index):
            nonlocal fetches
            fetches += 1
            return _snapshot(index.id)

    _patch_kiwoom_capacity(monkeypatch, FakeKis())

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    client = TestClient(app)

    r1 = client.get("/api/live/index-quotes")
    r2 = client.get("/api/live/index-quotes")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert fetches == 5  # TTL 내 재요청은 KIS 콜 0회
    assert r2.json() == r1.json()


def test_index_quotes_failed_index_keeps_last_good(tmp_path, monkeypatch) -> None:
    phase = {"fail_kosdaq": False}

    class FakeKis:
        async def fetch_index_price(self, _client, index):
            if phase["fail_kosdaq"] and index.id == "KOSDAQ":
                raise KiwoomApiError(code="EGW00201", msg="rate limited")
            value = 999.0 if phase["fail_kosdaq"] else 100.0
            return _snapshot(index.id, value=value)

    _patch_kiwoom_capacity(monkeypatch, FakeKis())

    # TTL 경계 통과를 위해 단조시계를 호출마다 크게 전진시킨다 (무한 증가 —
    # httpx 등 다른 소비자가 몇 번을 읽어도 고갈되지 않는다).
    tick = {"now": 0.0}

    def advancing_monotonic() -> float:
        tick["now"] += 1_000.0
        return tick["now"]

    monkeypatch.setattr(live_api.monotonic_time, "monotonic", advancing_monotonic)

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    client = TestClient(app)

    r1 = client.get("/api/live/index-quotes")
    assert {q["id"]: q["value"] for q in r1.json()["quotes"]}["KOSDAQ"] == 100.0

    phase["fail_kosdaq"] = True
    r2 = client.get("/api/live/index-quotes")
    values = {q["id"]: q["value"] for q in r2.json()["quotes"]}
    assert values["KOSPI"] == 999.0  # 갱신됨
    assert values["KOSDAQ"] == 100.0  # 실패 → last-good 유지


def test_index_quotes_without_data_dir_returns_empty() -> None:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status))
    res = TestClient(app).get("/api/live/index-quotes")

    assert res.status_code == 200
    assert res.json() == {"quotes": []}
