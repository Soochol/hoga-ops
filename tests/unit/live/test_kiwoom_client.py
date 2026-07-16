"""kiwoom_client — ka10080 분봉 어댑터 + cont_yn walk-back (MockTransport)."""
import httpx

from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.live.kiwoom_client import KiwoomClient, _row_to_candle


def _row(cntr_tm, cur="-255000", op="-255000", hi="-254000", lo="-256000", vol="100"):
    # 실측 ka10080 행 형태(부호 접두 = 등락방향).
    return {"cur_prc": cur, "trde_qty": vol, "cntr_tm": cntr_tm,
            "open_pric": op, "high_pric": hi, "low_pric": lo}


def test_row_to_candle_strips_sign_and_parses_time():
    c = _row_to_candle(_row("20260716153000"))
    assert c is not None
    # 20260716 15:30:00 KST → t_ms(왕복 확인).
    assert c.t_ms == hhmmssms_to_unix_ms("20260716", 153000000)
    assert c.close == 255000  # cur_prc 부호 strip
    assert c.open == 255000
    assert c.high == 254000
    assert c.low == 256000
    assert c.volume == 100


def test_row_to_candle_rejects_malformed_time():
    assert _row_to_candle(_row("2026071615")) is None  # 14자리 아님
    assert _row_to_candle({"cntr_tm": "notadate12345x"}) is None


def _client(handler):
    async def token_fn():
        return "tok"
    return KiwoomClient(
        token_fn=token_fn, _transport=httpx.MockTransport(handler), min_interval_s=0,
    )


async def test_fetch_single_page():
    def handler(req):
        body = {"stk_min_pole_chart_qry": [
            _row("20260716151000"), _row("20260716150900"), _row("20260716150800"),
        ], "return_code": 0}
        return httpx.Response(200, json=body, headers={"cont-yn": "N", "next-key": ""})

    client = _client(handler)
    candles = await client.fetch_minute_candles("005930")
    await client.aclose()
    assert len(candles) == 3
    # t_ms 오름차순.
    assert [c.t_ms for c in candles] == sorted(c.t_ms for c in candles)


async def test_fetch_walks_back_via_cont_yn():
    calls = []

    def handler(req):
        calls.append((req.headers.get("cont-yn"), req.headers.get("next-key")))
        if req.headers.get("cont-yn") != "Y":  # 첫 페이지
            body = {"stk_min_pole_chart_qry": [_row("20260716151000"), _row("20260716150900")]}
            return httpx.Response(200, json=body, headers={"cont-yn": "Y", "next-key": "K2"})
        # 둘째 페이지(과거)
        body = {"stk_min_pole_chart_qry": [_row("20260716150800"), _row("20260716150700")]}
        return httpx.Response(200, json=body, headers={"cont-yn": "N", "next-key": ""})

    client = _client(handler)
    candles = await client.fetch_minute_candles("005930")
    await client.aclose()
    assert len(candles) == 4  # 2페이지 병합
    # 첫 호출 cont-yn=N, 둘째는 이전 응답의 next-key(K2)로.
    assert calls[0] == ("N", "")
    assert calls[1] == ("Y", "K2")


async def test_until_date_stops_walkback():
    def handler(req):
        if req.headers.get("cont-yn") != "Y":
            body = {"stk_min_pole_chart_qry": [_row("20260716151000")]}
            return httpx.Response(200, json=body, headers={"cont-yn": "Y", "next-key": "K2"})
        # 둘째 페이지는 목표 이전 날짜(20260715) → until_date=20260716이면 정지.
        body = {"stk_min_pole_chart_qry": [_row("20260715151000")]}
        return httpx.Response(200, json=body, headers={"cont-yn": "Y", "next-key": "K3"})

    client = _client(handler)
    candles = await client.fetch_minute_candles("005930", until_date="20260716")
    await client.aclose()
    # 20260716 봉만, 20260715는 until_date 이전이라 제외 + walk-back 정지.
    assert len(candles) == 1


async def test_dedup_across_pages():
    def handler(req):
        if req.headers.get("cont-yn") != "Y":
            body = {"stk_min_pole_chart_qry": [_row("20260716151000"), _row("20260716150900")]}
            return httpx.Response(200, json=body, headers={"cont-yn": "Y", "next-key": "K2"})
        # 겹치는 봉(150900) 포함.
        body = {"stk_min_pole_chart_qry": [_row("20260716150900"), _row("20260716150800")]}
        return httpx.Response(200, json=body, headers={"cont-yn": "N", "next-key": ""})

    client = _client(handler)
    candles = await client.fetch_minute_candles("005930")
    await client.aclose()
    assert len(candles) == 3  # 150900 중복 제거


async def test_http_error_returns_empty():
    def handler(req):
        return httpx.Response(500, text="err")
    client = _client(handler)
    candles = await client.fetch_minute_candles("005930")
    await client.aclose()
    assert candles == []
