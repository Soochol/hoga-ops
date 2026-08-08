"""키움 주식 일봉 어댑터 테스트 (#1042, PR-F).

실측이 잡은 함정 셋을 봉인한다 — 셋 다 **조용히 틀리는** 종류다:
  ① `upd_stkpc_tp` 극성이 KIS 와 **반대** (0↔1)
  ② 종가 전용 필드가 없다 — `cur_prc` 가 종가
  ③ 가격이 무부호 (복수시세 `ka10095` 와 규약이 다르다)
  ④ 수정주가가 `base_dt` **상대** — 배치마다 척도가 갈린다
"""
from __future__ import annotations

import httpx
import pytest

from hoga.live.kiwoom_daily_candles import (
    UPD_ADJUSTED,
    UPD_RAW,
    adjust_flag,
    fetch_daily_candles,
    parse_row,
    resolve_base_dt,
    venue_code,
)
from hoga.live.kiwoom_rest import KiwoomRestClient

# 실측 행(005930, base_dt=20260803, upd_stkpc_tp=1)
ROW = {
    "cur_prc": "239500", "trde_qty": "27825493", "trde_prica": "6736161",
    "dt": "20260803", "open_pric": "248000", "high_pric": "249500",
    "low_pric": "238000", "pred_pre": "-23000", "pred_pre_sig": "5",
    "trde_tern_rt": "+0.48",
}
# 전일 실측 행 — 검산용(`262500 + (-23000) = 239500`)
ROW_PREV = {**ROW, "dt": "20260731", "cur_prc": "262500", "open_pric": "257000",
            "high_pric": "267000", "low_pric": "243000", "pred_pre": "+55500"}

# 수정주가 기준일(함정 ④). 조회 구간보다 **뒤**에 두어 둘이 구별되게 한다 —
# 기준일과 구간 끝이 같으면 그 테스트는 버그를 못 잡는다.
AS_OF = "20260808"


class _Prov:
    def get_token(self) -> str:
        return "tok"


def _client(handler) -> KiwoomRestClient:
    return KiwoomRestClient(_Prov(), transport=httpx.MockTransport(handler))


def _ok(rows: list[dict], *, cont: str = "N", nk: str = "") -> httpx.Response:
    return httpx.Response(
        200, json={"return_code": 0, "return_msg": "정상", "stk_dt_pole_chart_qry": rows},
        headers={"cont-yn": cont, "next-key": nk},
    )


# === 함정 ① 수정주가 극성 — KIS 와 반대 =====================================

def test_adjust_flag_polarity_is_inverted_from_kis() -> None:
    """**KIS 는 0 이 수정주가, 키움은 1 이 수정주가.**

    삼성전자 2018-05-04 액면분할(50:1) 리트머스로 실측 확증:

        upd_stkpc_tp=0 → 20180427 종가 2,650,000원  (원주가)
        upd_stkpc_tp=1 → 20180427 종가    53,000원  (수정주가)

    값을 그대로 옮기면 스크리너가 원주가를 수정주가 자리에 담는다. 액면분할
    종목에서만 틀려서 대부분의 종목에서는 증상이 없다.
    """
    assert adjust_flag(adjust=True) == UPD_ADJUSTED == "1"
    assert adjust_flag(adjust=False) == UPD_RAW == "0"


@pytest.mark.parametrize(("adjust", "want"), [(True, "1"), (False, "0")])
async def test_fetch_sends_the_adjust_flag(adjust: bool, want: str) -> None:
    sent: list[dict] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content))
        return _ok([ROW])

    c = _client(_h)
    await fetch_daily_candles(
        c, "005930", "20260803", "20260803",
        adjust=adjust, adjusted_as_of=AS_OF if adjust else None,
    )
    assert sent[0]["upd_stkpc_tp"] == want
    await c.aclose()


# === 함정 ② 종가 필드 =======================================================

def test_close_comes_from_cur_prc_because_there_is_no_close_field() -> None:
    """KIS 는 `stck_clpr`(종가)/`stck_prpr`(현재가)를 나누지만 키움은 한 칸이다."""
    candle, violation = parse_row(ROW, from_yyyymmdd="20260803", to_yyyymmdd="20260803")
    assert violation is None
    assert candle is not None
    assert candle.close == 239_500
    assert "stck_clpr" not in ROW and "close" not in ROW, (
        "종가 전용 필드가 없다는 것이 이 매핑의 근거다"
    )


