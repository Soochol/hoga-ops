"""kiwoom_after_hours — ka10087 호가 + ka10001 예상체결 + 합성 체결 원장.

⚠ **fixture 가 두 종류다. 성격이 다르니 섞어 읽지 말 것.**

- `GOLDEN`(ka10087)은 공식 **필드표로 조립한 합성**이다. 2026-08-14 당시 토큰 캐시가
  만료였고 새 발급은 사용자 dev 서버의 토큰을 죽이므로(#1088) 실응답을 못 떴다.
  그래서 이것이 고정하는 것은 "벤더가 무엇을 보내는가" 가 아니라 **파서가 그 형태를
  어떻게 다루는가**(키 선택·부호·빈 단계·판별 술어)다.
- `KA10001_REAL` 은 2026-08-19 16:28 **실응답**이다. 부호 변종(`"34950"` vs
  `"+35000"`)이 원본 그대로 들어 있어 파서가 실제로 만나는 형태를 고정한다.

`GOLDEN` 을 실프레임으로 교체할 때 1순위 확인 항목은 **총잔량 세 쌍 중 어느 것이
실제로 오는가**다. 공식 Response Example 에는 `sel_bid_tot_req`(정규장)만 찍혀 있고
우리가 읽는 `ovt_sigpric_sel_bid_tot_req`(시간외 단일가)는 없다.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from hoga.live.kiwoom_after_hours import (
    LEVELS,
    KiwoomAfterHoursError,
    KiwoomAfterHoursFetcher,
    _FillLedger,
    parse_ka10001_expected,
    parse_ka10087,
)

#: 2026-08-19 거래일 16:28 실응답(006360). **합성이 아니다** — 세션 scratchpad 에서
#: 건져 온 원본이라 부호 변종(`"34950"` vs `"+35000"`)이 그대로 들어 있다.
_FIXTURES = Path(__file__).parents[2] / "fixtures" / "kiwoom_after_hours"
KA10001_REAL = json.loads((_FIXTURES / "ka10001_006360_1628.json").read_text())

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


def _transport(
    body: dict,
    status: int = 200,
    *,
    counter: list[int] | None = None,
    expected_body: dict | None = None,
    expected_status: int = 200,
):
    """MockTransport. **fetcher 가 TR 을 둘 치므로 api-id 로 갈라 답한다.**

    `counter` 는 **ka10087 호출만** 센다 — TTL·single-flight 를 재는 단언들이 예상체결
    호출까지 세면 "캐시가 접혔는가" 와 "TR 이 몇 개인가" 가 한 숫자에 섞여, 나중에
    TR 을 하나 더 붙일 때 무관한 테스트가 무더기로 빨개진다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("api-id") == "ka10001":
            return httpx.Response(
                expected_status, content=json.dumps(expected_body or {"return_code": 0}).encode()
            )
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


# ── 예상체결 (ka10001) ──────────────────────────────────────────────────────


def test_parses_expected_fill_from_real_response() -> None:
    """2026-08-19 16:28 **실응답**에서 예상체결을 뽑는다.

    이 값이 왜 ka10087 이 아니라 ka10001 에서 오는지는 `ExpectedFill` docstring.
    같은 픽스처의 `cur_prc`(정규장 종가 34,950)와 **다른 값**이라는 것이 요점이다 —
    같으면 잔상과 구별되지 않는다.
    """
    exp = parse_ka10001_expected(KA10001_REAL)

    assert exp is not None
    assert (exp.price, exp.qty) == (35_000, 2_198)
    assert KA10001_REAL["cur_prc"] == "+34950"  # 종가와 다르다 = 잔상이 아니다


def test_expected_fill_accepts_unsigned_price() -> None:
    """부호 **없는** 가격이 실제로 온다 — 종가와 같을 때다(실측 `"34950"`).

    `_abs_int` 의 `lstrip("+-")` 가 없으면 이 변종에서 조용히 0 이 되고, 그러면
    "보합일 때만 예상체결이 사라지는" 재현 어려운 버그가 된다.
    """
    unsigned = parse_ka10001_expected({"exp_cntr_pric": "34950", "exp_cntr_qty": "3279"})
    signed = parse_ka10001_expected({"exp_cntr_pric": "+35000", "exp_cntr_qty": "481"})

    assert unsigned is not None and unsigned.price == 34_950
    assert signed is not None and signed.price == 35_000


