from __future__ import annotations

import datetime as dt
import re
from collections.abc import Awaitable, Callable, Hashable
from pathlib import Path

import pytest

from hoga.live import kiwoom_adjust_factors, kiwoom_minute_candles, kiwoom_rest_runtime
from hoga.live.candle_models import LiveCandle
from hoga.live.data_warnings import WARNING_CLASSIFICATION, classify_warning_reason
from hoga.live.kiwoom_adjust_factors import AdjustFactors
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_minute_candles import MinutePage, MinuteWalkResult
from hoga.live.live_candle_backfill import (
    _FALLBACK_BLOCKING_REASONS,
    LiveMinuteCandleBackfill,
    _date_from_t_ms,
)
from hoga.live.past_candles_cache import PastCandlesCache


def _kst_ms(date_yyyymmdd: str, hour: int = 9, minute: int = 0) -> int:
    kst = dt.timezone(dt.timedelta(hours=9))
    y = int(date_yyyymmdd[:4])
    m = int(date_yyyymmdd[4:6])
    d = int(date_yyyymmdd[6:8])
    return int(dt.datetime(y, m, d, hour, minute, tzinfo=kst).timestamp() * 1000)


def _bar(date_yyyymmdd: str) -> LiveCandle:
    return LiveCandle(
        t_ms=_kst_ms(date_yyyymmdd), open=100, high=110, low=95, close=105, volume=10,
    )


class _FakeWalk:
    """어댑터 자리에 꽂히는 페이크.

    PR-G(#1043) 이후 소비자는 **날짜별 1콜 팬**이 아니라 **구간 1회 walk-back** 을
    부른다(ADR-0136 §3). 그래서 페이크가 받는 것도 날짜가 아니라 `[oldest, newest]`
    구간이고, 그 안의 거래일을 한꺼번에 돌려준다.
    """

    def __init__(self, *, wedged: bool = False, exhausted: bool = False,
                 only: set[str] | None = None,
                 splits: dict[str, float] | None = None,
                 bars_by_date: dict[str, list[LiveCandle]] | None = None) -> None:
        self.calls: list[tuple[str, str, str, str | None]] = []
        self.day_calls: list[tuple[str, str, str | None]] = []
        self.page_calls: list[str] = []
        self.factor_calls: list[tuple[str, str]] = []
        self._wedged = wedged
        self._exhausted = exhausted
        self._only = only
        self._splits = splits
        self._bars_by_date = bars_by_date

    async def walk(self, _client, code, *, newest_yyyymmdd, oldest_yyyymmdd,
                   venue=None, fetch_page=None, **_kw) -> MinuteWalkResult:
        self.calls.append((code, oldest_yyyymmdd, newest_yyyymmdd, venue))
        if fetch_page is not None:
            # **진짜 walk 와 같은 계약을 지킨다: I/O 는 주입된 러너로만 한다.**
            # 이 한 줄이 없으면 페이크가 거버너를 통째로 건너뛰어, 과부하·유량
            # 검증(`_OverloadedScheduler`)이 아무것도 안 하면서 초록이 된다.
            await fetch_page(newest_yyyymmdd)
        bars: dict[str, list[LiveCandle]] = {}
        cur = dt.datetime.strptime(oldest_yyyymmdd, "%Y%m%d").date()
        end = dt.datetime.strptime(newest_yyyymmdd, "%Y%m%d").date()
        while cur <= end:
            date_s = cur.strftime("%Y%m%d")
            if self._bars_by_date is not None:
                if date_s in self._bars_by_date:
                    bars[date_s] = self._bars_by_date[date_s]
            elif self._only is None or date_s in self._only:
                bars[date_s] = [_bar(date_s)]
            cur += dt.timedelta(days=1)
        return MinuteWalkResult(
            bars_by_date=bars, pages=1,
            exhausted=self._exhausted, wedged=self._wedged,
        )

    async def day(self, _client, code, date_yyyymmdd, *, venue=None, **_kw):
        self.day_calls.append((code, date_yyyymmdd, venue))
        return [_bar(date_yyyymmdd)]

    async def page(self, _client, _code, cursor, **_kw) -> MinutePage:
        """주입된 러너가 실제로 도달하는 바닥. 내용은 이 페이크에서 안 쓴다."""
        self.page_calls.append(cursor)
        return MinutePage(complete={}, oldest="")

    async def factors(self, _client, code, *, as_of_yyyymmdd, **_kw) -> AdjustFactors:
        """수정계수 이음매(#1229). 기본은 항등이라 기존 단언이 그대로 성립한다.

        `splits`(효력일 → 분할비율)를 주면 **벤더 의미론을 흉내낸다**: 기준일
        **이후**의 이벤트는 테이블에 나타나지 않는다. 그래서 기준일을 오늘이
        아니라 배치 끝으로 잘못 잡으면 이 페이크가 항등 테이블을 돌려주고,
        옛 배치가 원주가로 남아 절벽이 되살아난다 — 그 회귀를 잡는 지렛대다.
        """
        self.factor_calls.append((code, as_of_yyyymmdd))
        if not self._splits:
            # `19900101` 하한은 "분봉이 닿을 수 있는 모든 날짜를 덮는다" 를 뜻한다.
            return AdjustFactors(as_of=as_of_yyyymmdd, dates=("19900101",), values=(1.0,))
        events = sorted(
            (d, r) for d, r in self._splits.items() if d <= as_of_yyyymmdd
        )
        dates = ["19900101", *(d for d, _ in events)]
        values = []
        for d in dates:
            ratio = 1.0
            for ex_date, r in events:
                if ex_date > d:
                    ratio *= r
            values.append(1.0 / ratio)
        return AdjustFactors(
            as_of=as_of_yyyymmdd, dates=tuple(dates), values=tuple(values),
        )


