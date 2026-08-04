from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api, lifecycle
from hoga.live.api import build_router
from hoga.live.candle_fetch_result import IndexCandleFetchResult
from hoga.live.candle_models import IndexCandlePoint
from hoga.live.investor import InvestorNetPoint
from hoga.util.timeenc import KST


async def _fake_page_fetch(_client):
    """페이크가 러너에 넘기는 페이지 팩토리 — 거버너 경로만 지나게 한다(ADR-0137)."""
    from hoga.live.kiwoom_rest import Page

    return Page(rows=[], cont=False, next_key="")

def _daily_t_ms(day: str) -> int:
    dt = datetime(
        int(day[:4]),
        int(day[4:6]),
        int(day[6:8]),
        15,
        30,
        tzinfo=KST,
    )
    return int(dt.timestamp() * 1000)


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status))
    return TestClient(app)


def _patch_kiwoom_index(monkeypatch, fake_kis):
    """지수 분봉 소스를 **키움 fetcher** 로 심는다.

    PR-J(#1046)에서 KIS 갈래가 사라졌다(ADR-0129 가 이미 키움 이관했고 폴백만
    남아 있었다). 그래서 페이크도 KIS 클라이언트가 아니라 키움 fetcher 자리에
    꽂는다. 이 파일이 보는 것은 **라우트 동작**(캐시·경고·degrade)이지 벤더
    와이어가 아니므로, 기존 페이크의 반환값을 그대로 재사용한다.

    라우트는 `asyncio.to_thread(fetcher.fetch, ...)` 로 부르므로 **동기** 다.
    """
    calls: list = []

    class _Fetcher:
        def fetch(self, index_id, from_s, to_s, *, bucket_seconds=60):
            calls.append({"index_id": index_id, "from": from_s, "to": to_s,
                          "bucket_seconds": bucket_seconds})
            import asyncio as _a

            from hoga.live.index_registry import get_representative_index
            return _a.run(fake_kis.fetch_index_minute_candles(
                get_representative_index(index_id), from_s, to_s,
                bucket_seconds=bucket_seconds, foreground=True,
            ))

    monkeypatch.setattr(live_api, "_kiwoom_index_fetcher", _Fetcher())
    return object(), calls


# `_patch_kis_capacity` 헬퍼는 삭제했다 — KIS 캐퍼시티 seam 이 사라졌다(PR-J·#1046).
# 지수 분봉은 `_patch_kiwoom_index`, 실패 주입은 `_patch_capacity_raises` 를 쓴다.

def _patch_kiwoom_capacity(monkeypatch, fake_daily):
    """키움 시임 한 곳 + 어댑터 함수. PR-C(#1039) 칼 컷오버로 일/주/월봉이 키움을 쓴다."""
    scheduler = object()
    calls = []
    monkeypatch.setattr(
        live_api.kiwoom_rest_runtime, "ensure_rest_client",
        lambda data_dir, account_id=0: object(),
    )
    monkeypatch.setattr(live_api.kiwoom_rest_runtime, "ensure_scheduler", lambda *_a, **_k: scheduler)

    async def fake_run_with_capacity(scheduler_arg, *, key, api_id, priority, fetch_fn, client):
        calls.append({"key": key, "api_id": api_id, "priority": priority})
        return await fetch_fn(client)

    monkeypatch.setattr(live_api.kiwoom_access, "run_with_capacity", fake_run_with_capacity)
    monkeypatch.setattr(live_api.kiwoom_index_rest, "fetch_index_daily_candles", fake_daily)
    return scheduler, calls


def test_live_indices_route_lists_only_enabled_representative_indices() -> None:
    res = _client().get("/api/live/indices")

    assert res.status_code == 200
    body = res.json()
    assert [row["id"] for row in body["indices"]] == [
        "KOSPI",
        "KOSDAQ",
        "KOSPI200",
        "KOSDAQ150",
        "KRX100",
    ]
    assert body["indices"][0]["kind"] == "index"
    assert body["indices"][0]["investor_scope"] == "market"
    assert all(row["id"] != "KRX300" for row in body["indices"])


