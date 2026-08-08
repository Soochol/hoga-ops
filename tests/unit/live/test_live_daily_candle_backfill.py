from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live import kiwoom_daily_candles, kiwoom_rest_runtime
from hoga.live.api import batched_daily_walkback
from hoga.live.candle_fetch_result import DailyCandleFetchResult
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
            candles=_daily_candles(from_yyyymmdd, to_yyyymmdd),
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
            candles=_daily_candles(from_yyyymmdd, to_yyyymmdd, close=205),
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
            candles=_daily_candles(from_yyyymmdd, to_yyyymmdd),
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
    assert r2["cached_batches"] == ["20240101__20240110"]


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
async def test_every_gap_shares_one_adjustment_basis(tmp_path, kiwoom) -> None:
    """**갭이 여럿이어도 수정주가 기준일은 하나다** — 2026-08-08 에 터진 버그다.

    키움 `ka10081` 의 수정주가는 `base_dt` **상대**라, 갭마다 그 갭의 끝 날짜를
    기준일로 쓰면 배치 경계에서 척도가 갈린다. 005930 차트가 2018-03-05 에서
    50배 절벽을 그렸다 — **분할일(2018-05-04)이 아니라 스크롤이 만든 요청
    경계**다. 갭 하나짜리 테스트는 이걸 원리적으로 못 잡는다.
    """
    kis = kiwoom(_FakeKis())
    cache = PastDailyCandlesCache()
    # 가운데를 캐시로 채워 갭을 둘로 쪼갠다 — 좌측 스크롤 백필이 만드는 모양이다.
    cache.append_batch(
        "KRX", "005930", dt.date(2024, 1, 10), dt.date(2024, 1, 20),
        _rows("20240110", "20240120"),
    )
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=cache,
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    await backfill.collect_daily(
        code="005930",
        frm=dt.date(2024, 1, 1),
        too=dt.date(2024, 1, 31),
        today_d=dt.date(2024, 3, 1),
        policy="KRX",
        from_label="20240101",
        to_label="20240131",
    )

    assert [(c[1], c[2]) for c in kis.calls] == [
        ("20240101", "20240109"), ("20240121", "20240131"),
    ], "갭이 둘로 쪼개져야 이 테스트가 의미를 갖는다"
    assert {c[5] for c in kis.calls} == {"20240301"}, "기준일은 두 갭 모두 오늘 하나"
    # 위 단언만 있으면 "기준일이 우연히 마지막 갭의 끝과 같은" 배치에서 통과한다.
    # 기준일이 **배치를 따라가지 않는다**는 것을 직접 못 박는다.
    assert all(c[5] != c[2] for c in kis.calls)
