"""키움 주식 일봉 어댑터 (`ka10081`) — PR-F (#1042).

KIS `FHKST03010100`(inquire-daily-itemchartprice) 대체. 반환형은 브로커 중립
`DailyCandleFetchResult` 라 소비자(백필 사다리·스크리너)는 소스를 모른다.

## 실측이 잡은 함정 셋 (#1042, 005930 · 2026-08-03)

**① `upd_stkpc_tp` 는 KIS 와 극성이 반대다 — 이게 가장 조용히 틀린다.**

    KIS   FID_ORG_ADJ_PRC = "0" → 수정주가 · "1" → 원주가
    키움  upd_stkpc_tp    = "1" → 수정주가 · "0" → 원주가

값을 그대로 옮기면 **스크리너가 원주가를 수정주가 자리에 담는다**. 액면분할
종목에서만 틀리므로 대부분의 종목에서는 아무 증상이 없다. 삼성전자 2018-05-04
액면분할(50:1)을 리트머스로 확증했다:

    upd_stkpc_tp=0 → 20180427 종가 2,650,000원  (원주가)
    upd_stkpc_tp=1 → 20180427 종가    53,000원  (수정주가)
                     2,650,000 ÷ 50 = 53,000 ✓

**② 종가 필드가 따로 없다.** `cur_prc` 가 그날의 종가다. KIS 는 `stck_clpr`
(종가)와 `stck_prpr`(현재가)를 나눠 주지만 키움 일봉은 한 칸이다. 검산으로
확인했다: 전일 `cur_prc` + 당일 `pred_pre` = 당일 `cur_prc`.

**③ 가격이 무부호다 — `ka10095`(복수시세)와 규약이 다르다.** 복수시세는
`cur_prc` 에 `'-239500'` 처럼 등락 방향을 부호로 실어 보내지만 일봉은 무부호이고
`pred_pre` 만 부호를 갖는다. 같은 벤더 안에서도 TR 마다 다르므로 절대값을 취한다
(부호가 오더라도 가격은 절대값이 맞다).

## 성질

- 페이지 **600행 ≈ 2.4년**. `base_dt` 랜덤 액세스가 되므로(#1008) 요청 구간의
  끝 날짜를 그대로 주소로 준다 — KIS 처럼 커서를 되감을 필요가 없다.
- 보유 **1989년까지** 실측(`base_dt=19900101` → 600행, 최신 19891226).
  ADR-0120 이 남긴 "키움은 과거가 얕다" 인상은 **분봉의 성질**이지 일봉이 아니다.
- venue 는 종목코드 접미(`_NX`/`_AL`) — 문서에 "일봉 미검증" 으로 남아 있던
  항목을 이 PR 에서 실측했다: `_NX` 333행(NXT 출범 이후만) · `_AL` 600행.
"""
from __future__ import annotations

from typing import Any

from hoga.live.candle_fetch_result import DailyCandleFetchResult, DailyInvariantViolation
from hoga.live.candle_models import LiveCandle, daily_anchor_ms
from hoga.live.kiwoom_multi_quote import VENUE_SUFFIX
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.venue import Venue

API_ID = "ka10081"

# **KIS 와 극성이 반대다**(위 함정 ①). 이름을 붙여 두는 이유는 리터럴 "1"/"0" 이
# 코드에 흩어지면 어느 쪽이 수정주가인지 읽는 사람이 매번 확인해야 하기 때문이다.
UPD_ADJUSTED = "1"
UPD_RAW = "0"

# 실측 600행/페이지 ≈ 2.4년. 8페이지면 약 19년, 12페이지면 1989년 바닥까지 닿는다.
_MAX_PAGES = 12
_DATE_LEN = 8


def adjust_flag(adjust: bool) -> str:
    """`adjust=True`(수정주가) → `"1"`. KIS 의 `FID_ORG_ADJ_PRC` 와 **반대**다."""
    return UPD_ADJUSTED if adjust else UPD_RAW


def _abs_int(raw: object) -> int | None:
    """원 단위 정수. 부호는 등락 방향이므로 가격에서는 버린다(함정 ③)."""
    text = str(raw or "").strip().replace("+", "").replace("-", "")
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def venue_code(code: str, venue: Venue) -> str:
    """KIS 는 `FID_COND_MRKT_DIV_CODE` 파라미터, 키움은 **종목코드 접미**(#1008)."""
    return f"{code}{VENUE_SUFFIX[venue]}"