@pytest.fixture
def kiwoom(monkeypatch):
    """키움 이음매 5점(클라이언트 조달·walk·하루치·페이지·수정계수)을 갈아끼운다."""
    def _install(fake: _FakeWalk) -> _FakeWalk:
        monkeypatch.setattr(
            kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object()
        )
        monkeypatch.setattr(kiwoom_minute_candles, "walk_minute_days", fake.walk)
        monkeypatch.setattr(kiwoom_minute_candles, "fetch_day", fake.day)
        monkeypatch.setattr(kiwoom_minute_candles, "fetch_minute_page", fake.page)
        monkeypatch.setattr(kiwoom_adjust_factors, "fetch_adjust_factors", fake.factors)
        return fake

    return _install


def _install_identity_factors(monkeypatch) -> list[tuple[str, str]]:
    """수정계수를 항등으로 고정한다 — `_FakeWalk` 를 안 쓰는 테스트용.

    **어댑터 함수를 통째로 갈아끼우므로 `ka10081` submit 이 아예 안 생긴다.**
    거버너 대기표를 세는 테스트가 `ka10080` 만 세도 되게 하려는 것이고, 계수
    콜의 페이싱은 그 자리가 아니라 전용 테스트가 박는다.
    """
    calls: list[tuple[str, str]] = []

    async def _factors(_client, code, *, as_of_yyyymmdd, **_kw) -> AdjustFactors:
        calls.append((code, as_of_yyyymmdd))
        return AdjustFactors(as_of=as_of_yyyymmdd, dates=("19900101",), values=(1.0,))

    monkeypatch.setattr(kiwoom_adjust_factors, "fetch_adjust_factors", _factors)
    return calls


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
        # 계정 차원(endpoint·cooldown_scope)은 PR-G(#1043)에서 사라졌다(#1015).
        self.calls.append({"key": key, "api_id": api_id, "priority": priority})
        return await call(None)


class _OverloadedScheduler:
    async def submit(self, **_kwargs):
        raise KiwoomCapacityOverloaded("KIS capacity scheduler pending request limit reached")


@pytest.mark.asyncio
async def test_live_minute_candle_backfill_schedules_past_minute_fetches(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="NXT",
    )

    assert result.fresh_dates == ["20260518"]
    assert result.cached_dates == []
    assert result.data_warnings == []
    assert len(result.candles) == 1
    assert kis.calls == [("005930", "20260518", "20260518", "NXT")]
    # 거버너 단위는 walk 구간이 아니라 **페이지(커서)** 다 — 유량 페이싱의 전제다.
    assert scheduler.calls == [
        {
            "key": ("live-candle-backfill", "minute-page", "NXT", "005930",
                    "20260518", "1"),
            "api_id": "ka10080",
            "priority": "user_visible",
        }
    ]


@pytest.mark.asyncio
async def test_collect_minute_skips_known_non_trading_past_dates(tmp_path, monkeypatch, kiwoom) -> None:
    from hoga.api import calendar as cal

    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    monkeypatch.setattr(
        cal,
        "is_trading_day",
        lambda d: False if d == "20260517" else True,  # noqa: SIM211 — 명시적 분기가 의도를 드러냄
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 17),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert kis.calls == [("005930", "20260518", "20260518", "KRX")], (
        "비거래일은 walk 구간에서 아예 빠진다"
    )
    assert scheduler.calls == [
        {
            "key": ("live-candle-backfill", "minute-page", "KRX", "005930",
                    "20260518", "1"),
            "api_id": "ka10080",
            "priority": "user_visible",
        }
    ]
    assert result.cached_dates == ["20260517"]
    assert result.fresh_dates == ["20260518"]
    assert len(result.candles) == 1
    assert result.data_warnings == []


@pytest.mark.asyncio
async def test_collect_minute_treats_non_trading_empty_as_covered_for_fallback(tmp_path, monkeypatch, kiwoom) -> None:
    from hoga.api import calendar as cal

    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    monkeypatch.setattr(cal, "is_trading_day", lambda d: False)

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 17),
        too=dt.date(2026, 5, 17),
        today_d=dt.date(2026, 6, 1),
        policy="NXT",
    )

    assert kis.calls == []
    assert scheduler.calls == []
    assert result.candles == []
    assert result.cached_dates == ["20260517"]
    assert result.fresh_dates == []
    assert result.data_warnings == []


