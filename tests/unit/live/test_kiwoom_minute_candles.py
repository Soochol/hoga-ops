"""키움 분봉 어댑터 테스트 (#1043, PR-G) — ADR-0136 §3 의 커서 규칙.

체크리스트(#1043)를 그대로 봉인한다. 하나라도 빠지면 조용히 틀린다:
  ① 커서 = 응답의 **최古 날짜**, 적재하지 않고 다음 `base_dt` 로 재사용
  ② **진행 보장 가드** — 없으면 보유 바닥에서 무한 루프
  ③ `max_pages` 도달 시 **조용한 절단 금지**
  ④ 완결성 판정에 **봉 개수·첫 봉 시각 금지** (333봉 정상일 · 09:02 개장일 반례)
"""
from __future__ import annotations

import datetime

import httpx
import pytest

from hoga.live.kiwoom_minute_candles import (
    MinutePage,
    fetch_minute_page,
    parse_row,
    split_page,
    venue_code,
    walk_minute_days,
)
from hoga.live.kiwoom_rest import KiwoomRestClient


class _Prov:
    def get_token(self) -> str:
        return "tok"


def _client(handler) -> KiwoomRestClient:
    return KiwoomRestClient(_Prov(), transport=httpx.MockTransport(handler))


def _ok(rows: list[dict]) -> httpx.Response:
    return httpx.Response(
        200,
        json={"return_code": 0, "return_msg": "정상", "stk_min_pole_chart_qry": rows},
        headers={"cont-yn": "N", "next-key": ""},
    )


def _bar(stamp: str, *, price: str = "-239500", qty: str = "100") -> dict:
    """실측 행 모양(005930, 2026-08-03). **가격에 부호가 붙는다.**"""
    return {
        "cntr_tm": stamp, "cur_prc": price, "open_pric": price,
        "high_pric": price, "low_pric": price, "trde_qty": qty,
        "acc_trde_qty": "27393019", "pred_pre": "-23000", "pred_pre_sig": "5",
    }


def _day(date_s: str, n: int) -> list[dict]:
    """그 날 09:00 부터 n 봉 (응답은 최신순이므로 역순으로 낸다)."""
    return [_bar(f"{date_s}{9 + (i // 60):02d}{i % 60:02d}00") for i in range(n)][::-1]


# === 부호 규약 — 일봉과 **반대**다 ==========================================

def test_minute_prices_carry_a_direction_sign_unlike_daily() -> None:
    """`ka10081`(일봉)은 무부호인데 `ka10080`(분봉)은 부호를 싣는다.

    #1043 실측: 900행 중 439행에 부호. 같은 `/api/dostk/chart` 경로인데도
    다르다 — 일봉 어댑터의 규약을 복사하면 안 되는 이유다.
    """
    parsed = parse_row(_bar("20260803153000", price="-239500"))
    assert parsed is not None
    date_s, candle = parsed
    assert date_s == "20260803"
    assert candle.close == 239_500, "부호는 등락 방향이라 가격에서는 버린다"

    plus = parse_row(_bar("20260730130400", price="+210000"))
    assert plus is not None and plus[1].close == 210_000


def test_bar_volume_comes_from_trde_qty_not_the_cumulative_field() -> None:
    """`acc_trde_qty` 는 **누적**이다 — 봉 거래량 자리에 쓰면 단조증가 막대가 된다."""
    parsed = parse_row(_bar("20260803153000", qty="2699056"))
    assert parsed is not None
    assert parsed[1].volume == 2_699_056


@pytest.mark.parametrize("bad", [
    {"cntr_tm": "2026080315300"},                       # 길이 부족
    {**_bar("20260803153000"), "cur_prc": "0"},          # 종가 0
    {**_bar("20260803153000"), "open_pric": ""},         # 필드 결손
    _bar("20260800153000"),                              # 자릿수는 맞고 달력상 불가능
    _bar("20260231153000"),                              # 2월 31일
])
def test_unreadable_rows_are_skipped_not_raised(bad: dict) -> None:
    assert parse_row(bad) is None


# === 체크리스트 ① 최古 날짜는 적재하지 않는다 ================================

def test_oldest_date_is_withheld_and_becomes_the_cursor() -> None:
    """**"반쪽을 버린다" 가 아니라 "반쪽 날짜를 다음 커서로 쓴다".**

    #1043 실측:
        base_dt=20260803 → 최古 20260730 이 139봉 (잘림)
        base_dt=20260730 → 같은 날이 382봉 (온전)
    """
    rows = _day("20260803", 3) + _day("20260731", 3) + _day("20260730", 2)
    page = split_page(rows)
    assert set(page.complete) == {"20260803", "20260731"}
    assert page.oldest == "20260730", "최古는 다음 커서이지 결과가 아니다"
    assert "20260730" not in page.complete


