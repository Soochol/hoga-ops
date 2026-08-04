import datetime as dt
from datetime import datetime

import duckdb
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import account_health, api as live_api, kis_runtime, lifecycle
from hoga.live.api import _KST, _quote_phase, build_router
from hoga.live.buffer import LiveBuffer
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.quote_models import Quote
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


@pytest.fixture(autouse=True)
def _hermetic_kis_env(monkeypatch):
    """Keep KIS route tests hermetic unless a test explicitly opts into accounts.

    Scheduler/account-pool construction reads configured accounts from ambient
    env, so developer creds or load_env side effects must not leak into tests.
    """
    for _k in ("KIS_APP_KEY", "KIS_APP_SECRET", "KIS_APP_KEY_2", "KIS_APP_SECRET_2"):
        monkeypatch.delenv(_k, raising=False)
    lifecycle.reset_for_tests()


@pytest.fixture(autouse=True)
def _bridge_kis_seed_to_kiwoom(monkeypatch):
    """PR-D(#1040) 칼 컷오버 이후에도 **기존 테스트 의도를 그대로** 살리는 브리지.

    이 파일의 테스트들은 "KIS 클라이언트가 있다/없다" 를 `kis_runtime` 시드로
    표현한다. 라우트가 키움을 쓰게 됐으므로 그 시드를 **키움 클라이언트 자리로
    이어준다** — creds 부재 → None → 빈 결과 같은 불변식이 재작성 없이 보존된다.

    어댑터 모듈 함수는 전달된 클라이언트의 메서드로 위임한다(와이어 파싱은
    `test_kiwoom_multi_quote` 가 덮는다).
    """
    def _client(data_dir, account_id=0):
        seeded = live_api.kis_runtime.get_kis_client(0)
        if seeded is not None:
            return seeded
        return live_api.kis_runtime.ensure_kis_client_from_env(data_dir)

    async def _fetch_chunk(client, chunk, *, venue="KRX"):
        # **청크 레벨 이음매다.** `fetch_multi_price` 를 통째로 대체하면 청킹·러너
        # 주입 배선이 페이크에 가려져 유량 페이싱이 깨져도 초록이 된다(ADR-0137).
        return await client.fetch_multi_price(chunk, venue=venue)

    monkeypatch.setattr(live_api.kiwoom_rest_runtime, "ensure_rest_client", _client)
    monkeypatch.setattr(live_api.kiwoom_rest_runtime, "ensure_scheduler", lambda *_a, **_k: object())
    monkeypatch.setattr(live_api.kiwoom_multi_quote, "fetch_chunk", _fetch_chunk)

    async def _run(scheduler, *, key, api_id, priority, fetch_fn, client):
        return await fetch_fn(client)

    monkeypatch.setattr(live_api.kiwoom_access, "run_with_capacity", _run)


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


QUOTES = [Quote("005930", 72400, 1.2, 750), Quote("000660", 183500, -0.8, -1500)]


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
                                 "change_pct_source": "kis", "warnings": [],
                                 "stale": False, "stale_reason": None}
    assert body["quotes"][1]["change_pct"] == -0.8
    assert body["quotes"][1]["change_won"] == -1500


def test_tab_metrics_batches_quotes_and_latest_hoga(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    kis_runtime.set_kis_client(_FakeKis(QUOTES), 0)  # type: ignore[arg-type]
    buf = LiveBuffer()
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        get_buffer=lambda: buf,
        data_dir=tmp_path,
    ))

    async def seed_orderbooks() -> None:
        await buf.publish(
            "005930",
            [LiveSnapshot(
                t_ms=1_800_000_000_000,
                kind=SnapshotKind.OB,
                payload={"total_bid_qty": 132, "total_ask_qty": 100, "phase": "regular"},
            )],
            now_ms=1_800_000_000_000,
        )
        await buf.publish(
            "000660",
            [LiveSnapshot(
                t_ms=1_800_000_000_000,
                kind=SnapshotKind.OB,
                payload={"total_bid_qty": 90, "total_ask_qty": 100, "phase": "regular"},
            )],
            now_ms=1_800_000_000_000,
        )

    with TestClient(app) as c:
        assert c.portal is not None
        c.portal.call(seed_orderbooks)

        r = c.get("/api/live/tab-metrics", params={"codes": "005930,000660"})

    assert r.status_code == 200
    body = r.json()
    assert body["phase"] == "open"
    assert body["metrics"] == [
        {
            "code": "005930",
            "change_pct": 1.2,
            "hoga_ratio_x": 1.32,
            "hoga_available": True,
            "hoga_reason": None,
            "source": "live",
        },
        {
            "code": "000660",
            "change_pct": -0.8,
            "hoga_ratio_x": 1.1111111111111112,
            "hoga_available": True,
            "hoga_reason": None,
            "source": "live",
        },
    ]


def test_quotes_open_serves_today_ohlc(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    quotes = [Quote("005930", 72400, 1.2, 750, open=72000, high=73000, low=71500)]
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
    quotes = [Quote("049080", 7770, 682.48, None)]
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
    quotes = [Quote("005930", 105, 2.1, 2)]
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
    quotes = [Quote("049080", 6290, 533.43, 5297, open=7550, high=7660, low=6080)]
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
    quotes = [Quote("005930", 105, 2.1, 2)]
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


def test_quote_phase_extended_venues_treat_nxt_preopen_as_open():
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


def test_quotes_route_legacy_auto_maps_to_integrated(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake = _FakeKis(QUOTES)
    kis_runtime.set_kis_client(fake, 0)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))

    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930", "venue": "AUTO"})

    assert r.status_code == 200
    assert fake.venues == ["UN"]


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