@pytest.mark.asyncio
async def test_live_minute_candle_backfill_reports_capacity_overload(tmp_path, kiwoom) -> None:
    kiwoom(_FakeWalk())
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_OverloadedScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert result.candles == []
    assert result.fresh_dates == []
    assert result.cached_dates == []
    # ADR-0143: `kind`·`is_failure` 가 붙고, **msg 도 정책 테이블에서 온다**.
    # 예전 문구 `"KIS capacity scheduler…"` 는 이 생성기에만 박혀 있던 KIS 시대
    # 잔재였다 — 같은 사유의 다른 경로(`classify_live_error`)와 갈려 있었다.
    assert result.data_warnings == [
        {
            "date": "20260518",
            "reason": "capacity_overloaded",
            # `policy.kind` 는 `rate_limit`(처방 축)인데 wire kind 는 `deferred`
            # (표시 축)다 — 유일한 의도적 비대칭. 근거는 `test_data_warnings.py`
            # ::test_capacity_overload_kind_intentionally_differs_from_policy.
            "kind": "deferred",
            "is_failure": True,
            "msg": "request queue is full; this date was not requested",
        }
    ]


# `test_fetch_past_shared_corider_survives_waiter_cancellation` 은
# `tests/unit/live/test_kiwoom_capacity.py` 로 이사했다. PR-G(#1043)에서 날짜별
# single-flight 가 사라지고 중복제거가 **거버너**(`KiwoomCapacityScheduler`)로
# 올라갔기 때문이다 — 성질(대기자 취소가 코라이더를 죽이면 안 된다)은 그대로다.


@pytest.mark.asyncio
async def test_collect_minute_caps_uncached_fetches_per_request(tmp_path, monkeypatch, kiwoom) -> None:
    """예산(3)보다 큰 미캐시 창(10일) → 최신 3일만 fetch, 나머지는 budget 경고로 유예."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
        max_fresh_dates_per_collect=3,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 10),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert result.fresh_dates == ["20260508", "20260509", "20260510"]
    # **콜이 3개가 아니라 1개다** — walk 한 번이 구간을 덮는다(ADR-0136 §3).
    assert kis.calls == [("005930", "20260508", "20260510", "KRX")]
    warned = [w for w in result.data_warnings if w["reason"] == "fetch_budget_exhausted"]
    assert [w["date"] for w in warned] == [f"2026050{d}" for d in range(1, 8)]


@pytest.mark.asyncio
async def test_budget_counts_only_uncached_dates(tmp_path, monkeypatch, kiwoom) -> None:
    """캐시된 날짜는 예산을 소모하지 않는다."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
    cache = PastCandlesCache(data_dir=tmp_path)
    for day in range(1, 8):  # 5/1-5/7 캐시 채움 → 미캐시는 5/8-5/10 셋뿐
        date_s = f"2026050{day}"
        cache.store_past("KRX", "005930", date_s, [
            {"t_ms": _kst_ms(date_s), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        ], "1")
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1, max_fresh_dates_per_collect=3,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 10),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert result.fresh_dates == ["20260508", "20260509", "20260510"]
    assert result.data_warnings == []  # 예산 내 완결 → 경고 없음
    assert kis.calls == [("005930", "20260508", "20260510", "KRX")], (
        "캐시된 앞구간은 walk 구간에서 빠진다"
    )