def test_index_candles_rejects_stock_code_as_index_id(tmp_path) -> None:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=005930&timeframe=D&from=20260601&to=20260619",
    )
    assert res.status_code == 422


def test_index_candles_returns_fake_kis_daily_rows(tmp_path, monkeypatch) -> None:
    async def fake_daily(_client, index, from_s, to_s, *, period="D", run_page=None):
        if run_page is not None:
            # 진짜 어댑터와 같은 계약: 페이지 I/O 는 러너를 지난다. 받기만 하고 안
            # 부르면 거버너 경로가 통째로 죽어 유량 검증이 조용히 무력해진다.
            await run_page(_fake_page_fetch, 0)
        assert index.id == "KOSPI"
        assert from_s == "20260601"
        assert to_s == "20260619"
        assert period == "D"
        return IndexCandleFetchResult(
            candles=[
                IndexCandlePoint(
                    t_ms=_daily_t_ms("20260619"),
                    open=2840.12,
                    high=2861.34,
                    low=2833.20,
                    close=2855.67,
                    volume=450000000,
                ),
            ],
        )

    scheduler, calls = _patch_kiwoom_capacity(monkeypatch, fake_daily)

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=D&from=20260601&to=20260619",
    )
    assert res.status_code == 200
    body = res.json()
    assert body["index_id"] == "KOSPI"
    assert body["candles"] == [
        {
            "t_ms": _daily_t_ms("20260619"),
            "open": 2840.12,
            "high": 2861.34,
            "low": 2833.2,
            "close": 2855.67,
            "volume": 450000000,
        },
    ]
    # 계정 차원(cooldown_scope·data_dir)은 키움 전환과 함께 사라졌다 — 유량이
    # TR별이라 계정을 고를 이유가 없다(#1015).
    assert calls == [{
        # 끝의 0 은 **페이지 인덱스** — 거버너 단위가 walk 전체가 아니라 페이지다.
        "key": ("index-daily", "KOSPI", "D", "20260601", "20260619", 0),
        "api_id": "ka20006",
        "priority": "user_visible",
    }]


def test_index_daily_candles_reuses_cached_newer_range_for_broader_scrollback(
    tmp_path,
    monkeypatch,
) -> None:
    calls: list[tuple[str, str]] = []

    async def fake_daily(_client, index, from_s, to_s, *, period="D", run_page=None):
        if run_page is not None:
            await run_page(_fake_page_fetch, 0)   # 계약 준수 — 위 테스트와 같은 이유
        calls.append((from_s, to_s))
        close = float(len(calls))
        return IndexCandleFetchResult(
            candles=[
                IndexCandlePoint(
                    t_ms=_daily_t_ms(from_s),
                    open=close, high=close, low=close, close=close, volume=1,
                ),
            ],
        )

    async def no_windowing(from_s, to_s, period, fetch_batch, *, max_concurrency=3):
        return await fetch_batch(from_s, to_s)

    _patch_kiwoom_capacity(monkeypatch, fake_daily)
    monkeypatch.setattr(live_api, "fetch_index_daily_candles_windowed", no_windowing, raising=False)
    monkeypatch.setattr(live_api, "index_candles_cache_instance", None, raising=False)

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    client = TestClient(app)
    r1 = client.get(
        "/api/live/index-candles?index_id=KOSDAQ&timeframe=D&from=20250101&to=20251231",
    )
    r2 = client.get(
        "/api/live/index-candles?index_id=KOSDAQ&timeframe=D&from=20240101&to=20251231",
    )

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert calls == [
        ("20250101", "20251231"),
        ("20240101", "20241231"),
    ]
    assert [c["close"] for c in r2.json()["candles"]] == [2.0, 1.0]