def test_expected_fill_none_when_either_side_is_zero() -> None:
    """한쪽만 있으면 None — 반쪽짜리 배너를 띄우지 않는다."""
    assert parse_ka10001_expected({"exp_cntr_pric": "0", "exp_cntr_qty": "3279"}) is None
    assert parse_ka10001_expected({"exp_cntr_pric": "34950", "exp_cntr_qty": "0"}) is None
    assert parse_ka10001_expected({}) is None


@pytest.mark.asyncio
async def test_expected_failure_does_not_take_down_the_ladder() -> None:
    """**실패 격리** — ka10001 이 죽어도 ka10087 사다리는 나간다.

    이 구간에 ka10087 은 **유일한** 호가 소스다. 예상체결은 그 위의 부가 정보라,
    부가 정보의 장애가 화면 전체를 끄는 것은 손익이 맞지 않는다(`AfterHoursView` 표).
    """
    f = KiwoomAfterHoursFetcher(
        _FakeTokenProvider(),
        _transport=_transport(GOLDEN, expected_body={"return_code": 3}, expected_status=500),
    )
    try:
        view = await f.get("006360")
    finally:
        f.close()

    assert view.expected is None
    assert view.book.ask[0].price == 35_400  # 사다리는 멀쩡하다


# ── 합성 체결 원장 (_FillLedger) ────────────────────────────────────────────
#
# 이 클래스의 계약은 "행을 만든다" 가 아니라 **"언제 만들지 않는가"** 다. 아래 네
# 개의 음성 케이스가 그 계약이고, 하나라도 빠지면 여러 주기의 합이 한 줄로 위조된다.

_T0 = 1_787_123_400_000  # 2026-08-19 16:30:00 KST


def test_first_observation_makes_no_row() -> None:
    """첫 관측은 기준선이다 — 그때까지의 누적은 여러 주기의 합이라 한 줄이 못 된다."""
    led = _FillLedger()
    led.observe("006360", t_ms=_T0, acc_volume=2_845, price=34_950)

    assert led.rows("006360", t_ms=_T0) == ()


def test_delta_within_one_boundary_makes_a_row() -> None:
    """정상 폴링(경계 0~1개)의 증분은 그 주기의 체결이다."""
    led = _FillLedger()
    led.observe("006360", t_ms=_T0 - 20_000, acc_volume=2_845, price=34_950)  # 16:29:40
    led.observe("006360", t_ms=_T0 + 27_000, acc_volume=6_329, price=34_950)  # 16:30:27

    rows = led.rows("006360", t_ms=_T0 + 27_000)
    assert len(rows) == 1
    assert (rows[0].price, rows[0].qty) == (34_950, 3_484)  # 실측 그대로


def test_observation_gap_re_baselines_instead_of_forging_a_row() -> None:
    """**관측 공백은 행을 만들지 않는다.**

    16:05 에 보다가 16:45 에 돌아오면 순진한 델타는 5,638주 @ 16:45 가격 한 줄을
    만든다. 그 물량은 네 주기에 걸쳐 서로 다른 가격에 체결된 것이라 **어느 주기의
    사실도 아니다** — 첫 관측에 행을 안 만드는 규칙이 갭으로 우회되는 경로다.
    """
    led = _FillLedger()
    led.observe("006360", t_ms=_T0 - 1_500_000, acc_volume=1_590, price=34_950)  # 16:05
    led.observe("006360", t_ms=_T0 + 900_000, acc_volume=7_228, price=35_100)  # 16:45

    assert led.rows("006360", t_ms=_T0 + 900_000) == ()


def test_exactly_one_boundary_still_counts() -> None:
    """경계 **하나**는 정상이다 — 체결 주기를 넘는 관측 쌍이 바로 그 모양이라,
    여기를 0 으로 좁히면 잡으려던 체결을 전부 놓친다."""
    led = _FillLedger()
    led.observe("006360", t_ms=_T0 - 1_000, acc_volume=2_845, price=34_950)  # 16:29:59
    led.observe("006360", t_ms=_T0 + 1_000, acc_volume=6_329, price=34_950)  # 16:30:01

    assert len(led.rows("006360", t_ms=_T0 + 1_000)) == 1


