"""키움 관심종목 복수시세(`ka10095`) 어댑터 — PR-D (#1040).

KIS `fetch_multi_price`(`FHKST11300006`, 30종목/콜)의 대체다. 반환 타입은
그대로 `Quote` 라 소비자(관심종목 목록·스크리너 장중 오버레이)는 무변경이다.

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

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from hoga.live.kiwoom_rest import KiwoomRestClient

# venue → 종목코드 접미의 정본은 `kiwoom_venue`(#1124 — 방향이 반대인 동명 상수 2벌 통합).
# 응답의 `stk_cd` 는 접미를 **그대로 에코**하므로 파싱 시 벗겨야 소비자 키와 맞는다.
# 캔들 모듈 둘이 이 기능 모듈에서 상수만 빌려 가던 구조라 재수출로 호환을 남긴다.
from hoga.live.kiwoom_venue import VENUE_SUFFIX
from hoga.live.quote_models import Quote
from hoga.live.venue import Venue

ChunkFetcher = Callable[[list[str]], Awaitable[list[Quote]]]
"""종목 청크 1개 → 시세 목록. `fetch_multi_price` 의 페이싱 이음매다."""


# 실측 상한(#1040). 넘기면 1634 로 영구 거절된다 — 재시도가 아니라 청킹이 답이다.
API_ID = "ka10095"

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


def _mwon_to_won(raw: object) -> int | None:
    """누적거래대금(백만원) → 원. 단위 근거는 호출부 주석.

    **0 을 None 으로 접는다** — 같은 값이 WS FID 14 로도 오는데 그쪽이 그렇게 접기
    때문이다(`kiwoom_frames._parse_trade` 의 `if cum_value_m > 0`). 한 값이 두 경로로
    오면 규약도 한 벌이어야 장중과 마감 후가 같은 뜻을 낸다.

    같은 파일의 `_abs_int`(거래량·OHLC)는 0 을 그대로 통과시킨다 — 이 폴백보다 오래된
    동작이고 소비처가 이미 0 을 접고 있어(프론트 `positive`) 여기서 바꾸지 않는다.
    """
    mwon = _abs_int(raw)
    return mwon * 1_000_000 if mwon else None


def _abs_ratio(raw: object) -> float | None:
    """비율 필드(%, 소수 2자리) → 크기. 부호는 증감방향이라 버린다.

    WS `kiwoom_frames._ratio` 의 미러다 — 같은 값을 두 경로로 받으므로 규약이
    갈리면 장중(WS)과 마감 후(REST)에 **다른 숫자**가 뜬다. `0.0` 을 None 으로
    접는 것까지 같다("미수신" 과 "진짜 0" 을 소비자가 구분하지 않아도 되게).
    """
    text = str(raw or "").strip().replace("+", "").replace("-", "")
    if not text:
        return None
    try:
        v = abs(float(text))
    except ValueError:
        return None
    return v if v > 0 else None


def strip_venue_suffix(code: str) -> str:
    """`'005930_NX'` → `'005930'`. 응답이 접미를 에코하므로 필요하다."""
    for suffix in ("_NX", "_AL"):
        if code.endswith(suffix):
            return code[: -len(suffix)]
    return code


def parse_row(row: dict[str, Any]) -> Quote | None:
    """`ka10095` 한 행 → `Quote`. 가격이 없으면 None(호출자가 건너뛴다)."""
    code = strip_venue_suffix(str(row.get("stk_cd") or "").strip())
    price = _abs_int(row.get("cur_prc"))
    if not code or price is None:
        return None
    return Quote(
        code=code,
        price=price,
        change_pct=_signed_float(row.get("flu_rt")),
        change_won=_signed_int(row.get("pred_pre")),
        open=_abs_int(row.get("open_pric")),
        high=_abs_int(row.get("high_pric")),
        low=_abs_int(row.get("low_pric")),
        volume=_abs_int(row.get("trde_qty")),
        previous_close=_abs_int(row.get("base_pric")),
        # **단위 흡수는 파서의 일이다** — 소비자가 키움 단위를 몰라도 되게(WS FID 14
        # 가 세운 규율, `kiwoom_frames._parse_trade`). `trde_prica` 는 백만원이다:
        # 실측 006360 2026-08-19 에 98,036 × 1e6 ÷ 2,837,598주 = 34,549원 으로 그날
        # 저가 32,100 ~ 고가 35,900 안에 떨어진다(천원·원 가정은 각각 34.5원·0.03원
        # 이라 기각). 지수 TR 의 동명 필드와도 같은 축이다(`market_overview`).
        trade_value=_mwon_to_won(row.get("trde_prica")),
        vs_prev_volume_pct=_abs_ratio(row.get("pred_trde_qty_pre")),
        fill_strength_pct=_abs_ratio(row.get("cntr_str")),
    )


def chunk_codes(codes: list[str], size: int = MAX_CODES_PER_CALL) -> list[list[str]]:
    """상한에 맞춰 쪼갠다. 상한을 넘기면 `1634` 로 **영구 거절**이라 필수다."""
    if size < 1:
        raise ValueError("size must be >= 1")
    return [codes[i:i + size] for i in range(0, len(codes), size)]


async def fetch_chunk(
    client: KiwoomRestClient, chunk: list[str], *, venue: Venue = "KRX"
) -> list[Quote]:
    """청크 하나 = **한 콜**. 거버너가 세는 단위와 벤더가 세는 단위가 여기서 같다."""
    suffix = VENUE_SUFFIX.get(venue, "")
    page = await client.call(
        API_ID, {"stk_cd": "|".join(f"{c}{suffix}" for c in chunk)}
    )
    return [q for q in (parse_row(row) for row in page.rows) if q is not None]


async def fetch_multi_price(
    client: KiwoomRestClient,
    codes: list[str],
    *,
    venue: Venue = "KRX",
    fetch_chunk_fn: ChunkFetcher | None = None,
) -> list[Quote]:
    """복수 종목 현재가. 상한(100)에 맞춰 청킹한다.

    ## `fetch_chunk_fn` 은 유량 페이싱 이음매다 — 기본값으로 두면 안 된다

    이전 판의 주석은 "거버너가 TR별 버킷으로 페이싱하므로" 청크를 순차로 돌렸다.
    **그 전제가 거짓이다**: 거버너(`kiwoom_capacity`)는 `run_with_capacity` 진입
    전에 버킷을 한 번만 소비하므로, 이 루프가 한 submit 안에 있으면 버킷은 1 을,
    벤더는 청크 수만큼 센다. 4,295종목(43청크)이 0.23초에 나가 6번째에서
    `1700 유량=5` 로 거절당했다(#1063 실측).

    그래서 **반복은 거버너 위, 실행은 거버너 안**이다. 호출자가 청크 1개를
    `run_with_capacity` 로 감싼 러너를 주입하면 청크마다 대기표를 뽑는다. 동시
    제출은 거버너가 흡수한다 — 버킷이 직렬화하고, 같은 TR 의 `user_visible` 이
    오면 background 가 뒤로 밀린다.

    기본값(주입 없음)은 페이싱이 없는 직접 호출이라 **테스트·단발 조사용**이다.
    """
    fetch = fetch_chunk_fn or (
        lambda chunk: fetch_chunk(client, chunk, venue=venue)
    )
    chunks = chunk_codes([c for c in codes if c])
    if not chunks:
        return []
    pages = await asyncio.gather(*(fetch(chunk) for chunk in chunks))
    return [quote for page in pages for quote in page]
