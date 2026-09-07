from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live import kiwoom_daily_candles, kiwoom_rest_runtime
from hoga.live.api import batched_daily_walkback
from hoga.live.candle_fetch_result import DailyCandleFetchResult, DailyInvariantViolation
from hoga.live.candle_models import LiveCandle
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.live_daily_candle_backfill import LiveDailyCandleBackfill
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache


def _daily_candles(from_yyyymmdd: str, to_yyyymmdd: str, *, close: int = 105) -> list[LiveCandle]:
    kst = dt.timezone(dt.timedelta(hours=9))
    start = dt.date(
        int(from_yyyymmdd[:4]),
        int(from_yyyymmdd[4:6]),
        int(from_yyyymmdd[6:8]),
    )
    end = dt.date(
        int(to_yyyymmdd[:4]),
        int(to_yyyymmdd[4:6]),
        int(to_yyyymmdd[6:8]),
    )
    out: list[LiveCandle] = []
    cur = start
    while cur <= end:
        out.append(
            LiveCandle(
                t_ms=int(dt.datetime(cur.year, cur.month, cur.day, 9, 0, tzinfo=kst).timestamp() * 1000),
                open=100,
                high=110,
                low=95,
                close=close,
                volume=10,
            )
        )
        cur = cur + dt.timedelta(days=1)
    return out


def _walked_end(to_yyyymmdd: str, adjusted_as_of: str | None) -> str:
    """진짜 어댑터는 **기준일까지** 걸어 내려오며 그 사이 행을 다 돌려준다(#1228).

    페이크가 요청 구간만 돌려주면 커버리지 확장이 캐시 정규화에서 되감기고
    (경계가 실제 행 범위로 조여진다) 갭 스킵 테스트가 아무것도 증명하지 못한다.
    """
    return max(to_yyyymmdd, adjusted_as_of) if adjusted_as_of else to_yyyymmdd


async def _fake_page_fetch(_client):
    """페이크 어댑터가 러너에 넘기는 페이지 팩토리.

    러너는 프로덕션 코드(`run_with_capacity`)라 반드시 실행되어야 하지만, 페이크
    클라이언트에는 `call` 이 없으므로 진짜 페이지 fetch 를 넣을 수 없다. 빈 페이지를
    돌려주는 팩토리를 넣어 **거버너 경로만** 실제로 지나게 한다.
    """
    from hoga.live.kiwoom_rest import Page

    return Page(rows=[], cont=False, next_key="")


class _FakeKis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str | None, bool, str | None]] = []

    async def fetch_daily_candles(
        self,
        _client,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: str | None = None,
        adjust: bool,
        adjusted_as_of: str | None,
        run_page=None,
    ) -> DailyCandleFetchResult:
        # **기본값을 두지 않는다.** 진짜 어댑터가 둘 다 필수로 요구하므로 페이크도
        # 그래야 한다 — 기본값을 주면 프로덕션이 척도를 안 넘겨도 테스트가 통과한다.
        self.calls.append(
            (code, from_yyyymmdd, to_yyyymmdd, venue, adjust, adjusted_as_of)
        )
        if run_page is not None:
            # 진짜 어댑터와 같은 계약: 페이지 I/O 는 러너를 지난다. 이 호출이 없으면
            # 페이크가 거버너를 건너뛰어 유량·과부하 검증이 조용히 죽는다.
            await run_page(_fake_page_fetch, 0)
        return DailyCandleFetchResult(
            candles=_daily_candles(
                from_yyyymmdd, _walked_end(to_yyyymmdd, adjusted_as_of)
            ),
            violations=[],
        )


