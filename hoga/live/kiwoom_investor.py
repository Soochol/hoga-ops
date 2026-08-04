"""키움 투자자 수급 어댑터 3종 — PR-E (#1041).

    ka10059  종목별 투자자 일별   ← KIS FHPTJ04160001
    ka10051  업종별 투자자 순매수  ← KIS FHPTJ04040000
    ka10064  장중 투자자 추정      ← KIS HHPTJ04160200

## 실측이 잡은 함정 셋 (#1041, 005930 · 2026-08-03)

**① `amt_qty_tp` 는 이름 순서가 직관과 반대다.**

    amt_qty_tp=2  →  외국인 -3,923,675   ← **수량(주)**
    amt_qty_tp=1  →  외국인   -952,097   ← 금액(백만원)

검산: 952,097백만원 ÷ 3,923,675주 = 242,650원/주 — 당일 범위(238,000~249,500)
안이다. `1` 을 쓰면 **금액을 수량 자리에 넣는다.**

**② `unit_tp` 는 무의미하다.** 필수 파라미터인데 `1` 과 `1000` 의 응답이 완전히
같다. 값을 채워 보내되 의미를 부여하지 말 것.

**③ 외국인 정의가 갈린다 — 이게 가장 조용히 틀린다.**

    키움 frgnr_invsr (-3,923,675) + natfor (+27,186) = -3,896,489 = KIS 외국인 ✅
    키움 orgn        (-5,039,954)                    = KIS 기관계             ✅

KIS 는 내국인대우외국인(`natfor`)을 외국인에 **합산**하고 키움은 **분리**한다.
`frgnr_invsr` 만 쓰면 0.7% 어긋난 값이 조용히 흐른다. `ka10051` 도 같은 분리다
(`native_trmt_frgnr_netprps`). **`ka10064`(장중 추정)에는 `natfor` 가 없다** —
가집계라 세분이 덜하므로 `frgnr_invsr` 를 그대로 쓴다.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from hoga.live.candle_models import daily_anchor_ms
from hoga.live.index_registry import RepresentativeIndex
from hoga.live.investor import (
    InvestorNetFetchResult,
    InvestorNetInvariantViolation,
    InvestorNetPoint,
    InvestorTrendEstimateRow,
)
from hoga.live.kiwoom_errors import KiwoomApiError
from hoga.live.kiwoom_index_candles import index_id_to_kiwoom_code
from hoga.live.kiwoom_rest import KiwoomRestClient

# **수량**축. 이름과 달리 2 가 수량이다(위 함정 ①).
AMT_QTY_QUANTITY = "2"
# 필수지만 응답에 영향이 없다(함정 ②). 벤더가 요구하므로 채워 보낼 뿐이다.
UNIT_TP_IGNORED = "1"
_TRDE_TP_ALL = "0"
_STEX_ALL = "3"
_DATE_LEN = 8
_MAX_PAGES = 6

_MRKT_KOSDAQ = "10"
_MRKT_KOSPI = "0"
_KOSDAQ_IDS = frozenset({"KOSDAQ", "KOSDAQ150"})


class KiwoomInvestorError(KiwoomApiError):
    """투자자 어댑터 실패. `KiwoomApiError` 상속 — 기존 degrade 팔이 흡수한다."""


def _signed(raw: object) -> int:
    """키움이 부호를 실어 보내는 수량 필드(`'+85703'`/`'-952097'`)."""
    text = str(raw or "").strip().replace("+", "")
    if not text or text in {"-", ""}:
        return 0
    try:
        return int(text)
    except ValueError:
        return 0


def foreign_net(row: dict[str, Any], *, base: str, native: str | None) -> int:
    """KIS 와 **같은 정의**의 외국인 순매수.

    KIS 는 내국인대우외국인을 외국인에 합산한다(#1041 실측으로 확인). 키움은
    분리해 주므로 더해야 한다. `native` 가 None 인 TR(`ka10064`)은 그 필드가
    아예 없으므로 base 만 쓴다.
    """
    total = _signed(row.get(base))
    if native is not None:
        total += _signed(row.get(native))
    return total




def _mrkt_tp(index_id: str) -> str:
    return _MRKT_KOSDAQ if index_id in _KOSDAQ_IDS else _MRKT_KOSPI


async def fetch_investor_net(
    client: KiwoomRestClient, code: str, from_yyyymmdd: str, to_yyyymmdd: str
) -> InvestorNetFetchResult:
    """종목별 투자자 일별 순매수(`ka10059`). KIS `fetch_investor_net` 대체."""
    def _covered(rows: list[dict[str, Any]], _page: Any) -> bool:
        oldest = min((str(r.get("dt") or "") for r in rows if r.get("dt")), default="")
        return bool(oldest) and oldest < from_yyyymmdd

    rows, truncated = await client.walk(
        "ka10059",
        {
            "stk_cd": code, "dt": to_yyyymmdd,
            "amt_qty_tp": AMT_QTY_QUANTITY, "trde_tp": _TRDE_TP_ALL,
            "unit_tp": UNIT_TP_IGNORED,
        },
        max_pages=_MAX_PAGES,
        stop=_covered,
    )

    points: list[InvestorNetPoint] = []
    violations: list[InvestorNetInvariantViolation] = []
    seen: set[str] = set()
    for row in rows:
        date_s = str(row.get("dt") or "")
        if len(date_s) != _DATE_LEN or not date_s.isdigit():
            violations.append(InvestorNetInvariantViolation(
                date_yyyymmdd=date_s or "(empty)", reason="malformed_row",
                detail=f"unparsable dt {date_s!r}",
            ))
            continue
        if date_s in seen or not (from_yyyymmdd <= date_s <= to_yyyymmdd):
            continue
        seen.add(date_s)
        points.append(InvestorNetPoint(
            t_ms=daily_anchor_ms(date_s),
            foreign_net=foreign_net(row, base="frgnr_invsr", native="natfor"),
            institution_net=_signed(row.get("orgn")),
        ))
    if truncated:
        # 조용한 절단 금지 — reason 집합이 닫혀 있어 malformed_row 로 싣되
        # detail 에 진짜 사유를 남긴다.
        violations.append(InvestorNetInvariantViolation(
            date_yyyymmdd=from_yyyymmdd, reason="malformed_row",
            detail=f"out_of_range: {_MAX_PAGES} 페이지에서 {from_yyyymmdd} 에 못 닿았다",
        ))
    points.sort(key=lambda p: p.t_ms)
    return InvestorNetFetchResult(points=points, violations=violations)


async def fetch_market_investor_net(
    client: KiwoomRestClient,
    index: RepresentativeIndex,
    from_yyyymmdd: str,
    to_yyyymmdd: str,
) -> list[InvestorNetPoint]:
    """시장(업종) 투자자 순매수(`ka10051`).

    **KIS 와 모양이 다르다**: KIS 는 일별 시계열을 한 번에 주지만 `ka10051` 은
    `base_dt` **하루치**를 업종별로 준다(#1007). 그래서 날짜마다 한 콜이다 —
    거버너가 TR별 버킷으로 페이싱하므로 순차로 돈다.
    """
    want = index_id_to_kiwoom_code(index.id)
    out: list[InvestorNetPoint] = []
    for date_s in _date_range(from_yyyymmdd, to_yyyymmdd):
        page = await client.call("ka10051", {
            "mrkt_tp": _mrkt_tp(index.id), "amt_qty_tp": "0",
            "base_dt": date_s, "stex_tp": _STEX_ALL,
        })
        for row in page.rows:
            # `inds_cd` 가 `'001_AL'` 처럼 venue 접미를 달고 온다(실측).
            code = str(row.get("inds_cd") or "").split("_")[0]
            if code != want:
                continue
            out.append(InvestorNetPoint(
                t_ms=daily_anchor_ms(date_s),
                foreign_net=foreign_net(
                    row, base="frgnr_netprps", native="native_trmt_frgnr_netprps"
                ),
                institution_net=_signed(row.get("orgn_netprps")),
            ))
            break
    out.sort(key=lambda p: p.t_ms)
    return out


def _date_range(from_yyyymmdd: str, to_yyyymmdd: str) -> list[str]:
    """[from, to] 달력일. 휴장일은 응답이 비어 자연히 걸러진다."""
    from datetime import timedelta  # noqa: PLC0415 — 지역 사용 1회
    start = datetime.strptime(from_yyyymmdd, "%Y%m%d")
    end = datetime.strptime(to_yyyymmdd, "%Y%m%d")
    days = (end - start).days
    if days < 0:
        return []
    return [(start + timedelta(days=i)).strftime("%Y%m%d") for i in range(days + 1)]


async def fetch_investor_trend_estimate(
    client: KiwoomRestClient, code: str
) -> list[InvestorTrendEstimateRow]:
    """장중 투자자 추정(`ka10064`). KIS `HHPTJ04160200` 대체.

    `natfor` 가 없는 TR 이라(가집계) `frgnr_invsr` 를 그대로 쓴다. 슬롯 간격이
    불규칙한 것(`090000`→`091900`→`095700`)은 KIS 가집계 발표 주기와 같은 성질이다.
    """
    page = await client.call("ka10064", {
        "stk_cd": code, "mrkt_tp": "000",
        "amt_qty_tp": "1", "trde_tp": _TRDE_TP_ALL,
    })
    out: list[InvestorTrendEstimateRow] = []
    for row in page.rows:
        slot = str(row.get("tm") or "").strip()
        if not slot:
            continue
        f = foreign_net(row, base="frgnr_invsr", native=None)
        i = _signed(row.get("orgn"))
        out.append(InvestorTrendEstimateRow(
            slot=slot, foreign_qty=f, institution_qty=i, sum_qty=f + i,
        ))
    return out
