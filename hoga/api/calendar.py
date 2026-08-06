"""GET /api/inventory/calendar — per-symbol month status map.

Composes disk_state.check_disk_state with the KIS trading-day list and a
today/17-KST overlay. Pure read-side; no mutation. See spec §5.3, §11 Q21.
"""
from __future__ import annotations

import asyncio
import calendar as stdlib_calendar
import datetime as dt
import logging
import time
from pathlib import Path

from fastapi import APIRouter, Query

from hoga.api import trading_days as trading_days_source
from hoga.api.disk_state import DiskState, check_disk_state
from hoga.api.eligibility import is_terminal_partial
from hoga.api.error_codes import UpstreamCode
from hoga.api.models import CalendarCell, CalendarResponse
from hoga.api.params import CODE_PATTERN

# Single Clock seam: KST + now_kst + is_today_too_early all live on
# orchestrator.py per Refactor 3. The today_locked overlay below reuses
# the same predicate that captures.py's enqueue guard uses — keeps the
# 17-KST cutoff in one place.
from hoga.collector.orchestrator import is_today_too_early, now_kst as _now_kst

log = logging.getLogger(__name__)


# ADR-0064 — "is TODAY a KRX session?" cache, kept SEPARATE from _month_cache.
# `_session_confirmed` holds YYYYMMDD strings proven to be trading sessions;
# a positive verdict is stable for the day, so it is cached and never
# re-fetched. A *negative* verdict is deliberately NOT cached permanently —
# only its last check time is recorded, so a transient calendar miss for today
# (which would otherwise silently halt live capture for the rest of the
# process, the way the old get_market_ohlcv proxy did) self-heals on the next
# re-check instead of needing a process restart. Re-checks are throttled to
# avoid hammering the upstream on a real holiday. (Post KRX→KIS migration the
# data source is KIS chk-holiday via _trading_days_for, which adds its own
# month cache + failure TTL underneath — the per-day session semantics here
# are unchanged.)
_session_confirmed: set[str] = set()
_session_last_miss_ms: dict[str, float] = {}
_SESSION_MISS_RECHECK_S = 60.0

_last_failure_reason: UpstreamCode | None = None

# 오버레이 위치. `set_data_dir` 로 주입한다(PR-H·#1044).
_data_dir: Path | None = None


def last_failure_reason() -> UpstreamCode | None:
    """Public accessor for the most recent KIS-availability failure."""
    return _last_failure_reason


class TradingDayUnavailableError(RuntimeError):
    """Trading-day data unavailable (KIS chk-holiday failed).
    Carries an UpstreamCode for HTTP surfacing."""
    def __init__(self, code: UpstreamCode) -> None:
        super().__init__(f"trading days unavailable: {code.value}")
        self.code = code


def set_data_dir(data_dir: Path | None) -> None:
    """오버레이 위치를 알려 준다. 앱 기동에서 한 번 호출한다(PR-H·#1044).

    시드는 패키지에 붙어 있어 항상 읽히지만, **커밋 이후의 새 거래일**은
    `<data_dir>/calendar/trading_days.txt` 오버레이에 쌓인다. 이 값이 없으면
    시드까지만 답한다 — 틀리지는 않고 커버리지가 짧아질 뿐이다.
    """
    global _data_dir  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    _data_dir = data_dir


def _trading_days_for(year: int, month: int) -> set[str] | None:
    """(year, month) 의 거래일 YYYYMMDD 집합. 커버리지 밖이면 None.

    **PR-H(#1044) 이후 조회 경로에 벤더가 없다.** 정적 시드
    (`hoga/api/trading_days_seed.txt`, 키움 `ka20006` 역산)와 data_dir 오버레이만
    읽는다. 그래서 여기서 사라진 것들:

      - 월 캐시 → `trading_days` 가 프로세스 싱글턴으로 이미 들고 있다
      - 실패 음성 캐시(60s TTL) → **실패라는 사건이 없다**
      - 자격증명 결여 vs 일시 장애 갈래(#976) → 파일은 자격증명을 안 쓴다

    None 이 뜻하는 것도 하나로 줄었다: **파일이 덮는 범위 밖**. 그건 진짜 모르는
    것이라 재시도해도 달라지지 않는다.

    **커버리지 밖은 `_last_failure_reason` 을 세우지 않는다.** 그게 사건이 아니기
    때문이다 — 소스는 멀쩡하고, 다음 달을 모르는 것은 `ka20006` 역산의 성질이다.
    사유를 세우면 두 가지가 동시에 깨졌다:

      1. `get_month_map` 이 **미래 달마다** 사유를 실어 보내, 캡처 폼의 오른쪽
         그리드(항상 +1개월 = 항상 커버리지 밖)가 배너를 상시 점등시켰다.
      2. 이 전역이 스레드풀에서 **교차 오염**됐다 — 좌/우 두 달 요청이 동시에 돌아
         커버리지 밖 달이 세운 사유를 커버리지 안 달이 `None` 으로 덮었다(그 반대도).
         사유를 세우는 경로가 "시드 부재" 하나로 줄면 모든 스레드가 같은 값을 써서
         경합 자체가 없어진다.
    """
    global _last_failure_reason  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩

    days = trading_days_source.trading_days(_data_dir)
    if not days:
        # 시드를 못 읽었다 = 배포 사고. 재시도 대상이 아니지만 사유는 남긴다.
        _last_failure_reason = UpstreamCode.TRADING_DAYS_UNAVAILABLE
        return None
    _last_failure_reason = None
    end = max(days)
    prefix = f"{year:04d}{month:02d}"
    # 그 달의 첫날이 커버리지를 넘으면 통째로 모른다(사유는 세우지 않는다 — 위 참조).
    if f"{prefix}01" > end:
        return None
    return {d for d in days if d.startswith(prefix)}


