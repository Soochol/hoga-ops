"""Stage 7-α / 7-β — /api/live router."""

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _hermetic_kis_env(monkeypatch):
    """Capacity-scheduled KIS routes derive configured accounts from ambient env.

    Developer-shell creds or another test's create_app→load_env can otherwise
    create real KIS clients. Keep the default at N=0 and let tests that need a
    multi-account pool opt in explicitly.
    """
    for _k in ("KIS_APP_KEY", "KIS_APP_SECRET", "KIS_APP_KEY_2", "KIS_APP_SECRET_2"):
        monkeypatch.delenv(_k, raising=False)


def _make_test_app(
    get_status_fn=None,
    control_fn=None,
    get_today_ask_peak=None,
    get_today_bid_peak=None,
    data_dir=None,
):
    """Mount the live router on a bare FastAPI for isolated testing."""
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    app = FastAPI()
    app.include_router(
        build_router(
            get_status=get_status_fn or lifecycle.get_status,
            get_buffer=lifecycle.get_buffer,
            on_control=control_fn,
            get_today_ask_peak=get_today_ask_peak,
            get_today_bid_peak=get_today_bid_peak,
            data_dir=data_dir,
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


def test_get_live_status_includes_kis_capacity_scheduler_snapshot(tmp_path) -> None:
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()

    app = _make_test_app(data_dir=tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        # 관측 표면의 **키는 프론트 계약이라 유지**하고 내용물만 키움 거버너로
        # 바뀐다(PR-J·#1046). 계정 성분(`configured_account_count` 등)은 사라졌다 —
        # 키움 유량은 TR별이라 셀 계정이 없다(#1015).
        scheduler = r.json()["rest_capacity_scheduler"]
        # `workers` 는 **살아 있는 워커 수**다 — 옛 KIS 스냅샷의 `max_workers`(설정값)와
        # 성격이 다르다. 첫 요청 전에는 0 이고, 그게 맞는 값이다.
        assert isinstance(scheduler["workers"], int)
        assert "queued" in scheduler
        assert "inflight" in scheduler
        assert "tr_buckets" in scheduler
        assert "configured_account_count" not in scheduler
        # 양보 기계(#1038 기계 ④)의 관측치 — 인터랙티브가 백필에 밀리지 않는지를
        # 운영에서 보는 유일한 신호다.
        assert "background_deferred_due_to_user_visible" in scheduler


def test_get_live_status_exposes_collector_ownership(tmp_path) -> None:
    """수집기 소유권이 **wire 까지** 나가는지 (ADR-0094 확장).

    `LiveStatus` 에 `collectors` 필드를 선언하지 않으면 FastAPI 가 `response_model`
    단계에서 **에러 없이 키를 버린다** — 라우트를 직접 부르는 테스트로는 못 잡는
    실패 유형이라 여기서 HTTP 응답을 본다.

    이 관측면이 필요한 이유: 락을 못 잡아 수집기를 안 띄운 인스턴스는 읽기 경로가
    멀쩡해서 화면상 정상과 구별되지 않는다.
    """
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()

    app = _make_test_app(data_dir=tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        body = r.json()
        assert "writers" in body, "response_model 이 writers 를 스트립했다"
        assert set(body["writers"]) == {"collectors", "ws", "daily"}
        # 스케줄러를 안 띄운 앱이므로 "미기동"(null) — false(뺏김)와 구별돼야 한다.
        assert body["writers"]["collectors"]["owned"] is None


def test_get_live_status_includes_cache_stats(tmp_path) -> None:
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()

    app = _make_test_app(data_dir=tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        cache_stats = r.json()["cache_stats"]
        # Closure-reachable caches surface their counters.
        assert set(cache_stats) >= {
            "past_candles",
            "minute_backfill",
            "past_daily_candles",
            "investor_net_daily",
            "today_ttl",
            "live_buffer",
        }
        # PastCandlesCache splits past vs today horizons.
        assert "hits" in cache_stats["past_candles"]["past"]
        assert "hits" in cache_stats["past_candles"]["today"]
        # The cold re-spend metric (PR-1 (a)).
        assert cache_stats["minute_backfill"]["fresh_past_fetches"] == 0
        # Ring buffer is size-only — no hit rate.
        live_buffer = cache_stats["live_buffer"]
        assert "total_entries" in live_buffer
        assert live_buffer["published_total"] == 0
        assert live_buffer["subscriber_drops"] == 0
        assert live_buffer["high_water_entries"] == 0
        assert "hit_rate" not in live_buffer


def test_post_live_control_dispatches_action() -> None:
    recorded: list[str] = []

    async def fake_control(action: str) -> None:
        recorded.append(action)

    app = _make_test_app(control_fn=fake_control)
    with TestClient(app) as c:
        r = c.post("/api/live/control", json={"action": "stop"})
        assert r.status_code == 200
        assert recorded == ["stop"]


async def _async_noop(action: str) -> None:
    pass


def test_post_live_control_rejects_unknown_action() -> None:
    app = _make_test_app(control_fn=_async_noop)
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


def test_status_exposes_supervised_task_health_through_lifespan(tmp_path, monkeypatch) -> None:
    """ADR-0088 end-to-end: the lifespan sets app.state.startup_runtime and the
    status route reads it, so GET /api/live/status carries supervised_tasks with
    watchlist-daily-loop reporting running=True (alive, not stale).

    ⚠ 그 루프는 2026-08-10 부터 **무조건 뜨지 않는다** — 자격이 있고 `daily` 락을
    잡았을 때만 뜬다(ADR-0094 확장). 여기서 재는 것은 health 배선이지 소유권이
    아니므로 자격을 준다.
    """
    from hoga.api import scheduler
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    monkeypatch.setattr(scheduler, "_kiwoom_credentialed", lambda *_a, **_k: True)
    lifecycle.reset_for_tests()
    app = create_app(tmp_path)
    with TestClient(app) as c:  # context manager runs the lifespan
        body = c.get("/api/live/status").json()
    tasks = {t["name"]: t["running"] for t in body["supervised_tasks"]}
    assert tasks.get("watchlist-daily-loop") is True


def test_get_live_snapshot_returns_404_when_no_data(tmp_path) -> None:
    """No publish yet → 404."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/snapshot?code=005930")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_live_snapshot_returns_buffered_latest(tmp_path) -> None:
    """After publish, GET /snapshot returns the latest entry."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    lifecycle.reset_for_tests()
    buf = lifecycle.get_buffer()
    await buf.publish(
        "005930",
        [
            LiveSnapshot(t_ms=12345, kind=SnapshotKind.OB, payload={"total_bid_qty": 1000}),
            LiveSnapshot(t_ms=12345, kind=SnapshotKind.TRADE, payload={"trades": [{"price": 100}]}),
            LiveSnapshot(t_ms=12345, kind=SnapshotKind.BROKER, payload={"buy_top": []}),
        ],
        now_ms=12345,
    )

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/snapshot?code=005930")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == "005930"
        assert body["t_ms"] == 12345
        assert body["orderbook"]["total_bid_qty"] == 1000
        assert body["recent_trades"] == [{"price": 100}]


@pytest.mark.asyncio
async def test_get_live_series_returns_buffered_arrays(tmp_path) -> None:
    from hoga.api.app import create_app
    from hoga.live import lifecycle
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    lifecycle.reset_for_tests()
    buf = lifecycle.get_buffer()
    for tick in range(3):
        t = (tick + 1) * 10_000
        await buf.publish(
            "005930",
            [
                LiveSnapshot(t_ms=t, kind=SnapshotKind.OB, payload={"total_bid_qty": 100 + tick}),
                LiveSnapshot(t_ms=t, kind=SnapshotKind.TRADE, payload={"trades": []}),
                LiveSnapshot(t_ms=t, kind=SnapshotKind.BROKER, payload={"buy_top": []}),
                LiveSnapshot(
                    t_ms=t,
                    kind=SnapshotKind.PROGRAM,
                    payload={"net_qty": 10 + tick, "net_amount": 1_000_000 + tick},
                ),
            ],
            now_ms=t,
        )

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/series?code=005930&date=20260527")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == "005930"
        assert body["date"] == "20260527"
        assert body["is_open"] is True  # session_close_ms None while live
        assert body["session_close_ms"] is None
        assert body["ask_peak_today"] is None
        assert body["bid_peak_today"] is None
        assert len(body["snapshots"]) == 3
        assert body["snapshots"][0]["total_bid_qty"] == 100
        assert len(body["programs"]) == 3
        assert body["programs"][-1]["net_qty"] == 12


def test_get_live_series_includes_today_ask_peak_from_getter() -> None:
    def fake_peak(code, venue):
        assert code == "005930"
        return {
            "date": "20260616",
            "coverage": "partial",
            "traded_prices": [25_000, 25_100],
            "traded_price": 25_100,
            "traded_qty": 3_000,
            "traded_t_ms": 1_780_000_000_000,
            "all_price": 25_200,
            "all_qty": 9_000,
            "all_t_ms": 1_780_000_005_000,
        }

    app = _make_test_app(get_today_ask_peak=fake_peak)
    with TestClient(app) as c:
        r = c.get("/api/live/series?code=005930&date=20260616")
        assert r.status_code == 200
        assert r.json()["ask_peak_today"] == {
            "date": "20260616",
            "coverage": "partial",
            "traded_prices": [25_000, 25_100],
            "traded_price": 25_100,
            "traded_qty": 3_000,
            "traded_t_ms": 1_780_000_000_000,
            "all_price": 25_200,
            "all_qty": 9_000,
            "all_t_ms": 1_780_000_005_000,
        }


def test_get_live_series_includes_today_bid_peak_from_getter() -> None:
    def fake_peak(code, venue):
        assert code == "005930"
        return {
            "date": "20260619",
            "coverage": "partial",
            "traded_prices": [70_000],
            "traded_price": 70_000,
            "traded_qty": 5_000,
            "traded_t_ms": 1_781_233_265_000,
            "all_price": 68_900,
            "all_qty": 12_000,
            "all_t_ms": 1_781_233_265_000,
        }

    app = _make_test_app(get_today_bid_peak=fake_peak)
    with TestClient(app) as c:
        r = c.get("/api/live/series?code=005930&date=20260619")
        assert r.status_code == 200
        assert r.json()["bid_peak_today"] == {
            "date": "20260619",
            "coverage": "partial",
            "traded_prices": [70_000],
            "traded_price": 70_000,
            "traded_qty": 5_000,
            "traded_t_ms": 1_781_233_265_000,
            "all_price": 68_900,
            "all_qty": 12_000,
            "all_t_ms": 1_781_233_265_000,
        }


# ----- /api/live/past-candles -----

import datetime

from hoga.live.candle_models import LiveCandle


def _kst_0900_ms(date_yyyymmdd: str) -> int:
    kst = datetime.timezone(datetime.timedelta(hours=9))
    y, m, d = (int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8]))
    return int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000)


def _today_kst_yyyymmdd() -> str:
    kst = datetime.timezone(datetime.timedelta(hours=9))
    return datetime.datetime.now(kst).strftime("%Y%m%d")


async def _fake_page_fetch(_client):
    """페이크 어댑터가 러너에 넘기는 페이지 팩토리.

    러너는 프로덕션 코드(`run_with_capacity`)라 반드시 실행되어야 하는데, 이 파일의
    페이크 클라이언트에는 `call` 이 없어 진짜 페이지 fetch 를 넣을 수 없다. 빈 페이지를
    돌려주는 팩토리로 **거버너 경로만** 실제로 지나게 한다(ADR-0137).
    """
    from hoga.live.kiwoom_rest import Page

    return Page(rows=[], cont=False, next_key="")


class _FakeKisForPast:
    """Stub KIS client returning deterministic minute bars per date."""

    def __init__(self):
        self.calls: list[str] = []  # records date arg per call

    async def fetch_past_minute_candles(
        self, code: str, date_yyyymmdd: str, **_kw
    ) -> list[LiveCandle]:
        self.calls.append(date_yyyymmdd)
        # KST 09:00 of the requested date — matches the real KIS shape so
        # PastCandlesCache's date-match guard (the "evict stale" check from
        # f63ed15 follow-up) treats this cache entry as valid on hit.
        kst = datetime.timezone(datetime.timedelta(hours=9))
        y, m, d = int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8])
        t_ms = int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000)
        return [LiveCandle(t_ms=t_ms, open=100, high=110, low=95, close=105, volume=10)]


def _past_app(tmp_path, fake_kis, monkeypatch):
    """Build a minimal FastAPI mounting only the /api/live router.

    Mirrors `_make_test_app` so we DO NOT trigger create_app's scheduler /
    capture pool / poller / KRX-network side effects. data_dir is `tmp_path`
    so the past-candles cache writes into the test sandbox.
    """
    from fastapi import FastAPI

    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake_kis)  # type: ignore[arg-type]
    _use_fake_kiwoom_client(monkeypatch, fake_kis)
    # 달력을 **"모름"** 으로 고정한다 — PR-H(#1044) 이전의 이 파일 환경과 같다.
    #
    # PR-H 이후 달력이 커밋된 시드에서 진짜 답을 내는데, 아래 테스트들이 쓰는
    # 날짜에 실제 휴장일이 섞여 있다(20260501 근로자의날 · 20260505 어린이날).
    # 이 파일이 보는 것은 백필 기계이지 달력이 아니므로, 달력 축을 중립으로 두어
    # 원래 검증하던 것(요청 구간의 모든 날짜를 어떻게 다루는가)을 보존한다.
    # 달력 자체의 계약은 `tests/api/test_trading_days_source.py` 가 덮는다.
    from hoga.api import calendar as _cal
    monkeypatch.setattr(_cal, "is_trading_day", lambda _d: None)
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    return app


