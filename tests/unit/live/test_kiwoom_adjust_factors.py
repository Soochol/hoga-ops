"""`kiwoom_adjust_factors` — 분봉 척도를 오늘로 고정하는 계수 테이블 (#1229)."""
from __future__ import annotations

import httpx
import pytest

from hoga.live.candle_models import LiveCandle
from hoga.live.kiwoom_adjust_factors import (
    AdjustFactors,
    build_factors,
    fetch_adjust_factors,
    scale_bars,
    scale_candle,
)
from hoga.live.kiwoom_rest import KiwoomRestClient


class _Tok:
    def get_token(self) -> str:
        return "t"


def _client(handler) -> KiwoomRestClient:
    return KiwoomRestClient(_Tok(), transport=httpx.MockTransport(handler))


def _rows(pairs: list[tuple[str, int]]) -> list[dict]:
    return [{"dt": d, "cur_prc": str(c)} for d, c in pairs]


def _ok(rows: list[dict]) -> httpx.Response:
    return httpx.Response(
        200, json={"return_code": 0, "return_msg": "", "stk_dt_pole_chart_qry": rows},
    )


# --- 테이블 구축 ------------------------------------------------------------


def test_factors_are_the_daily_adjusted_over_raw_ratio() -> None:
    """340570 실측 형태 — 20260806 효력, 그 이전 날짜만 계수가 붙는다."""
    f = build_factors(
        _rows([("20260807", 33100), ("20260806", 32200), ("20260805", 33200)]),
        _rows([("20260807", 33100), ("20260806", 32200), ("20260805", 65600)]),
        as_of="20260807",
    )
    assert f.dates == ("20260805", "20260806", "20260807")
    assert f.factor_for("20260807") == 1.0
    assert f.factor_for("20260806") == 1.0
    assert f.factor_for("20260805") == pytest.approx(0.5061, abs=1e-4)
    assert not f.is_identity


def test_missing_or_nonpositive_closes_drop_out_of_the_table() -> None:
    """한쪽에만 있는 날짜는 비율을 만들 수 없다 — 계단 함수라 이웃 계수가 옳다."""
    f = build_factors(
        _rows([("20260807", 100), ("20260806", 50), ("20260805", 0)]),
        _rows([("20260807", 100), ("20260804", 100)]),
        as_of="20260807",
    )
    assert f.dates == ("20260807",)


def test_factor_below_the_table_is_none_not_one() -> None:
    """**`None` 을 1.0 으로 접으면 안 된다.**

    테이블 밑은 "계수가 1이다" 가 아니라 "모른다" 다. 1.0 으로 접으면 원주가 봉이
    수정주가 자리에 들어가 화면에 정상처럼 보이는 절벽이 남는다 — 호출자가 경고로
    올릴 수 있어야 한다.
    """
    f = AdjustFactors(as_of="20260807", dates=("20260805",), values=(0.5,))
    assert f.factor_for("20260804") is None
    assert f.factor_for("20260805") == 0.5


def test_lookup_of_a_missing_inner_date_steps_down_to_the_older_entry() -> None:
    f = AdjustFactors(
        as_of="20260807", dates=("20260801", "20260806"), values=(0.5, 1.0),
    )
    assert f.factor_for("20260803") == 0.5   # 20260801 계단 위
    assert f.factor_for("20260807") == 1.0   # 20260806 계단 위


# --- 와이어 ----------------------------------------------------------------


async def test_fetch_sends_two_calls_that_differ_only_in_upd_flag() -> None:
    sent: list[dict] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content))
        upd = sent[-1]["upd_stkpc_tp"]
        close = 50 if upd == "1" else 100
        return _ok(_rows([("20260805", close)]))

    c = _client(_h)
    f = await fetch_adjust_factors(c, "005930", as_of_yyyymmdd="20260807")
    assert sent == [
        {"stk_cd": "005930", "base_dt": "20260807", "upd_stkpc_tp": "1"},
        {"stk_cd": "005930", "base_dt": "20260807", "upd_stkpc_tp": "0"},
    ]
    assert f.factor_for("20260805") == 0.5
    await c.aclose()


async def test_runner_receives_the_upd_flag_so_the_two_calls_cannot_join() -> None:
    """**중복제거 키 판별자다.**

    두 콜은 종목·기준일이 같고 `upd` 하나로만 갈린다. 러너가 이 값을 못 받으면
    호출자가 같은 키로 두 번 submit 하게 되고, 동시 실행된 요청이 조인되면
    **수정주가 응답이 원주가 자리에 들어가** 계수가 전부 1.0 이 된다 — 절벽이
    조용히 되살아난다.
    """
    seen: list[str] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        upd = _json.loads(r.content)["upd_stkpc_tp"]
        return _ok(_rows([("20260805", 50 if upd == "1" else 100)]))

    c = _client(_h)

    async def _run(upd: str, fetch_fn):
        seen.append(upd)
        return await fetch_fn(c)

    await fetch_adjust_factors(c, "005930", as_of_yyyymmdd="20260807", run_call=_run)
    assert seen == ["1", "0"]
    await c.aclose()


async def test_venue_is_ignored_by_default_because_events_belong_to_the_issue() -> None:
    """계수는 venue 무관이다 — NXT 접미가 붙으면 출범 이후만 있는 얕은 테이블이 온다."""
    sent: list[dict] = []

    def _h(r: httpx.Request) -> httpx.Response:
        import json as _json
        sent.append(_json.loads(r.content))
        return _ok(_rows([("20260805", 100)]))

    c = _client(_h)
    await fetch_adjust_factors(c, "005930", as_of_yyyymmdd="20260807")
    assert {s["stk_cd"] for s in sent} == {"005930"}
    await c.aclose()


# --- 적용 ------------------------------------------------------------------


def _bar(price: int, volume: int = 7) -> LiveCandle:
    return LiveCandle(
        t_ms=1, open=price, high=price + 10, low=price - 10, close=price, volume=volume,
    )


def test_scaling_touches_prices_but_not_volume() -> None:
    """**일봉과 규약이 다르다.**

    분봉은 벤더 `upd=1`/`upd=0` 의 `trde_qty` 가 같다(실측 900봉 불일치 0건).
    일봉은 거래량도 스케일한다(598/600행) — 그 규약을 복사하면 분봉 거래량이
    조용히 2배가 된다.
    """
    out = scale_candle(_bar(65600, volume=1234), 0.5)
    assert (out.open, out.high, out.low, out.close) == (32800, 32805, 32795, 32800)
    assert out.volume == 1234


def test_identity_factor_returns_the_very_same_object() -> None:
    """계수 1.0 은 곱셈을 건너뛴다 — 수정 이벤트가 없는 절대다수 경로가 벤더 값과
    비트 단위로 같아야 하기 때문이다(부동소수 왕복 금지)."""
    bar = _bar(65600)
    assert scale_candle(bar, 1.0) is bar
    bars = [bar]
    assert scale_bars(bars, 1.0) is bars
