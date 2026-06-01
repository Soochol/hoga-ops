import pytest
from hoga.live.kis_client import KisQuote, _parse_quote, _build_multi_price_params, _fetch_multi_price


def test_parse_quote_up_sign_positive():
    # prdy_vrss_sign 2 = 상승 → 양수, inter2_prpr → price
    q = _parse_quote("005930", {"inter2_prpr": "72400", "prdy_ctrt": "1.20", "prdy_vrss_sign": "2"})
    assert q == KisQuote(code="005930", price=72400, change_pct=1.20)


def test_parse_quote_down_sign_forces_negative():
    # 부호 5(하락)는 prdy_ctrt 가 부호 없이 와도 음수로 정규화
    q = _parse_quote("000660", {"inter2_prpr": "183500", "prdy_ctrt": "0.80", "prdy_vrss_sign": "5"})
    assert q.change_pct == -0.80
    assert q.price == 183500


def test_parse_quote_flat_sign_zero():
    q = _parse_quote("000020", {"inter2_prpr": "10000", "prdy_ctrt": "0.00", "prdy_vrss_sign": "3"})
    assert q.change_pct == 0.0


def test_parse_quote_missing_ctrt_is_none():
    q = _parse_quote("123456", {"inter2_prpr": "5000", "prdy_ctrt": "", "prdy_vrss_sign": ""})
    assert q.change_pct is None
    assert q.price == 5000


def test_build_multi_price_params_numbered_keys():
    p = _build_multi_price_params(["005930", "000660"])
    assert p["FID_COND_MRKT_DIV_CODE_1"] == "J" and p["FID_INPUT_ISCD_1"] == "005930"
    assert p["FID_COND_MRKT_DIV_CODE_2"] == "J" and p["FID_INPUT_ISCD_2"] == "000660"
    assert "FID_INPUT_ISCD_3" not in p


@pytest.mark.asyncio
async def test_fetch_multi_price_chunks_over_30_and_zips_order():
    calls: list[dict] = []

    async def fake_get(*, path, tr_id, params):
        calls.append(params)
        # output 순서 = 입력 순서. 청크 내 코드 수만큼 행 반환.
        n = sum(1 for k in params if k.startswith("FID_INPUT_ISCD_"))
        return {"output": [
            {"inter2_prpr": "100", "prdy_ctrt": "1.00", "prdy_vrss_sign": "2"} for _ in range(n)
        ]}

    codes = [f"{i:06d}" for i in range(35)]  # 35개 → 30 + 5 두 청크
    quotes = await _fetch_multi_price(fake_get, codes)

    assert len(calls) == 2  # 청킹
    assert [q.code for q in quotes] == codes  # 입력 순서 보존
    assert all(q.change_pct == 1.0 for q in quotes)
