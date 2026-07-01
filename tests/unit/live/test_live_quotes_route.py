import datetime as dt
from datetime import datetime

import duckdb
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hoga.live import account_health, kis_runtime, lifecycle, api as live_api
from hoga.live.api import build_router, _quote_phase, _KST
from hoga.live.kis_client import KisQuote


@pytest.fixture(autouse=True)
def _hermetic_kis_env(monkeypatch):
    """Keep KIS route tests hermetic unless a test explicitly opts into accounts.

    Scheduler/account-pool construction reads configured accounts from ambient
    env, so developer creds or load_env side effects must not leak into tests.
    """
    for _k in ("KIS_APP_KEY", "KIS_APP_SECRET", "KIS_APP_KEY_2", "KIS_APP_SECRET_2"):
        monkeypatch.delenv(_k, raising=False)
    lifecycle.reset_for_tests()


class _FakeKis:
    def __init__(self, quotes):
        self._quotes = quotes
        self.venues: list[str] = []

    async def fetch_multi_price(self, codes, *, venue="KRX"):
        self.venues.append(venue)
        return self._quotes


def _app(quotes, tmp_path, kis=True):
    # C1b 2026-06-10: get_kis_client 주입 제거 → 프로세스 dict에 account 0로 주입하고
    # data_dir 배선(client 라우팅 활성화 신호). 배경 /quotes는 N=0(hermetic env)이라
    # account 0 폴백으로 이 fake를 집어든다. kis=False면 미주입 → creds 부재로 빈 결과.
    if kis:
        kis_runtime.set_kis_client(_FakeKis(quotes), 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        data_dir=tmp_path,
    ))
    return app


QUOTES = [KisQuote("005930", 72400, 1.2, 750), KisQuote("000660", 183500, -0.8, -1500)]


