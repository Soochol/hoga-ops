"""GET /api/live/index-quotes — 하단 시장지표 바 라우트.

계약: 대표지수(enabled) 현재지수+전일대비를 서버 TTL 캐시로 코얼레스해 반환.
실패 지수는 last-good 유지, 자격증명/용량 부재 시 빈 배열(프론트가 바 숨김).
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api
from hoga.live import lifecycle
from hoga.live.api import build_router
from hoga.live.kis_client import IndexQuoteSnapshot
from hoga.live.kis_errors import KisApiError


def _snapshot(index_id: str, value: float = 2855.67, change: float = 12.3) -> IndexQuoteSnapshot:
    return IndexQuoteSnapshot(
        index_id=index_id,
        value=value,
        change=change,
        change_rate=0.43,
        t_ms=1_782_000_000_000,
    )


def _patch_kis_capacity(monkeypatch, fake_kis):
    scheduler = object()
    calls = []
    monkeypatch.setattr(live_api, "ensure_kis_capacity_scheduler", lambda data_dir: scheduler)
    monkeypatch.setattr(live_api.kis_access, "has_rest_capacity", lambda data_dir: True)

    async def fake_run_with_capacity(
        scheduler_arg,
        *,
        data_dir,
        key,
        endpoint,
        priority,
        fetch_fn,
        cooldown_scope=None,
    ):
        calls.append({
            "key": key,
            "endpoint": str(endpoint),
            "priority": priority,
            "cooldown_scope": cooldown_scope,
        })
        return await fetch_fn(fake_kis)

    monkeypatch.setattr(live_api.kis_access, "run_with_capacity", fake_run_with_capacity)
    return scheduler, calls


def test_index_quotes_returns_enabled_indices_in_registry_order(tmp_path, monkeypatch) -> None:
    class FakeKis:
        async def fetch_index_price(self, index, *, foreground=False):
            return _snapshot(index.id)

    _, calls = _patch_kis_capacity(monkeypatch, FakeKis())

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
    # 배경 우선순위 + 공용 쿨다운 스코프로 스케줄러에 제출된다.
    assert all(c["endpoint"] == "index-price" for c in calls)
    assert all(c["priority"] == "background" for c in calls)
    assert all(c["cooldown_scope"] == "index-price" for c in calls)
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
        async def fetch_index_price(self, index, *, foreground=False):
            nonlocal fetches
            fetches += 1
            return _snapshot(index.id)

    _patch_kis_capacity(monkeypatch, FakeKis())

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
        async def fetch_index_price(self, index, *, foreground=False):
            if phase["fail_kosdaq"] and index.id == "KOSDAQ":
                raise KisApiError(msg_cd="EGW00201", msg1="rate limited")
            value = 999.0 if phase["fail_kosdaq"] else 100.0
            return _snapshot(index.id, value=value)

    _patch_kis_capacity(monkeypatch, FakeKis())

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
