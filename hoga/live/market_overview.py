"""시장 종합(`/market`) 읽기 전용 표면 — 파싱과 스케일 규칙.

**저장하지 않는다.** 놓친 폴링의 대가가 잠깐의 낡음뿐이라 수요 구동 TTL 로 충분하다
(저장 축은 `investor_flow_*` — 그쪽은 결손이 영구 구멍이라 서버가 무조건 돈다, #1099).

이 모듈은 **벤더 행 → 도메인 값** 변환만 한다. TTL·단일비행·last-good 은 라우트가
`_get_index_quotes` 의 확립된 패턴으로 감싼다.

⚠ **스케일이 TR 마다 다르다.** 한 파서로 묶으면 조용히 100배 틀린다(실측 #1095·#1096):

    ka20003.cur_prc   '+6613.59'   소수점 포함
    ka10051.cur_prc   '658091'     ×100 정수
    ka90005.kospi200  '+103645'    ×100 정수
    ka90010.kospi200  '+1037.95'   소수점 포함

그래서 파서를 TR 별로 나눠 두고, 공용 헬퍼는 "부호 붙은 정수" 같은 **모양** 수준만
공유한다.
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

# 급등락 카운트의 페이지 상한. 200행에서 커서가 안 끝나므로(#1096) 어딘가에서 끊어야
# 하는데, **조용한 절사는 금지**다 — 끊었으면 응답이 그 사실을 말해야 한다(#1099).
MAX_BREADTH_PAGES = 5
BREADTH_PAGE_ROWS = 200


def signed_int(v: Any) -> int | None:
    """`'+12,410'` · `'-8787'` · `''` → int|None. 키움은 부호를 문자열에 실어 보낸다."""
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if not s or s in {"+", "-"}:
        return None
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return None


def decimal_price(v: Any) -> float | None:
    """소수점을 **포함해서** 오는 가격(ka20003·ka90010)."""
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if not s or s in {"+", "-"}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def scaled_price(v: Any, *, scale: int = 100) -> float | None:
    """소수점이 **제거되어** 오는 가격(ka10051·ka90005). 암묵 2자리를 되돌린다."""
    n = signed_int(v)
    return None if n is None else n / scale


class IndexBreadth:
    """ka20003 한 행 — 지수 값 + 등락종목수.

    등락종목수는 **종합지수(001/101)에만 노출**한다(#1100). 값이 있는 코스닥150 까지
    함께 빼는 이유는 "등락종목수는 시장 전체의 개념" 이라는 표시 규칙이지 벤더 공백이
    아니다 — 나중에 코스피200 값이 생겨도 화면 규칙이 흔들리지 않는다.
    """

    __slots__ = ("code", "name", "value", "change_pct", "rising", "falling", "flat", "upper", "lower")

    def __init__(self, row: dict[str, Any]) -> None:
        self.code = str(row.get("stk_cd") or "")
        self.name = str(row.get("stk_nm") or "")
        self.value = decimal_price(row.get("cur_prc"))
        self.change_pct = decimal_price(row.get("flu_rt"))
        self.rising = signed_int(row.get("rising"))
        self.falling = signed_int(row.get("fall"))
        self.flat = signed_int(row.get("stdns"))
        self.upper = signed_int(row.get("upl"))
        self.lower = signed_int(row.get("lst"))

    @property
    def is_whole_market(self) -> bool:
        """종합지수인가 — 등락종목수를 붙일 자격."""
        return self.code in {"001", "101"}


def parse_index_sectors(rows: list[dict[str, Any]]) -> list[IndexBreadth]:
    return [IndexBreadth(r) for r in rows]


def _mwon_to_eok(v: int | None) -> float | None:
    """백만원 → 억원. ka90005/ka90010/ka10131 의 금액 단위는 **백만원**이다
    (2026-08-05 실측 — NAVER 금액 129,866 ÷ 수량 609,980주 = 212,900원/주로 실주가와
    일치. 억원이면 주당 2,129만원이 되어 불가능). ka10051(억원)과 화면 축을 맞추기
    위해 여기서 정규화하고, **필드 이름에 단위를 박는다** — 이 페이지에서만 단위
    오표기가 세 번째였다(ka10064 백만원 · ka10051 억원 · 여기 백만원).
    """
    return None if v is None else v / 100


def parse_program_trend(
    rows: list[dict[str, Any]],
    *,
    kospi200_scaled: bool,
    trust_index_columns: bool = True,
) -> list[dict[str, Any]]:
    """ka90005(시각축)·ka90010(일자축) 공용 파서 — **스케일만 인자로 갈린다**.

    응답 스키마가 동일해 파서를 나누면 중복이 되지만, `kospi200` 스케일이 달라 그
    한 축은 반드시 호출부가 정해야 한다. 실수 여지를 줄이려고 기본값을 두지 않는다.

    `trust_index_columns=False` 면 `kospi200`·`basis` 를 `None` 으로 접는다.
    **일별 축 + 코스닥에서 그 두 열이 실제로 틀리기 때문이다**(2026-08-05 실측):
    과거일 값이 코스피 응답과 **완전히 동일**하고(08/04 1000.03 · 08/03 986.72 양쪽
    같음) `basis` 가 345·275 로 불가능한 크기다. 장중 축(ka90005)은 시장별로 올바르다
    (코스피 1046 / 코스닥 1361 ≈ KOSDAQ150). 즉 같은 이름의 열이 두 TR 에서 의미가
    다르고, 틀린 쪽을 그대로 흘리면 나중 소비자가 조용히 쓰레기를 그린다.
    """
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "t": str(r.get("cntr_tm") or ""),
                "arb_net_eok": _mwon_to_eok(signed_int(r.get("dfrt_trde_netprps"))),
                "non_arb_net_eok": _mwon_to_eok(signed_int(r.get("ndiffpro_trde_netprps"))),
                "total_net_eok": _mwon_to_eok(signed_int(r.get("all_netprps"))),
                "kospi200": (
                    None if not trust_index_columns
                    else scaled_price(r.get("kospi200")) if kospi200_scaled
                    else decimal_price(r.get("kospi200"))
                ),
                "basis": decimal_price(r.get("basis")) if trust_index_columns else None,
            }
        )
    return out


def parse_streaks(rows: list[dict[str, Any]], *, actor: str) -> list[dict[str, Any]]:
    """ka10131 → 주체별 연속 순매수. 외국인·기관이 **필드로 갈려 있어 한 응답이 두 카드**를 채운다."""
    prefix = "frgnr" if actor == "외국인" else "orgn"
    out: list[dict[str, Any]] = []
    for r in rows:
        days = signed_int(r.get(f"{prefix}_cont_netprps_dys"))
        # **양수만** — 음수 연속일수는 연속 순매도라 "순매수 상위" 카드에 섞이면
        # 안 된다(실화면에서 -2일 · 금액 — 행이 노출됐다, 2026-08-05).
        if days is None or days <= 0:
            continue
        out.append(
            {
                "code": str(r.get("stk_cd") or "").split("_")[0],
                "name": str(r.get("stk_nm") or ""),
                "actor": actor,
                "streak_days": days,
                # ⚠ 벤더 금액 단위는 백만원(_mwon_to_eok 근거) — amt_qty_tp 는 이
                # TR 에서 **무시된다**(0/1 응답 동일, 양축이 한 응답에 온다).
                "streak_net_eok": _mwon_to_eok(signed_int(r.get(f"{prefix}_cont_netprps_amt"))),
                "streak_net_qty_shares": signed_int(r.get(f"{prefix}_cont_netprps_qty")),
                "period_change_pct": decimal_price(r.get("prid_stkpc_flu_rt")),
            }
        )
    return out


# ka10051 주체 필드 — 값의 **단위는 요청의 `amt_qty_tp` 가 정한다**(#1117).
# 수집기는 `"0"`(금액, 억원)으로 찍으므로 여기서 나오는 값은 억원이다. 필드 이름에
# 단위를 박는 이유는 2026-08-04 의 단위 뒤바뀜 버그 때문이다.
INVESTOR_FIELDS: dict[str, str] = {
    "individual": "ind_netprps",
    "foreign": "frgnr_netprps",
    "institution": "orgn_netprps",
}

# 시장 전체 행 — 업종 행과 구분한다(`_AL` venue 접미가 붙어 온다).
WHOLE_MARKET_INDS = {"001_AL": "KOSPI", "101_AL": "KOSDAQ"}


def market_investor_row(rows: list[dict[str, Any]]) -> tuple[str, dict[str, int | None]] | None:
    """ka10051 응답에서 **시장 전체 행 하나**를 뽑아 3주체 값으로. 없으면 None.

    28~32행 중 업종 행은 버린다 — 카드가 쓰는 것은 종합(KOSPI/KOSDAQ) 뿐이다.
    업종별 수급은 저장은 하되(소급 조회 불가라 버리면 영원히 없다) 이 표면은 안 쓴다.
    """
    for r in rows:
        label = WHOLE_MARKET_INDS.get(str(r.get("inds_cd") or ""))
        if label is None:
            continue
        return label, {k: signed_int(r.get(f)) for k, f in INVESTOR_FIELDS.items()}
    return None


def expected_sample_count(*, session_minutes: int, poll_interval_ms: int) -> int:
    """세션 길이 ÷ 폴 주기. 화면의 "표본 42/78" 에서 분모다.

    커버리지가 값과 동급인 이유는 수집이 죽으면 차트가 **짧은 선을 사실처럼**
    그리기 때문이다(ADR-0064). 분모가 없으면 42 가 많은지 적은지 알 수 없다.
    """
    per_minute = 60_000 / max(poll_interval_ms, 1)
    return max(int(session_minutes * per_minute), 0)


# 급등·급락으로 셀 최소 변동폭(%). **벤더 하한(1%)이 너무 낮다** — 실측(2026-08-05)에서
# 코스피 1,000+ / 코스닥 1,000+ 가 잡혀 "시장의 37%가 급등" 이라는 무의미한 수가 나왔다.
# 같은 응답의 분포가 임계를 정해 준다(1페이지 200행 기준): ≥1% 200 · ≥2% 69 · ≥3% 26 ·
# ≥5% 5. 60분 창에서 3% 는 실제 움직임이고, 두 자리 수라 날마다 유의미하게 변한다.
JUMP_RATE_THRESHOLD_PCT = 3.0


def jump_rate_abs(row: dict[str, Any]) -> float | None:
    """`jmp_rt` 의 절대값(%). 부호는 `flu_tp`(급등/급락)가 이미 갈랐다."""
    v = decimal_price(row.get("jmp_rt"))
    return None if v is None else abs(v)


def below_threshold(rows: list[dict[str, Any]], *, threshold: float = JUMP_RATE_THRESHOLD_PCT) -> bool:
    """이 페이지의 **마지막 행**이 임계 아래인가 — 그러면 다음 페이지는 볼 필요가 없다.

    응답이 `jmp_rt` **내림차순**이라는 실측(급등 9.36→1.01, 급락 -4.42→-0.62, 양 방향
    모두 확인)에 기댄 조기 종료다. 정렬이 깨지면 과소 집계가 되므로, 이 함수를 쓰는
    쪽은 그 가정이 **응답 구조에 대한 것**임을 알고 있어야 한다.
    """
    if not rows:
        return True
    last = jump_rate_abs(rows[-1])
    return last is not None and last < threshold


def count_above_threshold(
    rows: list[dict[str, Any]], *, threshold: float = JUMP_RATE_THRESHOLD_PCT
) -> int:
    """임계 이상만 센다. 조기 종료해도 마지막 페이지엔 임계 미만이 섞여 있다."""
    return sum(1 for r in rows if (v := jump_rate_abs(r)) is not None and v >= threshold)


class BreadthCount:
    """목록을 세어 만든 카운트 + **절사 여부**.

    ka10016/ka10019 는 카운트를 주지 않고 목록을 준다. ka10019 는 200행에서 커서가
    안 끝나므로 상한이 필요한데, 끊었다는 사실을 응답이 말하지 않으면 "전부 셌다" 로
    읽힌다 — 그래서 `truncated` 가 값과 동급이다(#1099, 조용한 절사 금지).
    """

    __slots__ = ("count", "truncated")

    def __init__(self, count: int, *, truncated: bool) -> None:
        self.count = count
        self.truncated = truncated

    def as_dict(self) -> dict[str, Any]:
        return {"count": self.count, "truncated": self.truncated}


def count_rows(rows: list[dict[str, Any]], *, pages_used: int, cont: bool) -> BreadthCount:
    """행 수 → 카운트. 상한에 닿아 커서가 남았으면 절사로 표시한다."""
    truncated = cont and pages_used >= MAX_BREADTH_PAGES
    if truncated:
        log.info(
            "market_overview.breadth.truncated pages=%d rows=%d — 카운트는 하한이다",
            pages_used, len(rows),
        )
    return BreadthCount(len(rows), truncated=truncated)
