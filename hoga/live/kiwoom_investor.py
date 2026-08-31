"""키움 투자자 수급 어댑터 3종 — PR-E (#1041).

    ka10059  종목별 투자자 일별   ← KIS FHPTJ04160001
    ka10051  업종별 투자자 순매수  ← KIS FHPTJ04040000
    ka10064  장중 투자자 추정      ← KIS HHPTJ04160200

## 실측이 잡은 함정 셋 (#1041, 005930 · 2026-08-03)

**① `amt_qty_tp` 는 코드표·단위가 TR 마다 다르다.** ka10064 는 이름 순서가 직관과
반대이고(아래), **ka10051 은 표 자체가 다르다**: `0`=금액(**억원**) · `1`=`2`=수량(천주)
(2026-08-05 실측, 두 시장 교차 대조). ka90005/ka10131 은 파라미터가 아예 무시되고
금액(**백만원**)·수량이 한 응답에 온다. 한 TR 의 표를 다른 TR 에 옮기면 조용히 틀린다 —
이 파일에서만 단위 사고가 세 번 났다(#1119).

    amt_qty_tp=2  →  외국인 -3,923,675   ← **수량(주)**
    amt_qty_tp=1  →  외국인   -952,097   ← 금액(백만원)

검산: 952,097백만원 ÷ 3,923,675주 = 242,650원/주 — 당일 범위(238,000~249,500)
안이다. `1` 을 쓰면 **금액을 수량 자리에 넣는다.**

`ka10059` 도 같은 표다(2026-08-31 실측, 005930 · 20260828): `amt_qty_tp=1` 이
**백만원**이고 `acc_trde_prica` 와 같은 축이다. 검산 409,731백만원 ÷ 1,589,169주
= 257,830원/주 vs 당일 종가 257,000원 — 0.3%(VWAP↔종가) 차이.

**② `unit_tp` 는 TR 마다 다르다 — `ka10059` 에서는 실제로 스케일을 바꾼다.**
이 주석의 초판은 "무의미하다(`1` 과 `1000` 의 응답이 완전히 같다)" 고 단정했다.
`ka10064` 에는 맞을지 몰라도 **`ka10059` 에서는 틀리다** (2026-08-31 실측,
005930 · 20260828):

    수량 축(amt_qty_tp=2)
      unit_tp="1"     ind_invsr  1,589,169   ← **주**
      unit_tp="1000"  ind_invsr      1,589   ← **천주**
      (`acc_trde_qty` 는 둘 다 15,106,746 — 투자자 컬럼만 스케일된다)

    금액 축(amt_qty_tp=1)
      unit_tp="1"     ind_invsr    409,731
      unit_tp="1000"  ind_invsr    409,731   ← **같다. 이 축에서는 무시된다**

**즉 축까지 내려가야 맞다.** 앞선 정정은 "`ka10059` 에서는 스케일이 바뀐다" 로
TR 까지만 좁혔는데, 같은 TR 안에서도 **수량 축만** 스케일된다(2026-08-31 실측).

프로덕션은 아래 `UNIT_TP_SHARES = "1"` 을 넘겨 **주 단위로 무사**하다. 위험한 건
값이 아니라 옛 이름(`UNIT_TP_IGNORED`)과 옛 주석이었다 — "무의미" 를 믿고 `1000`
으로 정리하면 종목별 투자자 값이 전부 1000배 작아지고, 부호와 자릿수가 그럴듯해서
타입도 테스트도 깨지지 않는다. **`ka10064` 는 이 파라미터를 아예 보내지 않는다.**

**③ 외국인 정의가 갈린다 — 이게 가장 조용히 틀린다.**

    키움 frgnr_invsr (-3,923,675) + natfor (+27,186) = -3,896,489 = KIS 외국인 ✅
    키움 orgn        (-5,039,954)                    = KIS 기관계             ✅

KIS 는 내국인대우외국인(`natfor`)을 외국인에 **합산**하고 키움은 **분리**한다.
`frgnr_invsr` 만 쓰면 0.7% 어긋난 값이 조용히 흐른다. `ka10051` 도 같은 분리다
(`native_trmt_frgnr_netprps`). **`ka10064`(장중 추정)에는 `natfor` 가 없다** —
가집계라 세분이 덜하므로 `frgnr_invsr` 를 그대로 쓴다.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime
from functools import partial
from typing import Any

from hoga.live.candle_models import daily_anchor_ms
from hoga.live.index_registry import RepresentativeIndex
from hoga.live.investor import (
    InvestorNetFetchResult,
    InvestorNetInvariantViolation,
    InvestorNetPoint,
    InvestorSubjectBreakdown,
    InvestorTrendEstimateRow,
)
from hoga.live.kiwoom_errors import KiwoomApiError
from hoga.live.kiwoom_index_candles import index_id_to_kiwoom_code
from hoga.live.kiwoom_rest import KiwoomRestClient, Page, PageFetch, PageRunner

EstimateCallRunner = Callable[[PageFetch, str], Awaitable[Page]]
"""`(페이지 팩토리, 축)` → 페이지. `fetch_investor_trend_estimate` 의 페이싱 이음매.

