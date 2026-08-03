"""키움 관심종목 복수시세(`ka10095`) 어댑터 — PR-D (#1040).

KIS `fetch_multi_price`(`FHKST11300006`, 30종목/콜)의 대체다. 반환 타입은
그대로 `KisQuote` 라 소비자(관심종목 목록·스크리너 장중 오버레이)는 무변경이다.

## 배치 상한 100 — 실측이고, 넘기면 **영구 실패**다

`stk_cd` 를 `|` 로 이어 복수 종목을 한 번에 받는다. 실측(#1040):

    100종목 → 100행 ✅
    110종목 → HTTP 200 + return_code 5 + "허용된 요청 개수를 초과하였습니다[1634]"

**함정**: 벤더가 이 거절을 **유량 초과(`1700`)와 똑같은 `return_code == 5` + 똑같은
한글 문구**로 돌려준다. 대괄호 코드로만 구분된다. 유량으로 오분류하면 호출자가
"잠시 후 재시도" 로 읽어 **무한 재시도**에 빠진다 — `kiwoom_rest` 가 `1634` 를
`KiwoomBatchLimitError` 로 먼저 분류하는 이유다.

## 가격 단위가 지수와 다르다 — `parse_price` 를 쓰면 100배 틀린다

지수(`ka20005`/`ka20006`)는 소수점을 제거해 준다(`'624191'` = 6241.91). **주식은
정수 원 단위다**(`'-239500'` = 239,500원). 부호 접두는 **등락 방향**이고 값 자체는
절대값이다.

실측 교차검증(005930, 2026-08-03): `base_pric` 262,500 + `pred_pre` -23,000 =
239,500 = `cur_prc` ✅ / `flu_rt` -8.76% ≈ -23,000 / 262,500 ✅
"""
from __future__ import annotations

from typing import Any

from hoga.live.kis_client import KisQuote
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.venue import Venue

# venue → 종목코드 접미. KIS 는 `FID_COND_MRKT_DIV_CODE`(J/NX/UN) 파라미터를 쓰지만
# **키움은 코드에 접미를 붙인다**(#1008). 실측(005930, 2026-08-03):
#   005930     KRX  239,500  거래량 27,393,575
#   005930_NX  NXT  240,500  거래량 18,346,108
#   005930_AL  통합 240,500  거래량 45,739,907  ≈ KRX + NXT (산술 확인)
# 응답의 `stk_cd` 는 접미를 **그대로 에코**하므로 파싱 시 벗겨야 소비자 키와 맞는다.
VENUE_SUFFIX: dict[str, str] = {"KRX": "", "NXT": "_NX", "UN": "_AL"}

# 실측 상한(#1040). 넘기면 1634 로 영구 거절된다 — 재시도가 아니라 청킹이 답이다.
MAX_CODES_PER_CALL = 100


def _abs_int(raw: object) -> int | None:
    """주식 가격/수량 → 정수. 부호 접두는 등락 방향이라 제거한다.

    **지수용 `parse_price` 를 쓰지 말 것** — 그건 100 으로 나눈다(소수점 제거 포맷).
    주식은 원 단위 정수다.
    """
    text = str(raw or "").strip().replace("+", "").replace("-", "")
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _signed_float(raw: object) -> float | None:
    """등락률처럼 **키움이 이미 부호를 실어 보내는** 필드."""
    text = str(raw or "").strip().replace("+", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _signed_int(raw: object) -> int | None:
    """전일대비 등락액 — 부호 보존."""
    text = str(raw or "").strip().replace("+", "")
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def strip_venue_suffix(code: str) -> str:
    """`'005930_NX'` → `'005930'`. 응답이 접미를 에코하므로 필요하다."""
    for suffix in ("_NX", "_AL"):
        if code.endswith(suffix):
            return code[: -len(suffix)]
    return code


def parse_row(row: dict[str, Any]) -> KisQuote | None:
    """`ka10095` 한 행 → `KisQuote`. 가격이 없으면 None(호출자가 건너뛴다)."""
    code = strip_venue_suffix(str(row.get("stk_cd") or "").strip())
    price = _abs_int(row.get("cur_prc"))
    if not code or price is None:
        return None
    return KisQuote(
        code=code,
        price=price,
        change_pct=_signed_float(row.get("flu_rt")),
        change_won=_signed_int(row.get("pred_pre")),
        open=_abs_int(row.get("open_pric")),
        high=_abs_int(row.get("high_pric")),
        low=_abs_int(row.get("low_pric")),
        volume=_abs_int(row.get("trde_qty")),
        previous_close=_abs_int(row.get("base_pric")),
    )


def chunk_codes(codes: list[str], size: int = MAX_CODES_PER_CALL) -> list[list[str]]:
    """상한에 맞춰 쪼갠다. 상한을 넘기면 `1634` 로 **영구 거절**이라 필수다."""
    if size < 1:
        raise ValueError("size must be >= 1")
    return [codes[i:i + size] for i in range(0, len(codes), size)]


async def fetch_multi_price(
    client: KiwoomRestClient, codes: list[str], *, venue: Venue = "KRX"
) -> list[KisQuote]:
    """복수 종목 현재가. 상한(100)에 맞춰 청킹해 순차 호출한다.

    청크를 **병렬로 쏘지 않는다** — 거버너가 TR별 버킷으로 페이싱하므로 병렬화는
    큐에서 일어난다. 여기서 동시 발사하면 같은 TR 버킷을 서로 밀어낸다.
    """
    suffix = VENUE_SUFFIX.get(venue, "")
    out: list[KisQuote] = []
    for chunk in chunk_codes([c for c in codes if c]):
        page = await client.call(
            "ka10095", {"stk_cd": "|".join(f"{c}{suffix}" for c in chunk)}
        )
        for row in page.rows:
            quote = parse_row(row)
            if quote is not None:
                out.append(quote)
    return out
