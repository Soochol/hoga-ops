"""키움 종목 마스터 (`ka10099`) — PR-I (#1045).

KIS `.mst`(`kis_master.py`) 대체. 런타임은 `ka10099`, 부트스트랩은 커밋된 시드
스냅샷(`kiwoom_master_seed.json`).

## `.mst` 와 달라지는 것 넷

**① 시장은 응답이 아니라 요청이 정한다.** `mrkt_tp=0`(KOSPI) / `10`(KOSDAQ)로 **두 번**
부른다. 응답의 `marketCode` 는 상품 종류를 뜻하지 시장이 아니다 — KOSPI 요청에
`marketCode=8`(ETF) 이 1,155건 섞여 온다. 이걸 시장으로 읽으면 ETF 가 전부 미상
시장이 된다.

**② ETN 코드에 `Q` 접두가 없다.** `.mst` 는 `Q500061`, 키움은 `500061` 이다.
그래서 **캐시 schema bump 가 필수**다 — 안 하면 stale 캐시는 `Q500061` 을, 새
fetch 는 `500061` 을 주어 검색 결과가 이원화된다(기존 캐시에 `Q` 접두 380건).
정규화는 방어적으로 남긴다(실측 노출 0건이지만 벤더가 바꿀 수 있다).

**③ ETN 은 `marketCode` 가 셋이다.** `60`(ETN) · `90`(ETN 변동성) ·
**`70`(ETN 손실제한)**. 지도 티켓은 60/90 만 적었는데 실측에 70 이 있었다 —
둘만 매핑했다면 그 종목들이 조용히 사라진다.

**④ SPEC 밖 상품이 섞여 온다.** `6`(리츠 23) · `2`(인프라투자금융 2) ·
`4`(뮤추얼펀드 1). SPEC scope(보통주+ETF+ETN) 밖이라 버린다 — `.mst` 의
`_classify` 가 `RT`/`IF`/`MF` 를 버리던 것과 같은 자리다.

## 실측 (2026-08-03)

    mrkt_tp=0  → 2,474행  거래소 917 · ETF 1,155 · ETN 367+8+1 · 리츠 23 · 기타 3
    mrkt_tp=10 → 1,821행  전부 코스닥

커서 없음(`cont-yn=N`) — 한 콜이 한 시장 전부다.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, NamedTuple

SecurityType = Literal["stock", "etf", "etn"]
Market = Literal["KOSPI", "KOSDAQ"]

API_ID = "ka10099"

# 요청이 시장을 정한다(함정 ①).
MARKET_PARAM: dict[Market, str] = {"KOSPI": "0", "KOSDAQ": "10"}

# `marketCode` → 상품 종류. 없는 코드는 SPEC 밖이라 버린다(함정 ④).
_SECURITY_TYPE: dict[str, SecurityType] = {
    "0": "stock",    # 거래소
    "10": "stock",   # 코스닥
    "8": "etf",
    "60": "etn",     # ETN
    "90": "etn",     # ETN(변동성)
    "70": "etn",     # ETN(손실제한) — 지도 티켓이 빠뜨린 세 번째 ETN 코드
}


class MasterRow(NamedTuple):
    code: str
    name: str
    market: Market
    security_type: SecurityType
    #: NXT(넥스트레이드) 상장 여부. ``None`` = **모름**(판별 불가), ``False`` = 미상장.
    #: 이 둘을 합치면 안 된다 — ADR-0140 §4 의 판정 규칙이 "meta 부재 = 모름, 결손으로
    #: 단정 금지" 를 요구하고, 거래일 달력이 커버리지 밖을 ``None`` 으로 두는 것과 같은
    #: 규율이다. 구 시드(schema 3, 4-tuple)를 읽으면 여기가 ``None`` 이 된다.
    nxt_enabled: bool | None = None


class KiwoomMasterFetchError(Exception):
    """조회/파싱 실패. `UpstreamCode.MASTER_FETCH_FAILED` 로 매핑된다."""


def normalize_code(raw: object) -> str:
    """ETN `Q` 접두를 벗긴다(함정 ②).

    실측에서는 노출이 0건이지만 방어적으로 남긴다 — `.mst` 시절 코드가
    `Q500061` 이었고, 벤더가 다시 그렇게 보내면 캐시가 이원화된다.
    """
    code = str(raw or "").strip()
    return code[1:] if code.startswith("Q") and len(code) > 1 else code


def parse_row(row: dict[str, Any], market: Market) -> MasterRow | None:
    """행 하나 → `MasterRow`. SPEC 밖이거나 못 읽으면 None."""
    security_type = _SECURITY_TYPE.get(str(row.get("marketCode") or "").strip())
    if security_type is None:
        return None
    code = normalize_code(row.get("code"))
    name = str(row.get("name") or "").strip()
    if not code or not name:
        return None
    # `nxtEnable` 은 ka10099 가 **이미 주는 필드**인데 그동안 버렸다(#1106 — 응답 15필드
    # 중 4개만 썼다). 값 도메인은 'Y'/'N' 실측(전체 606/4,295, ETF·ETN 은 전량 N).
    raw_nxt = row.get("nxtEnable")
    nxt_enabled = None if raw_nxt is None else str(raw_nxt).strip() == "Y"
    return MasterRow(
        code=code, name=name, market=market, security_type=security_type,
        nxt_enabled=nxt_enabled,
    )


def parse_market(rows: list[dict[str, Any]], market: Market) -> list[MasterRow]:
    """한 시장의 응답 전체. 0행이면 예외 — **빈 카탈로그를 디스크에 쓰지 않는다.**"""
    out = [r for r in (parse_row(row, market) for row in rows) if r is not None]
    if not out:
        raise KiwoomMasterFetchError(f"{market}: ka10099 가 유효한 행을 0건 줬다")
    return out


async def fetch_symbol_master(client, *, run_call=None) -> list[MasterRow]:
    """두 시장 전부. `client` 는 `KiwoomRestClient`.

    타입 힌트를 붙이지 않은 이유: `hoga/api` 가 `hoga/live` 를 모듈 레벨로
    import 하면 순환이 생긴다(`live.api` 가 `api.calendar` 를 쓴다).

    `run_call` 은 **시장 1콜을 감쌀 러너**다(거버너 이음매) — `(fetch_fn, market)` 을
    받아 결과를 돌려준다. 없으면 직접 호출한다.

    **왜 루프 안에서 감싸는가** — 시장이 둘이라 콜도 둘이다. 함수 전체를 한 submit
    으로 감싸면 버킷은 1 을 세고 벤더는 2 를 센다(ADR-0137 "페이지 1장 = submit 1건",
    `market_routes._walk` 가 같은 이유로 `run_page` 를 받는다).
    """
    rows: list[MasterRow] = []
    for market, mrkt_tp in MARKET_PARAM.items():
        body = {"mrkt_tp": mrkt_tp}
        if run_call is None:
            page = await client.call(API_ID, body)
        else:
            page = await run_call(lambda c, b=body: c.call(API_ID, b), market)
        rows.extend(parse_market(page.rows, market))  # type: ignore[arg-type]
    return rows


SEED_PATH = Path(__file__).with_name("kiwoom_master_seed.json")


def load_seed() -> list[MasterRow]:
    """커밋된 부트스트랩 스냅샷. 못 읽으면 빈 리스트.

    **`.mst` 가 무인증 정적 파일이었다는 성질을 여기서 되산다**(SPEC §7).
    `ka10099` 는 인증이 필요하므로, 자격증명 없는 첫 부팅에서 검색이 통째로
    비지 않게 하려면 리포에 카탈로그가 하나 있어야 한다. 최신화는 런타임이
    하고 이 파일은 가끔만 갱신한다.
    """
    import json  # noqa: PLC0415 — 부팅 1회 경로
    import logging  # noqa: PLC0415

    try:
        payload = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        rows = payload["rows"]
    except (OSError, ValueError, KeyError):
        logging.getLogger(__name__).exception("종목 마스터 시드를 읽지 못했다: %s", SEED_PATH)
        return []
    # 행은 schema 3 에서 4-tuple, schema 4 부터 5-tuple(nxt_enabled)이다. 짧은 행은
    # **`False` 가 아니라 `None`(모름)** 으로 읽는다 — 구 시드가 "전 종목 NXT 미상장"
    # 이라고 거짓 증언하면 완결성 판정이 통째로 뒤집힌다.
    out: list[MasterRow] = []
    for r in rows:
        if len(r) == 4:  # noqa: PLR2004 — schema 3 (nxt_enabled 이전)
            c, n, m, t = r
            out.append(MasterRow(c, n, m, t))  # type: ignore[arg-type]
        else:
            c, n, m, t, x = r[:5]
            out.append(MasterRow(c, n, m, t, x))  # type: ignore[arg-type]
    return out