def is_trading_session_today(
    today_yyyymmdd: str, *, _now_s: float | None = None
) -> bool | None:
    """Is ``today`` a live KRX trading session right now? (ADR-0064)

    Lag-free: backed by the KIS chk-holiday *calendar* (via
    :func:`_trading_days_for`), which lists the whole month — today included —
    upfront. This is the gate the live poller must use; the old daily-OHLCV
    proxy misread a live trading day as non-trading early in the session and
    (once cached) silently halted capture for the whole process.

    Returns True/False, or None when KIS data is unavailable (the poller stays
    lenient on None — losing capture for a transient outage is worse than a
    brief burst of empty fetches). A True verdict is cached for the day; a
    False is re-checked (throttled) so a transient miss self-heals without a
    restart. Underneath, ``_trading_days_for`` adds its own month cache and
    60s failure TTL, and the fetch raises on an empty month — so a cached
    wrong-False for a real session would require KIS itself answering a
    non-empty month that omits today.

    ``_now_s`` is a monotonic-seconds seam for tests; production passes None.
    """
    if today_yyyymmdd in _session_confirmed:
        return True
    if _beyond_coverage(today_yyyymmdd):
        return None   # 커버리지 밖 — 모른다. 폴러는 None 에 관대하다(ADR-0064).

    now = _now_s if _now_s is not None else time.monotonic()
    year, month = int(today_yyyymmdd[:4]), int(today_yyyymmdd[4:6])
    # 음성 재확인 스로틀은 남긴다. 원래는 여기서 월 캐시를 비워 **fresh fetch** 를
    # 강제했는데, PR-H(#1044) 이후 소스가 정적 파일이라 다시 읽어도 같은 답이고
    # "일시적 miss" 라는 사건 자체가 없다 — 스케줄러가 오버레이를 갱신하면 mtime
    # 으로 자연히 반영되고, 그 갱신을 보는 시점이 바로 이 재확인이다.
    last_miss = _session_last_miss_ms.get(today_yyyymmdd)
    if last_miss is not None and (now - last_miss) < _SESSION_MISS_RECHECK_S:
        return False  # 최근에 확인했다 — 오늘은 진짜 휴장

    days = _trading_days_for(year, month)
    if days is None:
        # 달력 커버리지 밖 — 오버레이가 아직 그 날까지 못 왔다는 뜻이다.
        return None
    if today_yyyymmdd in days:
        _session_confirmed.add(today_yyyymmdd)
        return True
    _session_last_miss_ms[today_yyyymmdd] = now
    return False


