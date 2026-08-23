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
from hoga.live.candle_fetch_result import DailyInvariantViolation
from hoga.live.kis_client import KisApiError, KisRateLimitError, KisTransportError
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import (
    KiwoomApiError,
    KiwoomAuthError,
    KiwoomRateLimitError,
    KiwoomTerminalAuthError,
    KiwoomTransportError,
)
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache


def _t_ms(d: date, hour: int = 9) -> int:
    return int(datetime(d.year, d.month, d.day, hour, 0, 0, tzinfo=_KST).timestamp() * 1000)


class _FakeCache:
    """`PastDailyCandlesCache` 의 대역. **`list_batches` 는 항상 4-튜플을 낸다.**

    생성자 `batches` 는 픽스처라 3-튜플도 받아 위반을 빈 리스트로 채운다 — 위반이
    주제가 아닌 테스트가 그 축을 안 적게 하려는 것이다. 대역이 실물보다 느슨한 것은
    **입력 쪽뿐**이고, 계약 표면인 반환은 실물과 같은 4-튜플로 고정한다.
    """

    def __init__(self, batches=None, today=("miss", None)):
        # list[(date, date, list[dict], list)]
        self._batches = [
            b if len(b) == 4 else (*b, []) for b in (batches or [])
        ]
        self._today = today
        self.appended: list[tuple[date, date, list[dict], list]] = []
        self.stored_today: list[dict | None] = []

    def list_batches(self, code: str):
        return list(self._batches)

    def append_batch(
        self, code: str, frm: date, to: date, rows: list[dict],
        *, violations: list | None = None,
    ) -> None:
        self.appended.append((frm, to, rows, list(violations or [])))

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


