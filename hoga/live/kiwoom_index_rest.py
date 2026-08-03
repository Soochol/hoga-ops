"""키움 지수 현재가(`ka20001`)·일봉(`ka20006`) 어댑터 — PR-C (#1039).

`kiwoom_rest` seam 위에 얹는 첫 표면 이관이다. KIS 의 `fetch_index_price` /
`fetch_index_daily_candles` 를 대체하되 **반환 타입은 그대로**라 소비자
파이프라인(캐시·집계·경고)은 누가 fetch 했는지 모른다 — ADR-0129 D1 이 세운 규율.

## 가격 포맷이 TR 마다 다르다 — 실측으로 확인했다

    ka20001  cur_prc_n  '-6241.91'   소수점 **포함**
    ka20006  cur_prc    '624191'     소수점 **제거**(암묵 2자리)

`kiwoom_index_candles.parse_price` docstring 이 "이 파서를 다른 TR 에 재사용하지
말 것" 이라고 경고한 이유가 이것이다. 다만 그 구현은 `.` 유무로 분기하므로 **두
포맷을 모두 올바르게** 처리한다 — 같은 날(2026-08-03) 두 TR 이 각각 `-6241.91` 과
`624191` 을 주고 둘 다 6241.91 로 파싱되는 것을 실측으로 교차 검증했다. 그 불변식을
테스트로 못 박아 두었으므로 재사용이 안전하다.

**부호가 있는 필드에는 쓰지 말 것.** `parse_price` 는 부호를 제거한다(지수 레벨은
항상 양수라 옳다). `pred_pre_n`·`flu_rt_n` 은 키움이 **이미 부호를 실어 보내므로**
그대로 float 로 읽는다 — KIS 처럼 `prdy_vrss_sign` 코드로 부호를 복원할 필요가 없다.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from hoga.live.candle_fetch_result import DailyInvariantViolation, IndexCandleFetchResult
from hoga.live.candle_models import IndexCandlePoint
from hoga.live.index_registry import RepresentativeIndex
from hoga.live.kiwoom_errors import KiwoomApiError
from hoga.live.kiwoom_index_candles import index_id_to_kiwoom_code, parse_price
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.util.timeenc import KST

# 코스피/코스닥 시장 구분. ka20001 이 요구하는 필수 파라미터다.
_MRKT_KOSPI = "0"
_MRKT_KOSDAQ = "10"
_KOSDAQ_IDS = frozenset({"KOSDAQ", "KOSDAQ150"})

# 일봉 커서 상한 — 600행/페이지라 한 페이지로 2.4년이 덮인다. 그 이상은 폭주 신호다.
_MAX_DAILY_PAGES = 8
_DATE_LEN = 8


class KiwoomIndexRestError(KiwoomApiError):
    """지수 REST 어댑터 실패. `KiwoomApiError` 를 상속해 기존 degrade 팔이 흡수한다."""


def _mrkt_tp(index_id: str) -> str:
    return _MRKT_KOSDAQ if index_id in _KOSDAQ_IDS else _MRKT_KOSPI


def _signed(raw: object) -> float:
    """키움이 **이미 부호를 실어 보내는** 필드(전일대비·등락률)를 그대로 읽는다.

    `parse_price` 를 쓰면 안 된다 — 그건 부호를 제거한다.
    """
    text = str(raw).strip().replace("+", "")
    if not text:
        return 0.0
    return float(text)


def _daily_anchor_ms(date_yyyymmdd: str) -> int:
    """일봉 1건의 시각 앵커 = 그날 09:00 KST. KIS 경로와 같은 규약이라
    프론트가 투자자 막대를 같은 날 캔들에 정렬한다."""
    dt = datetime.strptime(date_yyyymmdd, "%Y%m%d").replace(hour=9, tzinfo=KST)
    return int(dt.timestamp() * 1000)


async def fetch_index_price(
    client: KiwoomRestClient, index: RepresentativeIndex
) -> tuple[str, float, float, float, int]:
    """지수 현재가 1건. ``(index_id, value, change, change_rate, t_ms)``.

    `ka20001` 은 **시각별 20행**을 주므로 최신 1행으로 좁힌다 — 소비자가 기대하는
    모양이 스냅샷이기 때문이다(#1007 에서 확인한 모양 차이).

    `t_ms` 는 **응답의 체결 시각(`tm_n`)** 이다. KIS 경로는 응답에 시각이 없어
    수신 시각으로 대체했는데(`IndexQuoteSnapshot` docstring), 키움은 진짜 값을
    주므로 그 필드의 원래 의도를 충족한다.
    """
    code = index_id_to_kiwoom_code(index.id)
    page = await client.call(
        "ka20001", {"inds_cd": code, "mrkt_tp": _mrkt_tp(index.id)}
    )
    if not page.rows:
        raise KiwoomIndexRestError(code="EMPTY", msg=f"ka20001 {index.id}: no rows")
    top = page.rows[0]  # 응답은 최신순이다(실측: 152000 → 151950 → 151940)
    return (
        index.id,
        parse_price(top.get("cur_prc_n")),
        _signed(top.get("pred_pre_n")),
        _signed(top.get("flu_rt_n")),
        _tm_to_ms(str(top.get("tm_n") or "")),
    )


def _tm_to_ms(hhmmss: str) -> int:
    """`'152000'` → 오늘 15:20:00 KST 의 epoch ms. 형식이 어긋나면 현재 시각."""
    now = datetime.now(KST)
    if len(hhmmss) != 6 or not hhmmss.isdigit():  # noqa: PLR2004 — HHMMSS 길이
        return int(now.timestamp() * 1000)
    stamped = now.replace(
        hour=int(hhmmss[0:2]), minute=int(hhmmss[2:4]), second=int(hhmmss[4:6]), microsecond=0
    )
    return int(stamped.timestamp() * 1000)


async def fetch_index_daily_candles(
    client: KiwoomRestClient,
    index: RepresentativeIndex,
    from_yyyymmdd: str,
    to_yyyymmdd: str,
) -> IndexCandleFetchResult:
    """[from, to] 지수 일봉. `base_dt` 랜덤 액세스 + 커서.

    **완결성을 데이터로 판정하지 않는다**(ADR-0136 §3). 한 페이지에서 앞이 잘릴 수
    있는 것은 최古 날짜 하나뿐이라는 **프로토콜의 성질**로 판정한다 — 일봉은 날짜가
    행 단위라 잘림 자체가 없지만, 커서 종료 조건은 같은 문법을 쓴다:
    **`from` 이전 날짜를 볼 때까지** 걸어야 `from` 이 온전하다.
    """
    code = index_id_to_kiwoom_code(index.id)

    def _covered(rows: list[dict[str, Any]], _page: Any) -> bool:
        oldest = min((str(r.get("dt") or "") for r in rows if r.get("dt")), default="")
        return bool(oldest) and oldest < from_yyyymmdd

    rows, truncated = await client.walk(
        "ka20006",
        {"inds_cd": code, "base_dt": to_yyyymmdd},
        max_pages=_MAX_DAILY_PAGES,
        stop=_covered,
    )

    candles: list[IndexCandlePoint] = []
    violations: list[DailyInvariantViolation] = []
    seen: set[str] = set()
    for row in rows:
        date_s = str(row.get("dt") or "")
        if len(date_s) != _DATE_LEN or date_s in seen:
            continue
        if not (from_yyyymmdd <= date_s <= to_yyyymmdd):
            continue
        seen.add(date_s)
        try:
            point = IndexCandlePoint(
                t_ms=_daily_anchor_ms(date_s),
                open=parse_price(row.get("open_pric")),
                high=parse_price(row.get("high_pric")),
                low=parse_price(row.get("low_pric")),
                close=parse_price(row.get("cur_prc")),
                volume=int(str(row.get("trde_qty") or "0").replace("-", "") or 0),
            )
        except (TypeError, ValueError) as exc:
            # reason 은 **닫힌 집합**이다(ADR-0129 D5) — 브로커 전용 값을 새로
            # 만들면 프론트가 소스를 구분해야 해서 응답의 중립성이 깨진다.
            violations.append(DailyInvariantViolation(
                date_yyyymmdd=date_s, reason="malformed_row", detail=str(exc),
            ))
            continue
        if point.close <= 0:
            violations.append(DailyInvariantViolation(
                date_yyyymmdd=date_s, reason="close_nonpositive",
                detail=f"close={point.close}",
            ))
            continue
        candles.append(point)

    if truncated:
        # 조용한 절단 금지 — kiwoom_index_candles 의 out_of_range 선례와 같은 규율.
        violations.append(DailyInvariantViolation(
            date_yyyymmdd=from_yyyymmdd, reason="out_of_range",
            detail=f"{_MAX_DAILY_PAGES} 페이지에서 {from_yyyymmdd} 에 못 닿았다",
        ))
    candles.sort(key=lambda c: c.t_ms)
    return IndexCandleFetchResult(candles=candles, violations=violations)