def weekdays_in_range(start: str, end: str) -> list[str]:
    """[start, end] 의 **평일**(월~금) YYYYMMDD, 오름차순. 휴장일은 모른다.

    KIS 거래일 목록을 못 얻을 때의 최후 폴백이다. 자격증명이 아예 없으면
    :func:`trading_days_in_range` 는 영원히 실패하고, 그 위에 fail-fast 로 서 있는
    범위 캡처는 **영원히 사용할 수 없다**. 그건 "잘못된 날짜를 막는" 게 아니라
    기능 자체를 없애는 것이다.

    휴장일이 섞여 들어가는 비용은 유계다 — 캡처가 업스트림에서 빈 응답을 받고
    ADR-0021 의 ``.no_upstream_data`` 센티넬을 남기고 끝난다(설계된 경로). 반면
    이득은 "자격증명 없이도 캡처를 걸 수 있다" 이다.

    **일시 장애에는 쓰지 않는다.** 그때는 잠시 후 재시도가 옳은 안내이고, 추측한
    날짜 목록으로 진행할 이유가 없다 — 호출부가 사유를 보고 갈라야 한다.
    """
    start_d = dt.date(int(start[:4]), int(start[4:6]), int(start[6:8]))
    end_d = dt.date(int(end[:4]), int(end[4:6]), int(end[6:8]))
    if end_d < start_d:
        raise ValueError("end_date < start_date")
    out: list[str] = []
    cur = start_d
    while cur <= end_d:
        if cur.weekday() < 5:  # noqa: PLR2004 — 5=토
            out.append(cur.strftime("%Y%m%d"))
        cur += dt.timedelta(days=1)
    return out


def trading_days_in_range(start: str, end: str) -> list[str]:
    """Public helper used by captures.py Task 7. Returns YYYYMMDD trading days
    in [start, end] inclusive, sorted.

    Raises :class:`TradingDayUnavailableError` when KIS data is unavailable for
    any month spanned by the range — fail-fast on the enqueue path so the user
    can't proceed with a guessed day list.

    PR-H(#1044) 이후 소스는 정적 시드 + data_dir 오버레이라, **범위 안에서는
    실패하지 않는다**. 이 예외가 남아 있는 이유는 하나뿐이다: 요청 구간이
    달력 커버리지를 넘을 때. 그건 추측한 날짜 목록으로 진행할 일이 아니다.
    """
    start_d = dt.date(int(start[:4]), int(start[4:6]), int(start[6:8]))
    end_d = dt.date(int(end[:4]), int(end[4:6]), int(end[6:8]))
    if end_d < start_d:
        raise ValueError("end_date < start_date")
    # **날짜 단위로도 커버리지를 본다.** 월 단위만 보면 같은 달 안에서 커버리지를
    # 넘는 꼬리(8/3까지 아는데 8/6까지 요청)를 못 잡아 **조용히 짧은 목록**을
    # 돌려준다 — 호출자는 그 사이 거래일이 원래 없었다고 읽는다.
    end_known = coverage_end()
    if end_known is None:
        # 소스를 못 읽었다(배포 사고) — 커버리지 부족과 조치가 다르다.
        raise TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_UNAVAILABLE)
    if end > end_known:
        raise TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_STALE)

    out: list[str] = []
    cur = dt.date(start_d.year, start_d.month, 1)
    while cur <= end_d:
        days = _trading_days_for(cur.year, cur.month)
        if days is None:
            raise TradingDayUnavailableError(last_failure_reason() or UpstreamCode.TRADING_DAYS_UNAVAILABLE)
        for d in sorted(days):
            if start <= d <= end:
                out.append(d)
        # Advance to the first day of the next month.
        if cur.month == 12:  # noqa: PLR2004, SIM108
            cur = dt.date(cur.year + 1, 1, 1)
        else:
            cur = dt.date(cur.year, cur.month + 1, 1)
    return out


def _beyond_coverage(date_yyyymmdd: str) -> bool:
    """그 날짜가 달력 커버리지 **끝을 넘었나**.

    `_trading_days_for` 는 월 단위라 **부분 커버 달을 못 잡는다** — 8월의 첫날이
    커버리지(8/3) 안이면 None 이 아닌 `{20260803}` 을 돌려주고, 8/4 는 그 집합에
    없으니 "휴장" 으로 **확정**된다. 그러면 라이브 세션 게이트가 정규장 중에
    닫힌다(실측 2026-08-04 09:32, 호가·체결 스트림 전면 차단).

    `trading_days_in_range` 는 같은 함정을 이미 막고 있었는데 날짜 술어 둘에는
    빠져 있었다. 커버리지 밖은 **모른다(None)** 여야 한다.
    """
    end = coverage_end()
    return end is None or date_yyyymmdd > end


def coverage_end() -> str | None:
    """달력이 답할 수 있는 마지막 날짜(YYYYMMDD). 소스가 비면 None.

    이 경계 뒤는 **모른다** — 아직 안 열린 날일 수도, 휴장일 수도 있다.
    호출자가 "정확한 구간" 과 "근사해야 하는 꼬리" 를 가르는 데 쓴다.
    """
    return trading_days_source.coverage_end(_data_dir)