def test_quotes_closed_refetches_over_intraday_sample_then_holds(monkeypatch, tmp_path):
    """closed 전환 시 장중 표본밖에 없으면 **다시 조회**하고, 종가 표본 확보 후엔 멈춘다.

    이 테스트는 원래 "장중 마지막 시세를 KIS 무호출로 서빙"을 계약으로 못 박고
    있었다 — '마지막 시세 유지'(스펙 2026-06-08 ⑧)의 과잉 해석이었다. 캐시를 채우는
    유일한 주체가 프론트 폴링이라(갱신 스케줄러 없음), 탭이 가려져 폴링이 끊기면 그
    순간 값이 종가 자리에 영구히 눌러앉았다. 실측 2026-08-01 — 관심종목의 삼성전자가
    07/31 오전 10시대 247,000 을 종가(262,500) 자리에 표시했고, 새로고침으로도 안
    풀려 백엔드 재시작만이 복구 경로였다.

    '마지막 시세 유지'는 여전히 유효하다. 다만 그 '마지막'이 **마감 후 표본**이어야
    한다(LiveQuoteFetcher.is_closing_sample). 등락률 표시 계약(종가+등락, pre_open 과
    다름)은 그대로다.
    """
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake, tmp_path))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    r1 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r1.json()["quotes"][0]["price"] == 72400
    assert fake.calls == 1
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "closed")
    r2 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    body = r2.json()
    assert fake.calls == 2, "장중 표본뿐이면 closed 는 종가를 다시 받아야 한다"
    assert body["phase"] == "closed"
    assert body["quotes"][0]["price"] == 72400
    assert body["quotes"][0]["change_pct"] == 1.2   # closed는 등락률 유지
    assert body["quotes"][1]["change_won"] == -1500
    assert body["quotes"][0]["stale"] is False      # 종가 표본이라 stale 아님

    # 종가 표본을 확보한 뒤에는 더 부르지 않는다 — 600s 하트비트 감속의 전제이자,
    # 이 수정이 closed 폴링을 매번 KIS 로 흘려보내지 않는다는 증거.
    c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert fake.calls == 2


def test_quotes_closed_cached_quotes_use_adjusted_change_pct_without_kis(monkeypatch, tmp_path):
    baseline_date = _route_baseline_date()
    _seed_quote_adjusted_daily(
        tmp_path,
        [("049080", baseline_date, 9930, 9930, 9930, 9930, 100)],
    )
    fake = _CountingFakeKis([Quote("049080", 7770, 682.48, None)])
    c = TestClient(_counting_app(fake, tmp_path))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    r1 = c.get("/api/live/quotes", params={"codes": "049080"})
    assert r1.status_code == 200
    assert fake.calls == 1
    assert r1.json()["quotes"][0]["change_pct"] == -21.75

    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "closed")
    r2 = c.get("/api/live/quotes", params={"codes": "049080"})

    assert r2.status_code == 200
    # open 표본은 종가가 아니라 closed 가 한 번 다시 받는다(같은 값이 돌아온다).
    # 이 테스트의 관심사는 그 다음 — 수정주가 baseline 이 closed 경로에서도 적용되는가.
    assert fake.calls == 2, "장중 표본뿐이면 closed 는 종가를 다시 받는다"
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
    fake = _FakeKis([Quote("067310", 0, None, None)])
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


def test_quotes_capacity_timeout_returns_stale_last_good(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake, tmp_path))

    r1 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r1.status_code == 200
    assert fake.calls == 1

    async def never_returns(*_args, **_kwargs):
        import asyncio

        await asyncio.sleep(10)

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", never_returns)

    r2 = c.get("/api/live/quotes", params={"codes": "005930,000660"})

    assert r2.status_code == 200
    body = r2.json()
    assert body["phase"] == "open"
    assert [q["code"] for q in body["quotes"]] == ["005930", "000660"]
    assert body["quotes"][0]["price"] == 72400
    assert body["quotes"][0]["change_pct"] == 1.2
    assert body["quotes"][0]["stale"] is True
    assert body["quotes"][0]["stale_reason"] == "capacity_timeout"


# `test_quotes_capacity_cooldown_returns_stale_last_good` 는 PR-D(#1040)에서
# 삭제했다 — 계정별 쿨다운은 KIS 계정 풀의 개념이고, 키움 유량은 TR별이라
# 고를 계정이 없다(#1015). 강등 경로가 타임아웃·과부하 둘로 줄었다.


def test_quotes_capacity_overloaded_returns_stale_last_good(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake, tmp_path))

    seed = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert seed.status_code == 200
    assert fake.calls == 1

    async def raise_overloaded(*_args, **_kwargs):
        raise KiwoomCapacityOverloaded("overloaded")

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", raise_overloaded)

    response = c.get("/api/live/quotes", params={"codes": "005930,000660"})

    assert response.status_code == 200
    body = response.json()
    assert [q["code"] for q in body["quotes"]] == ["005930", "000660"]
    assert body["quotes"][0]["stale"] is True
    assert body["quotes"][0]["stale_reason"] == "capacity_overloaded_upstream"
