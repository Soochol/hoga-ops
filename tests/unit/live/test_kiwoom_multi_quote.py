"""키움 관심종목 복수시세 어댑터 테스트 (#1040, PR-D).

두 가지가 조용히 틀릴 수 있는 지점이라 집중해서 봉인한다:
  1. **가격 단위** — 지수용 파서를 쓰면 100배 틀린다
  2. **배치 초과(1634)를 유량 초과(1700)로 오분류** — 무한 재시도가 된다
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from hoga.live.kiwoom_errors import KiwoomBatchLimitError, KiwoomRateLimitError
from hoga.live.kiwoom_index_candles import parse_price
from hoga.live.kiwoom_multi_quote import (
    MAX_CODES_PER_CALL,
    VENUE_SUFFIX,
    chunk_codes,
    fetch_multi_price,
    parse_row,
    strip_venue_suffix,
)
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.quote_models import Quote

# 실측 행(005930, 2026-08-03)
ROW = {
    "stk_cd": "005930", "cur_prc": "-239500", "flu_rt": "-8.76", "pred_pre": "-23000",
    "open_pric": "-248000", "high_pric": "-249500", "low_pric": "-238000",
    "trde_qty": "27393575", "base_pric": "262500",
}


class _Prov:
    def get_token(self) -> str:
        return "tok"


def _client(handler) -> KiwoomRestClient:
    return KiwoomRestClient(_Prov(), transport=httpx.MockTransport(handler))


def _ok(rows: list[dict]) -> httpx.Response:
    return httpx.Response(200, json={"return_code": 0, "return_msg": "정상",
                                     "atn_stk_infr": rows})


# === 가격 단위 — 지수와 다르다 ===============================================

def test_stock_price_is_won_not_scaled_like_index() -> None:
    """지수는 소수점을 제거해 주지만(`'624191'`=6241.91) **주식은 원 단위 정수**다.

    지수용 `parse_price` 를 쓰면 239,500원이 2,395원이 된다 — 100배 오차.
    """
    q = parse_row(ROW)
    assert q is not None
    assert q.price == 239_500, "부호는 등락 방향, 값은 절대값"
    assert parse_price("-239500") == pytest.approx(2395.0), (
        "지수 파서는 100 으로 나눈다 — 주식에 쓰면 안 되는 이유"
    )


def test_row_arithmetic_is_self_consistent() -> None:
    """실측 교차검증: base + change = cur, rate ≈ change / base."""
    q = parse_row(ROW)
    assert q is not None
    assert q.previous_close is not None and q.change_won is not None
    assert q.previous_close + q.change_won == q.price
    assert q.change_pct == pytest.approx(
        q.change_won / q.previous_close * 100, abs=0.01
    )


def test_signs_are_preserved_only_where_they_mean_direction() -> None:
    q = parse_row(ROW)
    assert q is not None
    assert q.change_pct == pytest.approx(-8.76), "등락률은 부호 보존"
    assert q.change_won == -23_000, "전일대비는 부호 보존"
    assert q.open == 248_000 and q.high == 249_500 and q.low == 238_000, "OHLC 는 절대값"


def test_row_without_price_is_skipped() -> None:
    assert parse_row({"stk_cd": "005930", "cur_prc": ""}) is None
    assert parse_row({"cur_prc": "1000"}) is None


# === 배치 상한 ================================================================

def test_batch_limit_matches_measured_ceiling() -> None:
    """실측(#1040): 100 은 통과, 110 은 1634 로 영구 거절."""
    assert MAX_CODES_PER_CALL == 100


def test_chunking_never_exceeds_the_limit() -> None:
    chunks = chunk_codes([f"{i:06d}" for i in range(250)])
    assert [len(c) for c in chunks] == [100, 100, 50]
    assert sum(len(c) for c in chunks) == 250


async def test_fetch_chunks_and_merges() -> None:
    seen: list[int] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        codes = _json.loads(r.content)["stk_cd"].split("|")
        seen.append(len(codes))
        return _ok([{**ROW, "stk_cd": c} for c in codes])

    c = _client(_h)
    quotes = await fetch_multi_price(c, [f"{i:06d}" for i in range(150)])
    # 청크는 **동시 제출**이라(거버너가 큐에서 페이싱한다) 도착 순서를 단언하지
    # 않는다 — 크기 구성만이 계약이다.
    assert sorted(seen, reverse=True) == [100, 50], "상한에 맞춰 쪼갠다"
    assert len(quotes) == 150
    await c.aclose()


# === 1634 vs 1700 — 같은 rc·같은 문구, 다른 의미 =============================

async def test_batch_limit_is_not_misread_as_rate_limit() -> None:
    """**이 구분이 없으면 무한 재시도가 된다.**

    벤더가 배치 초과를 유량 초과와 **똑같은 `return_code 5` + 똑같은 한글 문구**로
    돌려준다. 유량으로 읽으면 호출자가 "잠시 후 재시도" 로 해석하는데, 배치 초과는
    재시도해도 영원히 실패한다.
    """
    body = {"return_code": 5,
            "return_msg": "허용된 요청 개수를 초과하였습니다[1634]"}
    c = _client(lambda _r: httpx.Response(200, json=body))
    with pytest.raises(KiwoomBatchLimitError):
        await c.call("ka10095", {"stk_cd": "005930"})
    await c.aclose()


async def test_real_rate_limit_still_classifies_as_rate_limit() -> None:
    """반대 방향 회귀 방지 — 1700 은 여전히 유량 초과여야 한다."""
    body = {"return_code": 5,
            "return_msg": "허용된 요청 개수를 초과하였습니다[1700:… 유량=5, API ID=ka10095]"}
    c = _client(lambda _r: httpx.Response(429, json=body))
    with pytest.raises(KiwoomRateLimitError) as ei:
        await c.call("ka10095", {"stk_cd": "005930"})
    assert ei.value.quota == 5
    await c.aclose()


# === venue — KIS 파라미터가 아니라 코드 접미다 ================================

def test_response_code_echo_has_suffix_stripped() -> None:
    """응답 `stk_cd` 가 접미를 에코한다 — 벗기지 않으면 소비자 키가 안 맞는다."""
    assert strip_venue_suffix("005930_NX") == "005930"
    assert strip_venue_suffix("005930_AL") == "005930"
    assert strip_venue_suffix("005930") == "005930"
    q = parse_row({**ROW, "stk_cd": "005930_AL"})
    assert q is not None and q.code == "005930"


async def test_venue_is_expressed_as_code_suffix() -> None:
    """KIS 는 `FID_COND_MRKT_DIV_CODE` 파라미터, 키움은 **코드 접미**(#1008)."""
    sent: list[str] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content)["stk_cd"])
        return _ok([ROW])

    c = _client(_h)
    await fetch_multi_price(c, ["005930"], venue="NXT")
    await fetch_multi_price(c, ["005930"], venue="UN")
    await fetch_multi_price(c, ["005930"], venue="KRX")
    assert sent == ["005930_NX", "005930_AL", "005930"]
    await c.aclose()