def is_trading_day(date_yyyymmdd: str) -> bool | None:
    """Return True/False for ``date``, or None when KIS data is unavailable.

    Policy on None is the caller's: cold-path schedulers fail-fast
    (``trading_days_in_range`` raises), live-path callers fall back to a
    permissive default (e.g. don't gate polling so capture stays up when
    KIS is briefly unreachable). Keeping the data accessor and the policy
    separate avoids embedding either stance in the module.
    """
    if _beyond_coverage(date_yyyymmdd):
        return None
    year = int(date_yyyymmdd[:4])
    month = int(date_yyyymmdd[4:6])
    days = _trading_days_for(year, month)
    if days is None:
        return None
    return date_yyyymmdd in days


def reset_cache_for_tests() -> None:
    """Test helper — clears the trading-day cache between tests."""
    global _last_failure_reason  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    trading_days_source.reset_for_tests()
    _session_confirmed.clear()
    _session_last_miss_ms.clear()
    _last_failure_reason = None


def _all_weekdays_in_month(year: int, month: int) -> set[str]:
    """달력이 답하지 못하는 구간의 근사: 월~금을 전부 거래일로 친다.

    휴장일이 ``"holiday"`` 대신 ``"none"`` 으로 보이지만, 그건 **틀린 단정이 아니라
    덜 아는 것**이라 "수집 안 됨" 으로 읽혀도 손해가 유계다(캡처하면 업스트림 빈
    응답 → ADR-0021 센티넬). 반대로 모르는 날을 ``"holiday"`` 로 확정하면 진짜
    거래일이 **선택조차 불가능**해진다 — 그쪽이 훨씬 비싸다.

    근사가 실제로 쓰인 구간은 ``CalendarResponse.reason`` 이 알린다.
    """
    last_day = stdlib_calendar.monthrange(year, month)[1]
    out: set[str] = set()
    for day in range(1, last_day + 1):
        d = dt.date(year, month, day)
        if d.weekday() < 5:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            out.add(f"{year:04d}{month:02d}{day:02d}")
    return out


def _disk_state_to_status(st: DiskState) -> str:
    return {
        DiskState.COMPLETE: "complete",
        DiskState.SOURCE_PARTIAL: "source_partial",
        DiskState.CLIENT_INCOMPLETE: "client_incomplete",
        DiskState.INVALID: "invalid",                       # ADR-0020
        DiskState.NO_UPSTREAM_DATA: "no_upstream_data",     # ADR-0021
        DiskState.NONE: "none",
    }[st]


def _captured_at_ms(data_dir: Path, code: str, date: str) -> int | None:
    parquet = data_dir / "parquet" / date / code
    if parquet.exists():
        try:
            return int(parquet.stat().st_mtime * 1000)
        except OSError:
            return None
    raw = data_dir / "raw" / date / code
    if raw.exists():
        try:
            return int(raw.stat().st_mtime * 1000)
        except OSError:
            return None
    return None


def _cell_status_for(date_str: str, now: dt.datetime, trading_days: set[str],
                     data_dir: Path, code: str) -> str:
    d = dt.date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))
    today = now.date()
    if d > today:
        return "future"
    if is_today_too_early(date_str, now):
        return "today_locked"
    if date_str not in trading_days:
        return "weekend" if d.weekday() >= 5 else "holiday"  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
    # hogaplay is the canonical capture source — show its state directly (this
    # also covers the sentinel / raw / legacy-flat fallbacks, all hogaplay-only
    # artifacts). Only when there is NO hogaplay artifact at all do we consider a
    # live/REST promotion, surfacing it with a distinct *_live status so the
    # cell reads "WS data present, hogaplay not collected" rather than a
    # misleading hogaplay-framed ✕ (client_incomplete = "resume on capture").
    #
    # 승격 소스는 **벤더 중립**으로 부른다. 이 자리를 `kis`라 부르던 시절의 이름이
    # 프론트 라벨까지 새어 "KIS 실시간 데이터" 툴팁이 됐고, ADR-0136 이후로도 남아
    # 키움 데이터를 KIS라 부르고 있었다(calendarStatus.ts complete_live 참조).
    hp = check_disk_state(data_dir, code, date_str, source="hogaplay")
    if hp.state != DiskState.NONE:
        # 부분 결손 중 "재캡처가 무의미하다고 판정된" 것만 갈라 낸다. 나머지
        # SOURCE_PARTIAL 은 그대로 ⚠ — 아직 재캡처가 채워 줄 여지가 있다.
        if is_terminal_partial(hp, date_str, now):
            return "source_partial_confirmed"
        return _disk_state_to_status(hp.state)
    live = check_disk_state(data_dir, code, date_str).state  # aggregate: kiwoom_live/kis_api
    if live == DiskState.COMPLETE:
        return "complete_live"
    if live == DiskState.SOURCE_PARTIAL:
        return "partial_live"
    return "none"