def test_index_candles_returns_fake_kis_minute_rows(tmp_path, monkeypatch) -> None:
    class FakeKis:
        async def fetch_index_minute_candles(self, index, from_s, to_s, *, bucket_seconds=60, foreground=False):
            assert index.id == "KOSPI"
            assert from_s == "20260619"
            assert to_s == "20260619"
            assert bucket_seconds == 60
            assert foreground is True
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=1781829000000,
                        open=2850.10,
                        high=2852.34,
                        low=2849.87,
                        close=2851.67,
                        volume=123456,
                    ),
                ],
            )

    scheduler, calls = _patch_kiwoom_index(monkeypatch, FakeKis())

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260619&to=20260619",
    )
    assert res.status_code == 200
    body = res.json()
    assert body["index_id"] == "KOSPI"
    assert body["timeframe"] == "1m"
    assert body["candles"] == [
        {
            "t_ms": 1781829000000,
            "open": 2850.10,
            "high": 2852.34,
            "low": 2849.87,
            "close": 2851.67,
            "volume": 123456,
        },
    ]
    # 계정 차원(scheduler·data_dir·endpoint·cooldown_scope)은 PR-J(#1046)에서
    # 사라졌다 — 키움 지수 fetcher 는 자체 페이싱을 쓴다(ADR-0129). 남은 계약은
    # "라우트가 요청 파라미터를 그대로 흘려보내는가" 다.
    assert calls == [{
        "index_id": "KOSPI", "from": "20260619", "to": "20260619",
        "bucket_seconds": 60,
    }]


def test_index_minute_candles_repeated_request_uses_cache(tmp_path, monkeypatch) -> None:
    calls = 0

    class FakeKis:
        async def fetch_index_minute_candles(self, index, from_s, to_s, *, bucket_seconds=60, foreground=False):
            nonlocal calls
            calls += 1
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=1782103980000,
                        open=1.0,
                        high=1.0,
                        low=1.0,
                        close=float(calls),
                        volume=1,
                    ),
                ],
                violations=[],
            )

    _patch_kiwoom_index(monkeypatch, FakeKis())
    monkeypatch.setattr(live_api, "index_minute_candles_cache_instance", None, raising=False)

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    client = TestClient(app)

    r1 = client.get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260622&to=20260622",
    )
    r2 = client.get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260622&to=20260622",
    )

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert calls == 1
    assert r2.json()["candles"][0]["close"] == 1.0


def test_index_minute_candles_warn_when_request_starts_before_returned_depth(tmp_path, monkeypatch) -> None:
    class FakeKis:
        async def fetch_index_minute_candles(self, index, from_s, to_s, *, bucket_seconds=60, foreground=False):
            assert from_s == "20260601"
            assert to_s == "20260622"
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=1782103980000,
                        open=1.0,
                        high=1.0,
                        low=1.0,
                        close=1.0,
                        volume=1,
                    ),
                ],
                violations=[],
            )

    _patch_kiwoom_index(monkeypatch, FakeKis())
    monkeypatch.setattr(live_api, "index_minute_candles_cache_instance", None, raising=False)

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260601&to=20260622",
    )

    assert res.status_code == 200
    assert any(
        w["reason"] == "index_minute_depth_limited"
        and w["date"] == "20260622"
        for w in res.json()["data_warnings"]
    )


def test_index_investor_net_returns_market_rows_for_kospi(tmp_path, monkeypatch) -> None:
    """PR-E(#1041) 칼 컷오버 — 소스가 키움 `ka10051` 이다.

    어댑터가 **평평한 리스트**를 준다(날짜당 한 콜이라 불변식 위반 개념이 없다).
    """
    # ka10051 은 하루치 TR 이다 — 날짜 반복은 거버너 위(호출자)가 소유한다(ADR-0137).
    async def fake_market_investor_net_day(_client, index, date_s):
        assert index.id == "KOSPI"
        assert date_s == "20260619"
        return InvestorNetPoint(t_ms=1, foreign_net=-3519, institution_net=17184)

    monkeypatch.setattr(
        live_api.kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object()
    )
    monkeypatch.setattr(
        live_api.kiwoom_investor, "fetch_market_investor_net_day",
        fake_market_investor_net_day,
    )

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-investor-net?index_id=KOSPI&from=20260619&to=20260619",
    )

    assert res.status_code == 200
    body = res.json()
    assert body["index_id"] == "KOSPI"
    assert body["points"] == [
        {"t_ms": 1, "foreign_net": -3519, "institution_net": 17184},
    ]