def test_quotes_open_returns_change_pct(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    c = TestClient(_app(QUOTES, tmp_path))
    r = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    body = r.json()
    assert body["phase"] == "open"
    assert body["quotes"][0] == {"code": "005930", "price": 72400, "change_pct": 1.2,
                                 "change_won": 750, "open": None, "high": None, "low": None,
                                 "baseline_price": None, "baseline_date": None,
                                 "change_pct_source": "kis", "warnings": []}
    assert body["quotes"][1]["change_pct"] == -0.8
    assert body["quotes"][1]["change_won"] == -1500


def test_quotes_open_serves_today_ohlc(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    quotes = [KisQuote("005930", 72400, 1.2, 750, open=72000, high=73000, low=71500)]
    c = TestClient(_app(quotes, tmp_path))
    r = c.get("/api/live/quotes", params={"codes": "005930"})
    q0 = r.json()["quotes"][0]
    assert (q0["open"], q0["high"], q0["low"]) == (72000, 73000, 71500)


def _seed_quote_adjusted_daily(tmp_path, rows):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True, exist_ok=True)
    daily = sdir / "daily_adjusted.parquet"
    with duckdb.connect(":memory:") as con:
        con.execute(
            "CREATE TABLE d(code VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)"
        )
        con.executemany(
            "INSERT INTO d VALUES (?,?,?,?,?,?,?)",
            [
                (code, dt.date.fromisoformat(date_s), open_, high, low, close, volume)
                for code, date_s, open_, high, low, close, volume in rows
            ],
        )
        con.execute(f"COPY d TO '{daily}' (FORMAT parquet)")
    return daily


def _previous_weekday(today: dt.date) -> dt.date:
    d = today - dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d


def _route_baseline_date() -> str:
    return _previous_weekday(datetime.now(_KST).date()).isoformat()


def test_quotes_recomputes_change_pct_when_kis_uses_unadjusted_baseline(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    baseline_date = _route_baseline_date()
    _seed_quote_adjusted_daily(
        tmp_path,
        [("049080", baseline_date, 9930, 9930, 9930, 9930, 100)],
    )
    quotes = [KisQuote("049080", 7770, 682.48, None)]
    c = TestClient(_app(quotes, tmp_path))

    r = c.get("/api/live/quotes", params={"codes": "049080"})

    assert r.status_code == 200
    q0 = r.json()["quotes"][0]
    assert q0["price"] == 7770
    assert q0["change_pct"] == -21.75
    assert q0["change_won"] == -2160
    assert q0["baseline_price"] == 9930
    assert q0["baseline_date"] == baseline_date
    assert q0["change_pct_source"] == "adjusted_daily"
    assert q0["warnings"] == []


def test_quotes_recomputes_small_stale_kis_change_pct(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    baseline_date = _route_baseline_date()
    _seed_quote_adjusted_daily(
        tmp_path,
        [("005930", baseline_date, 100, 100, 100, 100, 100)],
    )
    quotes = [KisQuote("005930", 105, 2.1, 2)]
    c = TestClient(_app(quotes, tmp_path))

    r = c.get("/api/live/quotes", params={"codes": "005930"})

    assert r.status_code == 200
    q0 = r.json()["quotes"][0]
    assert q0["price"] == 105
    assert q0["change_pct"] == 5.0
    assert q0["change_won"] == 5
    assert q0["baseline_price"] == 100
    assert q0["baseline_date"] == baseline_date
    assert q0["change_pct_source"] == "adjusted_daily"
    assert q0["warnings"] == []


def test_quotes_hides_change_pct_when_adjusted_baseline_scale_mismatches_quote(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    baseline_date = _route_baseline_date()
    _seed_quote_adjusted_daily(
        tmp_path,
        [("049080", baseline_date, 993, 993, 993, 993, 100)],
    )
    quotes = [KisQuote("049080", 6290, 533.43, 5297, open=7550, high=7660, low=6080)]
    c = TestClient(_app(quotes, tmp_path))

    r = c.get("/api/live/quotes", params={"codes": "049080"})

    assert r.status_code == 200
    q0 = r.json()["quotes"][0]
    assert q0["price"] == 6290
    assert q0["change_pct"] is None
    assert q0["change_won"] is None
    assert (q0["open"], q0["high"], q0["low"]) == (7550, 7660, 6080)
    assert q0["baseline_price"] == 993
    assert q0["baseline_date"] == baseline_date
    assert q0["change_pct_source"] == "unavailable"
    assert q0["warnings"] == ["adjusted_baseline_scale_mismatch"]


def test_quotes_hides_change_pct_when_adjusted_baseline_is_stale(monkeypatch, tmp_path):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2026, 6, 30, 10, 0, tzinfo=tz)

    monkeypatch.setattr(live_api, "datetime", _FixedDatetime)
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    _seed_quote_adjusted_daily(
        tmp_path,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    quotes = [KisQuote("005930", 105, 2.1, 2)]
    c = TestClient(_app(quotes, tmp_path))

    r = c.get("/api/live/quotes", params={"codes": "005930"})

    assert r.status_code == 200
    q0 = r.json()["quotes"][0]
    assert q0["price"] == 105
    assert q0["change_pct"] is None
    assert q0["change_won"] is None
    assert q0["baseline_price"] == 100
    assert q0["baseline_date"] == "2026-06-26"
    assert q0["change_pct_source"] == "unavailable"
    assert q0["warnings"] == ["adjusted_baseline_stale"]


def test_quotes_pre_open_nulls_change_pct(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "pre_open")
    c = TestClient(_app(QUOTES, tmp_path))
    r = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    body = r.json()
    assert body["phase"] == "pre_open"
    assert all(q["change_pct"] is None for q in body["quotes"])
    assert all(q["change_won"] is None for q in body["quotes"])
    assert body["quotes"][0]["price"] == 72400


def test_quotes_no_kis_graceful_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    c = TestClient(_app(QUOTES, tmp_path, kis=False))
    r = c.get("/api/live/quotes", params={"codes": "005930"})
    assert r.status_code == 200
    assert r.json()["quotes"] == []


def test_quotes_filters_invalid_codes(monkeypatch, tmp_path):
    seen = {}
    class _Rec(_FakeKis):
        async def fetch_multi_price(self, codes, *, venue="KRX"): seen["codes"] = codes; return []
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    kis_runtime.set_kis_client(_Rec([]), 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    TestClient(app).get("/api/live/quotes", params={"codes": "005930,BADCODE,00066"})
    assert seen["codes"] == ["005930"]


def test_quotes_lazy_inits_kis_when_singleton_absent(monkeypatch, tmp_path):
    # _kis_client singleton never seeded (empty watchlist + no-gap day) but the
    # route is wired with data_dir → it resolves a client from env on demand
    # instead of silently returning empty quotes (code-review #2).
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake = _FakeKis(QUOTES)
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda data_dir: fake)
    app = FastAPI()
    # 싱글톤 미주입(autouse hermetic 리셋이 dict를 비움) + data_dir 배선 -> capacity
    # gate가 env에서 지연 생성(C1b: get_kis_client 주입 없이도 동일 lazy-init 경로).
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        data_dir=tmp_path,
    ))
    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    assert [q["code"] for q in r.json()["quotes"]] == ["005930", "000660"]


def test_quotes_creds_absent_graceful_empty(monkeypatch, tmp_path):
    # C1b 안전 의도 이전: 구 'data_dir 없음 → 빈 결과' 경로는 사라졌으나(data_dir이
    # 이제 필수), 'creds 부재 → 빈 결과 + client 미생성' graceful 불변식은 이 실제
    # seam으로 옮긴다. ensure_kis_client_from_env를 monkeypatch하지 *않고* 실제로 돌려
    # hermetic env(creds delenv'd)에서 None을 반환하게 한다 — 동작이 깨지면 client 생성
    # (dict 비어있지 않음)·500·비빈 결과 중 하나로 실패하는 진짜 가드(green ≠ 검증).
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930"})
    assert r.status_code == 200
    assert r.json()["quotes"] == []
    assert kis_runtime.get_kis_client(0) is None  # 우발적 client 생성 없음


def test_quote_phase_boundary_at_0900_kst():
    # 장전(09:00 직전)=pre_open, 정각 09:00=open (반장도 오픈은 09:00 동일)
    assert _quote_phase(datetime(2026, 6, 1, 8, 59, tzinfo=_KST)) == "pre_open"
    assert _quote_phase(datetime(2026, 6, 1, 9, 0, tzinfo=_KST)) == "open"
    assert _quote_phase(datetime(2026, 6, 1, 15, 30, tzinfo=_KST)) == "open"


def test_quote_phase_clock_boundaries_closed():
    """스펙 2026-06-08 ⑧: 평일 08:50–16:00만 폴링 가치 구간. KRX 동시호가
    08:50 시작(사용자 정정 — 구 08:30 아님). 2026-06-08은 월요일."""
    mk = lambda h, m: datetime(2026, 6, 8, h, m, tzinfo=_KST)  # noqa: E731
    assert _quote_phase(mk(8, 49)) == "closed"
    assert _quote_phase(mk(8, 50)) == "pre_open"
    assert _quote_phase(mk(9, 0)) == "open"
    assert _quote_phase(mk(15, 59)) == "open"
    assert _quote_phase(mk(16, 0)) == "closed"
    # 토요일(2026-06-13) 장중 시각도 closed
    assert _quote_phase(datetime(2026, 6, 13, 10, 0, tzinfo=_KST)) == "closed"


def test_quote_phase_auto_treats_nxt_preopen_as_open():
    assert _quote_phase(datetime(2026, 7, 1, 8, 30, tzinfo=_KST), "AUTO") == "open"
    assert _quote_phase(datetime(2026, 7, 1, 8, 30, tzinfo=_KST), "NXT") == "open"
    assert _quote_phase(datetime(2026, 7, 1, 8, 30, tzinfo=_KST), "UN") == "open"
    assert _quote_phase(datetime(2026, 7, 1, 8, 30, tzinfo=_KST), "KRX") == "closed"


def test_quotes_route_threads_explicit_nxt_venue(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake = _FakeKis(QUOTES)
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "NXT"})

    assert r.status_code == 200
    assert fake.venues == ["NXT"]


def test_quotes_route_auto_uses_nxt_before_regular_session(monkeypatch, tmp_path):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2026, 7, 1, 8, 30, tzinfo=tz)

    monkeypatch.setattr(live_api, "datetime", _FixedDatetime)
    fake = _FakeKis(QUOTES)
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "AUTO"})

    assert r.status_code == 200
    assert r.json()["phase"] == "open"
    assert fake.venues == ["NXT"]