def _effective_trading_days(
    year: int, month: int, *, today: str,
) -> tuple[set[str], UpstreamCode | None]:
    """그 달의 거래일 집합 + 근사를 알릴 사유. **경계에서 자른다.**

    이 함수가 존재하는 이유는 `_trading_days_for` 가 월 단위라 **부분 커버 달을 못
    가르기 때문**이다. 커버리지가 8/3 까지인 8월은 `{20260803}` 이라는 비어 있지
    않은 집합을 돌려주고, 그러면 8/4~8/31 이 전부 "휴장" 으로 **확정**된다 —
    `5db711f9`(#1044 회귀)가 라이브 세션 게이트에서 고친 것과 같은 함정이 달력 셀에
    그대로 남아 있었다. 그쪽은 `_beyond_coverage` 로 막았고, 여기서는 커버리지 뒤를
    평일로 근사해 채운다(범위 캡처가 이미 쓰는 정책과 같다 — captures.py §꼬리 근사).

    사유는 **근사가 실제로 판정을 바꾼 날이 있을 때만** 낸다. 판정 기준은
    "커버리지 밖 + 어제 이하":

      - 미래 날짜는 어차피 ``"future"`` 로 그려져 거래일 여부를 주장하지 않는다.
        여기에 사유를 붙이면 오른쪽 그리드(항상 다음 달)가 배너를 상시 점등시킨다.
      - **오늘은 구조적으로 항상 커버리지 밖**이다. `ka20006` 은 장이 끝나야 오늘
        행을 주므로, 오늘을 근거로 경고하면 정상 운영에서 매일 배너가 뜬다.

    그래서 남는 것은 하나뿐이다: **알았어야 하는 과거 날짜를 못 안다** = 오버레이가
    밀렸다. 그건 진짜로 알려야 하는 상태다(조치: 오버레이 갱신).
    """
    known = _trading_days_for(year, month)
    if known is None and last_failure_reason() is not None:
        # 소스 부재 — 전 구간 근사. 조치가 다르므로 사유도 다르다.
        return _all_weekdays_in_month(year, month), UpstreamCode.TRADING_DAYS_UNAVAILABLE

    end_known = coverage_end()
    weekdays = _all_weekdays_in_month(year, month)
    approximated = {d for d in weekdays if end_known is None or d > end_known}
    effective = (known or set()) | approximated
    stale = any(d < today for d in approximated)
    return effective, UpstreamCode.TRADING_DAYS_STALE if stale else None


def get_month_map(*, data_dir: Path, code: str, year: int, month: int) -> CalendarResponse:
    """Build the month status map. Pure read-side. 달력 커버리지 밖은 평일 근사."""
    now = _now_kst()
    effective_trading_days, reason = _effective_trading_days(
        year, month, today=now.strftime("%Y%m%d"),
    )
    last_day = stdlib_calendar.monthrange(year, month)[1]
    cells: list[CalendarCell] = []
    for day in range(1, last_day + 1):
        date_str = f"{year:04d}{month:02d}{day:02d}"
        status = _cell_status_for(date_str, now, effective_trading_days, data_dir, code)
        # "디스크에 실제 산출물이 있는" 상태들. source_partial_confirmed 는 확정
        # 결손이어도 하루 대부분이 수집돼 있으므로 여기 속한다 — 빼면 새 셀만
        # 조용히 캡처 시각을 잃는다.
        captured_ms = (_captured_at_ms(data_dir, code, date_str)
                       if status in ("complete", "source_partial",
                                     "source_partial_confirmed", "client_incomplete",
                                     "complete_live", "partial_live")
                       else None)
        cells.append(CalendarCell(date=date_str, status=status,  # type: ignore[arg-type]
                                  captured_at_ms=captured_ms))
    return CalendarResponse(cells=cells, as_of_ms=int(time.time() * 1000), reason=reason)


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/inventory", tags=["inventory"])

    @router.get("/calendar")
    async def calendar_route(code: str = Query(..., pattern=CODE_PATTERN),
                              year: int = Query(..., ge=2000, le=2100),
                              month: int = Query(..., ge=1, le=12)) -> CalendarResponse:
        # Offload the entire build to a threadpool so the cold-month KIS
        # HTTP fetch inside _trading_days_for doesn't block the event loop.
        # Warm calls (cache hit) still incur the round-trip; overhead is
        # negligible (~microseconds) vs the per-stall (seconds) we avoid.
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: get_month_map(data_dir=data_dir, code=code, year=year, month=month),
        )

    return router