def test_single_date_page_yields_nothing_complete() -> None:
    """한 날짜뿐이면 그 날짜가 곧 최古다 — 온전하다고 말할 수 있는 것이 없다."""
    page = split_page(_day("20260803", 5))
    assert page.complete == {}
    assert page.oldest == "20260803"


def test_empty_page_has_no_cursor() -> None:
    assert split_page([]) == MinutePage(complete={}, oldest="")


def test_complete_days_are_ascending_even_though_the_wire_is_descending() -> None:
    page = split_page(_day("20260803", 4) + _day("20260731", 2))
    bars = page.complete["20260803"]
    assert [b.t_ms for b in bars] == sorted(b.t_ms for b in bars)


# === 체크리스트 ④ 완결성을 데이터로 판정하지 않는다 ==========================

def test_completeness_never_looks_at_bar_count_or_first_bar_time() -> None:
    """**333봉 정상 거래일 · 09:02 개장일 반례**(#1012 실측).

    "첫 봉이 09:00 이면 온전" 도 "봉 수가 382 면 온전" 도 잘린 날과 원래 짧은
    날을 구분하지 못한다. 첫 실험이 그 판정으로 333봉 정상일을 불완전으로
    오판해 무한 재요청에 빠졌다.

    여기서는 봉 2개짜리 날과 09:02 시작인 날을 섞어도 **최古가 아니면 전부
    온전**으로 나온다 — 판정이 구조(프로토콜)에만 의존한다는 증거다.
    """
    rows = (
        _day("20260803", 2)                                  # 2봉짜리 날
        + [_bar("20260731090200"), _bar("20260731090300")]   # 09:02 개장일
        + _day("20260730", 300)                              # 최古 = 제외 대상
    )
    page = split_page(rows)
    assert set(page.complete) == {"20260803", "20260731"}, (
        "봉 수도 첫 봉 시각도 판정에 쓰이지 않는다"
    )
    assert page.oldest == "20260730", "300봉이어도 최古면 제외된다"


# === walk — 커서 전진 · 가드 · 절단 ==========================================

def _pages_handler(pages: list[list[dict]]):
    """`base_dt` 마다 다른 페이지를 돌려주는 핸들러. 요청 커서를 기록한다."""
    seen: list[str] = []
    it = iter(pages)

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        seen.append(_json.loads(r.content)["base_dt"])
        return _ok(next(it, []))

    return _h, seen


async def test_walk_advances_the_cursor_to_the_withheld_date() -> None:
    handler, seen = _pages_handler([
        _day("20260803", 2) + _day("20260731", 2) + _day("20260730", 1),
        _day("20260730", 2) + _day("20260729", 2) + _day("20260728", 1),
    ])
    c = _client(handler)
    res = await walk_minute_days(
        c, "005930", newest_yyyymmdd="20260803", oldest_yyyymmdd="20260729",
    )
    assert seen == ["20260803", "20260730"], "커서 = 직전 응답의 최古 날짜"
    assert set(res.bars_by_date) == {"20260803", "20260731", "20260730", "20260729"}
    assert not res.exhausted and not res.wedged
    await c.aclose()


async def test_walk_needs_a_strictly_older_date_to_stop() -> None:
    """`<=` 로 멈추면 **목표 구간의 가장 오래된 날짜를 영원히 못 받는다.**

    최古 날짜는 `complete` 에서 빠져 있기 때문이다. `kiwoom_index_candles` 가
    같은 자리에서 같은 실수를 했다(from 날짜가 09:52 부터 시작).
    """
    handler, seen = _pages_handler([
        _day("20260803", 2) + _day("20260731", 1),
        _day("20260731", 2) + _day("20260730", 1),
    ])
    c = _client(handler)
    res = await walk_minute_days(
        c, "005930", newest_yyyymmdd="20260803", oldest_yyyymmdd="20260731",
    )
    assert "20260731" in res.bars_by_date, (
        "목표 하한도 온전하게 받아야 한다 — 한 콜 더 가야 나온다"
    )
    assert len(seen) == 2
    await c.aclose()