def test_quotes_route_auto_uses_nxt_after_regular_session(monkeypatch, tmp_path):
    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: ANN001
            return datetime(2026, 7, 1, 16, 30, tzinfo=tz)

    monkeypatch.setattr(live_api, "datetime", _FixedDatetime)
    fake = _FakeKis(QUOTES)
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "AUTO"})

    assert r.status_code == 200
    assert r.json()["phase"] == "open"
    assert fake.venues == ["NXT"]


def test_quotes_route_rejects_invalid_venue(tmp_path):
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "BAD"})

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"


class _CountingFakeKis:
    def __init__(self, quotes):
        self._quotes = quotes
        self.calls = 0

    async def fetch_multi_price(self, codes, *, venue="KRX"):
        self.calls += 1
        return self._quotes


def _counting_app(fake, tmp_path):
    # C1b: account 0에 fake 주입 + data_dir 배선. 배경 /quotes는 N=0(hermetic)이라
    # account 0 폴백으로 이 fake를 집어든다(호출 카운트가 그대로 유효).
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        data_dir=tmp_path,
    ))
    return app


def test_quotes_closed_serves_last_seen_without_kis(monkeypatch, tmp_path):
    """closed에는 장중 마지막 시세를 KIS 무호출로 서빙('마지막 시세 유지' 결정,
    스펙 2026-06-08 ⑧). 등락률은 open과 동일하게 표시(종가+등락 — pre_open과
    다름)."""
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake, tmp_path))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    r1 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r1.json()["quotes"][0]["price"] == 72400
    assert fake.calls == 1
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "closed")
    r2 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    body = r2.json()
    assert fake.calls == 1, "closed에서 캐시 보유 코드에 KIS 호출 발생"
    assert body["phase"] == "closed"
    assert body["quotes"][0]["price"] == 72400
    assert body["quotes"][0]["change_pct"] == 1.2   # closed는 등락률 유지
    assert body["quotes"][1]["change_won"] == -1500


