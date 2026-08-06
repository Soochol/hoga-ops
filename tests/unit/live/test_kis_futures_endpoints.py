"""KIS 선물 시세 파싱 테스트.

**주 회귀 가드는 fail-open 이다.** KIS 는 존재하지 않는 종목코드에도 `rt_cd=0`
"정상처리 되었습니다" + 전 필드 빈 문자열을 준다(2026-08-06 실측: 음성대조군
`ZZ9999` 와 실재 코드의 응답이 rt_cd 수준에서 구분되지 않음). rt_cd 로 성공을
판정하면 롤오버로 사라진 월물을 계속 정상으로 읽는다 — 카드에 0 이 뜬다.

두 번째 가드는 베이시스 필드 선택이다. 응답에 `basis`(이론)와 `mrkt_basis`(시장)가
둘 다 오고 **부호가 다르다** — 실측 KOSPI200: basis +2.15 / mrkt_basis −1.77.
"""
import pytest

from hoga.api.kis_futures_master import FuturesMasterRow
from hoga.live.kis_futures_endpoints import KisFuturesEndpointsMixin

ROW = FuturesMasterRow(
    code="A01609",
    name="F 202609",
    product="kospi200",
    expiry="202609",
    underlying_code="2001",
    underlying_label="KOSPI200",
)

# 2026-08-06 실측 응답에서 관련 필드만 발췌.
REAL_OUTPUT1 = {
    "hts_kor_isnm": "F 202609",
    "futs_prpr": "981.15",
    "futs_prdy_vrss": "-60.90",
    "futs_prdy_ctrt": "-5.84",
    "futs_prdy_clpr": "1042.05",
    "acml_vol": "123714",
    "hts_otst_stpl_qty": "159288",
    "otst_stpl_qty_icdc": "-1469",
    "hts_thpr": "985.07",
    "basis": "2.15",
    "mrkt_basis": "-1.77",
    "dprt": "-0.40",
    "hts_rmnn_dynu": "36",
    "futs_last_tr_date": "20260910",
}

# fail-open: 미지원/롤오버된 코드의 실제 응답 모양.
EMPTY_OUTPUT1 = dict.fromkeys(REAL_OUTPUT1, "")


class _Client(KisFuturesEndpointsMixin):
    def __init__(self, body: dict) -> None:
        self._body = body
        self.calls: list[dict] = []

    async def _get(self, *, path, tr_id, params, foreground=False):
        self.calls.append({"path": path, "tr_id": tr_id, "params": params})
        return self._body


async def test_parses_real_response() -> None:
    q = await _Client({"rt_cd": "0", "output1": REAL_OUTPUT1}).fetch_futures_quote(ROW)
    assert q is not None
    assert q.value == 981.15
    assert q.change == -60.90
    assert q.change_rate == -5.84
    assert q.open_interest == 159288
    assert q.oi_change == -1469
    assert q.days_left == 36
    assert q.last_trade_date == "20260910"


async def test_basis_is_market_not_theoretical() -> None:
    """`basis`(+2.15)를 쓰면 부호가 뒤집힌다 — 화면이 콘탱고/백워데이션을 반대로 말한다."""
    q = await _Client({"rt_cd": "0", "output1": REAL_OUTPUT1}).fetch_futures_quote(ROW)
    assert q is not None
    assert q.market_basis == -1.77


async def test_fail_open_empty_response_returns_none() -> None:
    """rt_cd=0 + 빈 필드 = 미지원/사라진 월물. 0 으로 채우면 카드가 0 을 그린다."""
    client = _Client({"rt_cd": "0", "msg1": "정상처리 되었습니다.", "output1": EMPTY_OUTPUT1})
    assert await client.fetch_futures_quote(ROW) is None


async def test_missing_output1_returns_none() -> None:
    assert await _Client({"rt_cd": "0"}).fetch_futures_quote(ROW) is None


async def test_output3_is_never_read() -> None:
    """output3 은 코스닥150·VKOSPI 조회에도 KOSPI200 을 준다 — 읽으면 오염된다.

    기초자산이 엉뚱해도 파싱 결과가 흔들리지 않아야 한다.
    """
    body = {
        "rt_cd": "0",
        "output1": REAL_OUTPUT1,
        "output3": {"hts_kor_isnm": "KOSPI200", "bstp_nmix_prpr": "982.92"},
    }
    q = await _Client(body).fetch_futures_quote(ROW)
    assert q is not None
    assert q.market_basis == -1.77  # output3 으로 다시 계산했다면 -1.77 이 아니다


async def test_market_div_code_is_f() -> None:
    """옵션은 'O', 선물은 'F'. 바꿔 넣으면 또 조용히 빈 응답이 온다."""
    client = _Client({"rt_cd": "0", "output1": REAL_OUTPUT1})
    await client.fetch_futures_quote(ROW)
    assert client.calls[0]["params"]["FID_COND_MRKT_DIV_CODE"] == "F"
    assert client.calls[0]["params"]["FID_INPUT_ISCD"] == "A01609"


async def test_partial_failure_keeps_other_rows() -> None:
    """한 종목이 사라져도 나머지 카드는 살아야 한다."""
    other = ROW._replace(code="A06609", product="kosdaq150")

    class _Mixed(KisFuturesEndpointsMixin):
        async def _get(self, *, path, tr_id, params, foreground=False):
            if params["FID_INPUT_ISCD"] == "A06609":
                return {"rt_cd": "0", "output1": EMPTY_OUTPUT1}
            return {"rt_cd": "0", "output1": REAL_OUTPUT1}

    quotes = await _Mixed().fetch_futures_quotes([ROW, other])
    assert [q.code for q in quotes] == ["A01609"]


@pytest.mark.parametrize("price", ["0", "-1", ""])
async def test_non_positive_price_rejected(price: str) -> None:
    body = {"rt_cd": "0", "output1": {**REAL_OUTPUT1, "futs_prpr": price}}
    assert await _Client(body).fetch_futures_quote(ROW) is None