@pytest.mark.asyncio
async def test_fresh_budget_scales_with_tic_scope(tmp_path, monkeypatch, kiwoom) -> None:
    """신선 예산은 tic_scope 분 수에 비례한다 (3-상수 불변식, ADR-0105 개정).

    예산의 실체는 "collect당 벤더 콜 상한"이고 페이지 커버리지가 scope 에
    비례하므로, 날짜 예산을 고정하면 넓은 tf 의 dispatch(10m 거래일)가
    fetch_budget_exhausted 경고를 받아 60s 주기 저속 전진으로 퇴행한다 —
    에러가 아니라 발견이 늦는 종류라 여기 핀으로 박는다.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kiwoom(_FakeWalk())  # 벤더 seam 배선(반환값 불필요 — walk 가 fake 를 탄다)
    scheduler = _RecordingScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1, max_fresh_dates_per_collect=3,
    )

    # 9일 요청: 1분 예산(3)이면 6일이 유예되지만, tic_scope=5 예산(15)엔 전부 든다.
    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 9),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
        tic_scope="5",
    )
    assert result.data_warnings == [], "5분 스코프 예산(3×5=15) 안이라 유예 없음"
    assert len(result.fresh_dates) == 9

    # 대조군: 같은 창을 1분 스코프로 — 예산 3이라 6일이 유예된다.
    result_1m = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 11),
        too=dt.date(2026, 5, 19),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
        tic_scope="1",
    )
    deferred = [w for w in result_1m.data_warnings if w["reason"] == "fetch_budget_exhausted"]
    assert len(deferred) == 6, "1분 스코프는 종전 예산 그대로 (회귀 없음)"


@pytest.mark.asyncio
async def test_each_walk_page_takes_its_own_governor_slot(tmp_path, monkeypatch) -> None:
    """**페이지 N장이면 거버너 submit 도 N건이다.**

    walk 전체를 한 submit 으로 감싸면 거버너는 1건을 세고 벤더는 N건을 센다. 그
    간극이 2026-08-04 `ka10080` 유량 초과 8회(→ `/live` "시세 서버 연결 불가"
    토스트)의 직접 원인이었다: `run_with_capacity` 는 진입 전에 버킷을 한 번만
    소비하므로 walk 안쪽 최대 40콜은 페이싱을 전혀 받지 않았다.

    **`_FakeWalk` 로는 이 배선을 잡을 수 없다** — 페이크가 walk 를 통째로 대체하면
    페이지 루프가 사라지기 때문이다. 그래서 여기서만 **진짜 `walk_minute_days`** 를
    돌리고 페이지 1장만 페이크로 바꾼다.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)
    monkeypatch.setattr(
        kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object()
    )
    _install_identity_factors(monkeypatch)

    # 커서 → (온전한 날짜들, 다음 커서가 될 최古 날짜). 마지막 장은 목표 하한보다
    # **더** 오래된 날짜를 물어 walk 를 끝낸다.
    pages = {
        "20260518": (["20260518", "20260517"], "20260516"),
        "20260516": (["20260516", "20260515"], "20260514"),
        "20260514": (["20260514", "20260513"], "20260512"),
        "20260512": (["20260512"], "20260430"),
    }
    seen: list[str] = []

    async def _page(_client, _code, cursor, **_kw) -> MinutePage:
        seen.append(cursor)
        complete, oldest = pages[cursor]
        return MinutePage(complete={d: [_bar(d)] for d in complete}, oldest=oldest)

    monkeypatch.setattr(kiwoom_minute_candles, "fetch_minute_page", _page)

    scheduler = _RecordingScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 12),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert seen == ["20260518", "20260516", "20260514", "20260512"]
    assert len(scheduler.calls) == len(seen), "페이지마다 대기표 1장 — 여기가 계약이다"
    assert [c["key"] for c in scheduler.calls] == [
        ("live-candle-backfill", "minute-page", "KRX", "005930", cursor, "1")
        for cursor in seen
    ], "중복제거 key 는 구간이 아니라 커서 단위여야 겹치는 페이지가 조인된다"
    assert {c["api_id"] for c in scheduler.calls} == {"ka10080"}
    assert result.data_warnings == []
    assert result.fresh_dates == [f"2026051{d}" for d in range(2, 9)]