def test_measured_rows_are_arithmetically_consistent() -> None:
    """실측 교차검증: 전일 종가 + 당일 `pred_pre` = 당일 종가.

    이 검산이 `cur_prc` 를 종가로 읽는 것이 맞다는 근거다.
    """
    prev_close = int(ROW_PREV["cur_prc"])
    delta = int(ROW["pred_pre"])
    assert prev_close + delta == int(ROW["cur_prc"])


# === 함정 ③ 무부호 가격 — ka10095 와 규약이 다르다 ==========================

def test_prices_are_absolute_even_if_a_sign_arrives() -> None:
    """복수시세(`ka10095`)는 `cur_prc` 에 등락 방향을 부호로 싣지만 일봉은 무부호다.

    같은 벤더 안에서도 TR 마다 다르므로 부호가 오더라도 절대값을 취한다.
    """
    signed = {**ROW, "cur_prc": "-239500", "low_pric": "-238000"}
    candle, _ = parse_row(signed, from_yyyymmdd="20260803", to_yyyymmdd="20260803")
    assert candle is not None
    assert candle.close == 239_500
    assert candle.low == 238_000


# === 함정 ④ 수정주가는 base_dt 상대 =========================================

async def test_base_dt_carries_the_basis_date_not_the_range_end() -> None:
    """**이 단언 하나가 2018-03-05 절벽을 막는다.**

    키움 수정주가는 `base_dt` **상대**라, `base_dt` 이후의 액면분할은 빠진다.
    035720(카카오, 2021-04-15 5:1) 실측:

        base_dt=20191231 → 20191230 종가 153,500  (분할 미반영 = 원주가)
        base_dt=20210630 → 20200106 종가  31,008  (반영 = 155,040 ÷ 5)

    그래서 조회 구간이 과거여도 `base_dt` 는 **기준일**이어야 한다. 구간 끝을
    주소로 쓰면 배치마다 척도가 갈린다.
    """
    sent: list[dict] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content))
        return _ok([{**ROW, "dt": "20180302"}, {**ROW, "dt": "20180101"}])

    c = _client(_h)
    await fetch_daily_candles(
        c, "005930", "20171226", "20180302", adjust=True, adjusted_as_of=AS_OF
    )
    assert sent[0]["base_dt"] == AS_OF
    assert sent[0]["base_dt"] != "20180302", "구간 끝이 기준일 자리로 새면 안 된다"
    await c.aclose()


async def test_raw_fetch_keeps_base_dt_random_access() -> None:
    """원주가는 절대값이라 기준일이 무의미하다 — #1008 랜덤 액세스를 그대로 쓴다.

    여기서 굳이 기준일로 고정하면 페이지만 낭비된다(오늘부터 걸어 내려가야 하므로).
    """
    sent: list[dict] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content))
        return _ok([{**ROW, "dt": "20180302"}])

    c = _client(_h)
    await fetch_daily_candles(
        c, "005930", "20180301", "20180302", adjust=False, adjusted_as_of=None
    )
    assert sent[0]["base_dt"] == "20180302"
    await c.aclose()


def test_adjusted_fetch_without_a_basis_date_is_refused() -> None:
    """**기본값을 주지 않는 이유.** 기준일 없는 수정주가 요청은 조용히 배치의 끝
    날짜로 떨어지고, 그러면 그 뒤의 분할이 통째로 빠진다 — 증상은 분할 종목에서만,
    그것도 배치 경계에서만 나타나 한참 뒤에 발견된다.
    """
    with pytest.raises(ValueError, match="adjusted_as_of"):
        resolve_base_dt(to_yyyymmdd="20180302", adjust=True, adjusted_as_of=None)