def test_venue_suffix_table_covers_every_venue() -> None:
    import typing

    from hoga.live.venue import Venue
    assert set(VENUE_SUFFIX) == set(typing.get_args(Venue))


async def test_chunks_route_through_the_injected_fetcher() -> None:
    """**청크 N개면 러너도 N번 불린다** — 유량 페이싱의 전제다.

    거버너(`kiwoom_capacity`)는 `run_with_capacity` 진입 전에 버킷을 한 번만
    소비한다. 이 루프가 한 submit 안에 있으면 버킷은 1 을, 벤더는 청크 수만큼
    센다 — 4,295종목(43청크)이 0.23초에 나가 6번째에서 `1700 유량=5` 였다(#1063).
    """
    codes = [f"{i:06d}" for i in range(MAX_CODES_PER_CALL * 2 + 1)]   # 3청크
    seen: list[list[str]] = []

    async def _runner(chunk: list[str]):
        seen.append(chunk)
        return [Quote(chunk[0], 100, 0.0, 0)]

    out = await fetch_multi_price(None, codes, fetch_chunk_fn=_runner)  # type: ignore[arg-type]

    assert [len(c) for c in seen] == [MAX_CODES_PER_CALL, MAX_CODES_PER_CALL, 1]
    assert len(out) == 3, "청크별 결과가 하나로 합쳐진다"
    assert [q.code for q in out] == [c[0] for c in seen], "순서는 청크 순서를 따른다"