@pytest.mark.parametrize(
    ("exc", "expected_reason", "expected_msg_fragment"),
    [
        # 유량 초과만 벤더가 코드 대신 상한(`유량=5`)을 실어 준다 — 정책은 `1700` 을
        # `code` 에 넣고 `message` 는 원문 그대로 둔다.
        (KiwoomRateLimitError("유량 초과 [유량=5, API ID=ka10081]"), "rate_limit_upstream", "유량=5"),
        (
            KiwoomTransportError(httpx.RemoteProtocolError("server disconnected")),
            "transport_error",
            "server disconnected",
        ),
        (KiwoomApiError(code=3, msg="잘못된 요청입니다[1504:...]"), "api_error", "1504"),
        (
            KiwoomAuthError("인증에 실패했습니다[8005:Token이 유효하지 않습니다]"),
            "auth_error",
            "8005",
        ),
        (
            KiwoomTerminalAuthError(
                code=3, msg="인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]"
            ),
            "auth_error",
            "8050",
        ),
    ],
    ids=["rate_limit", "transport", "api", "token_auth", "terminal_auth"],
)
def test_today_kiwoom_errors_degrade_to_warnings(
    exc: Exception, expected_reason: str, expected_msg_fragment: str,
) -> None:
    """오늘 프로브가 **키움** 실패에 500 을 내지 않는다 — 2026-08-08 회귀.

    과거 gap 루프는 두 벤더 튜플을 잡는데 오늘 프로브만 `Kis*` 를 직접 적고 있었다.
    일봉이 키움으로 이관된 뒤(ADR-0136) `KiwoomApiError` 만 그대로 탈출해
    `/api/live/past-daily-candles` 가 500 이 됐다(`8050 지정단말기 인증 실패`).

    이 500 이 특히 나쁜 이유는 **화면이 조용하다**는 것이다: 핸들러가 없어 Starlette
    plain text 로 나가므로 프론트 `buildApiError` 가 에러 코드를 못 읽고, 캔들이 이미
    캐시에 있으면 `deriveCandleEmptyState` 가 아무것도 띄우지 않는다. 경고로 강등돼야
    최소한 "일부 과거구간 로딩 실패" 칩까지 도달한다.

    `token_auth` 케이스는 8050 과 **다른 갈래**다: `KiwoomAuthError` 는
    `KiwoomApiError` 의 하위 타입이 **아니라서**, api-error 계열만 잡아도 여전히
    500 으로 샜다(8005 는 2026-08-04 에 실제로 겪은 코드다). 지금은 둘 다
    `_STOP_WALK_ERRORS` 가 잡는다.

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
    # `msg` 는 벤더 원문이다. 예전엔 `_vendor_code` 로 접혀서 키움 실패가 return_code
    # 인 `"3"` 하나로 떠 대괄호 안의 진짜 코드가 화면에 도달하지 못했다.
    assert expected_msg_fragment in out["data_warnings"][0]["msg"]
    assert out["candles"] == []
    # 실패를 성공으로 오기록하지 않는다 — negative 캐시로 굳으면 그날은 영영 안 받는다.
    assert cache.stored_today == []
    assert out["fresh_batches"] == []


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


@pytest.mark.parametrize(
    ("exc", "stops"),
    [
        (KiwoomTerminalAuthError(code=3, msg="…[8050:…]"), True),
        (KiwoomAuthError("…[8005:…]"), True),
        (KiwoomCapacityOverloaded("queue full (128)"), True),
        (KiwoomApiError(code=3, msg="잘못된 요청입니다[1504:…]"), False),
    ],
    ids=["terminal_auth", "token_auth", "capacity", "api"],
)
def test_stop_walk_errors_end_the_gap_walk_but_api_errors_continue(
    exc: Exception, stops: bool,
) -> None:
    """걷기를 멈추는 축은 벤더가 아니라 **"더 걸어도 같은 결과인가"** 다.

    인증 실패·큐 포화는 남은 gap 을 두드려 봐야 같은 거절이다. 계속 걸으면 벤더를
    헛되이 때리고 경고만 gap 수만큼 불어나 원인이 오히려 안 보인다. 그 배치 고유의
    거절(1504 등)은 반대다 — 다음 배치는 성공할 수 있다.

    **`KiwoomTerminalAuthError` ⊂ `KiwoomApiError` 라 이 테스트가 순서 함정을 겸한다.**
    두 except 팔의 순서가 뒤집히면 8050 이 "계속" 팔로 새는데, 사유는 여전히
    `auth_error`(정책이 정하므로)라 **경고만 보는 테스트는 그걸 못 잡는다**. 걷는
    횟수를 세는 이 단언이 유일한 그물이다.

    캐시가 덮지 않는 gap 이 둘 생기도록 배치를 가운데에만 둔다.
    """
    cache = _FakeCache(batches=[(date(2024, 1, 10), date(2024, 1, 12), [])])
    calls: list[tuple[str, str]] = []

    async def fetch_batch(code, from_s, to_s):
        calls.append((from_s, to_s))
        raise exc

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 20),
        today_d=date(2024, 2, 1),
    ))

    expected_calls = 1 if stops else 2
    assert len(calls) == expected_calls, (
        f"gap 을 {len(calls)}번 걸었다 — {'멈췄어야' if stops else '계속했어야'} 한다"
    )
    assert len(out["data_warnings"]) == expected_calls


# ── 캐시 히트에서 진단이 살아남는가 (#1536) ────────────────────────────────────
#
# 아래 셋은 **실물 `PastDailyCandlesCache`** 를 쓴다. 대역이 아니라 실물인 이유:
# 이 결함의 절반이 캐시 자료구조에 있었다(배치 튜플에 위반 칸이 없었다). 대역으로
# 재면 대역이 위반을 들고 있어서 **오케스트레이터 배선만** 재고 저장 쪽 회귀는 못 본다.


def _empty_response_violation():
    """벤더가 은퇴한 코드에 주는 응답의 모양 — 행 하나, `dt` 가 빈 문자열.

    #1534 에서 37종목이 이 모양이었다. `date_yyyymmdd` 가 날짜가 **아니라는** 점이
    이 픽스처의 핵심이다.
    """
    return DailyInvariantViolation(
        date_yyyymmdd="(empty)", reason="malformed_row", detail="unparsable dt ''",
    )


def test_cache_hit_still_reports_the_violation_the_cold_call_reported() -> None:
    """**같은 요청을 두 번 한다 — 그게 이 테스트의 요점이다** (#1536).

    한 번만 재는 테스트는 이 결함을 **통과시킨다**: 콜드 경로는 고치기 전에도
    정확했다. 사라지는 것은 두 번째 응답이고, 사용자에게는 그쪽이 「새로고침」이다.
    """
    cache = PastDailyCandlesCache()
    calls: list[tuple[str, str, str]] = []

    async def fetch_batch(code, from_s, to_s):
        calls.append((code, from_s, to_s))
        return [], [_empty_response_violation()], None

    kwargs = dict(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    )
    cold = _run(batched_daily_walkback(**kwargs))
    warm = _run(batched_daily_walkback(**kwargs))

    assert len(calls) == 1, "두 번째는 캐시가 덮어 벤더를 안 부른다 — 그 상황을 재는 것이다"
    assert cold["candles"] == [] and warm["candles"] == []   # 봉이 0 인 것은 양쪽 같다
    assert [w["reason"] for w in cold["data_warnings"]] == ["invariant_violation"]
    assert [w["reason"] for w in warm["data_warnings"]] == ["invariant_violation"], (
        "웜에서 진단이 사라졌다 — 봉 0 은 그대로인데 이유만 없어지는 그 결함이다"
    )
    # 진단 자체는 콜드/웜이 같아야 한다. `batch` 는 저장 시 커버리지가 넓어질 수
    # 있어 제외한다(그 라벨이 응답 안에서 대조 가능한지는 아래 테스트가 본다).
    keys = ("reason", "kind", "is_failure", "date", "msg")
    assert ({k: cold["data_warnings"][0].get(k) for k in keys}
            == {k: warm["data_warnings"][0].get(k) for k in keys})


def test_cache_hit_warning_batch_label_is_findable_in_the_same_response() -> None:
    """`data_warnings[].batch` 가 같은 응답의 배치 목록 안에 있어야 대조가 된다.

    라벨이 어디에도 없는 문자열이면 「어느 구간의 이야기인가」를 읽는 쪽이 못 잇는다.
    """
    cache = PastDailyCandlesCache()

    async def fetch_batch(code, from_s, to_s):
        return [], [_empty_response_violation()], None

    kwargs = dict(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    )
    _run(batched_daily_walkback(**kwargs))
    warm = _run(batched_daily_walkback(**kwargs))

    labels = set(warm["cached_batches"]) | set(warm["fresh_batches"])
    assert warm["data_warnings"][0]["batch"] in labels


def test_cache_hit_drops_violations_of_dates_outside_the_request() -> None:
    """구간 필터가 **공허하지 않다**.

    이게 없으면 위 두 테스트는 "전부 그냥 싣는다" 로도 통과한다. 넓은 캐시 배치를
    좁게 다시 물으면 바깥 날짜의 위반은 빠져야 한다.
    """
    cache = PastDailyCandlesCache()
    inside = DailyInvariantViolation(
        date_yyyymmdd="20240103", reason="close_nonpositive", detail="close=0",
    )
    outside = DailyInvariantViolation(
        date_yyyymmdd="20240110", reason="close_nonpositive", detail="close=0",
    )

    async def fetch_batch(code, from_s, to_s):
        return [], [inside, outside], None

    _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 20), today_d=date(2024, 2, 1),
    ))

    async def never(code, from_s, to_s):
        raise AssertionError("캐시가 덮는다 — 벤더를 부르면 안 된다")

    warm = _run(batched_daily_walkback(
        cache=cache, fetch_batch=never, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert [w["date"] for w in warm["data_warnings"]] == ["20240103"]