def test_quotes_closed_cached_quotes_use_adjusted_change_pct_without_kis(monkeypatch, tmp_path):
    baseline_date = _route_baseline_date()
    _seed_quote_adjusted_daily(
        tmp_path,
        [("049080", baseline_date, 9930, 9930, 9930, 9930, 100)],
    )
    fake = _CountingFakeKis([KisQuote("049080", 7770, 682.48, None)])
    c = TestClient(_counting_app(fake, tmp_path))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    r1 = c.get("/api/live/quotes", params={"codes": "049080"})
    assert r1.status_code == 200
    assert fake.calls == 1
    assert r1.json()["quotes"][0]["change_pct"] == -21.75

    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "closed")
    r2 = c.get("/api/live/quotes", params={"codes": "049080"})

    assert r2.status_code == 200
    assert fake.calls == 1, "closed cached quote should not call KIS again"
    body = r2.json()
    assert body["phase"] == "closed"
    q0 = body["quotes"][0]
    assert q0["price"] == 7770
    assert q0["change_pct"] == -21.75
    assert q0["change_won"] == -2160
    assert q0["baseline_price"] == 9930
    assert q0["baseline_date"] == baseline_date
    assert q0["change_pct_source"] == "adjusted_daily"
    assert q0["warnings"] == []


def test_quotes_route_nxt_zero_price_stays_unavailable(monkeypatch, tmp_path):
    baseline_date = _route_baseline_date()
    _seed_quote_adjusted_daily(
        tmp_path,
        [("067310", baseline_date, 48650, 48650, 48650, 48650, 100)],
    )
    fake = _FakeKis([KisQuote("067310", 0, None, None)])
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "067310", "venue": "NXT"})

    assert r.status_code == 200
    q0 = r.json()["quotes"][0]
    assert q0["price"] == 0
    assert q0["change_pct"] is None
    assert q0["change_won"] is None
    assert q0["change_pct_source"] == "unavailable"
    assert q0["warnings"] == ["adjusted_baseline_unavailable"]
    assert fake.venues == ["NXT"]


def test_quotes_closed_cold_start_fetches_once(monkeypatch, tmp_path):
    """closed 콜드 스타트(서버 재시작 직후): 캐시 미스면 정확히 1회만 KIS를
    불러 채우고(KIS는 장외에도 종가 반환), 이후 요청은 캐시 서빙."""
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake, tmp_path))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "closed")
    r1 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert fake.calls == 1
    assert r1.json()["quotes"][0]["price"] == 72400
    r2 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert fake.calls == 1, "콜드 스타트 이후에도 KIS 재호출"
    assert r2.json()["quotes"][1]["price"] == 183500


def _two_account_quotes_app(tmp_path, monkeypatch, fake0, fake1):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake0, 0)
    kis_runtime.set_kis_client(fake1, 1)
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        data_dir=tmp_path,
    ))
    return app


def test_quotes_uses_shared_capacity_pool_first_healthy_account(monkeypatch, tmp_path):
    """N=2 정상: /quotes는 역할 고정이 아니라 공유 capacity pool의 least-loaded 후보를 쓴다."""
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    fake0, fake1 = _CountingFakeKis(QUOTES), _CountingFakeKis(QUOTES)
    app = _two_account_quotes_app(tmp_path, monkeypatch, fake0, fake1)
    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    assert fake0.calls == 1
    assert fake1.calls == 0


def test_quotes_skips_degraded_account(monkeypatch, tmp_path):
    """N=2이지만 account 1 REST 토큰 저하 -> /quotes scheduler pool에서 제외된다.

    REST pool health는 REST 토큰 latch(is_rest_degraded)만 본다(WS sub_failed는 직교).
    _two_account_quotes_app가 내부에서 reset_for_tests로 latch를 비우므로 app 구성 *후*에 마킹한다."""
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake0, fake1 = _CountingFakeKis(QUOTES), _CountingFakeKis(QUOTES)
    app = _two_account_quotes_app(tmp_path, monkeypatch, fake0, fake1)
    account_health.mark_rest_auth_degraded(1)
    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    assert fake0.calls == 1, "scheduler did not use remaining healthy account"
    assert fake1.calls == 0, "scheduler used degraded account 1"
