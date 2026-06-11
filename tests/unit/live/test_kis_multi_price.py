import pytest
from hoga.live.kis_client import KisQuote, _parse_quote, _build_multi_price_params, _fetch_multi_price


def test_parse_quote_up_sign_positive():
    # prdy_vrss_sign 2 = 상승 → 양수, inter2_prpr → price, 코드는 inter_shrn_iscd
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "72400",
                      "prdy_ctrt": "1.20", "prdy_vrss_sign": "2"})
    assert q == KisQuote(code="005930", price=72400, change_pct=1.20)


def test_parse_quote_down_sign_forces_negative():
    # 부호 5(하락)는 prdy_ctrt 가 부호 없이 와도 음수로 정규화
    q = _parse_quote({"inter_shrn_iscd": "000660", "inter2_prpr": "183500",
                      "prdy_ctrt": "0.80", "prdy_vrss_sign": "5"})
    assert q is not None
    assert q.change_pct == -0.80
    assert q.price == 183500


def test_parse_quote_flat_sign_zero():
    q = _parse_quote({"inter_shrn_iscd": "000020", "inter2_prpr": "10000",
                      "prdy_ctrt": "0.00", "prdy_vrss_sign": "3"})
    assert q is not None
    assert q.change_pct == 0.0


def test_parse_quote_missing_ctrt_is_none():
    q = _parse_quote({"inter_shrn_iscd": "123456", "inter2_prpr": "5000",
                      "prdy_ctrt": "", "prdy_vrss_sign": ""})
    assert q is not None
    assert q.change_pct is None
    assert q.price == 5000


def test_parse_quote_unknown_sign_is_none_not_positive():
    # #11: 미인식 부호코드(1·2·3·4·5 밖)는 방향 불명 → change_pct·change_won 모두
    # None. prdy_ctrt·inter2_prdy_vrss 는 절대값이라, 양수로 위조하면 하락 종목이
    # 상승(KRX 빨강)으로 역표시된다.
    q = _parse_quote({"inter_shrn_iscd": "000660", "inter2_prpr": "183500",
                      "inter2_prdy_vrss": "1500", "prdy_ctrt": "0.80", "prdy_vrss_sign": "0"})
    assert q is not None and q.price == 183500
    assert q.change_pct is None and q.change_won is None


def test_parse_quote_blank_or_missing_code_is_none():
    # 무효 코드 placeholder 행(inter_shrn_iscd 빈값) / 빈 dict → None
    assert _parse_quote({"inter_shrn_iscd": "", "inter2_prpr": ""}) is None
    assert _parse_quote({}) is None


def test_parse_quote_nonnumeric_price_is_safe():
    # 숫자 파싱 실패해도 500 유발 없이 안전 처리 (price 0, change_pct None)
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "N/A", "prdy_ctrt": "x"})
    assert q is not None and q.price == 0 and q.change_pct is None


def test_parse_quote_includes_today_ohlc():
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "298000",
                      "prdy_ctrt": "1.50", "prdy_vrss_sign": "2",
                      "inter2_oprc": "290500", "inter2_hgpr": "306500", "inter2_lwpr": "287500"})
    assert q is not None
    assert (q.open, q.high, q.low) == (290500, 306500, 287500)
    assert q.price == 298000 and q.change_pct == 1.50  # 기존 로직 불변


def test_parse_quote_ohlc_kept_when_change_bails_out():
    # 빈 prdy_ctrt → change=None 이어도 OHLC는 채워진다(단일 return 검증; 4-return 함정 방지).
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "298000",
                      "prdy_ctrt": "", "inter2_oprc": "290500",
                      "inter2_hgpr": "306500", "inter2_lwpr": "287500"})
    assert q is not None
    assert q.change_pct is None and q.change_won is None
    assert (q.open, q.high, q.low) == (290500, 306500, 287500)


def test_parse_quote_ohlc_missing_or_zero_is_none():
    # 빈값/0/비숫자 → None (0 위조 금지 — 스케일·양봉판정 오염 방지).
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "298000",
                      "prdy_ctrt": "1.5", "prdy_vrss_sign": "2",
                      "inter2_oprc": "0", "inter2_hgpr": "", "inter2_lwpr": "N/A"})
    assert q is not None
    assert (q.open, q.high, q.low) == (None, None, None)