async def test_progress_guard_stops_when_the_cursor_stalls() -> None:
    """**가드가 없으면 무한 루프다.** 보유 바닥(분봉 1년 롤링)에서 실제로 걸린다.

    바닥에서는 `base_dt=D` 가 D 하루치만 돌려주므로 최古 == 커서가 된다 —
    조사 실험이 이 가드 없이 그렇게 멈췄다(#1012).
    """
    calls = 0

    def _h(_r: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return _ok(_day("20250801", 382))   # 언제 물어도 같은 하루치

    c = _client(_h)
    res = await walk_minute_days(
        c, "005930", newest_yyyymmdd="20250801", oldest_yyyymmdd="20240101",
    )
    assert res.wedged is True
    assert calls == 1, "커서가 안 움직이면 즉시 멈춘다"
    assert res.bars_by_date == {}
    await c.aclose()


async def test_max_pages_truncation_is_never_silent() -> None:
    """조용히 끊기면 '데이터가 원래 없다' 로 읽힌다(`kiwoom_index_candles` 선례)."""
    n = 0

    def _h(_r: httpx.Request) -> httpx.Response:
        nonlocal n
        n += 1
        # 매 콜마다 하루씩만 뒤로 — 목표에 닿기 전에 상한에 걸린다.
        base = datetime.date(2026, 8, 3) - datetime.timedelta(days=n)
        newer = base.strftime("%Y%m%d")
        older = (base - datetime.timedelta(days=1)).strftime("%Y%m%d")
        return _ok(_day(newer, 2) + _day(older, 1))

    c = _client(_h)
    res = await walk_minute_days(
        c, "005930", newest_yyyymmdd="20260803", oldest_yyyymmdd="20250101",
        max_pages=3,
    )
    assert res.exhausted is True
    assert res.pages == 3
    await c.aclose()


async def test_walk_ignores_dates_outside_the_requested_window() -> None:
    handler, _ = _pages_handler([
        _day("20260803", 2) + _day("20260731", 2) + _day("20260728", 1),
    ])
    c = _client(handler)
    res = await walk_minute_days(
        c, "005930", newest_yyyymmdd="20260731", oldest_yyyymmdd="20260731",
    )
    assert set(res.bars_by_date) == {"20260731"}, "커서보다 새로운 날짜는 담지 않는다"
    await c.aclose()


async def test_empty_page_ends_the_walk() -> None:
    c = _client(lambda _r: _ok([]))
    res = await walk_minute_days(
        c, "005930", newest_yyyymmdd="20200101", oldest_yyyymmdd="20200101",
    )
    assert res.bars_by_date == {} and not res.exhausted and not res.wedged
    await c.aclose()


# === venue · 요청 파라미터 ===================================================

def test_venue_is_expressed_as_code_suffix() -> None:
    assert venue_code("005930", "KRX") == "005930"
    assert venue_code("005930", "NXT") == "005930_NX"
    assert venue_code("005930", "UN") == "005930_AL"


async def test_page_request_carries_base_dt_and_scope() -> None:
    sent: list[dict] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content))
        return _ok(_day("20260803", 2) + _day("20260731", 1))

    c = _client(_h)
    await fetch_minute_page(c, "005930", "20260803", venue="NXT")
    assert sent[0] == {
        "stk_cd": "005930_NX", "tic_scope": "1",
        "upd_stkpc_tp": "1", "base_dt": "20260803",
    }
    await c.aclose()


async def test_walk_routes_every_page_through_the_injected_fetcher() -> None:
    """주입하면 **모든** 페이지가 그 러너를 지난다 — 유량 페이싱의 전제다.

    거버너(`kiwoom_capacity`)는 submit 진입 전에 버킷을 한 번만 소비한다. 한
    페이지라도 러너를 건너뛰면 그만큼이 페이싱 밖으로 새어 `1700 유량=5` 로
    돌아온다(2026-08-04 `ka10080` 실측).
    """
    pages = {
        "20260803": MinutePage(complete={"20260803": []}, oldest="20260731"),
        "20260731": MinutePage(complete={"20260731": []}, oldest="20260729"),
    }
    seen: list[str] = []

    async def _fetch(cursor: str) -> MinutePage:
        seen.append(cursor)
        return pages[cursor]

    res = await walk_minute_days(
        None,  # type: ignore[arg-type] — 주입하면 client 경로는 죽는다
        "005930",
        newest_yyyymmdd="20260803", oldest_yyyymmdd="20260730",
        fetch_page=_fetch,
    )

    assert seen == ["20260803", "20260731"], "커서 전진이 러너를 통해 일어난다"
    assert res.pages == 2
    assert set(res.bars_by_date) == {"20260803", "20260731"}
