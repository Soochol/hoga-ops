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
import pytest

from hoga.live.api import _KST, batched_daily_walkback
from hoga.live.kis_client import KisApiError, KisRateLimitError, KisTransportError
from hoga.live.kiwoom_errors import (
    KiwoomApiError,
    KiwoomRateLimitError,
    KiwoomTransportError,
)


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
        return [{"t_ms": _t_ms(date(2024, 1, 3)), "v": 1}], []

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
        return [], []

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
        return [{"t_ms": _t_ms(date(2024, 1, 3)), "foreign_net": 5}], []

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
        return [{"t_ms": _t_ms(today), "v": 9}], []

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=today, too=today, today_d=today,
    ))

    assert cache.stored_today == [{"t_ms": _t_ms(today), "v": 9}]
    assert out["fresh_batches"] == ["20240105__20240105"]
    assert out["candles"][0]["v"] == 9


@pytest.mark.parametrize(
    ("exc", "expected_reason"),
    [
        (KiwoomRateLimitError("유량 초과 [유량=5, API ID=ka10081]"), "rate_limit_upstream"),
        (KiwoomTransportError(httpx.RemoteProtocolError("server disconnected")), "transport_error"),
        (KiwoomApiError(code=3, msg="인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]"), "api_error"),
    ],
    ids=["rate_limit", "transport", "api"],
)
def test_today_kiwoom_errors_degrade_to_warnings(exc: Exception, expected_reason: str) -> None:
    """오늘 프로브가 **키움** 실패에 500 을 내지 않는다 — 2026-08-08 회귀.

    과거 gap 루프는 `_API_ERRORS` 등 두 벤더 튜플을 잡는데 오늘 프로브만 `Kis*` 를
    직접 적고 있었다. 일봉이 키움으로 이관된 뒤(ADR-0136) `KiwoomApiError` 만 그대로
    탈출해 `/api/live/past-daily-candles` 가 500 이 됐다(`8050 지정단말기 인증 실패`).

    이 500 이 특히 나쁜 이유는 **화면이 조용하다**는 것이다: 핸들러가 없어 Starlette
    plain text 로 나가므로 프론트 `buildApiError` 가 에러 코드를 못 읽고, 캔들이 이미
    캐시에 있으면 `deriveCandleEmptyState` 가 아무것도 띄우지 않는다. 경고로 강등돼야
    최소한 "일부 과거구간 로딩 실패" 칩까지 도달한다.

    `frm == too == today_d` 라 gap 루프는 아예 돌지 않는다 — 경고를 만든 것이 오늘
    브랜치임을 이 조건 하나가 고정한다(gap 루프가 대신 만들어 준 것이 아니다).
    """
    cache = _FakeCache(today=("miss", None))
    today = date(2024, 1, 5)
    calls: list[tuple[str, str, str]] = []

    async def fetch_batch(code, from_s, to_s):
        calls.append((code, from_s, to_s))
        raise exc

    # 예외를 밖으로 내지 않는 것 자체가 이 테스트의 본론이다.
    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=today, too=today, today_d=today,
    ))

    assert calls == [("005930", "20240105", "20240105")]  # 오늘 프로브 1회뿐
    assert [w["reason"] for w in out["data_warnings"]] == [expected_reason]
    assert out["data_warnings"][0]["batch"] == "20240105__20240105"
    assert out["candles"] == []
    # 실패를 성공으로 오기록하지 않는다 — negative 캐시로 굳으면 그날은 영영 안 받는다.
    assert cache.stored_today == []
    assert out["fresh_batches"] == []


def test_dedupe_by_t_ms_keeps_last() -> None:
    ts = _t_ms(date(2024, 1, 3))
    cache = _FakeCache(batches=[(date(2024, 1, 1), date(2024, 1, 5),
                                 [{"t_ms": ts, "v": 1}, {"t_ms": ts, "v": 2}])])

    async def fetch_batch(code, from_s, to_s):
        return [], []

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert len(out["candles"]) == 1  # deduped by t_ms
    assert out["candles"][0]["v"] == 2  # last wins
