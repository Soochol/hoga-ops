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


def parse_program_trend(rows: list[dict[str, Any]], *, kospi200_scaled: bool) -> list[dict[str, Any]]:
    """ka90005(시각축)·ka90010(일자축) 공용 파서 — **스케일만 인자로 갈린다**.

    응답 스키마가 동일해 파서를 나누면 중복이 되지만, `kospi200` 스케일이 달라 그
    한 축은 반드시 호출부가 정해야 한다. 실수 여지를 줄이려고 기본값을 두지 않는다.
    """
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "t": str(r.get("cntr_tm") or ""),
                "arb_net": signed_int(r.get("dfrt_trde_netprps")),
                "non_arb_net": signed_int(r.get("ndiffpro_trde_netprps")),
                "total_net": signed_int(r.get("all_netprps")),
                "kospi200": (
                    scaled_price(r.get("kospi200")) if kospi200_scaled
                    else decimal_price(r.get("kospi200"))
                ),
                "basis": decimal_price(r.get("basis")),
            }
        )
    return out


def parse_streaks(rows: list[dict[str, Any]], *, actor: str) -> list[dict[str, Any]]:
    """ka10131 → 주체별 연속 순매수. 외국인·기관이 **필드로 갈려 있어 한 응답이 두 카드**를 채운다."""
    prefix = "frgnr" if actor == "외국인" else "orgn"
    out: list[dict[str, Any]] = []
    for r in rows:
        days = signed_int(r.get(f"{prefix}_cont_netprps_dys"))
        if not days:
            continue
        out.append(
            {
                "code": str(r.get("stk_cd") or "").split("_")[0],
                "name": str(r.get("stk_nm") or ""),
                "actor": actor,
                "streak_days": days,
                # 단위는 요청의 amt_qty_tp 가 정한다 — 이름에 박아 축을 못 헷갈리게 한다.
                "streak_net_amt": signed_int(r.get(f"{prefix}_cont_netprps_amt")),
                "streak_net_qty": signed_int(r.get(f"{prefix}_cont_netprps_qty")),
                "period_change_pct": decimal_price(r.get("prid_stkpc_flu_rt")),
            }
        )
    return out


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