class _FallbackKis(_FakeKis):
    async def fetch_daily_candles(
        self,
        _client,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: str | None = None,
        adjust: bool,
        adjusted_as_of: str | None,
        run_page=None,
    ) -> DailyCandleFetchResult:
        # **기본값을 두지 않는다.** 진짜 어댑터가 둘 다 필수로 요구하므로 페이크도
        # 그래야 한다 — 기본값을 주면 프로덕션이 척도를 안 넘겨도 테스트가 통과한다.
        self.calls.append(
            (code, from_yyyymmdd, to_yyyymmdd, venue, adjust, adjusted_as_of)
        )
        if run_page is not None:
            # 진짜 어댑터와 같은 계약: 페이지 I/O 는 러너를 지난다. 이 호출이 없으면
            # 페이크가 거버너를 건너뛰어 유량·과부하 검증이 조용히 죽는다.
            await run_page(_fake_page_fetch, 0)
        if venue == "UN":
            return DailyCandleFetchResult(candles=[], violations=[])
        return DailyCandleFetchResult(
            candles=_daily_candles(
                from_yyyymmdd, _walked_end(to_yyyymmdd, adjusted_as_of), close=205
            ),
            violations=[],
        )


class _RecordingScheduler:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: str,
        call: Callable[[object | None], Awaitable],
    ):
        # 계정 차원(endpoint·cooldown_scope)은 PR-F(#1042)에서 사라졌다 —
        # 키움 유량은 TR별이라 고를 계정이 없다(#1015). api_id 가 버킷 키다.
        self.calls.append({"key": key, "api_id": api_id, "priority": priority})
        return await call(None)


@pytest.fixture
def kiwoom(monkeypatch):
    """키움 이음매 2점(클라이언트 조달·어댑터 함수)을 갈아끼운다.

    PR-F 이후 소비자는 클라이언트 객체를 들고 다니지 않는다: 런타임에서 받아
    **모듈 레벨 어댑터 함수**를 부른다. 그래서 페이크도 그 함수 자리에 꽂는다.
    """
    def _install(fake: _FakeKis) -> _FakeKis:
        monkeypatch.setattr(
            kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object()
        )
        monkeypatch.setattr(
            kiwoom_daily_candles, "fetch_daily_candles", fake.fetch_daily_candles
        )
        return fake

    return _install


@pytest.mark.asyncio
async def test_live_daily_candle_backfill_schedules_past_daily_fetches(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FakeKis())
    scheduler = _RecordingScheduler()
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=scheduler,  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    result = await backfill.collect_daily(
        code="005930",
        frm=dt.date(2024, 1, 1),
        too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 2, 1),
        policy="UN",
        from_label="20240101",
        to_label="20240105",
    )

    assert result["venue"] == "UN"
    # 라벨은 요청한 갭 그대로다 — 벤더 왕복 기록이지 캐시 커버리지 기록이 아니다.
    assert result["fresh_batches"] == ["20240101__20240105"]
    assert len(result["candles"]) == 5
    # 끝의 두 칸이 **척도**다: 수정주가(True) · 기준일은 배치의 끝(20240105)이 아니라
    # **오늘**(20240201). 기준일이 배치를 따라가면 액면분할 절벽이 생긴다(함정 ④).
    assert kis.calls == [("005930", "20240101", "20240105", "UN", True, "20240201")]
    assert scheduler.calls == [
        {
            # 끝의 0 은 **페이지 인덱스** — 거버너 단위가 페이지다(ADR-0137).
            "key": ("live-candle-backfill", "daily", "UN", "005930",
                    "20240101", "20240105", 0),
            "api_id": "ka10081",
            "priority": "user_visible",
        }
    ]