def test_decrease_re_baselines() -> None:
    """누적이 줄면(벤더 되감기·날짜 전환) 기준만 새로 잡는다 — 음수 행은 없다."""
    led = _FillLedger()
    led.observe("006360", t_ms=_T0, acc_volume=6_329, price=34_950)
    led.observe("006360", t_ms=_T0 + 10_000, acc_volume=1_590, price=34_950)

    assert led.rows("006360", t_ms=_T0 + 10_000) == ()


def test_missing_price_makes_no_row() -> None:
    """가격이 없으면 행의 절반이 비어 표시할 수 없다."""
    led = _FillLedger()
    led.observe("006360", t_ms=_T0, acc_volume=2_845, price=34_950)
    led.observe("006360", t_ms=_T0 + 27_000, acc_volume=6_329, price=None)

    assert led.rows("006360", t_ms=_T0 + 27_000) == ()


def test_rows_are_newest_first() -> None:
    """체결창이 위에서부터 최신을 그린다 — 정렬을 소비자에게 미루지 않는다."""
    led = _FillLedger()
    led.observe("006360", t_ms=_T0, acc_volume=2_845, price=34_950)
    led.observe("006360", t_ms=_T0 + 30_000, acc_volume=6_329, price=34_950)
    led.observe("006360", t_ms=_T0 + 600_000, acc_volume=7_228, price=35_100)

    rows = led.rows("006360", t_ms=_T0 + 600_000)
    assert [r.qty for r in rows] == [899, 3_484]


def test_next_day_clears_rows() -> None:
    """자정을 넘겨 열어 둔 탭이 어제 체결을 오늘 것처럼 보여주지 않는다."""
    led = _FillLedger()
    led.observe("006360", t_ms=_T0, acc_volume=2_845, price=34_950)
    led.observe("006360", t_ms=_T0 + 30_000, acc_volume=6_329, price=34_950)
    assert len(led.rows("006360", t_ms=_T0 + 30_000)) == 1

    led.observe("006360", t_ms=_T0 + 86_400_000, acc_volume=100, price=35_000)

    assert led.rows("006360", t_ms=_T0 + 86_400_000) == ()


def test_rows_empty_for_unknown_code() -> None:
    assert _FillLedger().rows("000000", t_ms=_T0) == ()


# ── wire 모델 채움 (AfterHoursBookResponse) ─────────────────────────────────
#
# 위 테스트들은 fetcher·파서까지만 본다. `response_model` 은 **선언되지 않은 키를
# 조용히 버리므로**(CLAUDE.md), 모델을 실제로 채워 wire 키가 남는지 따로 재야 한다.
# 부분 payload(`active=False`)를 함께 넣는 것도 같은 규율이다 — 그 경로는 무자격
# dev·창 밖에서 **정상 경로**라 여기서 깨지면 그 환경이 전부 조용히 빈다.


def test_response_model_keeps_new_wire_keys() -> None:
    from hoga.live.api import AfterHoursBookResponse, AfterHoursFillModel

    dumped = AfterHoursBookResponse(
        code="006360",
        active=True,
        exp_price=35_000,
        exp_qty=2_198,
        fills=[AfterHoursFillModel(t_ms=1_787_123_427_000, price=34_950, qty=3_484)],
    ).model_dump()

    assert dumped["exp_price"] == 35_000
    assert dumped["exp_qty"] == 2_198
    assert dumped["fills"] == [{"t_ms": 1_787_123_427_000, "price": 34_950, "qty": 3_484}]
    # `side` 를 싣지 않는다 — 단일가 일괄 체결이라 방향이 정의되지 않는다.
    assert "side" not in dumped["fills"][0]


def test_inactive_partial_payload_still_carries_the_keys() -> None:
    """창 밖·미거래 종목의 부분 payload. **키가 사라지면 안 된다** — 프론트가
    `exp_price ?? 0` 같은 식으로 읽는데 키 자체가 없으면 미러가 거짓이 된다."""
    from hoga.live.api import AfterHoursBookResponse

    dumped = AfterHoursBookResponse(code="006360", active=False).model_dump()

    assert dumped["exp_price"] is None and dumped["exp_qty"] is None
    assert dumped["fills"] == []
    assert dumped["active"] is False