def test_past_candles_rejects_missing_code(tmp_path, monkeypatch) -> None:
    app = _past_app(tmp_path, _FakeKisForPast(), monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?from=20260501&to=20260502")
        assert r.status_code == 422


def test_past_candles_rejects_invalid_code_format(tmp_path, monkeypatch) -> None:
    app = _past_app(tmp_path, _FakeKisForPast(), monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=abc&from=20260501&to=20260502")
        assert r.status_code == 422


def test_past_candles_rejects_from_after_to(tmp_path, monkeypatch) -> None:
    app = _past_app(tmp_path, _FakeKisForPast(), monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260510&to=20260501")
        assert r.status_code == 422


def test_past_candles_rejects_range_over_250_days(tmp_path, monkeypatch) -> None:
    app = _past_app(tmp_path, _FakeKisForPast(), monkeypatch)
    with TestClient(app) as c:
        # 251 days (inclusive): 2024-01-01 to 2024-09-08
        r = c.get("/api/live/past-candles?code=005930&from=20240101&to=20240908")
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "date_range_too_large"


def test_past_candles_rejects_to_in_future(tmp_path, monkeypatch) -> None:
    app = _past_app(tmp_path, _FakeKisForPast(), monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20990101")
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "date_in_future"


@pytest.mark.asyncio
async def test_past_candles_happy_path_single_date(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        # Use a past date (yesterday relative to KST)
        kst = datetime.timezone(datetime.timedelta(hours=9))
        yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["candles"] and body["candles"][0]["open"] == 100
        assert body["fresh_dates"] == [yesterday]
        assert body["cached_dates"] == []
        assert body["data_warnings"] == []
        # Past candles are stored in-memory only.
        assert not (tmp_path / "kis-past-candles").exists()


@pytest.mark.asyncio
async def test_past_candles_memory_cache_hit_on_second_call(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        kst = datetime.timezone(datetime.timedelta(hours=9))
        yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")
        c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert fake.calls == [yesterday]
        # Second call — KIS should not be hit again
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200
        assert fake.calls == [yesterday]  # unchanged
        assert r.json()["cached_dates"] == [yesterday]
        assert r.json()["fresh_dates"] == []


@pytest.mark.asyncio
async def test_past_candles_today_memory_cache(tmp_path, monkeypatch) -> None:
    from hoga.live import api as live_api

    monkeypatch.setattr(live_api, "_today_kst_date", lambda: datetime.date(2026, 6, 26))
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        today = "20260626"
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == [today]
        r = c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == [today]  # 60s TTL not yet expired
        assert r.json()["cached_dates"] == [today]
        # No disk file written for today
        assert not (tmp_path / "kis-past-candles" / "005930" / f"{today}.json").exists()


@pytest.mark.asyncio
async def test_past_candles_partial_failure_kis_api_error(tmp_path, monkeypatch) -> None:
    from hoga.live.kiwoom_errors import KiwoomApiError

    class _PartialFakeKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            if date_yyyymmdd == "20260502":
                raise KiwoomApiError("HTTP_500", "server error")
            return [LiveCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    app = _past_app(tmp_path, _PartialFakeKis(), monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260503")
        assert r.status_code == 200
        body = r.json()
        warnings = body["data_warnings"]
        # **실패 입도가 날짜에서 구간으로 바뀌었다**(PR-G·#1043). KIS 분봉은
        # 날짜당 1콜이라 한 날짜만 실패시킬 수 있었지만, 키움은 1콜이 구간을
        # 덮으므로 그 콜이 실패하면 구간 전체가 미확보다. 일부만 성공한 척
        # 내려보내면 프론트가 구멍 뚫린 축을 진실로 그린다.
        assert [w["date"] for w in warnings] == ["20260501", "20260502", "20260503"]
        assert {w["reason"] for w in warnings} == {"api_error"}
        assert body["candles"] == []


@pytest.mark.asyncio
async def test_past_candles_fetches_uncached_dates_concurrently(tmp_path, monkeypatch) -> None:
    """spec 2026-06-08 §4: 미캐시 과거 날짜는 동시 fetch — 순차 구현은
    max_inflight==1이라 실패한다. 완료 순서를 의도적으로 뒤섞어(늦은 날짜가
    빨리 응답) 응답 candles의 날짜 오름차순 보장(§5 테스트 4)도 함께 핀한다.
    단일 계정(KIS 키 미설정)이라 계정 비례 상한(ADR-0100)은 3이다."""
    import asyncio as _asyncio

    # 단일 계정 확정 — 개발자 env에 KIS 키가 유출돼도 상한이 3으로 결정론적.
    for _name in (
        "KIS_APP_KEY",
        "KIS_APP_SECRET",
        "KIS_APP_KEY_2",
        "KIS_APP_SECRET_2",
        "KIS_APP_KEY_3",
        "KIS_APP_SECRET_3",
    ):
        monkeypatch.delenv(_name, raising=False)

    class _SlowFakeKis:
        def __init__(self):
            self.inflight = 0
            self.max_inflight = 0
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            try:
                # 늦은 날짜일수록 빨리 응답 → 완료 순서 ≠ 날짜 순서
                await _asyncio.sleep(0.05 - 0.005 * int(date_yyyymmdd[-1]))
                kst = datetime.timezone(datetime.timedelta(hours=9))
                y, m, d = (int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8]))
                t_ms = int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000)
                return [LiveCandle(t_ms=t_ms, open=100, high=110, low=95, close=105, volume=10)]
            finally:
                self.inflight -= 1

    fake = _SlowFakeKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260508")
        assert r.status_code == 200
        body = r.json()
    # **날짜별 병렬 팬이 사라졌다**(PR-G·#1043). KIS 는 날짜당 1콜(120행)이라
    # 병렬이 최적이었지만, 키움은 1콜이 900행 ≈ 2.35 거래일이라 병렬 팬이
    # 같은 날짜를 중복 수신한다. 지금의 성질은 "구간을 **한 번의 walk** 로
    # 덮는다" 이고, 그게 콜 수를 절반 이하로 줄인다(#1012 실측 20일 10콜).
    assert fake.max_inflight == 1, "walk 는 순차다 — 중복 수신이 없어야 이득이 난다"
    t_list = [cd["t_ms"] for cd in body["candles"]]
    assert t_list == sorted(t_list), "응답 candles가 날짜 오름차순이 아님"
    assert body["fresh_dates"] == [f"2026050{i}" for i in range(1, 9)]


def test_past_candles_concurrency_scales_per_account(tmp_path, monkeypatch) -> None:
    """past-candles 동시 상한은 configured 계정 수 비례 (ADR-0100): 계정당 3슬롯,
    상한 12. REST 유량이 앱키별 독립이라 계정 수가 곧 예산 배수다."""
    from hoga.live import api as live_api

    def _fake_ids(n: int):
        return lambda _data_dir: list(range(n))

    monkeypatch.setattr(live_api.kis_runtime, "configured_account_ids", _fake_ids(1))
    assert live_api._past_candles_concurrency(tmp_path) == 3, "단일 계정 = 3 (회귀 가드)"
    monkeypatch.setattr(live_api.kis_runtime, "configured_account_ids", _fake_ids(3))
    assert live_api._past_candles_concurrency(tmp_path) == 9, "3계정 = 9 (예산 3배)"
    monkeypatch.setattr(live_api.kis_runtime, "configured_account_ids", _fake_ids(5))
    assert live_api._past_candles_concurrency(tmp_path) == 12, "5계정 = 12 (상한 clamp)"
    monkeypatch.setattr(live_api.kis_runtime, "configured_account_ids", _fake_ids(0))
    assert live_api._past_candles_concurrency(tmp_path) == 3, "계정 0 = 3 (하한, 크래시 방지)"


@pytest.mark.asyncio
async def test_past_candles_singleflight_dedups_concurrent_same_date(tmp_path, monkeypatch) -> None:
    """spec 2026-06-08 §4.3: 같은 (code, date)의 동시 요청 2건 → KIS 콜 1회
    공유(두 탭/60초 refetch 경합의 쿼터 절약). 두 응답 모두 동일 bars를 받고
    후발 요청도 fresh로 보고한다(캐시가 아니라 공유 fetch 결과이므로)."""
    import asyncio as _asyncio

    import httpx

    class _SlowFakeKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            await _asyncio.sleep(0.05)  # 두 요청의 fetch 창을 겹치게 한다
            return [LiveCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    fake = _SlowFakeKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    transport = httpx.ASGITransport(app=app)
    url = "/api/live/past-candles?code=005930&from=20260501&to=20260501"
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r1, r2 = await _asyncio.gather(ac.get(url), ac.get(url))
    assert r1.status_code == 200 and r2.status_code == 200
    assert fake.calls == ["20260501"], "싱글플라이트 미동작 — 같은 날짜 중복 KIS 콜"
    assert r1.json()["candles"] == r2.json()["candles"]
    assert r1.json()["fresh_dates"] == r2.json()["fresh_dates"] == ["20260501"]


@pytest.mark.asyncio
async def test_past_candles_rate_limit_blocks_unstarted_fetches(tmp_path, monkeypatch) -> None:
    """병렬화(spec 2026-06-08 §4.4) 이후의 kis_blocked 계약: 레이트리밋 소진 시
    '아직 시작 안 한' fetch는 KIS를 더 두드리지 않고(rate_limit_aborted),
    이미 나간(in-flight) fetch는 완주해 결과를 서빙한다.
    (구 순차 계약 test_past_candles_rate_limit_aborts_remaining의 병렬 번역 —
    "실패 이후 날짜 KIS 콜 0"은 in-flight 회수가 불가능한 병렬에선 성립하지
    않으므로 "미시작 콜 0"으로 대체. '레이트리밋된 원격을 더 때리지 않는다'는
    원 의도는 보존된다.)

    결정성: 8날짜·슬롯 3 → D1-D3 동시 진입, D2가 0.01s에 실패(Event set은
    semaphore 해제보다 먼저 실행됨) → D4-D8은 슬롯 획득 시점에 Event를 보고
    스킵. D1·D3는 0.1s sleep 중(in-flight)이라 완주."""
    import asyncio as _asyncio

    from hoga.live.kiwoom_errors import KiwoomRateLimitError

    class _RateLimitedSlowKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            if date_yyyymmdd == "20260502":
                await _asyncio.sleep(0.01)  # 첫 배치 중 가장 먼저 실패
                raise KiwoomRateLimitError("1700 유량 초과")
            await _asyncio.sleep(0.1)  # 나머지 첫 배치는 실패 시점에 in-flight
            return [LiveCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    fake = _RateLimitedSlowKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260508")
        assert r.status_code == 200
        body = r.json()
    # **"미시작 콜 0" 의 새 형태.** 원 방어의 의도는 "유량에 걸린 원격을 더
    # 두드리지 않는다" 였고, 그 의도는 그대로다 — 다만 walk 는 구간 1콜이라
    # "이미 나간 콜" 도 "미시작 콜" 도 하나뿐이다. 실패 시점 이후로 추가 왕복이
    # 없다는 것이 지금의 관측 가능한 형태다.
    assert fake.calls == ["20260501", "20260502"], (
        "실패한 날짜까지만 걷고 멈춘다 — 이후 날짜로 더 두드리지 않는다"
    )
    assert body["candles"] == []
    warns = {w["date"]: w["reason"] for w in body["data_warnings"]}
    assert set(warns.values()) == {"rate_limit_upstream"}
    assert warns["20260508"] == "rate_limit_upstream", "구간 전체가 같은 사유로 미확보다"


@pytest.mark.asyncio
async def test_past_candles_rate_limit_still_serves_later_cache_hits(tmp_path, monkeypatch) -> None:
    """When KIS rate-limits mid-range, dates AFTER the abort that are already
    in memory must still be served. Regression for the "candles all disappear
    when scrolling to past" bug: backend used to skip every subsequent date
    unconditionally, so cached dates were dropped from the response and the
    frontend's `kisCandles` shrank while `past.data.segments` (independent of
    KIS) kept full coverage — leaving the candle pane empty over a wide axis."""
    from hoga.live.kiwoom_errors import KiwoomRateLimitError

    class _RateLimitedFakeKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            if date_yyyymmdd == "20260502":
                raise KiwoomRateLimitError("1700 유량 초과")
            kst = datetime.timezone(datetime.timedelta(hours=9))
            y, m, d = (
                int(date_yyyymmdd[:4]),
                int(date_yyyymmdd[4:6]),
                int(date_yyyymmdd[6:8]),
            )
            t_ms = int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000)
            return [LiveCandle(t_ms=t_ms, open=100, high=110, low=95, close=105, volume=10)]

    fake = _RateLimitedFakeKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        c.get("/api/live/past-candles?code=005930&from=20260503&to=20260503")
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260503")
        assert r.status_code == 200
        body = r.json()
        # **회귀 가드의 본질은 그대로다**: 유량 차단이 나도 이미 메모리에 있는
        # 날짜는 서빙돼야 한다. 원 버그는 백엔드가 차단 이후 날짜를 무조건
        # 건너뛰어 캐시된 날짜까지 응답에서 빠졌고, 프론트의 `kisCandles` 만
        # 줄어들어 넓은 축 위에 빈 캔들 창이 남았다.
        #
        # 개수만 2 → 1 이 됐다: walk 는 구간 1콜이라 실패가 구간 전체를 덮으므로
        # 20260501 도 미확보다(PR-G·#1043). 서빙되는 하나가 **캐시된 20260503**
        # 이라는 것이 이 테스트가 지키는 성질이다.
        served = [cd["t_ms"] for cd in body["candles"]]
        assert len(served) == 1, f"got candles={body['candles']}"
        assert served == [_kst_0900_ms("20260503")], "캐시된 날짜가 살아남아야 한다"
        assert "20260503" in body["cached_dates"]
        # KIS must still NOT be called for the post-abort date (the existing
        # invariant — don't hammer the rate-limited remote). The fake raises
        # once on 20260502; client retry is opaque to it (covered by
        # test_kis_client.py tests).
        # walk 는 실패한 날짜까지만 걷는다. 20260503 은 이미 캐시라 walk 구간
        # 밖이고(1차 요청에서 받아 왔다), 2차 요청은 20260501~20260502 만 건다.
        assert fake.calls == ["20260503", "20260501", "20260502"]
        # The aborted-warning is now only emitted when there was no cache to
        # fall back on. 20260503 was cached, so it should NOT carry a warning.
        warn_dates = [w["date"] for w in body["data_warnings"]]
        assert "20260503" not in warn_dates
        assert any(
            w["reason"] == "rate_limit_upstream" and w["date"] == "20260502"
            for w in body["data_warnings"]
        )


@pytest.mark.asyncio
async def test_past_candles_rate_limit_cooldown_blocks_immediate_followup(tmp_path, monkeypatch) -> None:
    """After an exhausted EGW00201, an immediate follow-up request should not
    start another KIS candle fetch burst. The user gets a rate-limit warning
    quickly instead of waiting through another retry wall."""
    from hoga.live.kiwoom_errors import KiwoomRateLimitError

    class _RateLimitedFakeKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            raise KiwoomRateLimitError("1700 유량 초과")

    fake = _RateLimitedFakeKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r1 = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260501")
        r2 = c.get("/api/live/past-candles?code=005930&from=20260502&to=20260502")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert fake.calls == ["20260501"]
    assert r1.json()["data_warnings"][0]["reason"] == "rate_limit_upstream"
    assert r2.json()["data_warnings"][0]["reason"] == "rate_limit_aborted"


@pytest.mark.asyncio
async def test_past_candles_weekend_skips_kis_and_returns_empty(tmp_path, monkeypatch) -> None:
    """Past weekend dates are known-empty and must not spend KIS capacity."""
    from hoga.api import calendar as cal

    class _CountingKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            return [LiveCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    fake = _CountingKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    # **`_past_app` 뒤에 세운다** — 그 헬퍼가 달력을 중립("모름")으로 고정하므로
    # 먼저 세우면 덮인다. 이 테스트만은 달력이 답을 내는 것이 검증 대상이다.
    monkeypatch.setattr(cal, "is_trading_day", lambda d: d != "20260516")
    with TestClient(app) as c:
        r1 = c.get("/api/live/past-candles?code=005930&from=20260516&to=20260516")
        r2 = c.get("/api/live/past-candles?code=005930&from=20260516&to=20260516")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert fake.calls == []
    body = r1.json()
    assert body["candles"] == []
    assert body["cached_dates"] == ["20260516"]
    assert body["fresh_dates"] == []
    assert body["data_warnings"] == []


@pytest.mark.asyncio
async def test_past_candles_memory_cache_not_survives_router_rebuild(tmp_path, monkeypatch) -> None:
    """Past memory cache is per-router process state; rebuilding the router
    starts with a fresh cache."""
    kst = datetime.timezone(datetime.timedelta(hours=9))
    yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")

    fake1 = _FakeKisForPast()
    app1 = _past_app(tmp_path, fake1, monkeypatch)
    with TestClient(app1) as c:
        c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert fake1.calls == [yesterday]

    # Second router with a *fresh* cache instance (simulating restart) must fetch again.
    fake2 = _FakeKisForPast()
    app2 = _past_app(tmp_path, fake2, monkeypatch)
    with TestClient(app2) as c:
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200
        assert fake2.calls == [yesterday]
        assert r.json()["cached_dates"] == []
        assert r.json()["fresh_dates"] == [yesterday]


def test_minute_today_non_trading_day_negative_caches(tmp_path, monkeypatch) -> None:
    """When today's KIS minute fetch returns empty, the cache stores a
    negative sentinel so a follow-up request within the TTL skips KIS."""
    from hoga.live import api as live_api

    class _EmptyTodayKis:
        def __init__(self):
            self.calls = 0

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls += 1
            return []  # simulate weekday holiday today

    monkeypatch.setattr(live_api, "_today_kst_date", lambda: datetime.date(2026, 6, 26))
    fake = _EmptyTodayKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    today = "20260626"
    with TestClient(app) as c:
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == 1  # second call skipped via negative cache


def test_minute_today_weekend_skips_kis_and_negative_caches(tmp_path, monkeypatch) -> None:
    """On weekends, today's minute candles are known-empty before hitting KIS."""
    from hoga.live import api as live_api

    class _CountingKis:
        def __init__(self):
            self.calls = 0

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls += 1
            return [LiveCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    monkeypatch.setattr(live_api, "_today_kst_date", lambda: datetime.date(2026, 6, 27))
    fake = _CountingKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r1 = c.get("/api/live/past-candles?code=005930&from=20260627&to=20260627")
        r2 = c.get("/api/live/past-candles?code=005930&from=20260627&to=20260627")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert fake.calls == 0
    assert r1.json()["candles"] == []
    assert r1.json()["data_warnings"] == []


def test_past_candles_threads_explicit_venue_to_kis_and_response(tmp_path, monkeypatch) -> None:
    kst = datetime.timezone(datetime.timedelta(hours=9))
    t_ms = int(datetime.datetime(2026, 5, 18, 9, 0, tzinfo=kst).timestamp() * 1000)

    class _VenueFakeKis:
        def __init__(self):
            self.kwargs: list[dict] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            self.kwargs.append(kw)
            return [LiveCandle(t_ms=t_ms, open=100, high=110, low=95, close=105, volume=10)]

    fake = _VenueFakeKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=NXT")
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == "NXT"
    # bucket_ms 미지정 = 1분(하위호환). 스코프는 venue 와 나란히 백필까지 흐른다.
    assert fake.kwargs == [{"venue": "NXT", "tic_scope": "1"}]


def _bucket_scope_app(tmp_path, monkeypatch):
    """`tic_scope` 를 채록하는 past-candles 앱. bucket_ms 계약 3종이 공유한다."""
    kst = datetime.timezone(datetime.timedelta(hours=9))
    t_ms = int(datetime.datetime(2026, 5, 18, 9, 0, tzinfo=kst).timestamp() * 1000)

    class _ScopeFakeKis:
        def __init__(self):
            self.kwargs: list[dict] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            self.kwargs.append(kw)
            return [LiveCandle(t_ms=t_ms, open=100, high=110, low=95, close=105, volume=10)]

    fake = _ScopeFakeKis()
    return fake, _past_app(tmp_path, fake, monkeypatch)


def test_past_candles_bucket_ms_selects_vendor_tic_scope(tmp_path, monkeypatch) -> None:
    """표시 버킷이 벤더 주기로 내려간다 — 이 기능의 본체(#1008).

    10분을 요청하면 `ka10080` 을 `tic_scope=10` 으로 부른다. 1분으로 받아 접는
    현행 대비 콜당 커버리지가 10배다.
    """
    fake, app = _bucket_scope_app(tmp_path, monkeypatch)
    with TestClient(app) as c:
        r = c.get(
            "/api/live/past-candles"
            "?code=005930&from=20260518&to=20260518&venue=KRX&bucket_ms=600000"
        )
        assert r.status_code == 200
        assert r.json()["bucket_ms"] == 600000

    assert fake.kwargs == [{"venue": "KRX", "tic_scope": "10"}]


def test_past_candles_without_bucket_ms_stays_one_minute(tmp_path, monkeypatch) -> None:
    """파라미터 도입 전 소비자가 그대로 돈다 — 응답도 1분이라고 밝힌다."""
    fake, app = _bucket_scope_app(tmp_path, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=KRX")
        assert r.status_code == 200
        assert r.json()["bucket_ms"] == 60000

    assert fake.kwargs == [{"venue": "KRX", "tic_scope": "1"}]


def test_past_candles_rejects_unmapped_bucket_ms(tmp_path, monkeypatch) -> None:
    """미지원 버킷은 **눈에 띄게** 실패한다.

    조용히 1분으로 폴백하면 프론트 집계가 정확한 봉을 만들어 증상이 안 보이고 콜
    수만 배로 는다 — 이 기능이 없애려던 비용이 그대로 돌아온다. 그래서 422 다.
    """
    fake, app = _bucket_scope_app(tmp_path, monkeypatch)
    with TestClient(app) as c:
        r = c.get(
            "/api/live/past-candles"
            "?code=005930&from=20260518&to=20260518&venue=KRX&bucket_ms=420000"
        )
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "unsupported_bucket_ms"

    assert fake.kwargs == [], "벤더를 만지기 전에 거절한다"


def test_past_candles_rejects_invalid_venue_before_kis(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=BAD")

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"
    assert fake.calls == []


def test_past_candles_legacy_auto_maps_to_integrated(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=AUTO")
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == "UN"
    assert fake.calls == ["20260518"]


def test_past_candles_integrated_uses_single_kis_un_call(tmp_path, monkeypatch) -> None:
    kst = datetime.timezone(datetime.timedelta(hours=9))

    def ts(hh: int, mm: int) -> int:
        return int(datetime.datetime(2026, 5, 18, hh, mm, tzinfo=kst).timestamp() * 1000)

    class _IntegratedFakeKis:
        def __init__(self):
            self.venues: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            venue = kw["venue"]
            self.venues.append(venue)
            if venue == "UN":
                return [LiveCandle(t_ms=ts(9, 0), open=100, high=112, low=95, close=106, volume=25)]
            raise AssertionError(f"unexpected venue {venue}")

    fake = _IntegratedFakeKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=UN")
        assert r.status_code == 200
        body = r.json()

    assert fake.venues == ["UN"]
    assert body["venue"] == "UN"
    assert [
        datetime.datetime.fromtimestamp(c["t_ms"] / 1000, tz=kst).strftime("%H%M")
        for c in body["candles"]
    ] == [
        "0900",
    ]
    assert body["candles"][0]["volume"] == 25
    assert body["candles"][0]["open"] == 100
    assert body["candles"][0]["high"] == 112
    assert body["candles"][0]["low"] == 95
    assert body["candles"][0]["close"] == 106
    assert body["effective_sessions"] == [
        {
            "date": "20260518",
            "venue": "UN",
            "open_ms": ts(8, 0),
            "close_ms": ts(20, 0),
        }
    ]


@pytest.mark.parametrize("venue", ["NXT", "UN"])
def test_past_candles_non_krx_empty_falls_back_to_krx(tmp_path, venue: str, monkeypatch) -> None:
    kst = datetime.timezone(datetime.timedelta(hours=9))

    def ts(hh: int, mm: int) -> int:
        return int(datetime.datetime(2026, 5, 18, hh, mm, tzinfo=kst).timestamp() * 1000)

    class _NoNonKrxMinuteKis:
        def __init__(self):
            self.kwargs: list[dict] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            self.kwargs.append(kw)
            if kw["venue"] in ("NXT", "UN"):
                return []
            return [
                LiveCandle(
                    t_ms=ts(9, 0),
                    open=100,
                    high=110,
                    low=95,
                    close=105,
                    volume=10,
                )
            ]

    fake = _NoNonKrxMinuteKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get(f"/api/live/past-candles?code=005930&from=20260518&to=20260518&venue={venue}")
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == venue
    assert [candle["close"] for candle in body["candles"]] == [105]
    assert fake.kwargs == [
        {"venue": venue, "tic_scope": "1"},
        {"venue": "KRX", "tic_scope": "1"},
    ]
    assert any(
        w["reason"] == "minute_fallback_to_krx" and w["date"] == "20260518"
        for w in body["data_warnings"]
    )
    assert body["effective_sessions"] == [
        {
            "date": "20260518",
            "venue": "KRX",
            "open_ms": ts(9, 0),
            "close_ms": ts(15, 30),
        }
    ]


def test_past_candles_non_krx_partial_range_fills_empty_dates_from_krx(tmp_path, monkeypatch) -> None:
    kst = datetime.timezone(datetime.timedelta(hours=9))

    def ts(date_s: str, close: int) -> LiveCandle:
        y, m, d = int(date_s[:4]), int(date_s[4:6]), int(date_s[6:8])
        return LiveCandle(
            t_ms=int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000),
            open=close - 1,
            high=close + 1,
            low=close - 2,
            close=close,
            volume=10,
        )

    def at(date_s: str, hh: int, mm: int) -> int:
        y, m, d = int(date_s[:4]), int(date_s[4:6]), int(date_s[6:8])
        return int(datetime.datetime(y, m, d, hh, mm, tzinfo=kst).timestamp() * 1000)

    class _PartialNxtMinuteKis:
        def __init__(self):
            self.calls: list[tuple[str, str]] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            venue = kw["venue"]
            self.calls.append((venue, date_yyyymmdd))
            if venue == "NXT":
                if date_yyyymmdd == "20260520":
                    return [ts(date_yyyymmdd, 220)]
                return []
            return [ts(date_yyyymmdd, 105)]

    fake = _PartialNxtMinuteKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260520&venue=NXT")
        assert r.status_code == 200
        body = r.json()

    assert [candle["close"] for candle in body["candles"]] == [105, 105, 220]
    assert fake.calls == [
        ("NXT", "20260518"),
        ("NXT", "20260519"),
        ("NXT", "20260520"),
        ("KRX", "20260518"),
        ("KRX", "20260519"),
    ]
    assert any(
        w["reason"] == "minute_fallback_to_krx" and w["date"] == "20260518__20260519"
        for w in body["data_warnings"]
    )
    assert body["effective_sessions"] == [
        {
            "date": "20260518",
            "venue": "KRX",
            "open_ms": at("20260518", 9, 0),
            "close_ms": at("20260518", 15, 30),
        },
        {
            "date": "20260519",
            "venue": "KRX",
            "open_ms": at("20260519", 9, 0),
            "close_ms": at("20260519", 15, 30),
        },
        {
            "date": "20260520",
            "venue": "NXT",
            "open_ms": at("20260520", 8, 0),
            "close_ms": at("20260520", 20, 0),
        },
    ]


def test_past_candles_non_krx_fallback_rechecks_primary_on_next_request(tmp_path, monkeypatch) -> None:
    kst = datetime.timezone(datetime.timedelta(hours=9))

    def ts(close: int) -> LiveCandle:
        return LiveCandle(
            t_ms=int(datetime.datetime(2026, 5, 18, 9, 0, tzinfo=kst).timestamp() * 1000),
            open=close - 1,
            high=close + 1,
            low=close - 2,
            close=close,
            volume=10,
        )

    class _NxtSupportChangesKis:
        def __init__(self):
            self.calls: list[tuple[str, str]] = []
            self.nxt_calls = 0

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            venue = kw["venue"]
            self.calls.append((venue, date_yyyymmdd))
            if venue == "NXT":
                self.nxt_calls += 1
                if self.nxt_calls == 1:
                    return []
                return [ts(205)]
            return [ts(105)]

    fake = _NxtSupportChangesKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r1 = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=NXT")
        r2 = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=NXT")

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert [candle["close"] for candle in r1.json()["candles"]] == [105]
    assert [candle["close"] for candle in r2.json()["candles"]] == [205]
    assert fake.calls == [
        ("NXT", "20260518"),
        ("KRX", "20260518"),
        ("NXT", "20260518"),
    ]
    assert not any(w["reason"] == "minute_fallback_to_krx" for w in r2.json()["data_warnings"])


def test_past_candles_non_krx_fallback_warning_dates_only_used_krx(tmp_path, monkeypatch) -> None:
    kst = datetime.timezone(datetime.timedelta(hours=9))

    def ts(date_s: str, close: int) -> LiveCandle:
        y, m, d = int(date_s[:4]), int(date_s[4:6]), int(date_s[6:8])
        return LiveCandle(
            t_ms=int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000),
            open=close - 1,
            high=close + 1,
            low=close - 2,
            close=close,
            volume=10,
        )

    class _WeekendAndWeekdayGapKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            if kw["venue"] == "NXT":
                if date_yyyymmdd == "20260519":
                    return [ts(date_yyyymmdd, 219)]
                return []
            if date_yyyymmdd == "20260518":
                return [ts(date_yyyymmdd, 105)]
            return []

    app = _past_app(tmp_path, _WeekendAndWeekdayGapKis(), monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260516&to=20260519&venue=NXT")
        assert r.status_code == 200
        body = r.json()

    assert [candle["close"] for candle in body["candles"]] == [105, 219]
    assert any(
        w["reason"] == "minute_fallback_to_krx" and w["date"] == "20260518"
        for w in body["data_warnings"]
    )


def test_past_candles_non_krx_fallback_does_not_replace_present_dates(tmp_path, monkeypatch) -> None:
    kst = datetime.timezone(datetime.timedelta(hours=9))

    def ts(date_s: str, close: int) -> LiveCandle:
        y, m, d = int(date_s[:4]), int(date_s[4:6]), int(date_s[6:8])
        return LiveCandle(
            t_ms=int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000),
            open=close - 1,
            high=close + 1,
            low=close - 2,
            close=close,
            volume=10,
        )

    class _WeekendGapNxtMinuteKis:
        def __init__(self):
            self.calls: list[tuple[str, str]] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            venue = kw["venue"]
            self.calls.append((venue, date_yyyymmdd))
            if venue == "NXT":
                if "20260518" <= date_yyyymmdd <= "20260522":
                    return [ts(date_yyyymmdd, int(date_yyyymmdd[-2:]) + 200)]
                return []
            if date_yyyymmdd in {"20260516", "20260517", "20260523", "20260524"}:
                return []
            return [ts(date_yyyymmdd, int(date_yyyymmdd[-2:]) + 100)]

    fake = _WeekendGapNxtMinuteKis()
    app = _past_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260516&to=20260524&venue=NXT")
        assert r.status_code == 200
        body = r.json()

    assert [candle["close"] for candle in body["candles"]] == [218, 219, 220, 221, 222]
    assert ("KRX", "20260518") not in fake.calls
    assert not any(w["reason"] == "minute_fallback_to_krx" for w in body["data_warnings"])


# ----- /api/live/past-daily-candles validation -----

from fastapi import HTTPException

from hoga.live.api import _validate_past_request


def test_validate_daily_accepts_uncapped_range() -> None:
    today = _today_kst_yyyymmdd()
    # max_days=None disables the cap — used by the daily path (ADR-0048).
    frm, _too, _today_d = _validate_past_request("005930", "20060101", today, max_days=None)
    assert frm.strftime("%Y%m%d") == "20060101"


def test_validate_daily_rejects_invalid_code() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_past_request("abc", "20240101", "20240102")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_invalid_date() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_past_request("005930", "2024-01-01", "20240102")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_from_after_to() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_past_request("005930", "20240505", "20240101")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_future_to() -> None:
    today = _today_kst_yyyymmdd()
    from datetime import (
        datetime as _dt,
        timedelta as _td,
    )

    kst = datetime.timezone(datetime.timedelta(hours=9))
    tomorrow = (_dt.now(kst) + _td(days=1)).strftime("%Y%m%d")
    with pytest.raises(HTTPException) as exc:
        _validate_past_request("005930", today, tomorrow)
    assert exc.value.status_code == 422


# ----- _compute_daily_gaps -----

from datetime import date as _date

from hoga.live.api import _compute_daily_gaps


def test_gaps_empty_cache_returns_full_range() -> None:
    gaps = _compute_daily_gaps(_date(2020, 1, 1), _date(2025, 12, 31), existing=[])
    assert gaps == [(_date(2020, 1, 1), _date(2025, 12, 31))]


def test_gaps_full_coverage_returns_empty() -> None:
    existing = [(_date(2020, 1, 1), _date(2025, 12, 31))]
    gaps = _compute_daily_gaps(_date(2021, 1, 1), _date(2024, 12, 31), existing)
    assert gaps == []


def test_gaps_prefix_gap() -> None:
    existing = [(_date(2020, 1, 1), _date(2025, 12, 31))]
    gaps = _compute_daily_gaps(_date(2018, 1, 1), _date(2022, 12, 31), existing)
    assert gaps == [(_date(2018, 1, 1), _date(2019, 12, 31))]


def test_gaps_suffix_gap() -> None:
    existing = [(_date(2020, 1, 1), _date(2022, 12, 31))]
    gaps = _compute_daily_gaps(_date(2020, 1, 1), _date(2024, 12, 31), existing)
    assert gaps == [(_date(2023, 1, 1), _date(2024, 12, 31))]


def test_gaps_middle_gap_between_two_batches() -> None:
    existing = [
        (_date(2020, 1, 1), _date(2022, 12, 31)),
        (_date(2024, 1, 1), _date(2025, 12, 31)),
    ]
    gaps = _compute_daily_gaps(_date(2021, 1, 1), _date(2024, 6, 30), existing)
    assert gaps == [(_date(2023, 1, 1), _date(2023, 12, 31))]


def test_gaps_adjacent_batches_coalesce() -> None:
    existing = [
        (_date(2020, 1, 1), _date(2022, 12, 31)),
        (_date(2023, 1, 1), _date(2025, 12, 31)),
    ]
    gaps = _compute_daily_gaps(_date(2018, 1, 1), _date(2025, 12, 31), existing)
    assert gaps == [(_date(2018, 1, 1), _date(2019, 12, 31))]


# ----- /api/live/past-daily-candles -----

from hoga.live.candle_fetch_result import DailyCandleFetchResult, DailyInvariantViolation


def _venues(kwargs: list[dict]) -> list[str]:
    """venue 목록을 뽑으면서 **척도**(함정 ④)를 함께 못 박는다.

    일봉은 수정주가이고, 기준일은 배치마다가 아니라 **요청 전체에서 하나**여야
    한다 — 갭마다 그 갭의 끝을 기준일로 쓰면 배치 경계에서 척도가 갈린다.
    기준일의 정확한 값은 여기서 고정하지 않는다(요청 시각의 오늘이라 자정
    경계에서 깨진다). 값 고정은 `today_d` 를 주입할 수 있는
    `test_live_daily_candle_backfill.py` 가 한다.
    """
    assert {kw["adjust"] for kw in kwargs} == {True}, "/live 일봉은 수정주가다"
    assert len({kw["adjusted_as_of"] for kw in kwargs}) == 1, "기준일은 하나다"
    return [kw["venue"] for kw in kwargs]


class _FakeKisForDaily:
    """Stub KIS client returning deterministic daily bars."""

    def __init__(self):
        self.calls: list[tuple[str, str, str]] = []
        self.kwargs: list[dict] = []
        self.violations: list[DailyInvariantViolation] = []
        self.raise_rate_limit_on_call: int | None = None

    async def fetch_daily_candles(
        self, code: str, from_yyyymmdd: str, to_yyyymmdd: str, **_kw
    ) -> DailyCandleFetchResult:
        idx = len(self.calls)
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
        self.kwargs.append(_kw)
        if self.raise_rate_limit_on_call is not None and idx == self.raise_rate_limit_on_call:
            from hoga.live.kis_client import KisRateLimitError

            raise KisRateLimitError("simulated rate limit")
        from datetime import (
            datetime as _dt,
            timedelta as _td,
        )

        kst = datetime.timezone(datetime.timedelta(hours=9))
        y, m, d = int(from_yyyymmdd[:4]), int(from_yyyymmdd[4:6]), int(from_yyyymmdd[6:8])
        ye, me, de = int(to_yyyymmdd[:4]), int(to_yyyymmdd[4:6]), int(to_yyyymmdd[6:8])
        start = _dt(y, m, d, 9, 0, tzinfo=kst)
        end = _dt(ye, me, de, 9, 0, tzinfo=kst)
        candles = []
        cur = start
        while cur <= end:
            candles.append(
                LiveCandle(
                    t_ms=int(cur.timestamp() * 1000),
                    open=100,
                    high=110,
                    low=95,
                    close=105,
                    volume=10,
                )
            )
            cur = cur + _td(days=1)
        return DailyCandleFetchResult(candles=candles, violations=list(self.violations))


def _daily_app(tmp_path, fake_kis, monkeypatch):
    from fastapi import FastAPI

    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake_kis)
    _use_fake_kiwoom_client(monkeypatch, fake_kis)
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    return app


def test_past_daily_cache_miss_calls_kis(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        body = r.json()
        assert len(body["candles"]) == 5
        assert "20240101__20240105" in body["fresh_batches"]
        assert body["cached_batches"] == []
        assert len(fake.calls) == 1


def test_past_daily_threads_explicit_venue_to_kis_and_response(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105&venue=UN")
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == "UN"
    assert _venues(fake.kwargs) == ["UN"]   # `foreground` 는 키움에 없다


def test_past_daily_legacy_auto_maps_to_integrated(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105&venue=AUTO")
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == "UN"
    assert _venues(fake.kwargs) == ["UN"]   # `foreground` 는 키움에 없다


@pytest.mark.parametrize("venue,primary_venue", [("NXT", "NXT"), ("UN", "UN")])
def test_past_daily_non_krx_empty_falls_back_to_krx(
    tmp_path, monkeypatch, venue: str, primary_venue: str
) -> None:
    class _NoNxtDailyKis(_FakeKisForDaily):
        async def fetch_daily_candles(
            self, code: str, from_yyyymmdd: str, to_yyyymmdd: str, **_kw
        ) -> DailyCandleFetchResult:
            if _kw.get("venue") in ("NXT", "UN"):
                self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
                self.kwargs.append(_kw)
                return DailyCandleFetchResult(candles=[], violations=[])
            return await super().fetch_daily_candles(code, from_yyyymmdd, to_yyyymmdd, **_kw)

    fake = _NoNxtDailyKis()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get(
            f"/api/live/past-daily-candles?code=005930&from=20240101&to=20240105&venue={venue}"
        )
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == venue
    assert len(body["candles"]) == 5
    # `foreground` 는 키움에 없다 — 의도 신호는 거버너의 `priority` 다(#1015).
    assert _venues(fake.kwargs[:2]) == [primary_venue, "KRX"]
    assert any(
        w["reason"] == "daily_fallback_to_krx" and w["batch"] == "20240101__20240105"
        for w in body["data_warnings"]
    )


def test_past_daily_non_krx_partial_range_fills_missing_dates_from_krx(tmp_path, monkeypatch) -> None:
    class _PartialUnDailyKis(_FakeKisForDaily):
        async def fetch_daily_candles(
            self, code: str, from_yyyymmdd: str, to_yyyymmdd: str, **_kw
        ) -> DailyCandleFetchResult:
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            self.kwargs.append(_kw)
            if _kw.get("venue") == "UN":
                kst = datetime.timezone(datetime.timedelta(hours=9))
                candles = [
                    LiveCandle(
                        t_ms=int(
                            datetime.datetime(2024, 1, 1, 9, 0, tzinfo=kst).timestamp() * 1000
                        ),
                        open=200,
                        high=210,
                        low=195,
                        close=205,
                        volume=20,
                    ),
                    LiveCandle(
                        t_ms=int(
                            datetime.datetime(2024, 1, 2, 9, 0, tzinfo=kst).timestamp() * 1000
                        ),
                        open=201,
                        high=211,
                        low=196,
                        close=206,
                        volume=21,
                    ),
                ]
                return DailyCandleFetchResult(candles=candles, violations=[])
            return await super().fetch_daily_candles(code, from_yyyymmdd, to_yyyymmdd, **_kw)

    fake = _PartialUnDailyKis()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=089030&from=20240101&to=20240120&venue=UN")
        assert r.status_code == 200
        body = r.json()

    # `foreground` 는 키움에 없다 — 의도 신호는 거버너의 `priority` 다(#1015).
    assert _venues(fake.kwargs[:2]) == ["UN", "KRX"]
    assert len(body["candles"]) == 20
    assert body["candles"][0]["close"] == 205
    assert body["candles"][1]["close"] == 206
    assert body["candles"][2]["close"] == 105
    assert any(
        w["reason"] == "daily_fallback_to_krx" and "partial range" in w["msg"]
        for w in body["data_warnings"]
    )


def test_past_daily_rejects_invalid_venue_before_kis(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105&venue=BAD")

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"
    assert fake.calls == []


def test_past_daily_cache_hit_skips_kis(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        body = r2.json()
        assert "20240101__20240105" in body["cached_batches"]
        assert body["fresh_batches"] == []
        assert len(fake.calls) == 1


def test_past_daily_partial_hit_gap_fill(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        c.get("/api/live/past-daily-candles?code=005930&from=20240301&to=20240501")
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240501")
        body = r2.json()
        assert len(fake.calls) == 2
        _, gap_from, gap_to = fake.calls[1]
        assert gap_from == "20240101"
        assert gap_to == "20240229"
        ts = [c["t_ms"] for c in body["candles"]]
        assert ts == sorted(set(ts))


def test_past_daily_rate_limit_surfaces_data_warning(tmp_path, monkeypatch) -> None:
    """Daily endpoint inherits ADR-0049: a ``KisRateLimitError`` reaching the
    handler means the client has already exhausted retries. The gap loop then
    breaks and the user sees one ``kis_rate_limit`` warning rather than the
    (now-impossible) wall of retryable transients.
    """
    fake = _FakeKisForDaily()
    fake.raise_rate_limit_on_call = 1
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        c.get("/api/live/past-daily-candles?code=005930&from=20240301&to=20240501")
        # Snapshot the call count after the warm-up call so we can assert the
        # second request's gap loop bails out after the rate-limited call.
        warmup_calls = len(fake.calls)
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240501")
        body = r2.json()
        assert any(w["reason"] == "rate_limit_upstream" for w in body["data_warnings"])
        # Gap loop must break after the first EGW00201 — no further KIS
        # calls for later gap batches in the SAME request. (Client retries
        # are opaque to the fake; they don't show up as additional calls.)
        post_warmup_calls = len(fake.calls) - warmup_calls
        assert post_warmup_calls == 1, (
            f"expected gap loop to break after one rate-limited call; got "
            f"{post_warmup_calls} calls: {fake.calls[warmup_calls:]}"
        )


def test_past_daily_violation_surfaces_to_wire(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    fake.violations = [
        DailyInvariantViolation(
            date_yyyymmdd="20240103",
            reason="close_nonpositive",
            detail="close=0",
        )
    ]
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        body = r.json()
        warn = [w for w in body["data_warnings"] if w["reason"] == "invariant_violation"]
        assert len(warn) == 1
        assert "20240103" in warn[0]["msg"]
        assert warn[0]["date"] == "20240103"


def test_past_daily_dedupes_and_sorts_overlapping_batches(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        c.get("/api/live/past-daily-candles?code=005930&from=20240103&to=20240107")
        r3 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240107")
        body = r3.json()
        ts = [c["t_ms"] for c in body["candles"]]
        assert ts == sorted(set(ts))
        assert len(ts) == 7


def test_past_daily_validation_404_when_kis_not_wired(tmp_path) -> None:
    from fastapi import FastAPI

    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(None)
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r.status_code == 503


def test_past_daily_empty_gap_caches_and_does_not_refetch(tmp_path, monkeypatch) -> None:
    """KIS returning [] for a gap (range fully non-trading) must still cache
    the empty batch so a follow-up request inside that range hits the cache
    instead of re-calling KIS. Prevents infinite re-fetch on holiday ranges."""

    class _EmptyKis(_FakeKisForDaily):
        async def fetch_daily_candles(self, code, from_yyyymmdd, to_yyyymmdd, **_kw):
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            from hoga.live.candle_fetch_result import DailyCandleFetchResult

            return DailyCandleFetchResult(candles=[], violations=[])

    fake = _EmptyKis()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r1 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r1.status_code == 200
        assert len(fake.calls) == 1
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r2.status_code == 200
        body = r2.json()
        assert "20240101__20240105" in body["cached_batches"]
        assert body["fresh_batches"] == []
        assert len(fake.calls) == 1


def test_past_daily_single_day_past_request(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240101")
        assert r.status_code == 200
        body = r.json()
        assert len(body["candles"]) == 1
        assert len(fake.calls) == 1
        _, gap_from, gap_to = fake.calls[0]
        assert gap_from == "20240101" and gap_to == "20240101"


def test_past_daily_today_only_request_skips_gap_branch(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    today = _today_kst_yyyymmdd()
    with TestClient(app) as c:
        r = c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        assert r.status_code == 200
        assert len(fake.calls) == 1
        _, call_from, call_to = fake.calls[0]
        assert call_from == today and call_to == today


def test_past_daily_today_negative_cache_skips_kis_within_ttl(tmp_path, monkeypatch) -> None:
    class _EmptyTodayKis(_FakeKisForDaily):
        async def fetch_daily_candles(self, code, from_yyyymmdd, to_yyyymmdd, **_kw):
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            from hoga.live.candle_fetch_result import DailyCandleFetchResult

            return DailyCandleFetchResult(candles=[], violations=[])

    fake = _EmptyTodayKis()
    app = _daily_app(tmp_path, fake, monkeypatch)
    today = _today_kst_yyyymmdd()
    with TestClient(app) as c:
        c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        assert len(fake.calls) == 1


def test_screener_daily_candles_reads_adjusted_parquet_without_kis(tmp_path, monkeypatch) -> None:
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["005930", "005930", "000660"],
            "date": [
                datetime.date(2024, 1, 2),
                datetime.date(2024, 1, 3),
                datetime.date(2024, 1, 2),
            ],
            "open": [70000.0, 70100.0, 100000.0],
            "high": [71000.0, 71100.0, 101000.0],
            "low": [69000.0, 69100.0, 99000.0],
            "close": [70500.0, 70600.0, 100500.0],
            "volume": [1000, 1100, 2000],
        }
    ).write_parquet(sdir / "daily_adjusted.parquet")

    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/screener-daily-candles?code=005930&from=20240101&to=20240104")

    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "screener_daily"
    assert body["code"] == "005930"
    assert [row["close"] for row in body["candles"]] == [70500.0, 70600.0]
    assert body["candles"][0]["t_ms"] == int(
        datetime.datetime(
            2024, 1, 2, 9, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=9))
        ).timestamp()
        * 1000
    )
    assert fake.calls == []


def test_screener_daily_candles_runs_off_the_event_loop(tmp_path, monkeypatch) -> None:
    """동기 parquet 스캔이 루프 스레드에서 돌면 그 동안 프로세스 전체가 멈춘다.

    전체 유니버스 × 전체 이력을 스캔하는 함수라, 루프에서 직접 부르면 그 시간 동안
    모든 요청·WS 프레임 송출·KIS 스케줄러가 정지한다.

    벽시계를 재지 않고 **실행 스레드에 running loop 가 없다**로 표현한다. 루프에서
    실행됐다면 ``get_running_loop()`` 이 성공하므로 거짓 통과가 불가능하다.
    """
    import asyncio

    from hoga.live import api as live_api

    observed: dict[str, bool] = {}

    def _record_thread(*_args, **_kwargs) -> dict:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            observed["on_loop_thread"] = False
        else:
            observed["on_loop_thread"] = True
        return {
            "code": "005930", "from": "20240101", "to": "20240104",
            "source": "screener_daily", "candles": [], "data_warnings": [],
        }

    monkeypatch.setattr(live_api, "read_screener_daily_candles", _record_thread)
    app = _daily_app(tmp_path, _FakeKisForDaily(), monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/screener-daily-candles?code=005930&from=20240101&to=20240104")

    assert r.status_code == 200
    assert observed["on_loop_thread"] is False, (
        "동기 parquet 스캔이 이벤트 루프를 차단한다 — asyncio.to_thread 로 감싸야 한다"
    )


# ----- /api/live/past-investor-net -----

from hoga.live.investor import (
    InvestorNetFetchResult,
    InvestorNetInvariantViolation,
    InvestorNetPoint,
    InvestorTrendEstimateRow,
)

# 투자자 3표면의 페이크 클라이언트를 라우트에 흘려보내는 홀더.
# `_investor_app`/`_investor_estimate_app` 이 채우고, 아래 seam 이 읽는다.
# dict 인 이유는 `global` 없이 갱신하기 위해서다(PLW0603).
_fake_kiwoom_client: dict[str, object | None] = {"client": None}


@pytest.fixture(autouse=True)
def _kiwoom_investor_seam(monkeypatch):
    """PR-E(#1041) 이후 어댑터는 **모듈 레벨 함수**다 — 그 한 점을 위임으로 돌린다.

    KIS 시절 소비자는 클라이언트 객체의 메서드를 불렀다. 키움 배선은 런타임에서
    클라이언트를 받아 `kiwoom_investor.fetch_*(client, ...)` 를 부른다. 이 아래
    테스트들이 검증하는 건 어댑터가 아니라 **페처의 캐시·누적·코얼레스 로직**이라,
    어댑터 자리에 "클라이언트 객체로 되돌려 보내는" 위임을 꽂으면 의도가 그대로
    보존된다. 어댑터 자체는 `test_kiwoom_investor.py` 가 덮는다.
    """
    from hoga.live import api as live_api

    _fake_kiwoom_client["client"] = None

    async def _net(client, code, from_yyyymmdd, to_yyyymmdd, *, run_page=None):
        if run_page is not None:
            await run_page(_fake_page_fetch, 0)
        return await client.fetch_investor_net(code, from_yyyymmdd, to_yyyymmdd)

    async def _market_day(client, index, date_yyyymmdd):
        # ka10051 은 하루치 TR 이다(ADR-0137) — 페이크 클라이언트는 아직 구간 API 라
        # 여기서 하루로 좁혀 준다. 날짜 반복은 거버너 위(호출자)가 소유한다.
        points = await client.fetch_market_investor_net(
            index, date_yyyymmdd, date_yyyymmdd)
        return points[0] if points else None

    async def _estimate(client, code, *, run_call=None):
        # ka10064 는 수량·금액이 별개의 콜이다 — 이음매를 축마다 태워야 거버너가
        # 세는 수와 벤더가 세는 수가 같아진다(ADR-0137). 페이크가 한 번만 태우면
        # 실코드가 두 콜을 한 대기표로 내보내도 테스트가 통과한다.
        if run_call is not None:
            for axis in ("2", "1"):
                await run_call(_fake_page_fetch, axis)
        return await client.fetch_investor_trend_estimate(code)

    async def _daily(client, code, from_yyyymmdd, to_yyyymmdd, *, run_page=None, **kw):
        if run_page is not None:
            await run_page(_fake_page_fetch, 0)
        return await client.fetch_daily_candles(code, from_yyyymmdd, to_yyyymmdd, **kw)

    for name, fn in (
        ("fetch_investor_net", _net),
        ("fetch_market_investor_net_day", _market_day),
        ("fetch_investor_trend_estimate", _estimate),
    ):
        monkeypatch.setattr(live_api.kiwoom_investor, name, fn)
    # 일봉·분봉은 `live_*_backfill` 이 부른다 — `live_api` 를 거치지 않는다.
    from hoga.live import kiwoom_adjust_factors, kiwoom_daily_candles, kiwoom_minute_candles

    monkeypatch.setattr(kiwoom_daily_candles, "fetch_daily_candles", _daily)

    async def _walk(client, code, *, newest_yyyymmdd, oldest_yyyymmdd,
                    fetch_page=None, **_kw):
        """walk-back 을 **날짜별 호출로 되돌리는** 위임.

        PR-G(#1043)에서 소비자가 날짜별 팬 → 구간 walk 로 바뀌었지만, 아래
        테스트들이 검증하는 것은 **라우트·캐시·venue 폴백·경고 정책**이지 키움
        와이어가 아니다. 커서 규칙 자체는 `test_kiwoom_minute_candles.py` 가
        실측 페이지 모양으로 덮는다. 그래서 이 자리에서 구간을 날짜로 풀어
        기존 페이크(날짜당 1콜)의 의도를 그대로 보존한다.

        **날짜 루프는 반드시 `fetch_page` 를 통과해야 한다.** 거버너 단위가 walk
        구간이 아니라 **페이지(커서)** 로 내려갔기 때문이다 — 루프를 러너 밖에서
        돌리면 중복제거·유량 페이싱이 이 페이크에서만 사라져, 싱글플라이트 계약이
        제품과 무관하게 깨진 것처럼 보인다.
        """
        import datetime as _dt

        bars = {}
        cur = _dt.datetime.strptime(oldest_yyyymmdd, "%Y%m%d").date()
        end = _dt.datetime.strptime(newest_yyyymmdd, "%Y%m%d").date()
        while cur <= end:
            date_s = cur.strftime("%Y%m%d")
            if fetch_page is not None:
                got = (await fetch_page(date_s)).complete.get(date_s) or []
            else:
                got = await client.fetch_past_minute_candles(code, date_s, **_kw)
            if got:
                bars[date_s] = got
            cur += _dt.timedelta(days=1)
        return kiwoom_minute_candles.MinuteWalkResult(
            bars_by_date=bars, pages=1, exhausted=False, wedged=False,
        )

    async def _day(client, code, date_yyyymmdd, **kw):
        return await client.fetch_past_minute_candles(code, date_yyyymmdd, **kw)

    async def _page(client, code, cursor, **kw):
        """커서 1개 = 날짜 1개로 읽어 기존 페이크(날짜당 1콜)에 그대로 잇는다.

        이 자리가 거버너를 지나는 유일한 지점이므로, 여기로 모아야 날짜별
        중복제거(싱글플라이트)가 제품과 같은 방식으로 재현된다.
        """
        got = await client.fetch_past_minute_candles(code, cursor, **kw)
        return kiwoom_minute_candles.MinutePage(
            complete={cursor: got} if got else {}, oldest="",
        )

    async def _factors(_client, _code, *, as_of_yyyymmdd, **_kw):
        """수정계수는 항등(#1229) — 이 파일이 보는 것은 라우트·캐시·폴백이다.

        `19900101` 하한은 "분봉이 닿을 수 있는 모든 날짜를 덮는다" 를 뜻한다.
        계수 자체의 계약(계단 조회·이벤트 횡단)은
        `test_kiwoom_adjust_factors.py` 와 `test_live_candle_backfill.py` 가 본다.
        """
        return kiwoom_adjust_factors.AdjustFactors(
            as_of=as_of_yyyymmdd, dates=("19900101",), values=(1.0,),
        )

    monkeypatch.setattr(kiwoom_minute_candles, "walk_minute_days", _walk)
    monkeypatch.setattr(kiwoom_minute_candles, "fetch_day", _day)
    monkeypatch.setattr(kiwoom_minute_candles, "fetch_minute_page", _page)
    monkeypatch.setattr(kiwoom_adjust_factors, "fetch_adjust_factors", _factors)
    yield
    _fake_kiwoom_client["client"] = None


def _use_fake_kiwoom_client(monkeypatch, fake) -> None:
    """라우트가 조달하는 클라이언트를 페이크로 바꾼다.

    `None` 을 넣으면 무자격 경로(ADR-0134)를 재현한다 — 라우트가 503 을 내는
    유일한 조건이다.
    """
    from hoga.live import api as live_api

    _fake_kiwoom_client["client"] = fake
    monkeypatch.setattr(
        live_api.kiwoom_rest_runtime,
        "ensure_rest_client",
        lambda *_a, **_k: _fake_kiwoom_client["client"],
    )


class _FakeKisForInvestor:
    """Stub KIS client returning deterministic investor points across [from, to]."""

    def __init__(self):
        self.calls: list[tuple[str, str, str]] = []
        self.violations: list[InvestorNetInvariantViolation] = []
        self.raise_rate_limit_on_call: int | None = None

    async def fetch_investor_net(
        self, code: str, from_yyyymmdd: str, to_yyyymmdd: str
    ) -> InvestorNetFetchResult:
        idx = len(self.calls)
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
        if self.raise_rate_limit_on_call is not None and idx == self.raise_rate_limit_on_call:
            from hoga.live.kiwoom_errors import KiwoomRateLimitError

            raise KiwoomRateLimitError("simulated rate limit")
        from datetime import (
            datetime as _dt,
            timedelta as _td,
        )

        kst = datetime.timezone(datetime.timedelta(hours=9))
        y, m, d = int(from_yyyymmdd[:4]), int(from_yyyymmdd[4:6]), int(from_yyyymmdd[6:8])
        ye, me, de = int(to_yyyymmdd[:4]), int(to_yyyymmdd[4:6]), int(to_yyyymmdd[6:8])
        cur = _dt(y, m, d, 9, 0, tzinfo=kst)
        end = _dt(ye, me, de, 9, 0, tzinfo=kst)
        points: list[InvestorNetPoint] = []
        while cur <= end:
            points.append(
                InvestorNetPoint(
                    t_ms=int(cur.timestamp() * 1000),
                    foreign_net=100,
                    institution_net=-50,
                )
            )
            cur = cur + _td(days=1)
        return InvestorNetFetchResult(points=points, violations=list(self.violations))


def _investor_app(tmp_path, fake_kis, monkeypatch):
    from fastapi import FastAPI

    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake_kis)
    _use_fake_kiwoom_client(monkeypatch, fake_kis)
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    return app


def test_index_investor_net_uses_scheduler_backed_fetcher(tmp_path, monkeypatch) -> None:
    from hoga.live import lifecycle
    from hoga.live.api import build_router
    from hoga.live.investor import InvestorNetPoint

    class _FakeKiwoomForIndexInvestor:
        def __init__(self):
            self.calls: list[tuple[str, str, str]] = []

        async def fetch_market_investor_net(self, index, from_yyyymmdd, to_yyyymmdd):
            # **평평한 리스트**다 — ka10051 은 날짜당 한 콜이라 종목별(ka10059)의
            # FetchResult 와 모양이 다르다(#1041). 소비자가 `.points` 를 읽으면
            # 여기서 터진다.
            self.calls.append((index.id, from_yyyymmdd, to_yyyymmdd))
            return [
                InvestorNetPoint(
                    t_ms=1_718_574_400_000, foreign_net=-3519, institution_net=17184,
                )
            ]

    fake = _FakeKiwoomForIndexInvestor()
    lifecycle.reset_for_tests()
    _use_fake_kiwoom_client(monkeypatch, fake)
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    with TestClient(app) as c:
        r = c.get("/api/live/index-investor-net?index_id=KOSDAQ&from=20260619&to=20260619")

    assert r.status_code == 200
    body = r.json()
    assert body["index_id"] == "KOSDAQ"
    assert body["points"] == [
        {
            "t_ms": 1_718_574_400_000,
            "foreign_net": -3519,
            "institution_net": 17184,
        }
    ]
    assert fake.calls == [("KOSDAQ", "20260619", "20260619")]


def _two_account_app(tmp_path, monkeypatch, fake0, fake1):
    """N=2 라우팅 검증용: account 0/1에 서로 다른 fake를 주입하고 env 2종을 세팅한다."""
    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake0, 0)
    kis_runtime.set_kis_client(fake1, 1)
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    return app


def test_past_investor_net_ignores_kis_account_health(tmp_path, monkeypatch) -> None:
    """PR-E(#1041) 칼 컷오버 회귀 가드 — **계정 차원이 통째로 사라졌다.**

    이 자리에는 원래 두 테스트가 있었다: N=2 계정 풀 라우팅과 degraded 계정
    제외. 키움 유량은 TR별이라 고를 계정이 없어(#1015) 둘 다 검증할 대상이
    없어졌다. 대신 **KIS 계정 건강이 이 라우트에 더는 영향을 주지 않는다**는
    새 불변식을 못 박는다 — 옛 배선이 되살아나면 여기서 걸린다.
    """
    from hoga.live import account_health

    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake, monkeypatch)
    account_health.mark_rest_auth_degraded(0)
    account_health.mark_rest_auth_degraded(1)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
    assert r.status_code == 200, "KIS 계정이 전부 degraded 여도 키움 경로는 산다"
    assert len(fake.calls) == 1


def test_past_candles_ignores_kis_account_health(tmp_path, monkeypatch) -> None:
    """PR-G(#1043) 칼 컷오버 회귀 가드 — **계정 차원이 통째로 사라졌다.**

    이 자리에는 원래 "user-visible 은 풀의 첫 건강한 계정을 쓴다" 는 테스트가
    있었다. 키움 유량은 TR별이라 고를 계정이 없어(#1015) 검증할 대상이 없어졌다.
    대신 **KIS 계정 건강이 이 라우트에 더는 영향을 주지 않는다**는 새 불변식을
    못 박는다 — 옛 배선이 되살아나면 여기서 걸린다.
    """
    from hoga.live import account_health

    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake, monkeypatch)
    account_health.mark_rest_auth_degraded(0)
    account_health.mark_rest_auth_degraded(1)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20240101&to=20240105")
    assert r.status_code == 200, "KIS 계정이 전부 degraded 여도 키움 경로는 산다"
    assert fake.calls, "분봉이 실제로 조회돼야 한다"


def test_past_investor_net_miss_calls_kis(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == "005930"
        assert len(body["points"]) == 5
        assert "20240101__20240105" in body["fresh_batches"]
        assert body["cached_batches"] == []
        assert body["points"][0]["foreign_net"] == 100
        assert body["points"][0]["institution_net"] == -50
        assert len(fake.calls) == 1


def test_past_investor_net_cache_hit_skips_kis(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        r2 = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        body = r2.json()
        assert "20240101__20240105" in body["cached_batches"]
        assert body["fresh_batches"] == []
        assert len(fake.calls) == 1


def test_past_investor_net_partial_hit_gap_fill(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        c.get("/api/live/past-investor-net?code=005930&from=20240301&to=20240501")
        r2 = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240501")
        body = r2.json()
        assert len(fake.calls) == 2
        _, gap_from, gap_to = fake.calls[1]
        assert gap_from == "20240101"
        assert gap_to == "20240229"
        ts = [p["t_ms"] for p in body["points"]]
        assert ts == sorted(set(ts))


def test_past_investor_net_rejects_invalid_code(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=ABC&from=20240101&to=20240105")
        assert r.status_code == 422
        assert len(fake.calls) == 0


def test_past_investor_net_503_when_kis_not_wired(tmp_path) -> None:
    from fastapi import FastAPI

    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(None)
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        assert r.status_code == 503


def test_past_investor_net_rate_limit_surfaces_warning(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForInvestor()
    fake.raise_rate_limit_on_call = 0
    app = _investor_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        body = r.json()
        assert any(w["reason"] == "rate_limit_upstream" for w in body["data_warnings"])


def test_past_investor_net_violation_surfaces_to_wire(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForInvestor()
    fake.violations = [
        InvestorNetInvariantViolation(
            date_yyyymmdd="20240103",
            reason="malformed_row",
            detail="bad",
        )
    ]
    app = _investor_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        body = r.json()
        warn = [w for w in body["data_warnings"] if w["reason"] == "invariant_violation"]
        assert len(warn) >= 1
        assert warn[0]["date"] == "20240103"


def test_past_investor_net_empty_result_cached(tmp_path, monkeypatch) -> None:
    class _EmptyKis(_FakeKisForInvestor):
        async def fetch_investor_net(self, code, from_yyyymmdd, to_yyyymmdd):
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            return InvestorNetFetchResult(points=[], violations=[])

    fake = _EmptyKis()
    app = _investor_app(tmp_path, fake, monkeypatch)
    with TestClient(app) as c:
        c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        r2 = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        body = r2.json()
        assert "20240101__20240105" in body["cached_batches"]
        assert body["points"] == []
        assert len(fake.calls) == 1
        assert len(fake.calls) == 1


# ----- /api/live/investor-trend-estimate -----


class _FakeKisForInvestorTrendEstimate:
    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.calls: list[str] = []

    async def fetch_investor_trend_estimate(self, code: str):
        self.calls.append(code)
        item = self.responses.pop(0) if self.responses else []
        if isinstance(item, BaseException):
            raise item
        return item


def _investor_estimate_row_model(
    slot: str,
    foreign_qty: int | None,
    institution_qty: int | None,
    sum_qty: int | None,
    *,
    amt: tuple[int | None, int | None, int | None] | None = None,
) -> InvestorTrendEstimateRow:
    """`amt` 는 (외국인, 기관, 합산) 백만원. 생략하면 금액 축이 비어 있는 행이다 —
    수량만 검증하는 기존 테스트가 금액을 지어내지 않게 하려고 옵션으로 둔다."""
    foreign_amt, institution_amt, sum_amt = amt if amt is not None else (None, None, None)
    return InvestorTrendEstimateRow(
        slot=slot,
        foreign_qty=foreign_qty,
        institution_qty=institution_qty,
        sum_qty=sum_qty,
        foreign_amt_mwon=foreign_amt,
        institution_amt_mwon=institution_amt,
        sum_amt_mwon=sum_amt,
    )


@pytest.mark.asyncio
async def test_investor_estimate_latest_only_accumulates_same_day_and_overwrites_slot(
    monkeypatch,
) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
            [InvestorTrendEstimateRow(slot="0910", foreign_qty=11, institution_qty=21, sum_qty=32)],
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=99, institution_qty=1, sum_qty=100)],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    r1 = await fetcher.fetch(fake, "005930")
    now = 160.0
    r2 = await fetcher.fetch(fake, "005930")
    now = 220.0
    r3 = await fetcher.fetch(fake, "005930")

    assert [r.slot for r in r1.rows] == ["0900"]
    assert [r.slot for r in r2.rows] == ["0900", "0910"]
    assert [(r.slot, r.foreign_qty) for r in r3.rows] == [("0900", 99), ("0910", 11)]
    assert [(r.slot, r.observed_at_ms) for r in r3.rows] == [("0900", 220_000), ("0910", 160_000)]
    assert r3.latest and r3.latest.slot == "0910"


@pytest.mark.asyncio
async def test_investor_estimate_full_history_replaces_latest_only_accumulator(monkeypatch) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
            [
                InvestorTrendEstimateRow(
                    slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30
                ),
                InvestorTrendEstimateRow(
                    slot="0920", foreign_qty=12, institution_qty=22, sum_qty=34
                ),
            ],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    await fetcher.fetch(fake, "005930")
    now = 160.0
    response = await fetcher.fetch(fake, "005930")

    assert [r.slot for r in response.rows] == ["0900", "0920"]
    assert [(r.slot, r.observed_at_ms) for r in response.rows] == [
        ("0900", 100_000),
        ("0920", 160_000),
    ]
    assert response.latest and response.latest.slot == "0920"


@pytest.mark.asyncio
async def test_investor_estimate_full_history_preserves_past_slot_timestamp(monkeypatch) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    fake = _FakeKisForInvestorTrendEstimate(
        [
            [
                InvestorTrendEstimateRow(
                    slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30
                ),
                InvestorTrendEstimateRow(
                    slot="0910", foreign_qty=11, institution_qty=21, sum_qty=32
                ),
            ],
            [
                InvestorTrendEstimateRow(
                    slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30
                ),
                InvestorTrendEstimateRow(
                    slot="0910", foreign_qty=99, institution_qty=1, sum_qty=100
                ),
            ],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    first = await fetcher.fetch(fake, "005930")
    now = 160.0
    second = await fetcher.fetch(fake, "005930")

    assert [r.slot for r in first.rows] == ["0900", "0910"]
    assert [(r.slot, r.foreign_qty, r.observed_at_ms) for r in first.rows] == [
        ("0900", 10, 100_000),
        ("0910", 11, 100_000),
    ]
    assert [(r.slot, r.foreign_qty, r.observed_at_ms) for r in second.rows] == [
        ("0900", 10, 100_000),
        ("0910", 99, 160_000),
    ]


@pytest.mark.asyncio
async def test_investor_estimate_full_history_preserves_unchanged_slots(monkeypatch) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    fake = _FakeKisForInvestorTrendEstimate(
        [
            [
                _investor_estimate_row_model("1", -95_000, 0, -95_000),
                _investor_estimate_row_model("2", -106_000, 0, -106_000),
                _investor_estimate_row_model("3", -117_000, 0, -117_000),
            ],
            [
                _investor_estimate_row_model("1", -95_000, 0, -95_000),
                _investor_estimate_row_model("2", -106_000, 0, -106_000),
                _investor_estimate_row_model("3", -117_000, 0, -117_000),
                _investor_estimate_row_model("4", -149_000, 53_000, -96_000),
            ],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260619")

    await fetcher.fetch(fake, "005930")
    now = 160.0
    response = await fetcher.fetch(fake, "005930")

    assert [(r.slot, r.observed_at_ms) for r in response.rows] == [
        ("1", 100_000),
        ("2", 100_000),
        ("3", 100_000),
        ("4", 160_000),
    ]


@pytest.mark.asyncio
async def test_investor_estimate_observed_at_survives_fetcher_restart(
    monkeypatch,
    tmp_path,
) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    store_path = tmp_path / "live" / "investor-trend-estimate-observed-at.json"
    first_fake = _FakeKisForInvestorTrendEstimate(
        [
            [
                _investor_estimate_row_model("1", -95_000, 0, -95_000),
                _investor_estimate_row_model("2", -106_000, 0, -106_000),
            ],
        ]
    )
    first_fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    await first_fetcher.fetch(first_fake, "005930")

    now = 160.0
    second_fake = _FakeKisForInvestorTrendEstimate(
        [
            [
                _investor_estimate_row_model("1", -95_000, 0, -95_000),
                _investor_estimate_row_model("2", -106_000, 0, -106_000),
                _investor_estimate_row_model("3", -117_000, 0, -117_000),
            ],
        ]
    )
    second_fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    response = await second_fetcher.fetch(second_fake, "005930")

    assert [(r.slot, r.observed_at_ms) for r in response.rows] == [
        ("1", 100_000),
        ("2", 100_000),
        ("3", 160_000),
    ]


@pytest.mark.asyncio
async def test_investor_estimate_observed_at_store_ignores_malformed_json(
    monkeypatch,
    tmp_path,
) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    store_path = tmp_path / "live" / "investor-trend-estimate-observed-at.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text(
        '{"20260619":{"005930":{"1":"bad","2":{"observed_at_ms":"bad"}}}}',
        encoding="utf-8",
    )
    fake = _FakeKisForInvestorTrendEstimate(
        [
            [_investor_estimate_row_model("1", -95_000, 0, -95_000)],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    response = await fetcher.fetch(fake, "005930")

    assert [(r.slot, r.observed_at_ms) for r in response.rows] == [("1", 100_000)]


@pytest.mark.asyncio
async def test_investor_estimate_observed_at_tracks_the_amount_axis_too(
    monkeypatch,
    tmp_path,
) -> None:
    """수량이 그대로여도 금액이 움직였으면 그 슬롯은 새로 관측된 것이다.

    수량은 천주 단위로 반올림돼 오므로 몇 분간 같은 값에 머문다. 관측시각 판정이
    수량만 보면 그 사이 금액이 계속 갱신돼도 슬롯이 "안 변했다" 로 읽혀 차수 시각이
    옛날에 못 박힌다.
    """
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    store_path = tmp_path / "live" / "investor-trend-estimate-observed-at.json"
    fake = _FakeKisForInvestorTrendEstimate(
        [
            [_investor_estimate_row_model("1", -912_000, 0, -912_000, amt=(-212_372, 0, -212_372))],
            # 같은 수량, 다른 금액 — 벤더가 천주 반올림 안에서 움직인 프레임.
            [_investor_estimate_row_model("1", -912_000, 0, -912_000, amt=(-213_500, 0, -213_500))],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    await fetcher.fetch(fake, "005930")
    now = 160.0
    response = await fetcher.fetch(fake, "005930")

    assert [(r.slot, r.observed_at_ms) for r in response.rows] == [("1", 160_000)]


def test_investor_estimate_stored_values_reads_legacy_rows_as_amounts() -> None:
    """구포맷(수량 이름에 담긴 금액)은 **금액 축으로** 읽는다.

    2026-08-04 이전 판은 `amt_qty_tp="1"`(금액, 백만원) 응답을 `foreign_qty` 등에
    담아 저장했다. 값 자체는 멀쩡하고 **단위 라벨만 틀렸다** — 그대로 수량으로 읽으면
    다음 폴링의 진짜 수량과 나란히 비교되어, 디스크의 금액이 수량 행세를 계속한다.

    구포맷 판별은 금액 키의 부재다. 신포맷은 값이 None 이어도 6키를 모두 쓴다.
    """
    from hoga.live.api import _investor_estimate_stored_values

    legacy = _investor_estimate_stored_values({
        "observed_at_ms": 100_000,
        "foreign_qty": -212_372,      # 실제로는 백만원이었다
        "institution_qty": -451_250,
        "sum_qty": -663_622,
    })
    assert legacy["foreign_amt_mwon"] == -212_372
    assert legacy["institution_amt_mwon"] == -451_250
    assert legacy["foreign_qty"] is None, "금액이 수량 자리에 남으면 안 된다"
    assert legacy["sum_qty"] is None

    current = _investor_estimate_stored_values({
        "observed_at_ms": 100_000,
        "foreign_qty": -912_000, "institution_qty": -1_925_000, "sum_qty": -2_837_000,
        "foreign_amt_mwon": -212_372, "institution_amt_mwon": -451_250,
        "sum_amt_mwon": -663_622,
    })
    assert current["foreign_qty"] == -912_000
    assert current["foreign_amt_mwon"] == -212_372

    # 신포맷인데 한 축이 비어 있는 슬롯 — 금액 키가 있으므로 구포맷으로 오인하지 않는다.
    one_sided = _investor_estimate_stored_values({
        "observed_at_ms": 100_000,
        "foreign_qty": -5_000, "institution_qty": -1_000, "sum_qty": -6_000,
        "foreign_amt_mwon": None, "institution_amt_mwon": None, "sum_amt_mwon": None,
    })
    assert one_sided["foreign_qty"] == -5_000
    assert one_sided["foreign_amt_mwon"] is None


@pytest.mark.asyncio
async def test_investor_estimate_full_history_removes_absent_persisted_slots(
    monkeypatch,
    tmp_path,
) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    store_path = tmp_path / "live" / "investor-trend-estimate-observed-at.json"
    first_fake = _FakeKisForInvestorTrendEstimate(
        [
            [
                _investor_estimate_row_model("1", -95_000, 0, -95_000),
                _investor_estimate_row_model("2", -106_000, 0, -106_000),
            ],
            [
                _investor_estimate_row_model("1", -95_000, 0, -95_000),
                _investor_estimate_row_model("3", -117_000, 0, -117_000),
            ],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    await fetcher.fetch(first_fake, "005930")
    now = 160.0
    await fetcher.fetch(first_fake, "005930")

    now = 220.0
    second_fake = _FakeKisForInvestorTrendEstimate(
        [
            [
                _investor_estimate_row_model("1", -95_000, 0, -95_000),
                _investor_estimate_row_model("2", -106_000, 0, -106_000),
            ],
        ]
    )
    restarted_fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )
    response = await restarted_fetcher.fetch(second_fake, "005930")

    assert [(r.slot, r.observed_at_ms) for r in response.rows] == [
        ("1", 100_000),
        ("2", 220_000),
    ]


@pytest.mark.asyncio
async def test_investor_estimate_observed_at_store_bounds_codes(
    monkeypatch,
    tmp_path,
) -> None:
    import json

    from hoga.live import api as live_api
    from hoga.live.api import (
        _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY,
        LiveInvestorEstimateFetcher,
    )

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    store_path = tmp_path / "live" / "investor-trend-estimate-observed-at.json"
    fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    for i in range(_INVESTOR_ESTIMATE_MAX_CODES_PER_DAY + 1):
        now = 100.0 + i
        fake = _FakeKisForInvestorTrendEstimate(
            [
                [_investor_estimate_row_model("1", i, 0, i)],
            ]
        )
        await fetcher.fetch(fake, f"{i:06d}")

    state = json.loads(store_path.read_text(encoding="utf-8"))
    assert len(state["20260619"]) == _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY
    assert "000000" not in state["20260619"]


@pytest.mark.asyncio
async def test_investor_estimate_empty_success_clears_same_day_accumulator() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
            [],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    await fetcher.fetch(fake, "005930")
    response = await fetcher.fetch(fake, "005930")

    assert response.status == "empty"
    assert response.rows == []
    assert response.latest is None
    assert fetcher._accumulator[("20260616", "005930")] == {}


@pytest.mark.asyncio
async def test_investor_estimate_all_null_rows_are_empty() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _FakeKisForInvestorTrendEstimate(
        [
            [
                InvestorTrendEstimateRow(
                    slot="0900", foreign_qty=None, institution_qty=None, sum_qty=None
                )
            ],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    response = await fetcher.fetch(fake, "005930")

    assert response.status == "empty"
    assert response.latest is None
    assert [(r.slot, r.foreign_qty, r.institution_qty, r.sum_qty) for r in response.rows] == [
        ("0900", None, None, None)
    ]


@pytest.mark.asyncio
async def test_investor_estimate_ttl_coalesces_calls() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=60, today_fn=lambda: "20260616")

    first = await fetcher.fetch(fake, "005930")
    second = await fetcher.fetch(fake, "005930")

    assert fake.calls == ["005930"]
    assert second.rows == first.rows
    assert second.fetched_at_ms == first.fetched_at_ms


@pytest.mark.asyncio
async def test_investor_estimate_inflight_coalesces_concurrent_calls() -> None:
    import asyncio

    from hoga.live.api import LiveInvestorEstimateFetcher

    class _SlowKis:
        def __init__(self) -> None:
            self.calls = 0
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def fetch_investor_trend_estimate(self, code: str):
            self.calls += 1
            self.started.set()
            await self.release.wait()
            return [
                InvestorTrendEstimateRow(
                    slot="0900",
                    foreign_qty=10,
                    institution_qty=20,
                    sum_qty=30,
                )
            ]

    fake = _SlowKis()
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=60, today_fn=lambda: "20260616")

    first_task = asyncio.create_task(fetcher.fetch(fake, "005930"))
    await fake.started.wait()
    second_task = asyncio.create_task(fetcher.fetch(fake, "005930"))
    fake.release.set()

    first, second = await asyncio.gather(first_task, second_task)

    assert fake.calls == 1
    assert second.rows == first.rows
    assert second.fetched_at_ms == first.fetched_at_ms


@pytest.mark.asyncio
async def test_investor_estimate_kis_failure_returns_previous_same_day_rows() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher
    from hoga.live.kiwoom_errors import KiwoomRateLimitError

    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
            KiwoomRateLimitError("rate limited"),
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    await fetcher.fetch(fake, "005930")
    response = await fetcher.fetch(fake, "005930")

    assert response.status == "error"
    assert response.data_warning and response.data_warning.reason == "rate_limit_upstream"
    assert [r.slot for r in response.rows] == ["0900"]


@pytest.mark.asyncio
async def test_investor_estimate_auth_failure_returns_degraded_credentials_warning() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher
    from hoga.live.kiwoom_errors import KiwoomAuthError

    fake = _FakeKisForInvestorTrendEstimate(
        [
            KiwoomAuthError("token issue failed"),
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    response = await fetcher.fetch(fake, "005930")

    assert response.status == "error"
    assert response.data_warning
    assert response.data_warning.reason == "credentials_missing"
    assert response.data_warning.msg == "KIS authentication failed"
    assert response.rows == []


@pytest.mark.asyncio
async def test_investor_estimate_evicts_previous_day_state(monkeypatch) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    today = "20260616"
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)

    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
            [InvestorTrendEstimateRow(slot="0930", foreign_qty=11, institution_qty=21, sum_qty=32)],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=60, today_fn=lambda: today)

    await fetcher.fetch(fake, "005930")
    today = "20260617"
    now = 101.0
    await fetcher.fetch(fake, "000660")

    assert ("20260616", "005930") not in fetcher._cache
    assert ("20260616", "005930") not in fetcher._accumulator
    assert ("20260616", "005930") not in fetcher._last_success_fetched_at_ms
    assert ("20260617", "000660") in fetcher._accumulator


@pytest.mark.asyncio
async def test_investor_estimate_bounds_codes_per_day(monkeypatch) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import (
        _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY,
        LiveInvestorEstimateFetcher,
    )

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    fake = _FakeKisForInvestorTrendEstimate(
        [
            (
                []
                if i % 2 == 0
                else [
                    InvestorTrendEstimateRow(
                        slot="0900", foreign_qty=i, institution_qty=0, sum_qty=i
                    )
                ]
            )
            for i in range(_INVESTOR_ESTIMATE_MAX_CODES_PER_DAY + 1)
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=60, today_fn=lambda: "20260616")

    for i in range(_INVESTOR_ESTIMATE_MAX_CODES_PER_DAY + 1):
        now = 100.0 + i
        await fetcher.fetch(fake, f"{i:06d}")

    assert ("20260616", "000000") not in fetcher._cache
    assert len(fetcher._cache) <= _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY
    assert len(fetcher._accumulator) == _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY


@pytest.mark.asyncio
async def test_investor_estimate_degraded_failure_is_cached_with_previous_rows(monkeypatch) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher
    from hoga.live.kiwoom_errors import KiwoomRateLimitError

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)

    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
            KiwoomRateLimitError("rate limited"),
            KiwoomRateLimitError("rate limited again"),
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=60, today_fn=lambda: "20260616")

    successful = await fetcher.fetch(fake, "005930")
    now = 161.0
    first_degraded = await fetcher.fetch(fake, "005930")
    now = 162.0
    cached_degraded = await fetcher.fetch(fake, "005930")
    now = 222.0
    second_degraded = await fetcher.fetch(fake, "005930")

    assert fake.calls == ["005930", "005930", "005930"]
    assert successful.fetched_at_ms == 100_000
    assert first_degraded.status == "error"
    assert cached_degraded.status == "error"
    assert second_degraded.status == "error"
    assert first_degraded.fetched_at_ms == successful.fetched_at_ms
    assert cached_degraded.fetched_at_ms == successful.fetched_at_ms
    assert second_degraded.fetched_at_ms == successful.fetched_at_ms
    assert [r.slot for r in second_degraded.rows] == ["0900"]
    assert second_degraded.data_warning
    assert second_degraded.data_warning.reason == "rate_limit_upstream"


@pytest.mark.asyncio
async def test_investor_estimate_api_and_transport_errors_preserve_previous_rows() -> None:
    import httpx

    from hoga.live.api import LiveInvestorEstimateFetcher
    from hoga.live.kiwoom_errors import KiwoomApiError, KiwoomTransportError

    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
            KiwoomTransportError(httpx.RemoteProtocolError("server disconnected")),
            KiwoomApiError("1503", "upstream rejected request"),
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    await fetcher.fetch(fake, "005930")
    transport_response = await fetcher.fetch(fake, "005930")
    api_response = await fetcher.fetch(fake, "005930")

    assert transport_response.status == "error"
    assert transport_response.data_warning
    assert transport_response.data_warning.reason == "api_error"
    assert [r.slot for r in transport_response.rows] == ["0900"]
    assert api_response.status == "error"
    assert api_response.data_warning
    assert api_response.data_warning.reason == "api_error"
    assert [r.slot for r in api_response.rows] == ["0900"]


@pytest.mark.asyncio
async def test_investor_estimate_parse_error_degrades() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _FakeKisForInvestorTrendEstimate(
        [
            [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
            [
                InvestorTrendEstimateRow(
                    slot="0910",
                    foreign_qty=11,
                    institution_qty=21,
                    sum_qty=32,
                ).model_copy(update={"foreign_qty": "not-an-int"})
            ],
        ]
    )
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    await fetcher.fetch(fake, "005930")
    response = await fetcher.fetch(fake, "005930")

    assert response.status == "error"
    assert response.data_warning
    assert response.data_warning.reason == "parse_error"
    assert [r.slot for r in response.rows] == ["0900"]


@pytest.mark.asyncio
async def test_investor_estimate_does_not_degrade_programming_errors() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _FakeKisForInvestorTrendEstimate([[object()]])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    with pytest.raises(AttributeError):
        await fetcher.fetch(fake, "005930")


def _investor_estimate_app(tmp_path, monkeypatch, fake_kis=None):
    from fastapi import FastAPI

    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    if fake_kis is not None:
        kis_runtime.set_kis_client(fake_kis)
    # fake_kis 가 None 이면 무자격 경로 — 라우트가 credentials_missing 을 낸다.
    _use_fake_kiwoom_client(monkeypatch, fake_kis)
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    return app


def test_investor_trend_estimate_route_uses_capacity_scheduler(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForInvestorTrendEstimate(
        [[InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)]]
    )
    app = _investor_estimate_app(tmp_path, monkeypatch, fake)
    r = TestClient(app).get("/api/live/investor-trend-estimate", params={"code": "005930"})

    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_investor_trend_estimate_route_returns_expected_rows(tmp_path, monkeypatch) -> None:
    fake = _FakeKisForInvestorTrendEstimate(
        [
            [
                InvestorTrendEstimateRow(
                    slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30,
                    foreign_amt_mwon=2, institution_amt_mwon=5, sum_amt_mwon=7,
                ),
                InvestorTrendEstimateRow(
                    slot="0910", foreign_qty=15, institution_qty=None, sum_qty=15,
                    foreign_amt_mwon=4, institution_amt_mwon=None, sum_amt_mwon=4,
                ),
            ]
        ]
    )
    app = _investor_estimate_app(tmp_path, monkeypatch, fake)

    r = TestClient(app).get("/api/live/investor-trend-estimate", params={"code": "005930"})

    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "005930"
    assert body["source"] == "kis"
    assert body["status"] == "ok"
    # 프론트가 축을 서버 왕복 없이 토글하므로 **두 축이 모두 실려야** 한다. 한 축만
    # 나가면 토글이 빈 표를 그리고, 그 회귀는 이 단언 말고는 잡히지 않는다.
    assert body["rows"] == [
        {
            "slot": "0900",
            "observed_at_ms": body["fetched_at_ms"],
            "foreign_qty": 10,
            "institution_qty": 20,
            "sum_qty": 30,
            "foreign_amt_mwon": 2,
            "institution_amt_mwon": 5,
            "sum_amt_mwon": 7,
        },
        {
            "slot": "0910",
            "observed_at_ms": body["fetched_at_ms"],
            "foreign_qty": 15,
            "institution_qty": None,
            "sum_qty": 15,
            "foreign_amt_mwon": 4,
            "institution_amt_mwon": None,
            "sum_amt_mwon": 4,
        },
    ]
    assert body["latest"]["slot"] == "0910"
    assert body["data_warning"] is None


def test_investor_trend_estimate_route_rejects_invalid_code(tmp_path, monkeypatch) -> None:
    app = _investor_estimate_app(tmp_path, monkeypatch, _FakeKisForInvestorTrendEstimate())

    r = TestClient(app).get("/api/live/investor-trend-estimate", params={"code": "ABC"})

    assert r.status_code == 422


def test_investor_trend_estimate_route_missing_kis_returns_degraded_error(tmp_path, monkeypatch) -> None:
    app = _investor_estimate_app(tmp_path, monkeypatch)

    r = TestClient(app).get("/api/live/investor-trend-estimate", params={"code": "005930"})

    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "005930"
    assert body["status"] == "error"
    assert body["fetched_at_ms"] is None
    assert body["rows"] == []
    assert body["latest"] is None
    assert body["data_warning"]["reason"] == "credentials_missing"


def test_live_settings_routes_round_trip(tmp_path):
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    app = FastAPI()
    app.include_router(
        build_router(
            data_dir=tmp_path,
            get_status=lifecycle.get_status,
        )
    )
    client = TestClient(app)

    # 응답은 새 이름만 낸다 — 프론트가 갈아탔으므로 이중 노출을 거뒀다(3단계).
    assert client.get("/api/live/settings").json() == {
        "schema_version": 1,
        "rest_bypass_enabled": False,
        "screener_depth_autocollect": False,
        "krx_prefer_hogaplay": False,
    }

    r = client.patch(
        "/api/live/settings",
        json={"screener_depth_autocollect": True},
    )

    assert r.status_code == 200
    assert r.json()["screener_depth_autocollect"] is True
    assert r.json()["rest_bypass_enabled"] is False
    assert client.get("/api/live/settings").json()["screener_depth_autocollect"] is True


def test_live_settings_patch_ignores_legacy_storage_policy_key(tmp_path):
    """storage_policy는 제거됨(2026-07-17) — 레거시 클라이언트가 보내도 무해하게
    무시되고(422 아님) 응답에도 나타나지 않는다."""
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    app = FastAPI()
    app.include_router(
        build_router(
            data_dir=tmp_path,
            get_status=lifecycle.get_status,
        )
    )
    client = TestClient(app)

    r = client.patch(
        "/api/live/settings",
        json={
            "storage_policy": "rest_only",
            "program_trade_storage_enabled": True,  # 폐지된 키(2026-07-21)
            "screener_depth_autocollect": True,
        },
    )

    assert r.status_code == 200
    assert "storage_policy" not in r.json()
    assert "heatmap_capture_enabled" not in r.json()
    assert "program_trade_storage_enabled" not in r.json()
    assert r.json()["screener_depth_autocollect"] is True


def test_live_settings_patch_can_set_bypass_alone(tmp_path):
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    app = FastAPI()
    app.include_router(
        build_router(
            data_dir=tmp_path,
            get_status=lifecycle.get_status,
        )
    )
    client = TestClient(app)

    r = client.patch(
        "/api/live/settings",
        json={"rest_bypass_enabled": True},
    )

    assert r.status_code == 200
    assert r.json() == {
        "schema_version": 1,
        "rest_bypass_enabled": True,
        "screener_depth_autocollect": False,
        "krx_prefer_hogaplay": False,
    }
    assert client.get("/api/live/settings").json()["rest_bypass_enabled"] is True

    # 옛 이름 PATCH 는 **조용히 무시**된다(3단계). 422 가 아니라 no-op 인 것은
    # pydantic extra-ignore 의 기존 정책이고, 레거시 클라이언트가 남아 있어도
    # 요청이 깨지지 않는다 — 옛 storage_policy 키와 같은 취급이다.
    r_legacy = client.patch(
        "/api/live/settings",
        json={"kis_rest_bypass_enabled": False},
    )
    assert r_legacy.status_code == 200
    assert r_legacy.json()["rest_bypass_enabled"] is True, "옛 이름은 반영되지 않는다"


# ── wire model 계약 (ADR-0004 · 동결선 배치 2) ────────────────────────────────


def test_from_is_a_wire_key_not_a_python_identifier():
    """`from` 은 파이썬 예약어라 필드명이 `from_` 이지만 **wire 는 `from`** 이다.

    alias 를 지워도 파이썬 코드는 멀쩡히 돌아가므로(필드명만 바뀐다) 이 단언이 없으면
    프론트 쿼리 키가 조용히 깨진다 — 과거 캔들·수급 네 라우트가 전부 이 키를 쓴다.
    """
    from hoga.live.api import (
        LiveIndexCandlesResponse,
        LivePastCandlesResponse,
        LivePastDailyCandlesResponse,
        LivePastInvestorNetResponse,
        ScreenerDailyCandlesResponse,
    )

    cases = [
        (LivePastCandlesResponse, {"code": "005930", "from": "20260101", "to": "20260102"}),
        (LivePastDailyCandlesResponse, {"code": "005930", "from": "20260101", "to": "20260102"}),
        (ScreenerDailyCandlesResponse,
         {"code": "005930", "from": "20260101", "to": "20260102", "source": "screener_daily"}),
        (LivePastInvestorNetResponse,
         {"code": "005930", "from": "20260101", "to": "20260102", "unit": "qty_shares"}),
        (LiveIndexCandlesResponse,
         {"index_id": "KOSPI", "from": "20260101", "to": "20260102", "timeframe": "D"}),
    ]
    for model, payload in cases:
        dumped = model.model_validate(payload).model_dump(by_alias=True)
        assert "from" in dumped, f"{model.__name__} 이 wire 키 `from` 을 잃었다"
        assert "from_" not in dumped, f"{model.__name__} 이 파이썬 필드명을 wire 로 흘렸다"


def test_snapshot_model_tolerates_partial_buffer_entries():
    """부분 스냅샷이 **500 이 되면 안 된다**.

    버퍼는 스트림이 만든 dict 를 그대로 보관하고, 그 dict 는 부분적일 수 있다
    (호가만 온 순간 등). 모델을 필수 필드로 선언했다가 실제로 여기서 깨졌다 —
    실서버 응답은 정상 스트림이라 완전했기 때문에 그 검사로는 안 잡혔고, 이 층위의
    테스트가 잡았다.
    """
    from hoga.live.api import LiveSnapshotResponse

    got = LiveSnapshotResponse.model_validate(
        {"code": "005930", "orderbook": {"total_bid_qty": 1000}, "recent_trades": [{"price": 100}]}
    ).model_dump(exclude_none=True)

    # 부재는 부재로 나간다 — `exclude_none` 이 라우트에 걸려 있는 이유다.
    assert got["orderbook"] == {"total_bid_qty": 1000, "asks": [], "bids": []}
    assert got["recent_trades"] == [{"price": 100}]


def test_series_response_never_strips_unknown_keys():
    """`/series` 는 **모르는 키도 통과**시킨다 (`extra="allow"`).

    이 라우트는 버퍼 dict 를 `**series` 로 펼쳐 조립하므로, 스트림이 키를 늘리면
    모델 선언이 뒤처질 수 있다. 그때 조용히 버리면 차트 초기 hydration 이 이유 없이
    반쪽이 된다 — 이 작업 전체가 막으려던 실패가 정확히 그것이라, 아직 모르는 키에도
    같은 원칙을 적용한다.

    또한 네 배열(snapshots·trades·brokers·programs) 항목은 **opaque** 다. 프론트가
    `Array<Record<string, unknown>>` 로 받아 그대로 버퍼에 넘기므로 항목 shape 은
    선언된 적이 없고, 여기서 좁히면 미러만 한 벌 늘고 스트립 위험이 생긴다.
    """
    from hoga.live.api import LiveSeriesResponse

    got = LiveSeriesResponse.model_validate(
        {
            "code": "005930",
            "date": "20260807",
            "session_open_ms": 1,
            "session_close_ms": None,
            "is_open": True,
            "snapshots": [{"t_ms": 1, "kind": "orderbook", "미래필드": 7}],
            "trades": [],
            "brokers": [],
            "programs": [],
            "ask_peak_today": {"date": "20260807", "coverage": "partial"},
            "bid_peak_today": None,
            "아직_모르는_최상위_키": {"nested": True},
        }
    ).model_dump()

    assert got["아직_모르는_최상위_키"] == {"nested": True}, "미지 최상위 키가 사라졌다"
    assert got["snapshots"][0]["미래필드"] == 7, "배열 항목이 opaque 하게 보존되지 않았다"
    # 장 중이면 close 가 없다 — 정당한 null 이므로 지우지 않는다.
    assert got["session_close_ms"] is None
    assert got["bid_peak_today"] is None