def test_basis_never_shrinks_below_the_range_end() -> None:
    """기준일보다 뒤를 조회하면(오늘 봉) `base_dt` 가 구간을 못 덮어 빈 응답이 된다."""
    assert resolve_base_dt(
        to_yyyymmdd="20260810", adjust=True, adjusted_as_of=AS_OF
    ) == "20260810"
    assert resolve_base_dt(
        to_yyyymmdd="20180302", adjust=True, adjusted_as_of=AS_OF
    ) == AS_OF


# === 불변식 위반 — reason 집합은 ADR-0129 D5 로 닫혀 있다 ====================

@pytest.mark.parametrize(("row", "reason"), [
    ({**ROW, "dt": "20"}, "malformed_row"),
    ({**ROW, "cur_prc": ""}, "malformed_row"),
    ({**ROW, "cur_prc": "0"}, "close_nonpositive"),
    ({**ROW, "high_pric": "1"}, "ohlc_inconsistent"),
])
def test_bad_rows_become_closed_set_violations(row: dict, reason: str) -> None:
    candle, violation = parse_row(row, from_yyyymmdd="20260803", to_yyyymmdd="20260803")
    assert candle is None
    assert violation is not None and violation.reason == reason


async def test_rows_older_than_from_are_not_violations() -> None:
    """**설계상 반드시 생기는 넘침이라 위반이 아니다.**

    walk 는 `from` 을 덮을 때까지 걷고, 덮었다는 것 자체가 그 페이지에 `from`
    이전 행이 섞였다는 뜻이다. 이걸 위반으로 실으면 정상 조회마다 경고가 뜬다.
    """
    rows = [ROW, {**ROW, "dt": "20260731"}, {**ROW, "dt": "20200101"}]
    c = _client(lambda _r: _ok(rows))
    res = await fetch_daily_candles(
        c, "005930", "20260731", "20260803", adjust=True, adjusted_as_of="20260803"
    )
    assert [x.reason for x in res.violations] == []
    assert len(res.candles) == 2
    await c.aclose()


async def test_rows_between_to_and_the_basis_date_are_returned_not_dropped() -> None:
    """**함정 ④ 로 뒤집힌 불변식이다.** 예전엔 `base_dt=to` 라 "`to` 보다 새로운
    행" 이 곧 이상이었다. 이제 기준일에서 걸어 내려오므로 `to`~기준일 사이 행은
    설계상 반드시 섞인다 — 위반으로 실으면 가짜 경고가 쏟아진다.

    그리고 **버리지도 않는다.** 어차피 받은 행이라, 돌려주면 호출자가 캐시
    커버리지를 그만큼 넓혀 다음 갭을 없앨 수 있다.
    """
    rows = [{**ROW, "dt": AS_OF}, {**ROW, "dt": "20260803"}, {**ROW, "dt": "20200101"}]
    c = _client(lambda _r: _ok(rows))
    res = await fetch_daily_candles(
        c, "005930", "20260803", "20260803", adjust=True, adjusted_as_of=AS_OF
    )
    assert [v.reason for v in res.violations] == []
    assert len(res.candles) == 2, "20260803(요청 끝) + 20260808(기준일) 둘 다"
    assert [x.t_ms for x in res.candles] == sorted(x.t_ms for x in res.candles)
    await c.aclose()


async def test_raw_fetch_still_stops_at_the_requested_end() -> None:
    """원주가는 `base_dt=to` 라 반환 구간이 예전과 같다 — 넓어지는 것은 수정주가
    경로뿐이다. 스크리너 코퍼스가 요청 안 한 날짜를 받으면 append 규약이 깨진다.
    """
    rows = [{**ROW, "dt": "20260808"}, {**ROW, "dt": "20260803"}]
    c = _client(lambda _r: _ok(rows))
    res = await fetch_daily_candles(
        c, "005930", "20260803", "20260803", adjust=False, adjusted_as_of=None
    )
    assert len(res.candles) == 1
    assert [v.reason for v in res.violations] == ["out_of_range"], (
        "원주가 경로에서는 `to` 보다 새로운 행이 여전히 진짜 이상이다"
    )
    await c.aclose()