async def test_injected_fetcher_replaces_the_direct_call_path() -> None:
    """주입하면 클라이언트를 **아예 쓰지 않는다** — 페이싱 밖으로 새는 콜이 없다."""
    calls = 0

    def _h(_r: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return _ok([ROW])

    c = _client(_h)

    async def _runner(chunk: list[str]):
        return [Quote(chunk[0], 1, 0.0, 0)]

    await fetch_multi_price(c, ["005930", "000660"], fetch_chunk_fn=_runner)
    assert calls == 0, "주입된 러너를 우회한 직접 호출이 있으면 안 된다"
    await c.aclose()


async def test_empty_codes_issues_no_call() -> None:
    """빈 목록은 청크가 0개 — 러너도 안 부른다."""
    called = False

    async def _runner(_chunk):
        nonlocal called
        called = True
        return []

    assert await fetch_multi_price(None, [], fetch_chunk_fn=_runner) == []  # type: ignore[arg-type]
    assert not called


# ── 당일 누적 요약 4종 (#1682 2단계) ───────────────────────────────────────────
#
# 10호가 요약 패널이 마감 후 `0B` 결손을 이 값들로 메운다. **단위와 의미가 조용히
# 틀릴 수 있는 자리**라 실캡처 픽스처로 못박는다 — 필드 이름만으로 추론하면
# `pred_trde_qty_pre` 를 증감률로 읽어 100%p 틀린다.

_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "fixtures" / "kiwoom_after_hours" / "ka10095_006360_1628.json"
)


def _fixture_row() -> dict:
    """실캡처 ka10095 한 행 (006360 GS건설, 2026-08-19 16:28 = 장 마감 후)."""
    return json.loads(_FIXTURE.read_text())["atn_stk_infr"][0]


def test_trade_value_is_normalized_from_mwon_to_won() -> None:
    # 벤더 `trde_prica` = 98,036 **백만원**. 파서가 원으로 흡수한다(WS FID 14 규율).
    assert parse_row(_fixture_row()).trade_value == 98_036_000_000


def test_trade_value_unit_is_proved_by_vwap_falling_inside_the_day_range() -> None:
    # 단위 증명을 테스트 안에 남긴다: 거래대금 ÷ 거래량 = VWAP 이므로 그날 저가와
    # 고가 사이에 **반드시** 떨어진다. 천원 가정이면 34.5원, 원 가정이면 0.03원이라
    # 이 부등식이 즉시 깨진다 — 즉 이 한 줄이 백만원 축을 유일하게 고정한다.
    q = parse_row(_fixture_row())
    assert q.trade_value is not None and q.volume
    vwap = q.trade_value / q.volume
    assert q.low is not None and q.high is not None
    assert q.low <= vwap <= q.high


def test_vs_prev_volume_is_a_ratio_not_a_delta() -> None:
    # 벤더가 보낸 값은 `+162.95`. 그날 거래량 2,837,598 / 전일(08-18) 1,741,402 =
    # 162.949% 라 **비율**이고, 증감률이었다면 62.95 여야 한다. 전일 거래량은 일봉
    # 코퍼스 실측이고, 같은 행의 `base_pric` 34,150 이 08-18 종가와 일치해 "전일" 의
    # 정의까지 함께 못박힌다. WS FID 30 과 같은 축이다.
    assert parse_row(_fixture_row()).vs_prev_volume_pct == pytest.approx(162.95)
    measured_ratio = 2_837_598 / 1_741_402 * 100  # 그날 거래량 / 전일 거래량
    assert measured_ratio == pytest.approx(162.95, abs=0.01)


def test_fill_strength_is_carried_through() -> None:
    assert parse_row(_fixture_row()).fill_strength_pct == pytest.approx(123.72)


def test_ratio_sign_is_direction_only_and_zero_folds_to_none() -> None:
    # WS `_ratio` 미러 — 같은 값이 두 경로로 오므로 규약이 갈리면 장중과 마감 후에
    # 다른 숫자가 뜬다. 0 은 "미수신" 으로 접는다.
    row = {**ROW, "cntr_str": "-88.10", "pred_trde_qty_pre": "0.00"}
    q = parse_row(row)
    assert q.fill_strength_pct == pytest.approx(88.10)
    assert q.vs_prev_volume_pct is None


def test_missing_summary_fields_stay_none() -> None:
    # 구 응답·부분 payload 에서도 파서가 죽지 않는다(ROW 에는 넷 다 없다).
    q = parse_row(ROW)
    assert (q.trade_value, q.vs_prev_volume_pct, q.fill_strength_pct) == (None, None, None)


def test_zero_trade_value_folds_to_none_like_the_ws_path() -> None:
    assert parse_row({**ROW, "trde_prica": "0"}).trade_value is None