def test_index_investor_net_rejects_non_market_index(tmp_path) -> None:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-investor-net?index_id=KOSPI200&from=20260619&to=20260619",
    )

    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "unsupported_index_investor_net"


# ---------------------------------------------------------------------------
# KIS 스택 감사 Fix C: /index-candles가 KIS 용량 한계에 걸리면 HTTP 500이 아니라
# 200 + capacity data_warning으로 강등한다(quotes 핸들러와 동일 정책).
# ---------------------------------------------------------------------------


def _patch_capacity_raises(monkeypatch, exc: Exception) -> None:
    from hoga.live.index_candles_cache import IndexCandlesCache
    from hoga.live.index_minute_candles_cache import IndexMinuteCandlesCache

    # 모듈 전역 캐시는 다른 테스트가 채워둘 수 있다 — 캐시 히트가 나면 fetch(→capacity
    # 에러) 경로를 안 타므로 빈 캐시를 미리 심어 강등 경로를 강제한다. build_router는
    # 캐시가 None일 때만 생성하므로(is None), 미리 심은 non-None 인스턴스는 유지된다.
    monkeypatch.setattr(live_api, "index_candles_cache_instance", IndexCandlesCache(), raising=False)
    monkeypatch.setattr(
        live_api, "index_minute_candles_cache_instance", IndexMinuteCandlesCache(), raising=False
    )

    # 일/주/월봉은 PR-C 로 키움을 쓴다 — 같은 강등 경로를 키움 시임에도 건다.
    monkeypatch.setattr(
        live_api.kiwoom_rest_runtime, "ensure_rest_client",
        lambda data_dir, account_id=0: object(),
    )
    monkeypatch.setattr(live_api.kiwoom_rest_runtime, "ensure_scheduler", lambda *_a, **_k: object())

    async def raising_kiwoom(scheduler_arg, *, key, api_id, priority, fetch_fn, client):
        raise exc

    monkeypatch.setattr(live_api.kiwoom_access, "run_with_capacity", raising_kiwoom)


# `test_index_daily_candles_degrade_on_capacity_cooldown` 은 삭제했다.
# **계정별 쿨다운(`KisCapacityCooldown`)이라는 개념 자체가 사라졌다**(PR-J·#1046):
# 키움 유량은 TR별이라 "이 계정만 쉰다" 가 성립하지 않는다(#1015). 남은 강등 사유는
# 큐 과부하 하나이고, 바로 아래 `..._degrade_on_capacity_overloaded` 가 덮는다.


def test_index_minute_candles_degrade_on_fetch_failure(tmp_path, monkeypatch) -> None:
    """업스트림 실패는 **500 이 아니라 200 + 경고**로 강등된다.

    원래는 KIS 캐퍼시티 과부하를 재현했다. PR-J(#1046)에서 지수 분봉의 KIS 갈래가
    사라졌으므로(ADR-0129 가 이미 키움 이관) 같은 성질을 **키움 실패**로 확인한다.
    키움 실패는 KIS 로 떨어지지 않는다(ADR-0129 D3) — 값 경계 튐과 진단 어려움을
    피하려는 의도적 선택이고, 대신 원인을 경고로 드러낸다.
    """
    from hoga.live.kiwoom_index_candles import KiwoomIndexCandlesError

    class _Boom:
        def fetch(self, *_a, **_kw):
            raise KiwoomIndexCandlesError("upstream down")

    monkeypatch.setattr(live_api, "_kiwoom_index_fetcher", _Boom())
    # 프로세스 싱글턴 캐시가 앞선 테스트 값을 서빙한다 — 실패 경로를 보려면 비운다.
    monkeypatch.setattr(
        live_api, "index_minute_candles_cache_instance", None, raising=False,
    )

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260619&to=20260619",
    )

    assert res.status_code == 200, "500 이 아니라 강등"
    body = res.json()
    assert body["candles"] == []
    assert len(body["data_warnings"]) == 1