@pytest.mark.asyncio
async def test_walk_harvest_serves_the_next_pan_chunk_from_cache(
    tmp_path, monkeypatch
) -> None:
    """순회분 전량 적재 — 페이지가 창을 넘겨 실어온 날짜로 다음 청크가 공짜가 된다.

    넓은 `tic_scope` 에서 한 페이지는 프론트 청크(10거래일)의 2~6배를 덮는다.
    수확 없이는 그 초과분이 폐기돼 다음 팬 청크가 **같은 페이지를 다시 사고**
    (ADR-0120 원인 ③의 재귀), 수확하면 벤더 콜 0 으로 끝난다. 여기가 그 계약이다.

    응답 격리도 같이 박는다: 수확분은 캐시에만 가고 첫 응답에는 안 실린다 —
    새면 프론트가 요청 안 한 구간의 캔들을 받아 병합 창 계약(from/to)이 깨진다.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)
    monkeypatch.setattr(
        kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object()
    )
    _install_identity_factors(monkeypatch)

    # 10분 스코프 시나리오: 한 페이지가 요청 창(5/15~5/18)을 넘어 5/11 까지 실어온다.
    pages = {
        "20260518": (
            ["20260518", "20260517", "20260516", "20260515",   # 요청 창
             "20260514", "20260513", "20260512", "20260511"],  # 수확분
            "20260510",
        ),
        # 2차 청크(5/11~5/14)가 캐시 미스라면 이 커서로 페이지를 다시 산다 —
        # 수확이 작동하면 이 항목은 **조회되지 않는다**.
        "20260514": (["20260514", "20260513", "20260512", "20260511"], "20260510"),
    }
    seen: list[str] = []

    async def _page(_client, _code, cursor, **_kw) -> MinutePage:
        seen.append(cursor)
        complete, oldest = pages[cursor]
        return MinutePage(complete={d: [_bar(d)] for d in complete}, oldest=oldest)

    monkeypatch.setattr(kiwoom_minute_candles, "fetch_minute_page", _page)

    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )

    first = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 15), too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1), policy="KRX",
    )
    assert seen == ["20260518"]
    # 응답 격리: 수확분(5/11~5/14)은 첫 응답에 새지 않는다.
    assert first.fresh_dates == ["20260515", "20260516", "20260517", "20260518"]
    assert {_date_from_t_ms(c["t_ms"]) for c in first.candles} == {
        "20260515", "20260516", "20260517", "20260518",
    }

    second = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 11), too=dt.date(2026, 5, 14),
        today_d=dt.date(2026, 6, 1), policy="KRX",
    )
    assert seen == ["20260518"], "다음 청크는 수확 캐시로 끝난다 — 벤더 콜 0"
    assert second.cached_dates == ["20260511", "20260512", "20260513", "20260514"]
    assert second.fresh_dates == []


@pytest.mark.asyncio
async def test_transport_failure_keeps_its_own_reason(tmp_path, kiwoom) -> None:
    """전송 실패는 `transport_error` 로 나간다 — `api_error` 로 접지 않는다.

    이전 판은 `except KiwoomRestError` 팔이 전부 `api_error` 였다. 그래서 프론트가
    진짜 전송 실패를 가려내려고 `msg` 에서 `'TRANSPORT/'` 문자열을 뒤져야 했다 —
    벤더 거절(기다린다)과 회선 끊김(점검한다)은 처방이 다른데 같은 얼굴이었다
    (ADR-0137).
    """
    import httpx

    from hoga.live.kiwoom_errors import KiwoomTransportError

    fake = _FakeWalk()

    async def _boom(*_a, **_kw):
        raise KiwoomTransportError(httpx.ConnectTimeout("timed out"))

    fake.walk = _boom          # type: ignore[method-assign]
    kiwoom(fake)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert [w["reason"] for w in result.data_warnings] == ["transport_error"]
    assert "TRANSPORT/" not in result.data_warnings[0]["msg"], (
        "사유가 정확해졌으므로 프론트가 msg 를 파싱할 이유가 없다"
    )


def test_fallback_blocking_reasons_cover_every_rest_error_reason() -> None:
    """**폴백 계약과 표시 계약이 같은 문자열을 공유한다.**

    `_rest_error_warning` 이 내는 사유가 `_FALLBACK_BLOCKING_REASONS` 에서 빠지면,
    막아야 할 날짜가 '안 막힌 날짜' 로 분류되어 NXT/UN → KRX 재조회가 조용히 켜진다.
    사유를 세분화할 때 여기를 함께 넓혔는지 이 테스트가 못 박는다.
    """
    import httpx

    from hoga.live.kiwoom_errors import (
        KiwoomApiError,
        KiwoomAuthError,
        KiwoomBatchLimitError,
        KiwoomTransportError,
    )
    from hoga.live.live_candle_backfill import (
        _FALLBACK_BLOCKING_REASONS,
        _rest_error_warning,
    )

    for exc in (
        KiwoomTransportError(httpx.ConnectTimeout("x")),
        KiwoomAuthError("no token"),
        KiwoomBatchLimitError(code=5, msg="1634"),
        KiwoomApiError(code=3, msg="rejected"),
        KiwoomRestError("module-specific"),
    ):
        reason = _rest_error_warning("20260518", exc)["reason"]
        assert reason in _FALLBACK_BLOCKING_REASONS, (
            f"{type(exc).__name__} → {reason!r} 이 폴백 차단 집합에 없다"
        )


def _ts_set_members(ts_path: Path, const_name: str) -> frozenset[str]:
    """``const NAME = new Set([...])`` 의 문자열 리터럴 집합.

    주석을 **잘라내기 전에** 지운다 — 순서를 뒤집으면 주석 속 ``]`` 에서 본문이
    조기 종료된다(같은 함정으로 `test_rest_wire_schema_contract` 의 union 파서가
    한 번 덜 읽었다). 여기서도 실제 위험이다: 이 상수의 주석이 대괄호를 품는다.
    """
    src = ts_path.read_text(encoding="utf-8")
    # 타입 주석(`const X: ReadonlySet<Y> = …`)을 허용한다. 없으면 kind 집합처럼
    # 주석이 붙은 선언을 **못 읽고**, 그 실패가 "프론트에 없는 값 N개" 로 위장된다
    # — 파서 회귀 테스트가 있어서 즉시 파서 문제로 드러났다.
    head = re.search(
        rf"^(?:export )?const {re.escape(const_name)}\s*(?::[^=]+)?=", src, re.M,
    )
    assert head is not None, (
        f"{ts_path.name} 에 `const {const_name}` 이 없다 — 이름이 바뀌었으면 이 가드도 같이 고칠 것"
    )
    body = re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", src[head.end():], flags=re.S))
    return frozenset(re.findall(r"'([^']*)'", body.split("]", 1)[0]))


def _frontend_blocking_kinds() -> frozenset[str]:
    ts_path = (
        Path(__file__).resolve().parents[3] / "frontend/src/api/livePastCandles.ts"
    )
    return _ts_set_members(ts_path, "BLOCKING_WARNING_KINDS")


def test_frontend_blocking_kinds_match_backend_blocking_reasons() -> None:
    """프론트 `BLOCKING_WARNING_KINDS` 는 이 집합의 **kind 투영**이다(ADR-0143).

    이관 전에는 양쪽이 같은 **사유** 집합이었다. 프론트가 kind 축으로 옮겨간 뒤로도
    대조는 계속돼야 하므로, 백엔드 사유를 kind 로 사영해 비교한다.

    **막는 방향**: 백엔드가 blocking 사유를 넓혔는데 그 kind 가 프론트 집합에 없는
    것, 그리고 그 반대. 값 드리프트는 타입이 원리적으로 못 잡는다.

    **못 보는 것**: 프론트가 이 상수를 다른 이름으로 옮기거나 `new Set` 이외의
    형태로 바꾸면 파서가 못 읽고 assert 가 먼저 터진다(조용한 통과는 아니다).

    왜 필요한가: ADR-0137 세분화 때 백엔드만 넓히고 프론트가 뒤처졌다. 그 상태에서
    `transport_error` 가 프론트에서 non-blocking 으로 분류돼 ① 자가 회복 refetch
    ② 델타 기준 박제 ③ canonical 재발행 가드를 **전부** 통과했고, 과거 전용 청크는
    `staleTime: Infinity` 라 ①이 유일한 회복 경로여서 그 구간이 재마운트 전까지
    영구 구멍으로 남았다(#1251).
    """
    expected = frozenset(
        classify_warning_reason(reason)[0] for reason in _FALLBACK_BLOCKING_REASONS
    )
    frontend = _frontend_blocking_kinds()

    assert frontend == expected, (
        "BE blocking 사유의 kind 집합과 FE `BLOCKING_WARNING_KINDS` 가 갈렸다. "
        f"프론트에 없는 kind={sorted(expected - frontend)} "
        f"프론트에만 남은 kind={sorted(frontend - expected)}. "
        "사유를 넓히거나 kind 를 바꿀 때 양쪽을 같은 PR 에서 고칠 것(ADR-0004)."
    )


def test_non_blocking_failures_stay_out_of_frontend_blocking_kinds() -> None:
    """**실패인데 blocking 이 아닌 것**이 kind 로 뭉뚱그려져 새지 않는가.

    `invariant_violation`(`data_quality`)은 실패지만 **데이터는 받았다** — 박제해도
    구멍이 나지 않는다(ADR-0020: 표시하되 렌더). 즉 `is_failure` 만으로는 가를 수
    없고, kind 로 사영할 때 두 부류가 같은 kind 를 공유하면 이 구분이 죽는다.

    이 테스트는 그 공유가 생기는 순간을 잡는다.
    """
    frontend = _frontend_blocking_kinds()

    for reason, (kind, is_failure) in WARNING_CLASSIFICATION.items():
        if not is_failure or reason in _FALLBACK_BLOCKING_REASONS:
            continue
        assert kind not in frontend, (
            f"{reason!r}(kind={kind!r})은 blocking 이 아닌데 그 kind 가 프론트 blocking "
            "집합에 있다 — 두 부류가 kind 를 공유하면 구분이 죽는다."
        )


def test_every_failure_reason_agrees_on_blocking_membership() -> None:
    """새 실패 사유가 **두 축 중 한쪽에만** 등록되는 사고를 막는다.

    사유가 `_FALLBACK_BLOCKING_REASONS` 에 있는데 그 kind 가 프론트 집합 밖이면
    프론트만 non-blocking 으로 보고(= #1251 재현), 반대면 백엔드만 폴백을 막는다.
    둘 다 무증상이라 여기서 잡는다.
    """
    frontend = _frontend_blocking_kinds()

    for reason, (kind, is_failure) in WARNING_CLASSIFICATION.items():
        if not is_failure:
            continue
        backend_blocking = reason in _FALLBACK_BLOCKING_REASONS
        frontend_blocking = kind in frontend
        assert backend_blocking == frontend_blocking, (
            f"{reason!r}(kind={kind!r}): BE blocking={backend_blocking} 인데 "
            f"FE blocking={frontend_blocking} 이다. 두 축을 같이 고칠 것."
        )


def test_frontend_blocking_kind_parser_actually_reads_members() -> None:
    """파서 자체의 회귀 — 빈 집합끼리 맞아떨어지는 위양성을 막는다.

    파서가 조용히 0개를 읽으면 실패 메시지가 "프론트에 없는 kind 7개" 라고만 말해
    **파서 결함을 드리프트로 위장**한다. 실제 멤버를 못 박아 그 오독을 끊는다.
    """
    members = _frontend_blocking_kinds()

    assert "transport" in members  # 배열 첫 원소
    assert "deferred" in members  # 배열 마지막 원소
    assert "data_quality" not in members  # 실패지만 blocking 아님
    assert len(members) == 7


# === 수정계수 (#1229) =======================================================
#
# 배경: 키움 수정주가는 `base_dt` **상대**다(340570 실측 2026-08-08 — 같은
# 20260805 15:30 봉이 `base_dt=20260805` 에선 65,600, `base_dt=20260807` 에선
# 33,200). 분봉 어댑터는 그 `base_dt` 를 **페이지마다** 옮기므로 벤더 수정주가를
# 쓸 수 없고, 원주가로 받아 여기서 계수를 곱한다. 아래 테스트들이 그 계약이다.


def _priced_bar(date_yyyymmdd: str, close: int) -> LiveCandle:
    return LiveCandle(
        t_ms=_kst_ms(date_yyyymmdd), open=close, high=close, low=close,
        close=close, volume=42,
    )


@pytest.mark.asyncio
async def test_batches_straddling_a_split_come_back_on_one_scale(
    tmp_path, monkeypatch, kiwoom
) -> None:
    """**좌측 스크롤이 쪼갠 두 배치가 한 척도로 이어진다.**

    이것이 이 기능의 존재 이유다. 프론트는 최신 구간을 먼저 받고 스크롤할 때마다
    옛 구간을 따로 요청한다. 기준일을 배치의 끝으로 잡으면 옛 배치의 기준일이
    수정일 **이전**이라 그 배치만 원주가로 오고, 차트에 **요청 경계**에서 절벽이
    생긴다 — 일봉이 005930 2018-03-05 에서 그랬던 것과 같은 실패다(#1228).

    페이크가 벤더 의미론(기준일 이후 이벤트는 안 보인다)을 흉내내므로,
    `as_of=today_s` 를 `pending[-1]` 로 되돌리면 옛 배치가 60,000 으로 남아
    여기가 빨개진다.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)
    # 원주가: 분할 전 60,000 → 분할(2:1) 후 30,000.
    raw = {
        "20260803": [_priced_bar("20260803", 60000)],
        "20260804": [_priced_bar("20260804", 60000)],
        "20260805": [_priced_bar("20260805", 60000)],
        "20260806": [_priced_bar("20260806", 30000)],
        "20260807": [_priced_bar("20260807", 30000)],
    }
    fake = kiwoom(_FakeWalk(bars_by_date=raw, splits={"20260806": 2.0}))
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )

    async def _collect(frm: dt.date, too: dt.date):
        return await backfill.collect_minute(
            code="340570", frm=frm, too=too,
            today_d=dt.date(2026, 8, 8), policy="KRX",
        )

    newer = await _collect(dt.date(2026, 8, 6), dt.date(2026, 8, 7))
    older = await _collect(dt.date(2026, 8, 3), dt.date(2026, 8, 5))

    closes = {
        _date_from_t_ms(c["t_ms"]): c["close"]
        for c in [*newer.candles, *older.candles]
    }
    assert closes == {
        "20260803": 30000, "20260804": 30000, "20260805": 30000,
        "20260806": 30000, "20260807": 30000,
    }, "배치 경계에서 척도가 갈렸다 — 기준일이 배치 끝으로 돌아갔는지 볼 것"
    # 기준일은 두 배치 모두 **오늘**이다. 배치 끝(20260805 / 20260807)이 아니다.
    assert {as_of for _, as_of in fake.factor_calls} == {"20260808"}


@pytest.mark.asyncio
async def test_factor_table_is_fetched_once_per_code_and_as_of(
    tmp_path, monkeypatch, kiwoom
) -> None:
    """여러 갭·여러 venue 가 **하나의 기준일과 하나의 테이블**을 공유한다.

    벽시계가 아니라 **호출 횟수**로 잰다. 캐시가 빠지면 collect 마다, 그리고 NXT→KRX
    폴백까지 겹쳐 종목당 하루 2콜이 요청마다 2콜로 불어난다.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)
    fake = kiwoom(_FakeWalk())
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )
    for day in (18, 19, 20):
        await backfill.collect_minute(
            code="005930", frm=dt.date(2026, 5, day), too=dt.date(2026, 5, day),
            today_d=dt.date(2026, 6, 1), policy="KRX",
        )

    assert fake.factor_calls == [("005930", "20260601")]


@pytest.mark.asyncio
async def test_overnight_rescale_drops_the_cached_bars_of_that_code(
    tmp_path, monkeypatch, kiwoom
) -> None:
    """밤사이 액면분할이 효력을 얻으면 그 종목의 과거 봉 캐시를 버린다.

    캐시에 담긴 봉은 계수가 **이미 곱해진 표시값**이라, 어제 담긴 항목만 옛 척도로
    남으면 같은 차트에 두 척도가 섞인다 — 이 기능이 없애려던 바로 그 상태다.
    섞임을 만드는 유일한 경로가 새 fetch 이고 모든 fetch 가 계수 조회를 지나므로,
    거기서 끊으면 원천적으로 안 생긴다.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)
    raw = {
        "20260803": [_priced_bar("20260803", 60000)],
        "20260804": [_priced_bar("20260804", 60000)],
    }
    # 효력일 20260805 — 8/4 시점에는 안 보이고 8/5 시점에는 보인다.
    fake = kiwoom(_FakeWalk(bars_by_date=raw, splits={"20260805": 2.0}))
    cache = PastCandlesCache(data_dir=tmp_path)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache,
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )

    first = await backfill.collect_minute(
        code="340570", frm=dt.date(2026, 8, 3), too=dt.date(2026, 8, 3),
        today_d=dt.date(2026, 8, 4), policy="KRX",
    )
    assert [c["close"] for c in first.candles] == [60000]   # 아직 분할 전 척도

    second = await backfill.collect_minute(
        code="340570", frm=dt.date(2026, 8, 3), too=dt.date(2026, 8, 4),
        today_d=dt.date(2026, 8, 5), policy="KRX",
    )

    assert fake.factor_calls == [("340570", "20260804"), ("340570", "20260805")]
    assert [c["close"] for c in second.candles] == [30000, 30000], (
        "8/3 이 옛 척도(60,000)로 캐시에 남았다 — 한 차트에 두 척도가 섞인다"
    )


