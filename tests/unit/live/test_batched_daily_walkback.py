"""Unit tests for the shared daily walk-back orchestrator.

`batched_daily_walkback` concentrates the gap/cache/today-tristate/dedupe
assembly that /past-daily-candles and /past-investor-net both used to copy-paste
inline. These tests exercise that orchestration ONCE through a fake cache + fake
`fetch_batch` — no FastAPI route-driving, no KIS mock. The two routes keep only
thin adapter smoke tests in test_api.py.
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime

import httpx

from hoga.live.api import _KST, batched_daily_walkback
from hoga.live.kis_client import KisApiError, KisRateLimitError, KisTransportError


def _t_ms(d: date, hour: int = 9) -> int:
    return int(datetime(d.year, d.month, d.day, hour, 0, 0, tzinfo=_KST).timestamp() * 1000)


class _FakeCache:
    def __init__(self, batches=None, today=("miss", None)):
        self._batches = list(batches or [])  # list[(date, date, list[dict])]
        self._today = today
        self.appended: list[tuple[date, date, list[dict]]] = []
        self.stored_today: list[dict | None] = []

    def list_batches(self, code: str):
        return list(self._batches)

    def append_batch(self, code: str, frm: date, to: date, rows: list[dict]) -> None:
        self.appended.append((frm, to, rows))

    def get_today(self, code: str):
        return self._today

    def store_today(self, code: str, bar: dict | None) -> None:
        self.stored_today.append(bar)


def _run(coro):
    return asyncio.run(coro)


def test_gap_calls_fetch_records_fresh_and_appends() -> None:
    cache = _FakeCache()
    calls: list[tuple[str, str, str]] = []

    async def fetch_batch(code, from_s, to_s):
        calls.append((code, from_s, to_s))
        return [{"t_ms": _t_ms(date(2024, 1, 3)), "v": 1}], [], None

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert len(calls) == 1  # one gap fetched
    assert out["candles"] and out["candles"][0]["v"] == 1
    assert out["fresh_batches"] == ["20240101__20240105"]
    assert out["cached_batches"] == []
    assert cache.appended  # persisted to cache
    assert out["code"] == "005930" and out["from"] == "20240101" and out["to"] == "20240105"


def test_cache_hit_skips_fetch() -> None:
    cache = _FakeCache(batches=[(date(2024, 1, 1), date(2024, 1, 5),
                                 [{"t_ms": _t_ms(date(2024, 1, 2)), "v": 7}])])
    called = False

    async def fetch_batch(code, from_s, to_s):
        nonlocal called
        called = True
        return [], [], None

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert called is False  # fully covered by cache → no KIS round-trip
    assert out["cached_batches"] == ["20240101__20240105"]
    assert out["candles"][0]["v"] == 7


def test_rate_limit_breaks_loop_and_warns() -> None:
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        raise KisRateLimitError("EGW00201 too many requests")

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert out["candles"] == []
    assert any(w["reason"] == "rate_limit_upstream" for w in out["data_warnings"])
    assert out["fresh_batches"] == []


def test_api_error_continues_with_warning() -> None:
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        raise KisApiError(msg_cd="ERR99", msg1="boom")

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert any(w["reason"] == "api_error" for w in out["data_warnings"])


def test_transport_error_continues_with_distinct_warning() -> None:
    """A KisTransportError (TCP disconnect mid-backfill) must NOT propagate out
    of the walk-back as a 500 — it degrades like an api error (skip the batch,
    keep going) but records a DISTINCT ``transport_error`` reason so operators
    can tell a network blip from a vendor rejection (different remediation).
    Regression: 2026-06-11 foreground daily-candle backfill 500, where
    ``httpx.RemoteProtocolError`` escaped the client uncaught.

    사유는 ``"transport"`` 가 아니라 **``"transport_error"``** 다 — 프론트 계약이
    후자인데 전자를 내보내고 있어서, 이 경로의 전송 실패가 토스트에 도달하지
    못했다(ADR-0137)."""
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        raise KisTransportError(httpx.RemoteProtocolError("server disconnected"))

    # Must return normally (no raise) — that is what closes the 500.
    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert out["candles"] == []
    assert any(w["reason"] == "transport_error" for w in out["data_warnings"])
    assert not any(w["reason"] == "transport" for w in out["data_warnings"]), (
        "프론트가 보는 문자열은 `transport_error` 다 — 짧은 쪽은 아무도 안 읽는다"
    )
    # Not misreported as a generic api error.
    assert not any(w["reason"] == "api_error" for w in out["data_warnings"])


def test_output_key_is_parameterized() -> None:
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        return [{"t_ms": _t_ms(date(2024, 1, 3)), "foreign_net": 5}], [], None

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="points",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert "points" in out and "candles" not in out
    assert out["points"][0]["foreign_net"] == 5


def test_today_miss_fetches_and_stores() -> None:
    cache = _FakeCache(today=("miss", None))
    today = date(2024, 1, 5)

    async def fetch_batch(code, from_s, to_s):
        # today_s == today range; return today's row
        return [{"t_ms": _t_ms(today), "v": 9}], [], None

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=today, too=today, today_d=today,
    ))

    assert cache.stored_today == [{"t_ms": _t_ms(today), "v": 9}]
    assert out["fresh_batches"] == ["20240105__20240105"]
    assert out["candles"][0]["v"] == 9


def test_dedupe_by_t_ms_keeps_last() -> None:
    ts = _t_ms(date(2024, 1, 3))
    cache = _FakeCache(batches=[(date(2024, 1, 1), date(2024, 1, 5),
                                 [{"t_ms": ts, "v": 1}, {"t_ms": ts, "v": 2}])])

    async def fetch_batch(code, from_s, to_s):
        return [], [], None

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert len(out["candles"]) == 1  # deduped by t_ms
    assert out["candles"][0]["v"] == 2  # last wins


# === covered_to — fetch 가 요청보다 넓게 덮었을 때 (#1228 후속) ==============

def test_wider_coverage_skips_the_remaining_gaps_in_the_same_request() -> None:
    """**파편화된 캐시 + 넓은 요청 = fetch 한 번.**

    일봉 수정주가는 기준일에서 걸어 내려와야 해서(#1228 함정 ④) 갭 하나를
    받으면 그 위 구간을 어차피 다 받는다. 갭 목록은 fetch 전에 미리 계산되므로,
    받은 커버리지를 반영하지 않으면 **같은 구간을 갭 개수만큼 다시 받는다** —
    좌측 스크롤로 캐시가 잘게 쪼개진 사용자가 정확히 그 비용을 낸다.
    """
    # 가운데 두 조각만 캐시 → 갭 3개(01-01~01-04, 01-08~01-09, 01-13~01-19)
    cache = _FakeCache(batches=[
        (date(2024, 1, 5), date(2024, 1, 7), [{"t_ms": _t_ms(date(2024, 1, 5)), "v": 1}]),
        (date(2024, 1, 10), date(2024, 1, 12), [{"t_ms": _t_ms(date(2024, 1, 10)), "v": 2}]),
    ])
    calls: list[tuple[str, str]] = []

    async def fetch_batch(code, from_s, to_s):
        calls.append((from_s, to_s))
        # 기준일(=오늘)까지 걸어 내려온 어댑터를 흉내낸다: 요청 구간 위쪽 행도 온다.
        rows = [{"t_ms": _t_ms(date(2024, 1, d)), "v": d} for d in range(1, 21)]
        return rows, [], date(2024, 1, 21)

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 19),
        today_d=date(2024, 1, 21),
    ))

    assert calls == [("20240101", "20240104")], "가장 오래된 갭 하나로 끝나야 한다"
    assert len(out["fresh_batches"]) == 1
    # 커버리지를 넓혀 기록해야 **다음 요청**에서도 갭이 안 생긴다.
    assert cache.appended[0][0] == date(2024, 1, 1)
    assert cache.appended[0][1] == date(2024, 1, 20), "오늘(01-21) 직전까지"


def test_widened_batch_never_swallows_todays_provisional_bar() -> None:
    """오늘 봉은 TTL 슬롯 전용이다 — TTL 없는 과거 배치에 들어가면 얼어붙는다.

    step 6 의 today 슬롯 덮어쓰기가 보통 가려주지만, today fetch 가 실패하면
    그 가림이 사라져 어제 값이 오늘 봉으로 굳는다.
    """
    cache = _FakeCache()
    today = date(2024, 1, 21)

    async def fetch_batch(code, from_s, to_s):
        rows = [{"t_ms": _t_ms(date(2024, 1, d)), "v": d} for d in (19, 20, 21)]
        return rows, [], today

    _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 19), too=date(2024, 1, 21), today_d=today,
    ))

    cached_rows = cache.appended[0][2]
    assert [r["v"] for r in cached_rows] == [19, 20], "21(오늘)은 배치에 안 들어간다"
    assert cache.appended[0][1] == date(2024, 1, 20)


def test_covered_to_none_keeps_the_requested_gap_bounds() -> None:
    """투자자 순매수 경로(`ka10059`)는 커서가 `to` 상대라 넓힐 것이 없다."""
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        return [{"t_ms": _t_ms(date(2024, 1, 3)), "v": 1}], [], None

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="points",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert cache.appended[0][:2] == (date(2024, 1, 1), date(2024, 1, 5))
    assert out["fresh_batches"] == ["20240101__20240105"]


def test_empty_response_does_not_claim_the_wider_span() -> None:
    """**빈 응답은 커버리지를 넓히지 못한다.**

    확장의 근거는 "그 행을 실제로 받았다" 뿐이다. 빈 응답까지 넓게 적으면
    일시적 빈 응답 하나가 오늘까지를 "조회 완료" 로 굳혀 다음 날까지 재시도를
    막는다. 빈 갭 캐싱 자체(휴일 구간 무한 재조회 방지)는 그대로 살아 있다.
    """
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        return [], [], date(2024, 1, 21)

    _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5),
        today_d=date(2024, 1, 21),
    ))

    assert cache.appended[0][:2] == (date(2024, 1, 1), date(2024, 1, 5))
