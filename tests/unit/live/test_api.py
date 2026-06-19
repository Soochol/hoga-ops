"""Stage 7-α / 7-β — /api/live router."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _hermetic_kis_env(monkeypatch):
    """배경 라우트(quotes·investor-net)는 kis_access.kis_for_role → configured_account_ids
    로 ambient os.environ을 읽는다(계정 분리 2026-06-09). 개발 셸이 실제 KIS creds를
    export하거나 다른 테스트의 create_app→load_env가 os.environ을 오염시키면 background가
    실제 account 1 클라이언트를 만들려 한다(비결정 + 네트워크). 기본을 N=0(전부 account 0
    주입 fake로 폴백)으로 격리한다 — N=2 라우팅을 검증하는 테스트만 명시적으로 setenv."""
    for _k in ("KIS_APP_KEY", "KIS_APP_SECRET", "KIS_APP_KEY_2", "KIS_APP_SECRET_2"):
        monkeypatch.delenv(_k, raising=False)


def _make_test_app(
    get_status_fn=None,
    control_fn=None,
    get_today_ask_peak=None,
    get_today_bid_peak=None,
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
    await buf.publish("005930", [
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.OB, payload={"total_bid_qty": 1000}),
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.TRADE, payload={"trades": [{"price": 100}]}),
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.BROKER, payload={"buy_top": []}),
    ], now_ms=12345)

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
        await buf.publish("005930", [
            LiveSnapshot(t_ms=t, kind=SnapshotKind.OB, payload={"total_bid_qty": 100 + tick}),
            LiveSnapshot(t_ms=t, kind=SnapshotKind.TRADE, payload={"trades": []}),
            LiveSnapshot(t_ms=t, kind=SnapshotKind.BROKER, payload={"buy_top": []}),
        ], now_ms=t)

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


def test_get_live_series_includes_today_ask_peak_from_getter() -> None:
    def fake_peak(code: str) -> dict | None:
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
    def fake_peak(code: str) -> dict | None:
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
from hoga.live.kis_models import KisCandle


def _today_kst_yyyymmdd() -> str:
    kst = datetime.timezone(datetime.timedelta(hours=9))
    return datetime.datetime.now(kst).strftime("%Y%m%d")


class _FakeKisForPast:
    """Stub KIS client returning deterministic minute bars per date."""

    def __init__(self):
        self.calls: list[str] = []  # records date arg per call

    async def fetch_past_minute_candles(self, code: str, date_yyyymmdd: str, **_kw) -> list[KisCandle]:
        self.calls.append(date_yyyymmdd)
        # KST 09:00 of the requested date — matches the real KIS shape so
        # PastCandlesCache's date-match guard (the "evict stale" check from
        # f63ed15 follow-up) treats this cache entry as valid on hit.
        kst = datetime.timezone(datetime.timedelta(hours=9))
        y, m, d = int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8])
        t_ms = int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000)
        return [KisCandle(t_ms=t_ms, open=100, high=110, low=95, close=105, volume=10)]


def _past_app(tmp_path, fake_kis):
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
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    return app


def test_past_candles_rejects_missing_code(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?from=20260501&to=20260502")
        assert r.status_code == 422


def test_past_candles_rejects_invalid_code_format(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=abc&from=20260501&to=20260502")
        assert r.status_code == 422


def test_past_candles_rejects_from_after_to(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260510&to=20260501")
        assert r.status_code == 422


def test_past_candles_rejects_range_over_250_days(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        # 251 days (inclusive): 2024-01-01 to 2024-09-08
        r = c.get("/api/live/past-candles?code=005930&from=20240101&to=20240908")
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "date_range_too_large"


def test_past_candles_rejects_to_in_future(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20990101")
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "date_in_future"


@pytest.mark.asyncio
async def test_past_candles_happy_path_single_date(tmp_path) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
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
        # Disk file written under tmp_path
        assert (tmp_path / "kis-past-candles" / "005930" / f"{yesterday}.json").exists()


@pytest.mark.asyncio
async def test_past_candles_disk_cache_hit_on_second_call(tmp_path) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
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
async def test_past_candles_today_memory_cache(tmp_path) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        kst = datetime.timezone(datetime.timedelta(hours=9))
        today = datetime.datetime.now(kst).strftime("%Y%m%d")
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == [today]
        r = c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == [today]  # 60s TTL not yet expired
        assert r.json()["cached_dates"] == [today]
        # No disk file written for today
        assert not (tmp_path / "kis-past-candles" / "005930" / f"{today}.json").exists()


@pytest.mark.asyncio
async def test_past_candles_partial_failure_kis_api_error(tmp_path) -> None:
    from hoga.live.kis_client import KisApiError

    class _PartialFakeKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            if date_yyyymmdd == "20260502":
                raise KisApiError(msg_cd="HTTP_500", msg1="server error")
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    app = _past_app(tmp_path, _PartialFakeKis())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260503")
        assert r.status_code == 200
        body = r.json()
        warnings = body["data_warnings"]
        assert len(warnings) == 1
        assert warnings[0]["date"] == "20260502"
        assert warnings[0]["reason"] == "kis_api_error"
        # Two successful dates' bars in candles_all
        assert len(body["candles"]) == 2


@pytest.mark.asyncio
async def test_past_candles_fetches_uncached_dates_concurrently(tmp_path) -> None:
    """spec 2026-06-08 §4: 미캐시 과거 날짜는 동시 fetch(상한 5) — 순차 구현은
    max_inflight==1이라 실패한다. 완료 순서를 의도적으로 뒤섞어(늦은 날짜가
    빨리 응답) 응답 candles의 날짜 오름차순 보장(§5 테스트 4)도 함께 핀한다."""
    import asyncio as _asyncio

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
                y, m, d = (int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]),
                           int(date_yyyymmdd[6:8]))
                t_ms = int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000)
                return [KisCandle(t_ms=t_ms, open=100, high=110, low=95,
                                  close=105, volume=10)]
            finally:
                self.inflight -= 1

    fake = _SlowFakeKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260508")
        assert r.status_code == 200
        body = r.json()
    assert fake.max_inflight >= 2, "병렬화 안 됨 — 순차 fetch"
    assert fake.max_inflight <= 5, "동시 상한(_PAST_CANDLES_CONCURRENCY=5) 초과"
    t_list = [cd["t_ms"] for cd in body["candles"]]
    assert t_list == sorted(t_list), "응답 candles가 날짜 오름차순이 아님"
    assert body["fresh_dates"] == [f"2026050{i}" for i in range(1, 9)]


@pytest.mark.asyncio
async def test_past_candles_singleflight_dedups_concurrent_same_date(tmp_path) -> None:
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
            await _asyncio.sleep(0.05)   # 두 요청의 fetch 창을 겹치게 한다
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105,
                              volume=10)]

    fake = _SlowFakeKis()
    app = _past_app(tmp_path, fake)
    transport = httpx.ASGITransport(app=app)
    url = "/api/live/past-candles?code=005930&from=20260501&to=20260501"
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r1, r2 = await _asyncio.gather(ac.get(url), ac.get(url))
    assert r1.status_code == 200 and r2.status_code == 200
    assert fake.calls == ["20260501"], "싱글플라이트 미동작 — 같은 날짜 중복 KIS 콜"
    assert r1.json()["candles"] == r2.json()["candles"]
    assert r1.json()["fresh_dates"] == r2.json()["fresh_dates"] == ["20260501"]


@pytest.mark.asyncio
async def test_past_candles_rate_limit_blocks_unstarted_fetches(tmp_path) -> None:
    """병렬화(spec 2026-06-08 §4.4) 이후의 kis_blocked 계약: 레이트리밋 소진 시
    '아직 시작 안 한' fetch는 KIS를 더 두드리지 않고(rate_limit_aborted),
    이미 나간(in-flight) fetch는 완주해 결과를 서빙한다.
    (구 순차 계약 test_past_candles_rate_limit_aborts_remaining의 병렬 번역 —
    "실패 이후 날짜 KIS 콜 0"은 in-flight 회수가 불가능한 병렬에선 성립하지
    않으므로 "미시작 콜 0"으로 대체. '레이트리밋된 원격을 더 때리지 않는다'는
    원 의도는 보존된다.)

    결정성: 8날짜·슬롯 5 → D1-D5 동시 진입, D2가 0.01s에 실패(Event set은
    semaphore 해제보다 먼저 실행됨) → D6-D8은 슬롯 획득 시점에 Event를 보고
    스킵. D1·D3-D5는 0.1s sleep 중(in-flight)이라 완주."""
    import asyncio as _asyncio

    from hoga.live.kis_client import KisRateLimitError

    class _RateLimitedSlowKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            if date_yyyymmdd == "20260502":
                await _asyncio.sleep(0.01)   # 첫 배치 중 가장 먼저 실패
                raise KisRateLimitError("EGW00201 rate limited")
            await _asyncio.sleep(0.1)        # 나머지 첫 배치는 실패 시점에 in-flight
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105,
                              volume=10)]

    fake = _RateLimitedSlowKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260508")
        assert r.status_code == 200
        body = r.json()
    # 미시작(D6-D8)은 KIS에 도달하지 않는다 — 원 방어의 핵심.
    assert sorted(fake.calls) == [
        "20260501", "20260502", "20260503", "20260504", "20260505",
    ]
    # in-flight 완주: 실패한 D2를 제외한 첫 배치 4건은 서빙된다.
    assert body["fresh_dates"] == [
        "20260501", "20260503", "20260504", "20260505",
    ]
    assert len(body["candles"]) == 4
    warns = {w["date"]: w["reason"] for w in body["data_warnings"]}
    assert warns["20260502"] == "kis_rate_limit"
    assert warns["20260506"] == warns["20260507"] == warns["20260508"] == "rate_limit_aborted"


@pytest.mark.asyncio
async def test_past_candles_rate_limit_still_serves_later_cache_hits(tmp_path) -> None:
    """When KIS rate-limits mid-range, dates AFTER the abort that are already
    on disk must still be served. Regression for the "candles all disappear
    when scrolling to past" bug: backend used to skip every subsequent date
    unconditionally, so cached dates were dropped from the response and the
    frontend's `kisCandles` shrank while `past.data.segments` (independent of
    KIS) kept full coverage — leaving the candle pane empty over a wide axis."""
    from hoga.live.kis_client import KisRateLimitError
    from hoga.live.past_candles_cache import PastCandlesCache

    # Pre-populate the cache for the date AFTER the rate-limited one, so it
    # would be served as a hit if the loop checks the cache instead of bailing.
    # t_ms must match the requested date (KST) or PastCandlesCache's
    # date-match guard evicts the entry as stale.
    kst = datetime.timezone(datetime.timedelta(hours=9))
    cached_t_ms = int(datetime.datetime(2026, 5, 3, 9, 0, tzinfo=kst).timestamp() * 1000)
    pre_cache = PastCandlesCache(data_dir=tmp_path)
    pre_cache.store_past("005930", "20260503", [
        {"t_ms": cached_t_ms, "open": 200, "high": 210, "low": 195, "close": 205, "volume": 50},
    ])

    class _RateLimitedFakeKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls.append(date_yyyymmdd)
            if date_yyyymmdd == "20260502":
                raise KisRateLimitError("EGW00201 rate limited")
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    fake = _RateLimitedFakeKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260503")
        assert r.status_code == 200
        body = r.json()
        # 20260503's cached bar must be served (this is the regression check).
        assert len(body["candles"]) == 2, (
            f"expected cached date 20260503 to be served alongside 20260501; got candles={body['candles']}"
        )
        assert "20260503" in body["cached_dates"]
        # KIS must still NOT be called for the post-abort date (the existing
        # invariant — don't hammer the rate-limited remote). The fake raises
        # once on 20260502; client retry is opaque to it (covered by
        # test_kis_client.py tests).
        assert fake.calls == ["20260501", "20260502"]
        # The aborted-warning is now only emitted when there was no cache to
        # fall back on. 20260503 was cached, so it should NOT carry a warning.
        warn_dates = [w["date"] for w in body["data_warnings"]]
        assert "20260503" not in warn_dates
        assert any(w["reason"] == "kis_rate_limit" and w["date"] == "20260502" for w in body["data_warnings"])


@pytest.mark.asyncio
async def test_past_candles_weekend_empty_response(tmp_path) -> None:
    """KIS returns [] for non-trading days (weekends, holidays). Endpoint
    should accept that as a normal zero-candle date — no warning."""

    class _EmptyFakeKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            return []

    app = _past_app(tmp_path, _EmptyFakeKis())
    with TestClient(app) as c:
        # 20260516 (Saturday)
        r = c.get("/api/live/past-candles?code=005930&from=20260516&to=20260516")
        assert r.status_code == 200
        body = r.json()
        assert body["candles"] == []
        assert body["data_warnings"] == []
        assert body["fresh_dates"] == ["20260516"]


@pytest.mark.asyncio
async def test_past_candles_disk_cache_survives_router_rebuild(tmp_path) -> None:
    """Past disk cache must survive a new router/cache instance — simulating
    a server restart. Builds two apps against the same tmp_path."""
    kst = datetime.timezone(datetime.timedelta(hours=9))
    yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")

    fake1 = _FakeKisForPast()
    app1 = _past_app(tmp_path, fake1)
    with TestClient(app1) as c:
        c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert fake1.calls == [yesterday]

    # Second router with a *fresh* cache instance (simulating restart). KIS
    # must not be called again — disk hit only.
    fake2 = _FakeKisForPast()
    app2 = _past_app(tmp_path, fake2)
    with TestClient(app2) as c:
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200
        assert fake2.calls == []
        assert r.json()["cached_dates"] == [yesterday]


def test_minute_today_non_trading_day_negative_caches(tmp_path) -> None:
    """When today's KIS minute fetch returns empty, the cache stores a
    negative sentinel so a follow-up request within the TTL skips KIS."""

    class _EmptyTodayKis:
        def __init__(self):
            self.calls = 0

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **_kw):
            self.calls += 1
            return []  # simulate Saturday / holiday today

    fake = _EmptyTodayKis()
    app = _past_app(tmp_path, fake)
    today = _today_kst_yyyymmdd()
    with TestClient(app) as c:
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == 1  # second call skipped via negative cache


def test_past_candles_threads_explicit_venue_to_kis_and_response(tmp_path) -> None:
    class _VenueFakeKis:
        def __init__(self):
            self.kwargs: list[dict] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            self.kwargs.append(kw)
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    fake = _VenueFakeKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=NXT")
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == "NXT"
    assert fake.kwargs == [{"venue": "NXT", "foreground": True}]


def test_past_candles_rejects_invalid_venue_before_kis(tmp_path) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=BAD")

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"
    assert fake.calls == []


def test_past_candles_auto_merges_krx_regular_and_nxt_extended(tmp_path) -> None:
    kst = datetime.timezone(datetime.timedelta(hours=9))

    def ts(hh: int, mm: int) -> int:
        return int(datetime.datetime(2026, 5, 18, hh, mm, tzinfo=kst).timestamp() * 1000)

    class _AutoFakeKis:
        def __init__(self):
            self.venues: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd, **kw):
            venue = kw["venue"]
            self.venues.append(venue)
            if venue == "KRX":
                return [
                    KisCandle(t_ms=ts(9, 0), open=100, high=110, low=95, close=105, volume=10),
                    KisCandle(t_ms=ts(15, 31), open=999, high=999, low=999, close=999, volume=999),
                ]
            return [
                KisCandle(t_ms=ts(8, 0), open=80, high=81, low=79, close=80, volume=8),
                KisCandle(t_ms=ts(15, 31), open=1531, high=1532, low=1530, close=1531, volume=15),
            ]

    fake = _AutoFakeKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=AUTO")
        assert r.status_code == 200
        body = r.json()

    assert sorted(fake.venues) == ["KRX", "NXT"]
    assert body["venue"] == "AUTO"
    assert [datetime.datetime.fromtimestamp(c["t_ms"] / 1000, tz=kst).strftime("%H%M") for c in body["candles"]] == [
        "0800", "0900", "1531",
    ]
    assert [c["close"] for c in body["candles"]] == [80, 105, 1531]


def test_past_candles_integrated_uses_single_kis_un_call(tmp_path) -> None:
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
                return [KisCandle(t_ms=ts(9, 0), open=100, high=112, low=95, close=106, volume=25)]
            raise AssertionError(f"unexpected venue {venue}")

    fake = _IntegratedFakeKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260518&to=20260518&venue=UN")
        assert r.status_code == 200
        body = r.json()

    assert fake.venues == ["UN"]
    assert body["venue"] == "UN"
    assert [datetime.datetime.fromtimestamp(c["t_ms"] / 1000, tz=kst).strftime("%H%M") for c in body["candles"]] == [
        "0900",
    ]
    assert body["candles"][0]["volume"] == 25
    assert body["candles"][0]["open"] == 100
    assert body["candles"][0]["high"] == 112
    assert body["candles"][0]["low"] == 95
    assert body["candles"][0]["close"] == 106


# ----- /api/live/past-daily-candles validation -----

from hoga.live.api import _validate_past_request
from fastapi import HTTPException


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
    from datetime import timedelta as _td, datetime as _dt
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

from hoga.live.kis_client import DailyCandleFetchResult, DailyInvariantViolation


class _FakeKisForDaily:
    """Stub KIS client returning deterministic daily bars."""

    def __init__(self):
        self.calls: list[tuple[str, str, str]] = []
        self.kwargs: list[dict] = []
        self.violations: list[DailyInvariantViolation] = []
        self.raise_rate_limit_on_call: int | None = None

    async def fetch_past_daily_candles(
        self, code: str, from_yyyymmdd: str, to_yyyymmdd: str, **_kw
    ) -> DailyCandleFetchResult:
        idx = len(self.calls)
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
        self.kwargs.append(_kw)
        if self.raise_rate_limit_on_call is not None and idx == self.raise_rate_limit_on_call:
            from hoga.live.kis_client import KisRateLimitError
            raise KisRateLimitError("simulated rate limit")
        from datetime import datetime as _dt, timedelta as _td
        kst = datetime.timezone(datetime.timedelta(hours=9))
        y, m, d = int(from_yyyymmdd[:4]), int(from_yyyymmdd[4:6]), int(from_yyyymmdd[6:8])
        ye, me, de = int(to_yyyymmdd[:4]), int(to_yyyymmdd[4:6]), int(to_yyyymmdd[6:8])
        start = _dt(y, m, d, 9, 0, tzinfo=kst)
        end = _dt(ye, me, de, 9, 0, tzinfo=kst)
        candles = []
        cur = start
        while cur <= end:
            candles.append(KisCandle(
                t_ms=int(cur.timestamp() * 1000),
                open=100, high=110, low=95, close=105, volume=10,
            ))
            cur = cur + _td(days=1)
        return DailyCandleFetchResult(candles=candles, violations=list(self.violations))


def _daily_app(tmp_path, fake_kis):
    from fastapi import FastAPI
    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake_kis)
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    return app


def test_past_daily_cache_miss_calls_kis(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        body = r.json()
        assert len(body["candles"]) == 5
        assert "20240101__20240105" in body["fresh_batches"]
        assert body["cached_batches"] == []
        assert len(fake.calls) == 1


def test_past_daily_threads_explicit_venue_to_kis_and_response(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105&venue=UN")
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == "UN"
    assert fake.kwargs == [{"venue": "UN", "foreground": True}]


def test_past_daily_auto_uses_integrated_venue_with_warning(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105&venue=AUTO")
        assert r.status_code == 200
        body = r.json()

    assert body["venue"] == "AUTO"
    assert fake.kwargs == [{"venue": "UN", "foreground": True}]
    assert any(
        w["reason"] == "auto_daily_uses_integrated"
        and w["batch"] == "20240101__20240105"
        for w in body["data_warnings"]
    )


def test_past_daily_rejects_invalid_venue_before_kis(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105&venue=BAD")

    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_venue"
    assert fake.calls == []


def test_past_daily_cache_hit_skips_kis(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        body = r2.json()
        assert "20240101__20240105" in body["cached_batches"]
        assert body["fresh_batches"] == []
        assert len(fake.calls) == 1


def test_past_daily_partial_hit_gap_fill(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
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


def test_past_daily_rate_limit_surfaces_data_warning(tmp_path) -> None:
    """Daily endpoint inherits ADR-0049: a ``KisRateLimitError`` reaching the
    handler means the client has already exhausted retries. The gap loop then
    breaks and the user sees one ``kis_rate_limit`` warning rather than the
    (now-impossible) wall of retryable transients.
    """
    fake = _FakeKisForDaily()
    fake.raise_rate_limit_on_call = 1
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        c.get("/api/live/past-daily-candles?code=005930&from=20240301&to=20240501")
        # Snapshot the call count after the warm-up call so we can assert the
        # second request's gap loop bails out after the rate-limited call.
        warmup_calls = len(fake.calls)
        r2 = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240501")
        body = r2.json()
        assert any(w["reason"] == "kis_rate_limit" for w in body["data_warnings"])
        # Gap loop must break after the first EGW00201 — no further KIS
        # calls for later gap batches in the SAME request. (Client retries
        # are opaque to the fake; they don't show up as additional calls.)
        post_warmup_calls = len(fake.calls) - warmup_calls
        assert post_warmup_calls == 1, (
            f"expected gap loop to break after one rate-limited call; got "
            f"{post_warmup_calls} calls: {fake.calls[warmup_calls:]}"
        )


def test_past_daily_violation_surfaces_to_wire(tmp_path) -> None:
    fake = _FakeKisForDaily()
    fake.violations = [DailyInvariantViolation(
        date_yyyymmdd="20240103", reason="close_nonpositive", detail="close=0",
    )]
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        body = r.json()
        warn = [w for w in body["data_warnings"] if w["reason"] == "invariant_violation"]
        assert len(warn) == 1
        assert "20240103" in warn[0]["msg"]
        assert warn[0]["date"] == "20240103"


def test_past_daily_dedupes_and_sorts_overlapping_batches(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
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
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        data_dir=tmp_path,
    ))
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240105")
        assert r.status_code == 503


def test_past_daily_empty_gap_caches_and_does_not_refetch(tmp_path) -> None:
    """KIS returning [] for a gap (range fully non-trading) must still cache
    the empty batch so a follow-up request inside that range hits the cache
    instead of re-calling KIS. Prevents infinite re-fetch on holiday ranges."""

    class _EmptyKis(_FakeKisForDaily):
        async def fetch_past_daily_candles(self, code, from_yyyymmdd, to_yyyymmdd, **_kw):
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            from hoga.live.kis_client import DailyCandleFetchResult
            return DailyCandleFetchResult(candles=[], violations=[])

    fake = _EmptyKis()
    app = _daily_app(tmp_path, fake)
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


def test_past_daily_single_day_past_request(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-daily-candles?code=005930&from=20240101&to=20240101")
        assert r.status_code == 200
        body = r.json()
        assert len(body["candles"]) == 1
        assert len(fake.calls) == 1
        _, gap_from, gap_to = fake.calls[0]
        assert gap_from == "20240101" and gap_to == "20240101"


def test_past_daily_today_only_request_skips_gap_branch(tmp_path) -> None:
    fake = _FakeKisForDaily()
    app = _daily_app(tmp_path, fake)
    today = _today_kst_yyyymmdd()
    with TestClient(app) as c:
        r = c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        assert r.status_code == 200
        assert len(fake.calls) == 1
        _, call_from, call_to = fake.calls[0]
        assert call_from == today and call_to == today


def test_past_daily_today_negative_cache_skips_kis_within_ttl(tmp_path) -> None:
    class _EmptyTodayKis(_FakeKisForDaily):
        async def fetch_past_daily_candles(self, code, from_yyyymmdd, to_yyyymmdd, **_kw):
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            from hoga.live.kis_client import DailyCandleFetchResult
            return DailyCandleFetchResult(candles=[], violations=[])

    fake = _EmptyTodayKis()
    app = _daily_app(tmp_path, fake)
    today = _today_kst_yyyymmdd()
    with TestClient(app) as c:
        c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        c.get(f"/api/live/past-daily-candles?code=005930&from={today}&to={today}")
        assert len(fake.calls) == 1


# ----- /api/live/past-investor-net -----

from hoga.live.kis_client import (
    InvestorNetFetchResult,
    InvestorNetInvariantViolation,
)
from hoga.live.kis_models import InvestorNetPoint, InvestorTrendEstimateRow


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
            from hoga.live.kis_client import KisRateLimitError
            raise KisRateLimitError("simulated rate limit")
        from datetime import datetime as _dt, timedelta as _td
        kst = datetime.timezone(datetime.timedelta(hours=9))
        y, m, d = int(from_yyyymmdd[:4]), int(from_yyyymmdd[4:6]), int(from_yyyymmdd[6:8])
        ye, me, de = int(to_yyyymmdd[:4]), int(to_yyyymmdd[4:6]), int(to_yyyymmdd[6:8])
        cur = _dt(y, m, d, 9, 0, tzinfo=kst)
        end = _dt(ye, me, de, 9, 0, tzinfo=kst)
        points: list[InvestorNetPoint] = []
        while cur <= end:
            points.append(InvestorNetPoint(
                t_ms=int(cur.timestamp() * 1000), foreign_net=100, institution_net=-50,
            ))
            cur = cur + _td(days=1)
        return InvestorNetFetchResult(points=points, violations=list(self.violations))


def _investor_app(tmp_path, fake_kis):
    from fastapi import FastAPI
    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake_kis)
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        data_dir=tmp_path,
    ))
    return app


def _two_account_app(tmp_path, monkeypatch, fake0, fake1):
    """N=2 라우팅 검증용: account 0/1에 서로 다른 fake를 주입하고 env 2종을 세팅한다.
    build_router가 모든 라우트를 한 라우터에 마운트하므로 라우트 중립 — foreground
    (past-candles→account 0)·background(investor-net/quotes→account 1) 양쪽 spy 검증에
    공용(계정 분리 2026-06-09, C1b 2026-06-10 일반화)."""
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
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        data_dir=tmp_path,
    ))
    return app


def test_past_investor_net_routes_background_to_account1(tmp_path, monkeypatch) -> None:
    """N=2 정상: 배경 라우트가 account 1(유휴였던 REST 버킷)을 쓴다 — account 0은 무호출."""
    monkeypatch.setattr("hoga.live.account_health._ws_probe", lambda: set())
    fake0, fake1 = _FakeKisForInvestor(), _FakeKisForInvestor()
    app = _two_account_app(tmp_path, monkeypatch, fake0, fake1)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        assert len(fake1.calls) == 1, "background가 account 1을 쓰지 않음"
        assert len(fake0.calls) == 0, "account 0(foreground 전용)이 background에 침범"


def test_past_investor_net_account1_degraded_falls_back_to_account0(tmp_path, monkeypatch) -> None:
    """N=2이지만 account 1 REST 토큰 저하 → 배경 라우트가 account 0로 폴백(②우선순위 보호).

    REST 라우팅은 REST 토큰 latch(is_rest_degraded)만 본다(WS sub_failed는 직교 — 폴백 무관,
    2026-06-10). 그래서 degraded를 mark_rest_auth_degraded(1)로 위조한다. _two_account_app가
    내부에서 reset_for_tests로 latch를 비우므로 app 구성 *후*에 마킹한다."""
    from hoga.live import account_health
    fake0, fake1 = _FakeKisForInvestor(), _FakeKisForInvestor()
    app = _two_account_app(tmp_path, monkeypatch, fake0, fake1)
    account_health.mark_rest_auth_degraded(1)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        assert len(fake0.calls) == 1, "degraded인데 account 0로 폴백 안 됨"
        assert len(fake1.calls) == 0, "degraded account 1을 그대로 사용"


def test_past_candles_routes_foreground_to_account0(tmp_path, monkeypatch) -> None:
    """N=2: foreground 라우트(past-candles)는 account 0 전용 — account 1(배경 REST
    버킷)을 건드리지 않는다. C1b 라우트 레벨 가드: 라우트의 'foreground' 문자열이
    'background'로 뒤집히면 N=2에서 account 1로 새므로 fake1.calls>0로 잡힌다."""
    fake0, fake1 = _FakeKisForPast(), _FakeKisForPast()
    app = _two_account_app(tmp_path, monkeypatch, fake0, fake1)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        assert len(fake0.calls) >= 1, "foreground가 account 0(전용 버킷)를 쓰지 않음"
        assert len(fake1.calls) == 0, "foreground가 account 1(배경 버킷)에 침범"


def test_past_investor_net_miss_calls_kis(tmp_path) -> None:
    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake)
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


def test_past_investor_net_cache_hit_skips_kis(tmp_path) -> None:
    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake)
    with TestClient(app) as c:
        c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        r2 = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        body = r2.json()
        assert "20240101__20240105" in body["cached_batches"]
        assert body["fresh_batches"] == []
        assert len(fake.calls) == 1


def test_past_investor_net_partial_hit_gap_fill(tmp_path) -> None:
    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake)
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


def test_past_investor_net_rejects_invalid_code(tmp_path) -> None:
    fake = _FakeKisForInvestor()
    app = _investor_app(tmp_path, fake)
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
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        data_dir=tmp_path,
    ))
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        assert r.status_code == 503


def test_past_investor_net_rate_limit_surfaces_warning(tmp_path) -> None:
    fake = _FakeKisForInvestor()
    fake.raise_rate_limit_on_call = 0
    app = _investor_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        assert r.status_code == 200
        body = r.json()
        assert any(w["reason"] == "kis_rate_limit" for w in body["data_warnings"])


def test_past_investor_net_violation_surfaces_to_wire(tmp_path) -> None:
    fake = _FakeKisForInvestor()
    fake.violations = [InvestorNetInvariantViolation(
        date_yyyymmdd="20240103", reason="malformed_row", detail="bad",
    )]
    app = _investor_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        body = r.json()
        warn = [w for w in body["data_warnings"] if w["reason"] == "invariant_violation"]
        assert len(warn) >= 1
        assert warn[0]["date"] == "20240103"


def test_past_investor_net_empty_result_cached(tmp_path) -> None:
    class _EmptyKis(_FakeKisForInvestor):
        async def fetch_investor_net(self, code, from_yyyymmdd, to_yyyymmdd):
            self.calls.append((code, from_yyyymmdd, to_yyyymmdd))
            return InvestorNetFetchResult(points=[], violations=[])

    fake = _EmptyKis()
    app = _investor_app(tmp_path, fake)
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
) -> InvestorTrendEstimateRow:
    return InvestorTrendEstimateRow(
        slot=slot,
        foreign_qty=foreign_qty,
        institution_qty=institution_qty,
        sum_qty=sum_qty,
    )


@pytest.mark.asyncio
async def test_investor_estimate_latest_only_accumulates_same_day_and_overwrites_slot(monkeypatch) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        [InvestorTrendEstimateRow(slot="0910", foreign_qty=11, institution_qty=21, sum_qty=32)],
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=99, institution_qty=1, sum_qty=100)],
    ])
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
    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        [
            InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30),
            InvestorTrendEstimateRow(slot="0920", foreign_qty=12, institution_qty=22, sum_qty=34),
        ],
    ])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    await fetcher.fetch(fake, "005930")
    now = 160.0
    response = await fetcher.fetch(fake, "005930")

    assert [r.slot for r in response.rows] == ["0900", "0920"]
    assert [(r.slot, r.observed_at_ms) for r in response.rows] == [("0900", 100_000), ("0920", 160_000)]
    assert response.latest and response.latest.slot == "0920"


@pytest.mark.asyncio
async def test_investor_estimate_full_history_preserves_past_slot_timestamp(monkeypatch) -> None:
    from hoga.live import api as live_api
    from hoga.live.api import LiveInvestorEstimateFetcher

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)
    fake = _FakeKisForInvestorTrendEstimate([
        [
            InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30),
            InvestorTrendEstimateRow(slot="0910", foreign_qty=11, institution_qty=21, sum_qty=32),
        ],
        [
            InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30),
            InvestorTrendEstimateRow(slot="0910", foreign_qty=99, institution_qty=1, sum_qty=100),
        ],
    ])
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
    fake = _FakeKisForInvestorTrendEstimate([
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
    ])
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
    first_fake = _FakeKisForInvestorTrendEstimate([
        [
            _investor_estimate_row_model("1", -95_000, 0, -95_000),
            _investor_estimate_row_model("2", -106_000, 0, -106_000),
        ],
    ])
    first_fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    await first_fetcher.fetch(first_fake, "005930")

    now = 160.0
    second_fake = _FakeKisForInvestorTrendEstimate([
        [
            _investor_estimate_row_model("1", -95_000, 0, -95_000),
            _investor_estimate_row_model("2", -106_000, 0, -106_000),
            _investor_estimate_row_model("3", -117_000, 0, -117_000),
        ],
    ])
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
    fake = _FakeKisForInvestorTrendEstimate([
        [_investor_estimate_row_model("1", -95_000, 0, -95_000)],
    ])
    fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    response = await fetcher.fetch(fake, "005930")

    assert [(r.slot, r.observed_at_ms) for r in response.rows] == [("1", 100_000)]


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
    first_fake = _FakeKisForInvestorTrendEstimate([
        [
            _investor_estimate_row_model("1", -95_000, 0, -95_000),
            _investor_estimate_row_model("2", -106_000, 0, -106_000),
        ],
        [
            _investor_estimate_row_model("1", -95_000, 0, -95_000),
            _investor_estimate_row_model("3", -117_000, 0, -117_000),
        ],
    ])
    fetcher = LiveInvestorEstimateFetcher(
        ttl_seconds=0,
        today_fn=lambda: "20260619",
        observed_at_store_path=store_path,
    )

    await fetcher.fetch(first_fake, "005930")
    now = 160.0
    await fetcher.fetch(first_fake, "005930")

    now = 220.0
    second_fake = _FakeKisForInvestorTrendEstimate([
        [
            _investor_estimate_row_model("1", -95_000, 0, -95_000),
            _investor_estimate_row_model("2", -106_000, 0, -106_000),
        ],
    ])
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
        fake = _FakeKisForInvestorTrendEstimate([
            [_investor_estimate_row_model("1", i, 0, i)],
        ])
        await fetcher.fetch(fake, f"{i:06d}")

    state = json.loads(store_path.read_text(encoding="utf-8"))
    assert len(state["20260619"]) == _INVESTOR_ESTIMATE_MAX_CODES_PER_DAY
    assert "000000" not in state["20260619"]


@pytest.mark.asyncio
async def test_investor_estimate_empty_success_clears_same_day_accumulator() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        [],
    ])
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

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=None, institution_qty=None, sum_qty=None)],
    ])
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

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
    ])
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
    from hoga.live.kis_client import KisRateLimitError

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        KisRateLimitError("rate limited"),
    ])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    await fetcher.fetch(fake, "005930")
    response = await fetcher.fetch(fake, "005930")

    assert response.status == "error"
    assert response.data_warning and response.data_warning.reason == "kis_rate_limit"
    assert [r.slot for r in response.rows] == ["0900"]


@pytest.mark.asyncio
async def test_investor_estimate_auth_failure_returns_degraded_credentials_warning() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher
    from hoga.live.kis_client import KisAuthError

    fake = _FakeKisForInvestorTrendEstimate([
        KisAuthError("token issue failed"),
    ])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    response = await fetcher.fetch(fake, "005930")

    assert response.status == "error"
    assert response.data_warning
    assert response.data_warning.reason == "kis_credentials_missing"
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

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        [InvestorTrendEstimateRow(slot="0930", foreign_qty=11, institution_qty=21, sum_qty=32)],
    ])
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
    fake = _FakeKisForInvestorTrendEstimate([
        ([] if i % 2 == 0 else [InvestorTrendEstimateRow(slot="0900", foreign_qty=i, institution_qty=0, sum_qty=i)])
        for i in range(_INVESTOR_ESTIMATE_MAX_CODES_PER_DAY + 1)
    ])
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
    from hoga.live.kis_client import KisRateLimitError

    now = 100.0
    monkeypatch.setattr(live_api.monotonic_time, "monotonic", lambda: now)
    monkeypatch.setattr(live_api.monotonic_time, "time", lambda: now)

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        KisRateLimitError("rate limited"),
        KisRateLimitError("rate limited again"),
    ])
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
    assert second_degraded.data_warning.reason == "kis_rate_limit"


@pytest.mark.asyncio
async def test_investor_estimate_api_and_transport_errors_preserve_previous_rows() -> None:
    import httpx

    from hoga.live.api import LiveInvestorEstimateFetcher
    from hoga.live.kis_client import KisApiError, KisTransportError

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        KisTransportError(httpx.RemoteProtocolError("server disconnected")),
        KisApiError("KIS999", "upstream rejected request"),
    ])
    fetcher = LiveInvestorEstimateFetcher(ttl_seconds=0, today_fn=lambda: "20260616")

    await fetcher.fetch(fake, "005930")
    transport_response = await fetcher.fetch(fake, "005930")
    api_response = await fetcher.fetch(fake, "005930")

    assert transport_response.status == "error"
    assert transport_response.data_warning
    assert transport_response.data_warning.reason == "kis_api_error"
    assert [r.slot for r in transport_response.rows] == ["0900"]
    assert api_response.status == "error"
    assert api_response.data_warning
    assert api_response.data_warning.reason == "kis_api_error"
    assert [r.slot for r in api_response.rows] == ["0900"]


@pytest.mark.asyncio
async def test_investor_estimate_parse_error_degrades() -> None:
    from hoga.live.api import LiveInvestorEstimateFetcher

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)],
        [
            InvestorTrendEstimateRow(
                slot="0910",
                foreign_qty=11,
                institution_qty=21,
                sum_qty=32,
            ).model_copy(update={"foreign_qty": "not-an-int"})
        ],
    ])
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


def _investor_estimate_app(tmp_path, fake_kis=None):
    from fastapi import FastAPI
    from hoga.live import kis_runtime, lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    if fake_kis is not None:
        kis_runtime.set_kis_client(fake_kis)
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    return app


def test_investor_trend_estimate_route_uses_background_role(tmp_path, monkeypatch) -> None:
    from hoga.live import kis_access

    fake = _FakeKisForInvestorTrendEstimate([
        [InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30)]
    ])
    seen = {}

    def fake_kis_for_role(role, data_dir):
        seen["role"] = role
        seen["data_dir"] = data_dir
        return fake

    monkeypatch.setattr(kis_access, "kis_for_role", fake_kis_for_role)
    app = _investor_estimate_app(tmp_path)
    r = TestClient(app).get("/api/live/investor-trend-estimate", params={"code": "005930"})

    assert r.status_code == 200
    assert seen == {"role": "background", "data_dir": tmp_path}


def test_investor_trend_estimate_route_returns_expected_rows(tmp_path) -> None:
    fake = _FakeKisForInvestorTrendEstimate([
        [
            InvestorTrendEstimateRow(slot="0900", foreign_qty=10, institution_qty=20, sum_qty=30),
            InvestorTrendEstimateRow(slot="0910", foreign_qty=15, institution_qty=None, sum_qty=15),
        ]
    ])
    app = _investor_estimate_app(tmp_path, fake)

    r = TestClient(app).get("/api/live/investor-trend-estimate", params={"code": "005930"})

    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "005930"
    assert body["source"] == "kis"
    assert body["status"] == "ok"
    assert body["rows"] == [
        {
            "slot": "0900",
            "observed_at_ms": body["fetched_at_ms"],
            "foreign_qty": 10,
            "institution_qty": 20,
            "sum_qty": 30,
        },
        {
            "slot": "0910",
            "observed_at_ms": body["fetched_at_ms"],
            "foreign_qty": 15,
            "institution_qty": None,
            "sum_qty": 15,
        },
    ]
    assert body["latest"]["slot"] == "0910"
    assert body["data_warning"] is None


def test_investor_trend_estimate_route_rejects_invalid_code(tmp_path) -> None:
    app = _investor_estimate_app(tmp_path, _FakeKisForInvestorTrendEstimate())

    r = TestClient(app).get("/api/live/investor-trend-estimate", params={"code": "ABC"})

    assert r.status_code == 422


def test_investor_trend_estimate_route_missing_kis_returns_degraded_error(tmp_path) -> None:
    app = _investor_estimate_app(tmp_path)

    r = TestClient(app).get("/api/live/investor-trend-estimate", params={"code": "005930"})

    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "005930"
    assert body["status"] == "error"
    assert body["fetched_at_ms"] is None
    assert body["rows"] == []
    assert body["latest"] is None
    assert body["data_warning"]["reason"] == "kis_credentials_missing"