@pytest.mark.asyncio
async def test_factor_calls_take_their_own_governor_slots(tmp_path, monkeypatch) -> None:
    """계수 콜도 거버너를 지난다 — `ka10081` 버킷으로, `upd` 로 갈린 키로.

    키에서 `upd` 가 빠지면 동시 실행된 두 요청이 조인돼 **수정주가 응답이 원주가
    자리에** 들어간다(계수가 전부 1.0 → 절벽 부활). `past_candles_cache` 의
    `tic_scope` 키 누락과 같은 종류의 오염이라 키 모양을 못 박는다.
    """
    from hoga.api import calendar as cal
    from hoga.live import kiwoom_rest

    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)
    monkeypatch.setattr(
        kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object()
    )
    monkeypatch.setattr(kiwoom_minute_candles, "walk_minute_days", _FakeWalk().walk)

    class _Client:
        async def call(self, api_id, body, **_kw):
            if api_id != kiwoom_adjust_factors.API_ID:
                return kiwoom_rest.Page(rows=[], cont=False, next_key="", raw={})
            close = 50 if body["upd_stkpc_tp"] == "1" else 100
            return kiwoom_rest.Page(
                rows=[{"dt": "20260518", "cur_prc": str(close)}],
                cont=False, next_key="", raw={},
            )

    monkeypatch.setattr(
        kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: _Client()
    )
    scheduler = _RecordingScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )
    await backfill.collect_minute(
        code="005930", frm=dt.date(2026, 5, 18), too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1), policy="KRX",
    )

    factor_keys = [c["key"] for c in scheduler.calls if c["api_id"] == "ka10081"]
    assert factor_keys == [
        ("live-candle-backfill", "adjust-factors", "005930", "20260601", "1"),
        ("live-candle-backfill", "adjust-factors", "005930", "20260601", "0"),
    ]