class _GatedKis(_FakeKis):
    """Blocks inside the first fetch so a second concurrent request races into
    (or is coalesced out of) the walk-back."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()

    async def fetch_daily_candles(
        self,
        _client,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: str | None = None,
        adjust: bool,
        adjusted_as_of: str | None,
        run_page=None,
    ) -> DailyCandleFetchResult:
        # **기본값을 두지 않는다.** 진짜 어댑터가 둘 다 필수로 요구하므로 페이크도
        # 그래야 한다 — 기본값을 주면 프로덕션이 척도를 안 넘겨도 테스트가 통과한다.
        self.calls.append(
            (code, from_yyyymmdd, to_yyyymmdd, venue, adjust, adjusted_as_of)
        )
        if run_page is not None:
            # 진짜 어댑터와 같은 계약: 페이지 I/O 는 러너를 지난다. 이 호출이 없으면
            # 페이크가 거버너를 건너뛰어 유량·과부하 검증이 조용히 죽는다.
            await run_page(_fake_page_fetch, 0)
        await self.gate.wait()
        return DailyCandleFetchResult(
            candles=_daily_candles(
                from_yyyymmdd, _walked_end(to_yyyymmdd, adjusted_as_of)
            ),
            violations=[],
        )


@pytest.mark.asyncio
async def test_collect_daily_coalesces_concurrent_same_venue_code_requests(tmp_path, kiwoom) -> None:
    # Overlapping [from, today] requests for the same (venue, code) on a cold
    # cache must share one KIS walk-back — the second reads the warm cache.
    kis = kiwoom(_GatedKis())
    scheduler = _RecordingScheduler()
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=scheduler,  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    async def one(frm: dt.date, from_label: str):
        return await backfill.collect_daily(
            code="005930",
            frm=frm,
            too=dt.date(2024, 1, 10),
            today_d=dt.date(2024, 2, 1),
            policy="KRX",
            from_label=from_label,
            to_label="20240110",
        )

    t1 = asyncio.create_task(one(dt.date(2024, 1, 1), "20240101"))
    t2 = asyncio.create_task(one(dt.date(2024, 1, 5), "20240105"))

    for _ in range(100):
        await asyncio.sleep(0)
        if kis.calls:
            break
    assert len(kis.calls) == 1

    kis.gate.set()
    r1, r2 = await asyncio.gather(t1, t2)

    assert len(kis.calls) == 1
    assert len(r1["candles"]) == 10
    assert len(r2["candles"]) == 6
    assert r2["fresh_batches"] == []
    # 캐시된 구간이 요청 끝(0110)이 아니라 **오늘 직전**(0131)까지다 — 어댑터가
    # 기준일에서 걸어 내려오며 받은 행을 커버리지로 인정한 결과다. 이것이 다음
    # 요청에서 갭이 안 생기게 만드는 지점이다(#1228 후속).
    assert r2["cached_batches"] == ["20240101__20240131"]


@pytest.mark.asyncio
async def test_live_daily_candle_backfill_falls_back_to_krx_for_empty_integrated(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FallbackKis())
    scheduler = _RecordingScheduler()
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=scheduler,  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    result = await backfill.collect_daily(
        code="005930",
        frm=dt.date(2024, 1, 1),
        too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 2, 1),
        policy="UN",
        from_label="20240101",
        to_label="20240105",
    )

    assert len(result["candles"]) == 5
    assert result["candles"][0]["close"] == 205
    # venue 는 `cooldown_scope`(계정 축) 가 아니라 **중복제거 key** 로만 구분된다 —
    # PR-F(#1042)에서 계정 차원이 사라졌기 때문이다(#1015). key 쪽이 더 강한 신호다:
    # primary/fallback 을 함께 못 박는다.
    assert [call["key"][2] for call in scheduler.calls] == ["UN", "KRX"]
    # 위치가 아니라 **포함**으로 본다 — key 끝에 페이지 인덱스가 붙기 때문이다.
    assert "fallback" in scheduler.calls[1]["key"]
    assert [c[3] for c in kis.calls] == ["UN", "KRX"], "어댑터에도 venue 가 흘러야 한다"
    assert any(
        warning["reason"] == "daily_fallback_to_krx"
        and warning["batch"] == "20240101__20240105"
        for warning in result["data_warnings"]
    )


class _OverloadedScheduler:
    """거버너가 큐 포화로 신규 요청을 거절하는 상태."""

    async def submit(self, *, key, api_id, priority, call):
        raise KiwoomCapacityOverloaded("queue full (128)")


@pytest.mark.asyncio
async def test_capacity_overload_is_not_disguised_as_a_vendor_rate_limit(tmp_path, kiwoom) -> None:
    """거버너 큐 포화를 **벤더 유량 초과로 위장하지 않는다.**

    예전엔 `_fetch` 가 `KiwoomCapacityOverloaded` 를 `KisRateLimitError` 로 감쌌다.
    상위 walkback 이 그 타입으로만 경고를 만들었기 때문인데, 그 편법이 두 거짓을
    만들었다: (1) 사유가 `rate_limit_upstream` 이라 **묻지도 않은 벤더**가 거절한
    것처럼 보였고, (2) 같은 사건을 분봉 경로는 `capacity_overloaded` 로 불러서 두
    경로가 같은 일에 다른 이름을 붙였다.

    이 테스트가 재는 것은 **경계에서 타입이 바뀌지 않는다**는 것이다 — 사유 문자열은
    이제 `error_policy` 가 정하므로, 위장이 남아 있으면 여기서 이름이 갈린다.
    """
    kiwoom(_FakeKis())
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=_OverloadedScheduler(),  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    result = await backfill.collect_daily(
        code="005930",
        frm=dt.date(2024, 1, 1),
        too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 2, 1),
        policy="KRX",
        from_label="20240101",
        to_label="20240105",
    )

    reasons = [w["reason"] for w in result["data_warnings"]]
    assert reasons == ["capacity_overloaded"]
    assert "rate_limit_upstream" not in reasons, (
        "벤더는 이 구간을 거절한 적이 없다 — 우리 큐가 찼을 뿐이다"
    )
    assert result["candles"] == []
    # 500 으로 새지 않는 것도 함께 잰다(투자자 경로는 이 타입을 아무도 안 잡아서
    # 실제로 500 이 났다).
    assert result["fresh_batches"] == []


@pytest.mark.asyncio
async def test_missing_client_is_permanent_not_retry_soon(tmp_path, monkeypatch) -> None:
    """자격증명이 사라진 상태를 "잠시 후 재시도" 로 안내하지 않는다(ADR-0137 R4).

    예전엔 이것도 `KisRateLimitError` 였다 — 고치기 전에는 영원히 같은 실패인데
    기다리라고 말하는 셈이었다. 정상 경로에서는 라우트가 앞서 503 `not_wired` 로
    막으므로, 여기까지 오는 것은 요청 도중 자격증명이 사라진 경우뿐이다.
    """
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: None)
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    result = await backfill.collect_daily(
        code="005930",
        frm=dt.date(2024, 1, 1),
        too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 2, 1),
        policy="KRX",
        from_label="20240101",
        to_label="20240105",
    )

    assert [w["reason"] for w in result["data_warnings"]] == ["auth_error"]


def _rows(from_yyyymmdd: str, to_yyyymmdd: str) -> list[dict]:
    return [
        {"t_ms": c.t_ms, "open": c.open, "high": c.high,
         "low": c.low, "close": c.close, "volume": c.volume}
        for c in _daily_candles(from_yyyymmdd, to_yyyymmdd)
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", ["KRX", "NXT", "UN"])
async def test_cold_daily_reuses_today_from_fresh_adjusted_history(
    tmp_path, kiwoom, policy,
) -> None:
    kis = kiwoom(_FakeKis())
    cache = PastDailyCandlesCache()
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=_RecordingScheduler(),
        walkback=batched_daily_walkback,
    )
    args = dict(
        code="066570", frm=dt.date(2024, 1, 1), too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 1, 5), policy=policy,
        from_label="20240101", to_label="20240105",
    )
    first = await backfill.collect_daily(**args)
    warm = await backfill.collect_daily(**args)

    assert len(kis.calls) == 1, "the history response already contains today's candle"
    assert kis.calls[0][4:] == (True, "20240105")
    assert first["candles"] == warm["candles"] == _rows("20240101", "20240105")
    assert first["fresh_batches"] == ["20240101__20240104"]
    assert warm["fresh_batches"] == []
    assert cache.get_today(policy, "066570") == ("hit", _rows("20240105", "20240105")[0])
    assert cache.get_today(policy, "005930") == ("miss", None)
    other_venue = "NXT" if policy == "KRX" else "KRX"
    assert cache.get_today(other_venue, "066570") == ("miss", None)
    assert all(row["t_ms"] < _rows("20240105", "20240105")[0]["t_ms"]
               for _, _, rows, _ in cache.list_batches(policy, "066570") for row in rows)


@pytest.mark.asyncio
async def test_historical_only_daily_request_does_not_seed_today(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FakeKis())
    cache = PastDailyCandlesCache()
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=_RecordingScheduler(),
        walkback=batched_daily_walkback,
    )
    out = await backfill.collect_daily(
        code="066570", frm=dt.date(2024, 1, 1), too=dt.date(2024, 1, 4),
        today_d=dt.date(2024, 1, 5), policy="KRX", from_label="20240101", to_label="20240104",
    )
    assert len(kis.calls) == 1
    assert out["candles"] == _rows("20240101", "20240104")
    assert cache.get_today("KRX", "066570") == ("miss", None)


@pytest.mark.asyncio
async def test_concurrent_cold_daily_requests_make_one_wire_call(tmp_path, monkeypatch) -> None:
    import json

    import httpx

    from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler
    from hoga.live.kiwoom_rest import KiwoomRestClient

    class Token:
        def get_token(self):
            return "test-token"

    calls = []
    async def wire(request):
        calls.append((request.headers["api-id"], json.loads(request.content)))
        return httpx.Response(200, json={"return_code": 0, "stk_dt_pole_chart_qry": [
            {"dt": day, "open_pric": "100", "high_pric": "110", "low_pric": "95",
             "cur_prc": "105", "trde_qty": "10"}
            for day in ["20240105", "20240104", "20240103", "20240102", "20240101"]
        ]})

    client = KiwoomRestClient(Token(), transport=httpx.MockTransport(wire))
    scheduler = KiwoomCapacityScheduler()
    scheduler.set_clients([client])
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_: client)
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path, cache=PastDailyCandlesCache(), scheduler=scheduler,
        walkback=batched_daily_walkback,
    )
    async def collect(frm):
        return await backfill.collect_daily(
            code="066570", frm=frm, too=dt.date(2024, 1, 5), today_d=dt.date(2024, 1, 5),
            policy="KRX", from_label=frm.strftime("%Y%m%d"), to_label="20240105",
        )
    try:
        first, second = await asyncio.gather(collect(dt.date(2024, 1, 1)), collect(dt.date(2024, 1, 3)))
        assert calls == [("ka10081", {"stk_cd": "066570", "base_dt": "20240105", "upd_stkpc_tp": "1"})]
        assert first["candles"] == _rows("20240101", "20240105")
        assert second["candles"] == _rows("20240103", "20240105")
        assert first["data_warnings"] == second["data_warnings"] == []
    finally:
        await scheduler.aclose()
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("gap_result", ["missing", "invalid"])
async def test_cold_daily_keeps_today_probe_when_history_cannot_seed_it(
    tmp_path, kiwoom, gap_result,
) -> None:
    class IncompleteHistory(_FakeKis):
        async def fetch_daily_candles(self, client, code, frm, too, **kwargs):
            result = await super().fetch_daily_candles(client, code, frm, too, **kwargs)
            if frm == "20240105":
                return result
            if gap_result == "missing":
                return DailyCandleFetchResult(candles=result.candles[:-1], violations=[])
            return DailyCandleFetchResult(candles=result.candles, violations=[
                DailyInvariantViolation(date_yyyymmdd="20240105", reason="malformed_row", detail="bad row"),
            ])

    kis = kiwoom(IncompleteHistory())
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path, cache=PastDailyCandlesCache(), scheduler=_RecordingScheduler(),
        walkback=batched_daily_walkback,
    )
    out = await backfill.collect_daily(
        code="066570", frm=dt.date(2024, 1, 1), too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 1, 5), policy="KRX", from_label="20240101", to_label="20240105",
    )
    assert [(c[1], c[2]) for c in kis.calls] == [("20240101", "20240104"), ("20240105", "20240105")]
    assert out["candles"] == _rows("20240101", "20240105")
    assert bool(out["data_warnings"]) == (gap_result == "invalid")


@pytest.mark.asyncio
@pytest.mark.parametrize("elapsed", [20.0, 60.0])
async def test_reused_today_expires_from_walk_start_not_walk_completion(
    tmp_path, kiwoom, monkeypatch, elapsed,
) -> None:
    from hoga.live import live_daily_candle_backfill, past_daily_candles_cache

    clock = [100.0]
    monkeypatch.setattr(live_daily_candle_backfill, "monotonic", lambda: clock[0], raising=False)
    monkeypatch.setattr(past_daily_candles_cache, "_monotonic", lambda: clock[0])

    class SlowHistory(_FakeKis):
        async def fetch_daily_candles(self, client, code, frm, too, **kwargs):
            result = await super().fetch_daily_candles(client, code, frm, too, **kwargs)
            if frm != "20240105":
                clock[0] += elapsed
            return result

    kis = kiwoom(SlowHistory())
    cache = PastDailyCandlesCache(today_ttl_seconds=60)
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=_RecordingScheduler(),
        walkback=batched_daily_walkback,
    )
    args = dict(
        code="066570", frm=dt.date(2024, 1, 1), too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 1, 5), policy="KRX", from_label="20240101", to_label="20240105",
    )
    await backfill.collect_daily(**args)
    assert len(kis.calls) == (1 if elapsed < 60 else 2)
    if elapsed < 60:
        clock[0] = 160.0
        assert cache.get_today("KRX", "066570") == ("miss", None)
        await backfill.collect_daily(**args)
        assert len(kis.calls) == 2
        assert kis.calls[-1][1:3] == ("20240105", "20240105")


@pytest.mark.asyncio
async def test_daily_reuse_preserves_integrated_venue_fallback(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FallbackKis())
    cache = PastDailyCandlesCache()
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=_RecordingScheduler(),
        walkback=batched_daily_walkback,
    )
    out = await backfill.collect_daily(
        code="066570", frm=dt.date(2024, 1, 1), too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 1, 5), policy="UN", from_label="20240101", to_label="20240105",
    )
    assert [c[3] for c in kis.calls] == ["UN", "KRX", "UN", "KRX"]
    assert out["candles"][-1]["close"] == 205
    assert any(w["reason"] == "daily_fallback_to_krx" for w in out["data_warnings"])
    assert cache.get_today("UN", "066570")[0] == "hit"
    assert cache.get_today("KRX", "066570") == ("miss", None)


@pytest.mark.asyncio
async def test_successive_leftward_requests_share_one_adjustment_basis(
    tmp_path, kiwoom
) -> None:
    """**fetch 가 여러 번이어도 수정주가 기준일은 하나다** — 2026-08-08 버그다.

    키움 `ka10081` 의 수정주가는 `base_dt` **상대**라, fetch 마다 그 구간의 끝
    날짜를 기준일로 쓰면 경계에서 척도가 갈린다. 005930 차트가 2018-03-05 에서
    50배 절벽을 그렸다 — **분할일(2018-05-04)이 아니라 스크롤이 만든 요청
    경계**다. fetch 하나짜리 테스트는 이걸 원리적으로 못 잡으므로, 좌측 스크롤
    (요청 2회)을 그대로 재현한다.
    """
    kis = kiwoom(_FakeKis())
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    async def view(frm: dt.date):
        return await backfill.collect_daily(
            code="005930", frm=frm, too=dt.date(2024, 1, 31),
            today_d=dt.date(2024, 3, 1), policy="KRX",
            from_label=frm.strftime("%Y%m%d"), to_label="20240131",
        )

    await view(dt.date(2024, 1, 20))   # 처음 열기
    await view(dt.date(2024, 1, 1))    # 왼쪽으로 스크롤

    assert [(c[1], c[2]) for c in kis.calls] == [
        ("20240120", "20240131"), ("20240101", "20240119"),
    ], "두 번째 요청은 **새로 드러난 왼쪽만** 받는다"
    assert {c[5] for c in kis.calls} == {"20240301"}, "기준일은 두 fetch 모두 오늘"
    # 위 단언만 있으면 "기준일이 우연히 그 구간 끝과 같은" 배치에서 통과한다.
    # 기준일이 **구간을 따라가지 않는다**는 것을 직접 못 박는다.
    assert all(c[5] != c[2] for c in kis.calls)


@pytest.mark.asyncio
async def test_fragmented_cache_costs_one_fetch_not_one_per_hole(
    tmp_path, kiwoom
) -> None:
    """파편화된 캐시에 넓은 요청 하나 → **fetch 한 번**.

    기준일 고정(#1228)의 대가는 fetch 마다 오늘부터 걷는 것이다. 갭 목록은
    fetch 전에 계산되므로, 받은 커버리지를 반영하지 않으면 사용자가 좌측
    스크롤로 만든 구멍 개수만큼 그 walk 를 반복한다(실측 캐시엔 구멍이 10개
    넘게 있었다).
    """
    kis = kiwoom(_FakeKis())
    cache = PastDailyCandlesCache()
    for frm_s, to_s in (("20240105", "20240107"), ("20240110", "20240112")):
        frm_d = dt.date(2024, int(frm_s[4:6]), int(frm_s[6:8]))
        to_d = dt.date(2024, int(to_s[4:6]), int(to_s[6:8]))
        cache.append_batch("KRX", "005930", frm_d, to_d, _rows(frm_s, to_s))
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=cache,
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    await backfill.collect_daily(
        code="005930", frm=dt.date(2024, 1, 1), too=dt.date(2024, 1, 19),
        today_d=dt.date(2024, 1, 21), policy="KRX",
        from_label="20240101", to_label="20240119",
    )

    assert [(c[1], c[2]) for c in kis.calls] == [("20240101", "20240104")], (
        "가장 오래된 갭 하나가 나머지를 덮는다"
    )


@pytest.mark.asyncio
async def test_date_rollover_drops_batches_of_the_old_basis(tmp_path, kiwoom) -> None:
    """**날짜가 넘어가면 캐시된 배치의 척도를 더는 믿을 수 없다.**

    배치는 받을 당시의 기준일로 굳어 있다. 그 사이 액면분할이 나면 옛 배치는
    미반영, 새 배치는 반영이라 경계에서 절벽이 생긴다 — 고친 버그가 프로세스
    수명 안에서 되살아나는 유일한 경로다. 배치별 기준일을 기억하는 대신 통째로
    버리는 이유는 기준일이 **전역으로 하나**라 부분 무효화할 축이 없어서다.
    """
    kis = kiwoom(_FakeKis())
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    async def view(today_d: dt.date):
        return await backfill.collect_daily(
            code="005930", frm=dt.date(2024, 1, 1), too=dt.date(2024, 1, 5),
            today_d=today_d, policy="KRX",
            from_label="20240101", to_label="20240105",
        )

    await view(dt.date(2024, 2, 1))
    same_day = await view(dt.date(2024, 2, 1))
    assert same_day["fresh_batches"] == [], "같은 날 재요청은 캐시로 끝난다"

    rolled = await view(dt.date(2024, 2, 2))
    assert rolled["fresh_batches"] == ["20240101__20240105"], "날짜가 넘어가면 다시 받는다"
    assert {c[5] for c in kis.calls} == {"20240201", "20240202"}
    assert len(kis.calls) == 2, "버리는 것은 하루 한 번뿐이다"


@pytest.mark.asyncio
async def test_rest_bypass_cache_only_still_reports_cached_violations(tmp_path) -> None:
    """REST 우회에서도 캐시된 위반이 나온다 (#1536).

    **우회는 벤더를 아예 안 부른다** — 즉 여기서 안 되살리면 이유는 프로세스
    재시작 전까지 영영 없다. 우회를 켜 둔 사용자에게는 그게 상시 상태다.
    """
    cache = PastDailyCandlesCache()
    cache.append_batch(
        "KRX", "005930", dt.date(2024, 1, 1), dt.date(2024, 1, 5), [],
        violations=[DailyInvariantViolation(
            date_yyyymmdd="(empty)", reason="malformed_row", detail="unparsable dt ''",
        )],
    )
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=cache,
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    out = await backfill.collect_daily_cache_only(
        code="005930", frm=dt.date(2024, 1, 1), too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 2, 1), policy="KRX",
        from_label="20240101", to_label="20240105",
    )

    reasons = [w["reason"] for w in out["data_warnings"]]
    assert "invariant_violation" in reasons, "우회 경로에서 진단이 사라졌다"
    # 우회 안내는 그대로 있어야 한다 — 위반이 그걸 밀어내면 안 된다.
    assert "rest_bypassed" not in reasons, "구간이 캐시로 다 덮여 안내가 없는 것이 정상"
    assert out["candles"] == []