def parse_row(
    row: dict[str, Any], *, from_yyyymmdd: str, to_yyyymmdd: str
) -> tuple[LiveCandle | None, DailyInvariantViolation | None]:
    """행 하나 → (캔들, 위반). 둘 중 하나만 채워진다.

    `reason` 집합은 ADR-0129 D5 로 닫혀 있다 — 브로커 전용 사유를 새로 만들면
    프론트가 소스를 구분해야 해서 응답의 중립성이 깨진다.
    """
    date_s = str(row.get("dt") or "").strip()
    if len(date_s) != _DATE_LEN or not date_s.isdigit():
        return None, DailyInvariantViolation(
            date_yyyymmdd=date_s or "(empty)", reason="malformed_row",
            detail=f"unparsable dt {date_s!r}",
        )
    # YYYYMMDD 는 사전순 비교가 곧 시간순 비교다.
    if date_s < from_yyyymmdd or date_s > to_yyyymmdd:
        return None, DailyInvariantViolation(
            date_yyyymmdd=date_s, reason="out_of_range",
            detail=f"row date outside [{from_yyyymmdd}, {to_yyyymmdd}]",
        )

    o = _abs_int(row.get("open_pric"))
    h = _abs_int(row.get("high_pric"))
    low = _abs_int(row.get("low_pric"))
    # `cur_prc` 가 종가다 — 종가 전용 필드가 없다(함정 ②).
    c = _abs_int(row.get("cur_prc"))
    v = _abs_int(row.get("trde_qty")) or 0
    if o is None or h is None or low is None or c is None:
        return None, DailyInvariantViolation(
            date_yyyymmdd=date_s, reason="malformed_row",
            detail="OHLC 필드 누락",
        )
    if c <= 0:
        return None, DailyInvariantViolation(
            date_yyyymmdd=date_s, reason="close_nonpositive", detail=f"close={c}",
        )
    if h < max(o, c) or low > min(o, c) or h < low:
        return None, DailyInvariantViolation(
            date_yyyymmdd=date_s, reason="ohlc_inconsistent",
            detail=f"o={o} h={h} l={low} c={c}",
        )
    return LiveCandle(
        t_ms=daily_anchor_ms(date_s), open=o, high=h, low=low, close=c, volume=v,
    ), None


async def fetch_daily_candles(
    client: KiwoomRestClient,
    code: str,
    from_yyyymmdd: str,
    to_yyyymmdd: str,
    *,
    venue: Venue = "KRX",
    adjust: bool = True,
) -> DailyCandleFetchResult:
    """[from, to] 구간의 일봉. KIS `fetch_past_daily_candles` 대체.

    `base_dt=to` 로 **끝 날짜를 직접 주소 지정**하고 커서로 과거로 걸어간다.
    KIS 구현이 `[DATE_1, DATE_2]` 양끝을 밀고 당기며 venue 별 예외까지 다뤄야
    했던 것(60회 루프·4갈래 커서 분기)과 달리, 여기서는 종료 조건이 하나다:
    **페이지에서 `from` 보다 오래된 날짜를 봤으면 덮은 것이다.**
    """
    def _covered(rows: list[dict[str, Any]], _page: Any) -> bool:
        oldest = min((str(r.get("dt") or "") for r in rows if r.get("dt")), default="")
        return bool(oldest) and oldest < from_yyyymmdd

    rows, truncated = await client.walk(
        API_ID,
        {
            "stk_cd": venue_code(code, venue),
            "base_dt": to_yyyymmdd,
            "upd_stkpc_tp": adjust_flag(adjust),
        },
        max_pages=_MAX_PAGES,
        stop=_covered,
    )

    candles: list[LiveCandle] = []
    violations: list[DailyInvariantViolation] = []
    seen: set[str] = set()
    for row in rows:
        date_s = str(row.get("dt") or "").strip()
        if date_s and date_s in seen:
            continue
        candle, violation = parse_row(
            row, from_yyyymmdd=from_yyyymmdd, to_yyyymmdd=to_yyyymmdd
        )
        if date_s:
            seen.add(date_s)
        if violation is not None:
            # **구간보다 오래된 행은 위반이 아니다.** walk 는 `from` 을 덮을 때까지
            # 걷고, 덮었다는 것 자체가 그 페이지에 `from` 이전 행이 섞였다는 뜻이다
            # — 설계상 반드시 생긴다. 반대로 `to` 보다 **새로운** 행은 진짜 이상이다
            # (`base_dt=to` 를 줬는데 미래가 왔다), 그건 그대로 싣는다.
            if not (violation.reason == "out_of_range" and date_s < from_yyyymmdd):
                violations.append(violation)
            continue
        if candle is not None:
            candles.append(candle)

    if truncated:
        # 조용한 절단 금지. reason 집합이 닫혀 있어 malformed_row 로 싣되 detail 에
        # 진짜 사유를 남긴다(`kiwoom_investor` 와 같은 관례).
        violations.append(DailyInvariantViolation(
            date_yyyymmdd=from_yyyymmdd, reason="malformed_row",
            detail=f"truncated: {_MAX_PAGES} 페이지에서 {from_yyyymmdd} 에 못 닿았다",
        ))

    candles.sort(key=lambda c: c.t_ms)   # 응답은 최신순(DESC) 이다
    return DailyCandleFetchResult(candles=candles, violations=violations)