@pytest.mark.asyncio
async def test_dates_below_the_factor_table_warn_instead_of_caching_empty(
    tmp_path, monkeypatch, kiwoom
) -> None:
    """계수를 모르는 날짜는 **경고**다 — 빈 배열로 캐시하면 안 된다.

    walk 가 깨끗이 끝났으면 응답에 없는 날짜는 비거래일로 접히는데, "계수를 몰라
    안 실었다" 가 그 분기로 새면 프론트가 빈 캔들을 진실로 그리고 캐시가 그것을
    박제한다. 무척도 봉을 그냥 내보내는 것도 답이 아니다 — 화면에 정상처럼 보이는
    절벽이 남는다.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)

    class _ShallowFactors(_FakeWalk):
        async def factors(self, _client, code, *, as_of_yyyymmdd, **_kw):
            self.factor_calls.append((code, as_of_yyyymmdd))
            # 테이블이 20260519 까지만 닿는다 — 그 아래는 "모른다".
            return AdjustFactors(
                as_of=as_of_yyyymmdd, dates=("20260519",), values=(1.0,),
            )

    kiwoom(_ShallowFactors())
    cache = PastCandlesCache(data_dir=tmp_path)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=cache,
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )
    result = await backfill.collect_minute(
        code="005930", frm=dt.date(2026, 5, 18), too=dt.date(2026, 5, 19),
        today_d=dt.date(2026, 6, 1), policy="KRX",
    )

    assert [w["date"] for w in result.data_warnings] == ["20260518"]
    assert result.data_warnings[0]["reason"] == "api_error"
    assert cache.get_past("KRX", "005930", "20260518", "1") is None, (
        "계수를 모르는 날짜가 빈 배열로 박제됐다"
    )
    assert result.fresh_dates == ["20260519"]


@pytest.mark.asyncio
async def test_factor_failure_blocks_the_walk_but_still_serves_cached_dates(
    tmp_path, monkeypatch, kiwoom
) -> None:
    """계수를 못 얻으면 walk 를 **아예 안 돈다** — 받아 봐야 척도가 없다.

    캐시분은 그대로 낸다: 이미 담긴 봉끼리는 한 척도라 자체 일관적이고, 계수를
    못 얻었다는 것은 척도가 바뀌었다는 증거도 아니다.

    사유가 walk 실패와 **같은 표**여야 한다 — 프론트는 사유 문자열로 박제 여부를
    가르므로(`_FALLBACK_BLOCKING_REASONS`), 같은 원인이 어느 콜에서 났느냐로
    사유가 갈리면 폴백·재시도 정책이 갈린다.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)
    fake = kiwoom(_FakeWalk())
    cache = PastCandlesCache(data_dir=tmp_path)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache,
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )
    # 1차: 정상으로 20260518 을 캐시에 담는다.
    await backfill.collect_minute(
        code="005930", frm=dt.date(2026, 5, 18), too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1), policy="KRX",
    )

    async def _boom(*_a, **_kw):
        raise KiwoomRestError("token dead")

    monkeypatch.setattr(kiwoom_adjust_factors, "fetch_adjust_factors", _boom)
    # 기준일을 넘겨 계수 캐시를 무효화한 뒤 미캐시 날짜를 섞어 요청한다.
    result = await backfill.collect_minute(
        code="005930", frm=dt.date(2026, 5, 18), too=dt.date(2026, 5, 19),
        today_d=dt.date(2026, 6, 2), policy="KRX",
    )

    assert fake.calls == [("005930", "20260518", "20260518", "KRX")], (
        "계수 실패 뒤에도 walk 가 돌았다 — 척도 없는 봉을 사러 간 것이다"
    )
    assert [w["date"] for w in result.data_warnings] == ["20260519"]
    assert result.data_warnings[0]["reason"] in _FALLBACK_BLOCKING_REASONS
    assert result.cached_dates == ["20260518"]
    assert len(result.candles) == 1