`PageRunner` 와 모양이 같지만 두 번째 인자가 페이지 인덱스가 아니라 **축**이다 —
중복제거 key 를 갈라야 하는 단위가 여기서는 페이지가 아니라 축이기 때문이다.
"""

# **수량**축. 이름과 달리 2 가 수량이다(위 함정 ①).
AMT_QTY_QUANTITY = "2"
# ka10051 전용 — 금액(억원) 축. ka10064 의 표(1=금액)와 다르다(위 함정 ①).
KA10051_AMT_EOK = "0"
# **금액**축(백만원). 1 이 금액이다 — 직관과 반대라 상수로 못 박는다.
AMT_QTY_AMOUNT = "1"
# `ka10059` **수량 축**의 단위를 주(株)로 고정한다. `1000` 이면 천주로 스케일된다 —
# 무의미한 값이 아니다(함정 ②의 정정). **금액 축에서는 무시된다**(실측) — 그래도
# 필수 파라미터라 두 축 모두 이 값을 보낸다.
UNIT_TP_SHARES = "1"

# `ka10064` 축 → 그 축이 채우는 행 필드 3개. 단위가 이름에 박혀 있어야 축이 뒤바뀐
# 배선이 리뷰에서 눈에 띈다(함정 ① 이 조용히 통과한 경로가 정확히 여기였다).
_ESTIMATE_AXES: dict[str, tuple[str, str, str]] = {
    AMT_QTY_QUANTITY: ("foreign_qty", "institution_qty", "sum_qty"),
    AMT_QTY_AMOUNT: ("foreign_amt_mwon", "institution_amt_mwon", "sum_amt_mwon"),
}
_ESTIMATE_FIELDS = tuple(field for keys in _ESTIMATE_AXES.values() for field in keys)
#: `ka10059` 기관 세부 → `InvestorSubjectBreakdown` 필드. 순서는 화면 표기 순서다.
#:
#: **합이 `orgn`(기관계)와 정확히 같다** — 005930 100행(20260403~20260828) 실측
#: 위반 0건. 표본이 1종목뿐이라 이 항등식은 주석이 아니라 `fetch_investor_net` 의
#: 행별 검사로 지킨다.
_ORGN_PARTS: tuple[tuple[str, str], ...] = (
    ("fnnc_invt", "fin_invest"),
    ("insrnc", "insurance"),
    ("invtrt", "trust"),
    ("etc_fnnc", "other_fin"),
    ("bank", "bank"),
    ("penfnd_etc", "pension"),
    ("samo_fund", "private_fund"),
    ("natn", "nation"),
)

#: 금액 축의 항등식 허용오차(백만원). **수량 축은 0 이다 — 느슨하게 하지 말 것.**
#:
#: 벤더가 컬럼마다 **독립적으로** 백만원 단위 반올림을 하므로, 반올림한 값들의 합은
#: 합의 반올림과 다를 수 있다. 관여하는 반올림은 세부 8개 + `orgn` 자신 = 9개이고
#: 각각 ±0.5 이라 정수 편차의 상한은 4다. 실측(005930 100행)은 최대 2였다 — 여유는
#: 이론에서 나온 것이지 표본에서 나온 것이 아니다.
#:
#: `_ORGN_PARTS` 에서 **파생한다** — 컬럼 목록을 복사해 두면 목록이 늘 때 상한만
#: 뒤처져서, 늘어난 컬럼의 반올림이 그대로 오탐이 된다.
#:
#: 구조적 결손(컬럼 하나 누락)은 이 축에서도 ~200,000 규모라 4로 충분히 잡힌다.
_AMOUNT_ROUNDING_TOLERANCE = (len(_ORGN_PARTS) + 1) // 2

_TRDE_TP_ALL = "0"
_STEX_ALL = "3"
_DATE_LEN = 8
_MAX_PAGES = 6

# `ka10051` 의 시장 구분은 **0=코스피 · 1=코스닥**이다. `ka20001`
# (`kiwoom_index_rest`)은 코스닥이 `"10"` 이라 값이 갈린다 — 위 함정 ① 이 `amt_qty_tp`
# 를 두고 경고한 "TR 마다 코드표가 다르다" 가 `mrkt_tp` 에도 그대로 참이다.
#
# #1296 이 그 사고였다: 여기가 `"10"` 이었고, 벤더는 에러 대신 **매칭 안 되는 행
# 집합**을 줘서 `/api/live/index-investor-net?index_id=KOSDAQ` 가 경고 없이 빈
# 결과를 돌려줬다. 실측 근거 둘 — `investor_flow_collector.MARKETS = ("0", "1")`
# 주석("mrkt_tp=0 은 코스피 28행, 1 은 코스닥 32행"), 그리고 20260811 장중 표본의
# `mrkt_tp="1"` 응답이 담은 `101_AL`(종합(KOSDAQ)) 행.
_MRKT_KOSDAQ = "1"
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




async def _direct_call(fetch: PageFetch, _axis: str, *, client: KiwoomRestClient) -> Page:
    """페이싱 없는 폴백. 테스트·단발 조회용이며 **운영 경로가 아니다** — 라우트는
    `run_call` 을 반드시 주입한다(ADR-0137)."""
    return await fetch(client)


def _mrkt_tp(index_id: str) -> str:
    return _MRKT_KOSDAQ if index_id in _KOSDAQ_IDS else _MRKT_KOSPI


async def fetch_investor_net(
    client: KiwoomRestClient,
    code: str,
    from_yyyymmdd: str,
    to_yyyymmdd: str,
    *,
    axis: str = AMT_QTY_QUANTITY,
    run_page: PageRunner | None = None,
) -> InvestorNetFetchResult:
    """종목별 투자자 일별 순매수(`ka10059`). KIS `fetch_investor_net` 대체.

    `axis` 는 `AMT_QTY_QUANTITY`(주) 또는 `AMT_QTY_AMOUNT`(백만원)다. **한 응답에
    둘이 함께 오지 않는다** — 별개의 콜이라 축을 바꾸면 벤더 콜이 하나 더 난다.
    기본값이 수량인 것은 일봉 차트 pane 이 그 축을 쓰기 때문이다.

    `run_page` 는 유량 페이싱 이음매다 — walk 는 최대 `_MAX_PAGES` 콜이고,
    주입하지 않으면 그 전부가 한 submit 안에서 페이싱 없이 나간다(ADR-0137).
    """
    # 금액 축은 컬럼마다 반올림돼 오므로 항등식이 정확히 맞지 않는다(위 상수).
    tolerance = _AMOUNT_ROUNDING_TOLERANCE if axis == AMT_QTY_AMOUNT else 0
    def _covered(rows: list[dict[str, Any]], _page: Any) -> bool:
        oldest = min((str(r.get("dt") or "") for r in rows if r.get("dt")), default="")
        return bool(oldest) and oldest < from_yyyymmdd

    rows, truncated = await client.walk(
        "ka10059",
        {
            "stk_cd": code, "dt": to_yyyymmdd,
            "amt_qty_tp": axis, "trde_tp": _TRDE_TP_ALL,
            "unit_tp": UNIT_TP_SHARES,
        },
        max_pages=_MAX_PAGES,
        stop=_covered,
        run_page=run_page,
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
        institution = _signed(row.get("orgn"))
        parts = {field: _signed(row.get(key)) for key, field in _ORGN_PARTS}
        # 항등식 경계 방어. 실측 표본이 1종목뿐이라(#1041 계열 주석) 나머지 종목은
        # 런타임이 본다 — 어긋나도 **행을 버리지 않는다**: 상위 3주체는 벤더가 직접
        # 준 값이라 여전히 옳고, 버리면 멀쩡한 날이 화면에서 사라진다. 대신 경고를
        # 실어 "세부의 합이 기관계와 다르다" 를 화면이 말할 수 있게 한다.
        parts_sum = sum(parts.values())
        if abs(parts_sum - institution) > tolerance:
            violations.append(InvestorNetInvariantViolation(
                date_yyyymmdd=date_s, reason="malformed_row",
                detail=(
                    f"orgn_mismatch: 기관계 {institution} ≠ 세부 8종 합 {parts_sum} "
                    f"(차 {institution - parts_sum}, 허용 ±{tolerance})"
                ),
            ))
        points.append(InvestorNetPoint(
            t_ms=daily_anchor_ms(date_s),
            foreign_net=foreign_net(row, base="frgnr_invsr", native="natfor"),
            institution_net=institution,
            breakdown=InvestorSubjectBreakdown(
                individual=_signed(row.get("ind_invsr")),
                native_foreign=_signed(row.get("natfor")),
                other_corp=_signed(row.get("etc_corp")),
                **parts,
            ),
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


async def fetch_market_investor_net_day(
    client: KiwoomRestClient,
    index: RepresentativeIndex,
    date_yyyymmdd: str,
) -> InvestorNetPoint | None:
    """시장(업종) 투자자 순매수 **하루치**(`ka10051`). 휴장일은 None.

    **KIS 와 모양이 다르다**: KIS 는 일별 시계열을 한 번에 주지만 `ka10051` 은
    `base_dt` 하루치를 업종별로 준다(#1007). 그래서 **날짜 수만큼 콜**이다.

    이 함수가 하루치인 것이 계약이다 — 날짜 반복은 반드시 거버너 **위**에 있어야
    한다(ADR-0137). 한 submit 안에서 N일을 돌면 버킷은 1 을 세고 벤더는 N 을 세서,
    90일 요청 하나가 유량을 90콜만큼 쓰면서 페이싱은 전혀 받지 않는다. 이전 판이
    정확히 그랬고 주석에는 "거버너가 페이싱하므로 순차로 돈다" 고 적혀 있었다.

    ## 빈 응답과 "행은 왔는데 우리 업종이 없음" 은 다른 사건이다 (#1296)

    - **빈 응답 → None.** 휴장일의 서명이고 실패가 아니다.
    - **행이 있는데 `want` 매칭 없음 → `KiwoomInvestorError`.** 요청은 성공했는데
      엉뚱한 시장을 받았다는 뜻이다. 잘못된 `mrkt_tp` 가 정확히 이 모양으로
      나타났고, 두 사건을 한 `None` 으로 접어 둔 탓에 코스닥이 **경고 없이** 빈
      결과로 1년 가까이 흘렀다.

    이 가드가 **못 보는 것**: "거래일인데 응답이 비었다". 그건 여전히 휴장일 규칙에
    흡수돼 None 이다 — 판정하려면 거래일 달력을 이 함수에 끌어들여야 하는데, 그건
    축을 하나 더 늘리는 별개 결정이라 여기서 하지 않는다.
    """
    want = index_id_to_kiwoom_code(index.id)
    mrkt_tp = _mrkt_tp(index.id)
    page = await client.call("ka10051", {
        # 금액(억원) 축 — 시장 순매수는 금액이 표시 관례다. 이 선택이 응답의
        # unit="amt_eok" 로 노출된다(#1119: 모델 주석이 "수량" 이라 조용히 거짓이던 자리).
        "mrkt_tp": mrkt_tp, "amt_qty_tp": KA10051_AMT_EOK,
        "base_dt": date_yyyymmdd, "stex_tp": _STEX_ALL,
    })
    for row in page.rows:
        # `inds_cd` 가 `'001_AL'` 처럼 venue 접미를 달고 온다(실측).
        code = str(row.get("inds_cd") or "").split("_")[0]
        if code != want:
            continue
        return InvestorNetPoint(
            t_ms=daily_anchor_ms(date_yyyymmdd),
            foreign_net=foreign_net(
                row, base="frgnr_netprps", native="native_trmt_frgnr_netprps"
            ),
            institution_net=_signed(row.get("orgn_netprps")),
        )
    if page.rows:
        # 받은 업종코드를 메시지에 싣는다 — "어느 시장을 받았나" 가 곧 진단이다.
        # 호출자(`live_index_investor_net`)가 `classify_live_error` 로 흡수해
        # `api_error` 경고로 노출하므로 wire enum 은 그대로다.
        got = sorted({str(r.get("inds_cd") or "").split("_")[0] for r in page.rows})
        raise KiwoomInvestorError(
            "index_row_absent",
            f"ka10051 이 {index.id}(업종 {want}) 행을 주지 않았다 — "
            f"mrkt_tp={mrkt_tp} · base_dt={date_yyyymmdd} 로 {len(page.rows)}행을 받았고 "
            f"업종코드는 {got[:6]} 이다",
        )
    return None


def date_range(from_yyyymmdd: str, to_yyyymmdd: str) -> list[str]:
    """[from, to] 달력일. 휴장일은 응답이 비어 자연히 걸러진다."""
    from datetime import timedelta  # noqa: PLC0415 — 지역 사용 1회
    start = datetime.strptime(from_yyyymmdd, "%Y%m%d")
    end = datetime.strptime(to_yyyymmdd, "%Y%m%d")
    days = (end - start).days
    if days < 0:
        return []
    return [(start + timedelta(days=i)).strftime("%Y%m%d") for i in range(days + 1)]


async def fetch_investor_trend_estimate(
    client: KiwoomRestClient,
    code: str,
    *,
    run_call: EstimateCallRunner | None = None,
) -> list[InvestorTrendEstimateRow]:
    """장중 투자자 추정(`ka10064`) — **수량·금액 두 축**. KIS `HHPTJ04160200` 대체.

    `natfor` 가 없는 TR 이라(가집계) `frgnr_invsr` 를 그대로 쓴다. 슬롯 간격이
    불규칙한 것(`090000`→`091900`→`095700`)은 KIS 가집계 발표 주기와 같은 성질이다.

    ## 축이 둘인 이유 — 그리고 **함정 ① 이 여기서도 참이다**

    2026-08-04 까지 이 함수는 `amt_qty_tp="1"` 하나만 불렀다. 위 함정 ① 이 같은
    파일에 적혀 있는데도 그랬고, 그래서 **금액(백만원)이 `_qty` 필드로 흘러** 화면에
    "만주" 로 그려졌다. `ka10064` 실측(005930 · 2026-08-04 14:31):

        amt_qty_tp=2  →  외국인 -912,000    기관 -1,925,000   ← **수량(주)**
        amt_qty_tp=1  →  외국인 -212,372    기관   -451,250   ← 금액(백만원)

    검산: 212,372백만원 ÷ 912,000주 = 232,864원/주 — 당일 범위(228,000~244,500)
    안이다. 반대로 놓으면 429만원/주라 성립하지 않는다. **크기만 보고는 판별이
    안 된다** — 두 축 모두 부호도 자릿수도 그럴듯하다. 비율이 당일 캔들 고저 안에
    떨어지는지가 유일한 오라클이다.

    수량 축은 천주 단위로 반올림돼 온다(`-90000` · `-925000` · `-912000`). 가집계의
    성질이지 절단이 아니다.

    ## `run_call` 은 유량 페이싱 이음매다 — 주입하지 않으면 페이싱이 무효다

    축이 둘이라 **콜도 둘**이다. 호출자가 이 함수 전체를 거버너 하나로 감싸면 버킷은
    1 을 세고 벤더는 2 를 세서, 대기표 한 장으로 두 콜이 나간다(ADR-0137). 축마다
    대기표를 뽑으려면 호출자가 이 자리에 `run_with_capacity` 를 끼워야 한다.
    """
    runner = run_call if run_call is not None else partial(_direct_call, client=client)
    by_slot: dict[str, dict[str, int]] = {}
    order: list[str] = []
    for axis, keys in _ESTIMATE_AXES.items():
        page = await runner(
            lambda c, axis=axis: c.call("ka10064", {
                "stk_cd": code, "mrkt_tp": "000",
                "amt_qty_tp": axis, "trde_tp": _TRDE_TP_ALL,
            }),
            axis,
        )
        for row in page.rows:
            slot = str(row.get("tm") or "").strip()
            if not slot:
                continue
            if slot not in by_slot:
                by_slot[slot] = {}
                order.append(slot)
            f = foreign_net(row, base="frgnr_invsr", native=None)
            i = _signed(row.get("orgn"))
            by_slot[slot].update({keys[0]: f, keys[1]: i, keys[2]: f + i})

    # 한 축에만 있는 슬롯(축 사이 경계에서 새 슬롯이 생긴 프레임)은 그 축만 채우고
    # 반대 축은 None 으로 둔다 — 없는 값을 0 으로 만들면 "순매수 0" 이라는 없는
    # 사실이 된다.
    return [
        InvestorTrendEstimateRow(slot=slot, **{k: by_slot[slot].get(k) for k in _ESTIMATE_FIELDS})
        for slot in order
    ]