async def test_rows_newer_than_the_basis_date_are_still_violations() -> None:
    """진짜 이상은 여기 하나로 좁혀진다 — 기준일을 줬는데 그보다 미래가 왔다."""
    c = _client(lambda _r: _ok([{**ROW, "dt": "20261231"}, {**ROW, "dt": "20200101"}]))
    res = await fetch_daily_candles(
        c, "005930", "20260803", "20260803", adjust=True, adjusted_as_of=AS_OF
    )
    assert [v.reason for v in res.violations] == ["out_of_range"]
    await c.aclose()


# === 커서 · 종료 조건 ========================================================

async def test_walk_stops_once_the_page_reaches_past_from() -> None:
    """종료 조건이 하나다 — KIS 구현의 4갈래 커서 분기가 사라진다."""
    pages = [
        _ok([{**ROW, "dt": "20260803"}], cont="Y", nk="k1"),
        _ok([{**ROW, "dt": "20260601"}], cont="Y", nk="k2"),
    ]
    it = iter(pages)
    n = 0

    def _h(_r: httpx.Request) -> httpx.Response:
        nonlocal n
        n += 1
        return next(it)

    c = _client(_h)
    await fetch_daily_candles(
        c, "005930", "20260701", "20260803", adjust=True, adjusted_as_of="20260803"
    )
    assert n == 2, "from 이전 날짜를 본 페이지에서 멈춘다(구조적 술어)"
    await c.aclose()


async def test_result_is_ascending_even_though_the_wire_is_descending() -> None:
    """응답은 최신순이고 소비자(차트·캐시)는 오름차순을 기대한다."""
    c = _client(lambda _r: _ok([ROW, ROW_PREV]))
    res = await fetch_daily_candles(
        c, "005930", "20260731", "20260803", adjust=True, adjusted_as_of="20260803"
    )
    assert [x.t_ms for x in res.candles] == sorted(x.t_ms for x in res.candles)
    assert res.candles[0].close == 262_500, "20260731 이 먼저다"
    await c.aclose()


async def test_duplicate_dates_are_collapsed() -> None:
    c = _client(lambda _r: _ok([ROW, ROW, ROW]))
    res = await fetch_daily_candles(
        c, "005930", "20260803", "20260803", adjust=True, adjusted_as_of="20260803"
    )
    assert len(res.candles) == 1
    await c.aclose()


async def test_truncation_is_never_silent() -> None:
    """`max_pages` 에 걸렸는데 조용하면 '데이터가 원래 없다' 로 읽힌다."""
    c = _client(lambda _r: _ok([{**ROW, "dt": "20260803"}], cont="Y", nk="k"))
    res = await fetch_daily_candles(
        c, "005930", "19900101", "20260803", adjust=True, adjusted_as_of="20260803"
    )
    assert any("truncated" in v.detail for v in res.violations)
    await c.aclose()


# === venue — KIS 파라미터가 아니라 코드 접미 =================================

def test_venue_is_expressed_as_code_suffix() -> None:
    """#1042 실측으로 '일봉 venue 미검증' 을 닫았다: `_NX` 333행 · `_AL` 600행."""
    assert venue_code("005930", "KRX") == "005930"
    assert venue_code("005930", "NXT") == "005930_NX"
    assert venue_code("005930", "UN") == "005930_AL"


async def test_fetch_threads_the_venue_suffix() -> None:
    sent: list[str] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content)["stk_cd"])
        return _ok([ROW])

    c = _client(_h)
    for v in ("KRX", "NXT", "UN"):
        await fetch_daily_candles(
            c, "005930", "20260803", "20260803", venue=v,  # type: ignore[arg-type]
            adjust=True, adjusted_as_of=AS_OF,
        )
    assert sent == ["005930", "005930_NX", "005930_AL"]
    await c.aclose()


# === 앵커 — 소스 무관 규약 ===================================================

def test_anchor_is_0900_kst_same_as_the_kis_path() -> None:
    """앵커가 어긋나면 차트에서 하루씩 밀린 것처럼 보인다."""
    import datetime

    from hoga.util.timeenc import KST
    candle, _ = parse_row(ROW, from_yyyymmdd="20260803", to_yyyymmdd="20260803")
    assert candle is not None
    got = datetime.datetime.fromtimestamp(candle.t_ms / 1000, tz=KST)
    assert (got.year, got.month, got.day, got.hour, got.minute) == (2026, 8, 3, 9, 0)