def test_parse_quote_includes_signed_change_won():
    # inter2_prdy_vrss(전일대비 등락액, 절대값) 에 prdy_vrss_sign 을 등락률과 공통 적용
    up = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "72400",
                       "inter2_prdy_vrss": "750", "prdy_ctrt": "1.05", "prdy_vrss_sign": "2"})
    assert up is not None and up.change_won == 750
    down = _parse_quote({"inter_shrn_iscd": "000660", "inter2_prpr": "183500",
                         "inter2_prdy_vrss": "1500", "prdy_ctrt": "0.81", "prdy_vrss_sign": "5"})
    assert down is not None and down.change_won == -1500


def test_parse_quote_change_won_falls_back_to_prdy_vrss():
    # inter2 접두사 없는 prdy_vrss 폴백 (multprice 정식 키는 inter2_prdy_vrss)
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "72400",
                      "prdy_vrss": "750", "prdy_ctrt": "1.05", "prdy_vrss_sign": "2"})
    assert q is not None and q.change_won == 750


def test_parse_quote_flat_change_won_is_zero():
    q = _parse_quote({"inter_shrn_iscd": "000020", "inter2_prpr": "10000",
                      "inter2_prdy_vrss": "0", "prdy_ctrt": "0.00", "prdy_vrss_sign": "3"})
    assert q is not None and q.change_won == 0


def test_parse_quote_missing_change_won_is_none():
    # 등락액 키가 없으면 change_won None — 등락률은 정상 파싱
    q = _parse_quote({"inter_shrn_iscd": "005930", "inter2_prpr": "72400",
                      "prdy_ctrt": "1.05", "prdy_vrss_sign": "2"})
    assert q is not None and q.change_won is None and q.change_pct == 1.05


def test_build_multi_price_params_numbered_keys():
    p = _build_multi_price_params(["005930", "000660"])
    assert p["FID_COND_MRKT_DIV_CODE_1"] == "J" and p["FID_INPUT_ISCD_1"] == "005930"
    assert p["FID_COND_MRKT_DIV_CODE_2"] == "J" and p["FID_INPUT_ISCD_2"] == "000660"
    assert "FID_INPUT_ISCD_3" not in p


@pytest.mark.asyncio
async def test_fetch_multi_price_chunks_over_30():
    calls: list[dict] = []

    async def fake_get(*, path, tr_id, params):
        calls.append(params)
        # output 행마다 자신의 inter_shrn_iscd (요청 코드 순서대로)
        codes_in = []
        n = 1
        while f"FID_INPUT_ISCD_{n}" in params:
            codes_in.append(params[f"FID_INPUT_ISCD_{n}"])
            n += 1
        return {"output": [
            {"inter_shrn_iscd": c, "inter2_prpr": "100", "prdy_ctrt": "1.00", "prdy_vrss_sign": "2"}
            for c in codes_in
        ]}

    codes = [f"{i:06d}" for i in range(35)]  # 35개 → 30 + 5 두 청크
    quotes = await _fetch_multi_price(fake_get, codes)

    assert len(calls) == 2  # 청킹
    assert {q.code for q in quotes} == set(codes)
    assert all(q.change_pct == 1.0 for q in quotes)


@pytest.mark.asyncio
async def test_fetch_multi_price_maps_by_response_code_not_position():
    # 핵심: 응답이 요청과 다른 순서 + 가운데 빈 placeholder 행이어도
    # inter_shrn_iscd 로 매핑되어 값이 엉뚱한 종목에 붙지 않는다.
    async def fake_get(*, path, tr_id, params):
        return {"output": [
            {"inter_shrn_iscd": "000660", "inter2_prpr": "183500", "prdy_ctrt": "0.80", "prdy_vrss_sign": "5"},
            {"inter_shrn_iscd": "", "inter2_prpr": ""},  # 무효 코드 → 빈 placeholder
            {"inter_shrn_iscd": "005930", "inter2_prpr": "72400", "prdy_ctrt": "1.20", "prdy_vrss_sign": "2"},
        ]}

    quotes = await _fetch_multi_price(fake_get, ["005930", "999999", "000660"])
    by = {q.code: q for q in quotes}
    assert set(by) == {"005930", "000660"}  # 빈 placeholder 는 건너뜀
    assert by["005930"].price == 72400 and by["005930"].change_pct == 1.20
    assert by["000660"].price == 183500 and by["000660"].change_pct == -0.80
