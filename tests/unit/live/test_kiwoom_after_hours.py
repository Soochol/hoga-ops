"""kiwoom_after_hours (ka10087) — 파서 + fetcher TTL 캐시/single-flight.

⚠ **fixture 는 합성이다.** ka10001 테스트가 실호출 응답을 옮겨 온 것과 달리, 여기
골든은 공식 **필드표**로 조립했다 — 2026-08-14 시점에 토큰 캐시가 만료였고 새 발급은
사용자 dev 서버의 토큰을 죽이므로(#1088) 실응답을 뜰 수 없었다. 그래서 이 테스트가
고정하는 것은 "벤더가 무엇을 보내는가" 가 아니라 **파서가 그 형태를 어떻게 다루는가**
(키 선택·부호·빈 단계·판별 술어)다. 실프레임을 받으면 골든을 교체할 것.

교체 시 1순위 확인 항목은 **총잔량 세 쌍 중 어느 것이 실제로 오는가**다. 공식
Response Example 에는 `sel_bid_tot_req`(정규장)만 찍혀 있고 우리가 읽는
`ovt_sigpric_sel_bid_tot_req`(시간외 단일가)는 없다.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from hoga.live.kiwoom_after_hours import (
    LEVELS,
    KiwoomAfterHoursError,
    KiwoomAfterHoursFetcher,
    parse_ka10087,
)

# 필드표 기반 합성 응답. 부호 prefix 는 키움 REST 공통 wire 형식이고, 빈 단계를
# `"-0"` 으로 둔 것은 0D 애프터마켓 실측에서 확인된 관용 표기를 그대로 흉내낸 것이다.
GOLDEN = {
    "return_code": 0,
    "return_msg": "정상적으로 처리되었습니다",
    "bid_req_base_tm": "164000",
    # 매도 5단 — 1이 최우선(가장 낮은 매도).
    "ovt_sigpric_sel_bid_1": "+35400", "ovt_sigpric_sel_bid_qty_1": "1200",
    "ovt_sigpric_sel_bid_2": "+35450", "ovt_sigpric_sel_bid_qty_2": "800",
    "ovt_sigpric_sel_bid_3": "+35500", "ovt_sigpric_sel_bid_qty_3": "450",
    "ovt_sigpric_sel_bid_4": "-0", "ovt_sigpric_sel_bid_qty_4": "-0",
    "ovt_sigpric_sel_bid_5": "-0", "ovt_sigpric_sel_bid_qty_5": "-0",
    # 매수 5단 — 1이 최우선(가장 높은 매수).
    "ovt_sigpric_buy_bid_1": "-35350", "ovt_sigpric_buy_bid_qty_1": "2100",
    "ovt_sigpric_buy_bid_2": "-35300", "ovt_sigpric_buy_bid_qty_2": "1700",
    "ovt_sigpric_buy_bid_3": "-0", "ovt_sigpric_buy_bid_qty_3": "-0",
    "ovt_sigpric_buy_bid_4": "-0", "ovt_sigpric_buy_bid_qty_4": "-0",
    "ovt_sigpric_buy_bid_5": "-0", "ovt_sigpric_buy_bid_qty_5": "-0",
    # 시간외 **단일가** 총잔량 — 파서가 읽어야 하는 쌍.
    "ovt_sigpric_sel_bid_tot_req": "2450",
    "ovt_sigpric_buy_bid_tot_req": "3800",
    # 함정: 아래 두 쌍은 **다른 개념**인데 같은 응답에 있다. 파서가 이걸 집으면 안 된다.
    "sel_bid_tot_req": "24028", "buy_bid_tot_req": "26579",
    "ovt_sel_bid_tot_req": "999", "ovt_buy_bid_tot_req": "888",
    "ovt_sigpric_cur_prc": "35350",
    "ovt_sigpric_pred_pre_sig": "5",
    "ovt_sigpric_pred_pre": "-350",
    "ovt_sigpric_flu_rt": "-0.98",
    "ovt_sigpric_acc_trde_qty": "12345",
}


class _FakeTokenProvider:
    def __init__(self) -> None:
        self.calls = 0

    def get_token(self) -> str:
        self.calls += 1
        return "tok"


def _transport(body: dict, status: int = 200, *, counter: list[int] | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if counter is not None:
            counter.append(1)
        return httpx.Response(status, content=json.dumps(body).encode())

    return httpx.MockTransport(handler)


def test_parses_five_levels_best_first() -> None:
    book = parse_ka10087("006360", GOLDEN)

    assert len(book.ask) == LEVELS == 5
    assert len(book.bid) == 5
    # index 0 = 최우선. 부호 prefix 는 등락방향이라 가격에서 제거된다.
    assert (book.ask[0].price, book.ask[0].qty) == (35_400, 1_200)
    assert (book.bid[0].price, book.bid[0].qty) == (35_350, 2_100)


def test_empty_levels_become_zero_padding() -> None:
    """`"-0"` 빈 단계는 price=0·qty=0 으로 접힌다 — 배열 길이는 늘 5다.

    소비자(프론트)가 길이를 분기하지 않아도 되게 하는 계약이다. 10호가 격자에
    그대로 넣으면 `padLevels` 가 10칸으로 다시 채워 바깥 5행이 빈다.
    """
    book = parse_ka10087("006360", GOLDEN)

    assert (book.ask[3].price, book.ask[3].qty) == (0, 0)
    assert (book.bid[2].price, book.bid[2].qty) == (0, 0)


def test_reads_single_price_totals_not_the_other_two_pairs() -> None:
    """총잔량 세 쌍 중 **시간외 단일가** 쌍을 읽는다.

    이 단언이 없으면 정규장 총잔량(24,028/26,579)을 시간외로 표시하는 사고가
    조용히 통과한다 — 공식 Response Example 에 그 쌍만 찍혀 있어서 실제로 하기
    쉬운 실수다(모듈 docstring).
    """
    book = parse_ka10087("006360", GOLDEN)

    assert (book.total_ask_qty, book.total_bid_qty) == (2_450, 3_800)
    assert book.total_ask_qty != 24_028  # 정규장 쌍
    assert book.total_ask_qty != 999  # 시간외 종가매매 쌍


def test_summary_fields() -> None:
    book = parse_ka10087("006360", GOLDEN)

    assert book.base_tm == "164000"
    assert book.cur_price == 35_350
    assert book.acc_volume == 12_345
    # 등락률은 부호가 유의미하다 — abs 로 접으면 하락이 상승으로 보인다.
    assert book.change_pct == -0.98


def test_has_quotes_false_when_all_levels_empty() -> None:
    """전 단계가 0 이면 `has_quotes` 가 False — 라우트가 정규장 스냅샷을 유지한다.

    시간외 주문이 없는 종목에서 빈 호가창으로 갈아끼우면 화면이 오히려 나빠진다.
    """
    empty = {k: ("-0" if k.startswith("ovt_sigpric_") and "bid" in k else v)
             for k, v in GOLDEN.items()}

    assert parse_ka10087("006360", empty).has_quotes is False
    assert parse_ka10087("006360", GOLDEN).has_quotes is True


@pytest.mark.asyncio
async def test_ttl_cache_collapses_repeat_calls() -> None:
    calls: list[int] = []
    f = KiwoomAfterHoursFetcher(
        _FakeTokenProvider(), ttl_ms=60_000, _transport=_transport(GOLDEN, counter=calls),
    )
    try:
        await f.get("006360")
        await f.get("006360")
    finally:
        f.close()

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_zero_ttl_refetches() -> None:
    """TTL 이 지나면 다시 친다 — 시간외 호가는 변동값이라 캐시가 굳으면 안 된다."""
    calls: list[int] = []
    f = KiwoomAfterHoursFetcher(
        _FakeTokenProvider(), ttl_ms=0, _transport=_transport(GOLDEN, counter=calls),
    )
    try:
        await f.get("006360")
        await f.get("006360")
    finally:
        f.close()

    assert len(calls) == 2


@pytest.mark.asyncio
async def test_single_flight_collapses_concurrent_calls() -> None:
    calls: list[int] = []
    f = KiwoomAfterHoursFetcher(
        _FakeTokenProvider(), ttl_ms=60_000, _transport=_transport(GOLDEN, counter=calls),
    )
    try:
        await asyncio.gather(*(f.get("006360") for _ in range(5)))
    finally:
        f.close()

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_return_code_nonzero_raises() -> None:
    body = {"return_code": 3, "return_msg": "조회할 자료가 없습니다"}
    f = KiwoomAfterHoursFetcher(_FakeTokenProvider(), _transport=_transport(body))
    try:
        with pytest.raises(KiwoomAfterHoursError):
            await f.get("006360")
    finally:
        f.close()


@pytest.mark.asyncio
async def test_failure_is_not_cached() -> None:
    """실패는 캐시하지 않는다 — 다음 요청이 재시도한다(ka10001 과 같은 규율)."""
    calls: list[int] = []
    f = KiwoomAfterHoursFetcher(
        _FakeTokenProvider(), _transport=_transport({"return_code": 3}, counter=calls),
    )
    try:
        for _ in range(2):
            with pytest.raises(KiwoomAfterHoursError):
                await f.get("006360")
    finally:
        f.close()

    assert len(calls) == 2


# ── 당일 종가 역산 (2026-08-18) ──────────────────────────────────────────────
#
# 시간외 단일가(16:00–18:00)는 **당일 종가 ±10%** 안에서 거래되므로 등락률 분모가
# 종가여야 한다. 벤더는 종가를 필드로 주지 않고 `|현재가| − 종가대비` 로만 알 수 있다.


def test_close_price_is_reconstructed_from_the_vendor_delta() -> None:
    """실측 픽스처(2026-08-18 16:20, 028050 삼성E&A).

    전일 종가는 49,800(ka10007 `flu_rt` −3.82 의 분모)이고 당일 종가는 47,900 이다.
    벤더 `flu_rt` −0.42 는 −200/47,900 이므로 **종가 기준**이 값으로 증명된다.
    """
    book = parse_ka10087("028050", {
        "ovt_sigpric_cur_prc": "-47700",
        "ovt_sigpric_pred_pre": "-200",
        "ovt_sigpric_flu_rt": "-0.42",
    })

    assert book.cur_price == 47_700
    assert book.close_price == 47_900
    # 역산한 종가로 다시 계산한 등락률이 벤더 값과 맞는다(반올림 2자리).
    assert round((47_700 - 47_900) / 47_900 * 100, 2) == book.change_pct


def test_close_price_keeps_the_delta_sign() -> None:
    """**부호 규칙이 응답 안에서 둘로 갈린다** — 이 테스트가 그 경계를 못박는다.

    `cur_prc` 의 부호는 등락 **방향 표시**(절댓값이 가격)이고 `pred_pre` 의 부호는
    **값의 일부**다. 둘을 같은 파서로 읽으면 상승·하락이 각각 반대로 틀린다.
    """
    up = parse_ka10087("000000", {
        "ovt_sigpric_cur_prc": "+48100", "ovt_sigpric_pred_pre": "+200",
    })
    assert up.close_price == 47_900  # 상승: 48,100 − (+200)

    down = parse_ka10087("000000", {
        "ovt_sigpric_cur_prc": "-47700", "ovt_sigpric_pred_pre": "-200",
    })
    assert down.close_price == 47_900  # 하락: 47,700 − (−200)


def test_close_price_is_none_when_either_input_is_missing() -> None:
    """모름을 0 이나 현재가로 때우지 않는다 — 소비자가 등락률 표시를 생략해야 한다.

    분모를 추측하면 **0.00% 로 박제된 사다리**가 나오고, 그건 빈 칸보다 나쁘다
    (`hidden_pre_open` 이 같은 이유로 값을 죽인다).
    """
    assert parse_ka10087("000000", {"ovt_sigpric_cur_prc": "-47700"}).close_price is None
    assert parse_ka10087("000000", {"ovt_sigpric_pred_pre": "-200"}).close_price is None
    assert parse_ka10087("000000", {}).close_price is None
    # 종가대비가 현재가보다 커서 역산이 0 이하가 되는 병리적 응답도 모름으로 접는다.
    assert parse_ka10087("000000", {
        "ovt_sigpric_cur_prc": "-100", "ovt_sigpric_pred_pre": "+500",
    }).close_price is None
