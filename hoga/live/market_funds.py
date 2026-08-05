"""증시 주변 자금 — KOFIA 오픈API 파싱·정규화 (#1101).

**이 지도의 유일한 제3 벤더다.** 키움도 KIS 도 시장 전체 예탁금·신용융자·CMA 를 주지
않는다(키움의 예수금 조회는 내 계좌 전용, ka10013/ka10033 은 종목별). 원천은 금융투자협회
공시이고 공공데이터포털이 그것을 오픈API 로 낸다.

실측(#1098)이 정한 세 가지 제약:

**① 인증은 Decoding 키다.** 포털이 주는 Encoding 형(`%2B`·`%3D`)을 HTTP 클라이언트의
`params=` 에 넘기면 **이중 인코딩**되어 인증이 깨진다. 그래서 이 모듈은 키를 받을 때
한 번 `unquote` 한다 — 이미 decoded 인 키에 `unquote` 를 걸어도 무해하다(`%` 가 없다).

**② CMA 만 축이 다르다.** 예탁금·신용융자는 날짜당 1행인데 CMA 는
`mngInvTgt`(MMF형·RP형·…·**합계**) × `invrCtg`(개인·기관)으로 갈린다. `합계` 행이 이미
있으므로 **유형별 소계를 더하면 이중 계상**이다 — 개인·기관 두 합계 행만 더한다.

**③ T+2 는 관측이지 계약이 아니다.** 공시 지연이 바뀔 수 있으므로 화면은 응답의
`basDt` 를 기준일로 표기해야 한다. 이 모듈은 그래서 기준일을 **값과 함께** 실어 보낸다
(고정 "T+2" 문구를 어디에도 박지 않는다).

단위는 **원(raw)** 이다 — 조·억 환산은 표시 계층의 몫이다.
"""
from __future__ import annotations

import logging
import urllib.parse
from typing import Any

log = logging.getLogger(__name__)

BASE_URL = "https://apis.data.go.kr/1160100/service/GetKofiaStatisticsInfoService"

OP_CAPITAL = "getSecuritiesMarketTotalCapitalInfo"   # 증시자금추이 → 고객예탁금
OP_CREDIT = "getGrantingOfCreditBalanceInfo"          # 신용공여잔고추이 → 신용융자
OP_CMA = "getCMAStatus"                               # 일자별CMA현황 → CMA

# 카드의 3계열. 값이 어느 필드에서 오는지를 한 곳에 모아 둔다.
FIELD_DEPOSIT = "invrDpsgAmt"      # 투자자예탁금
FIELD_CREDIT = "crdTrFingWhl"      # 신용거래융자 전체(코스피+코스닥)
CMA_TOTAL_LABEL = "합계"


def normalize_key(raw: str) -> str:
    """Encoding 형 인증키를 Decoding 형으로. 이미 decoded 면 그대로 돌아온다(멱등)."""
    return urllib.parse.unquote(raw.strip())


def _rows(body: dict[str, Any]) -> list[dict[str, Any]]:
    """공공데이터포털 표준 봉투에서 행 목록. 1건이면 리스트가 아니라 객체로 온다."""
    items = ((body.get("response") or {}).get("body") or {}).get("items") or {}
    rows = items.get("item") if isinstance(items, dict) else items
    if isinstance(rows, dict):
        return [rows]
    return list(rows or [])


def result_code(body: dict[str, Any]) -> str | None:
    return ((body.get("response") or {}).get("header") or {}).get("resultCode")


def _amount(v: Any) -> int | None:
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return None


def parse_single_value_series(body: dict[str, Any], *, field: str) -> dict[str, int]:
    """날짜당 1행인 응답(예탁금·신용융자) → `{basDt: 값}`.

    휴장일 행은 **애초에 오지 않는다** — 빈 날을 만들지 말고 온 날짜만 쓴다.
    """
    out: dict[str, int] = {}
    for r in _rows(body):
        date = str(r.get("basDt") or "")
        val = _amount(r.get(field))
        if date and val is not None:
            out[date] = val
    return out


def parse_cma_series(body: dict[str, Any]) -> dict[str, int]:
    """CMA → `{basDt: 총잔액}`. **합계 행만** 더한다.

    유형별 소계(MMF형·RP형·…)를 함께 더하면 합계 행과 **이중 계상**된다. `합계` 행이
    `invrCtg`(개인·기관)로 갈려 있으므로 그 둘의 합이 전체다.
    """
    out: dict[str, int] = {}
    for r in _rows(body):
        if str(r.get("mngInvTgt") or "") != CMA_TOTAL_LABEL:
            continue
        date = str(r.get("basDt") or "")
        val = _amount(r.get("actBal"))
        if date and val is not None:
            out[date] = out.get(date, 0) + val
    return out


def merge_series(
    deposit: dict[str, int], credit: dict[str, int], cma: dict[str, int]
) -> list[dict[str, Any]]:
    """세 계열 → 날짜 오름차순 행. 화면 축(3계열 × 날짜)과 같은 모양이다.

    세 오퍼레이션의 최신일이 어긋날 수 있으므로(공시 시점이 각각이다) **합집합**을
    쓰고 없는 값은 `None` 으로 남긴다 — 0 으로 채우면 "그날 예탁금이 0" 이라는
    거짓말이 된다.
    """
    dates = sorted(set(deposit) | set(credit) | set(cma))
    return [
        {
            "date": d,
            "deposit_won": deposit.get(d),
            "credit_won": credit.get(d),
            "cma_won": cma.get(d),
        }
        for d in dates
    ]
