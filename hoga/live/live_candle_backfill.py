from __future__ import annotations

import asyncio
import logging
import time as monotonic_time
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Protocol

from hoga import perf_debug
from hoga.api import calendar as trading_calendar
from hoga.live import kis_access
from hoga.live.kis_capacity_scheduler import (
    KisCapacityCooldown,
    KisCapacityOverloaded,
)
from hoga.live.kis_client import KisApiError, KisClient, KisRateLimitError
from hoga.live.kis_venue import (
    KisVenue,
    LiveVenuePolicy,
    session_window_hhmmss,
)
from hoga.live.past_candles_cache import PastCandlesCache

_KST = timezone(timedelta(hours=9))
_WEEKEND_START_WEEKDAY = 5
log = logging.getLogger(__name__)


class KisRestScheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: kis_access.KisRequestPriority,
        call: Callable[[KisClient], Awaitable],
        cooldown_scope: Hashable | None = None,
    ): ...


@dataclass(frozen=True)
class LiveMinuteCandleBackfillResult:
    candles: list[dict]
    cached_dates: list[str]
    fresh_dates: list[str]
    data_warnings: list[dict]
    effective_sessions: list[dict]

    def model_dump(self) -> dict:
        return {
            "candles": self.candles,
            "cached_dates": self.cached_dates,
            "fresh_dates": self.fresh_dates,
            "data_warnings": self.data_warnings,
            "effective_sessions": self.effective_sessions,
        }


class LiveMinuteCandleBackfill:
    """Owns Live Candle Backfill minute cache, scheduling, and warnings."""

    def __init__(
        self,
        *,
        data_dir,
        cache: PastCandlesCache,
        scheduler: KisRestScheduler,
        concurrency: int = 3,
        rate_limit_cooldown_s: float = 10.0,
    ) -> None:
        self._data_dir = data_dir
        self._cache = cache
        self._scheduler = scheduler
        self._sem = asyncio.Semaphore(concurrency)
        self._rate_limit_cooldown_s = rate_limit_cooldown_s
        self._inflight: dict[
            tuple[KisVenue, str, str],
            asyncio.Task[tuple[list[dict], str | None]],
        ] = {}
        self._rate_limit_until = 0.0
        self._warm_tasks: dict[tuple[KisVenue, str], asyncio.Task[None]] = {}

    async def collect_minute(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
        read_ahead: bool = False,
        earliest_allowed: date | None = None,
    ) -> LiveMinuteCandleBackfillResult:
        out = await self._collect_minute_inner(
            code=code, frm=frm, too=too, today_d=today_d, policy=policy,
        )
        # read-ahead: 이번 요청창 직전 동일 폭 구간을 background로 선행 워밍.
        # settle-loop의 다음 청크가 캐시 히트가 된다. 레이트리밋/용량 경고가
        # 있으면 예산이 이미 부족하다는 뜻이므로 이번엔 건너뛴다.
        if read_ahead and not _fallback_blocking_warning_dates(out.data_warnings):
            # span_days는 의도적으로 무제한이다(요청창 폭 전체). 프론트 팬은
            # to=today 고정으로 창이 넓어지고 nextHistoricalFrom이 from을 매 스텝
            # 정확히 stepChunkDays(=5캘린더일)씩 뒤로 옮기므로, [frm-span, frm-1]은
            # 항상 다음 청크가 필요로 하는 [frm-5, frm-1]의 superset이다(gap 없음).
            # 5로 캡하면 backend가 프론트 STEP_TRADING_DAYS에 암묵 결합돼, 그 상수가
            # 커지면 gap이 생긴다. 무제한 비용은 O(span) 캐시조회뿐(이미 데운 날짜는
            # _warm_run에서 get_past로 스킵)이라 무시 가능.
            span_days = (too - frm).days + 1
            ra_too = frm - timedelta(days=1)
            ra_frm = ra_too - timedelta(days=span_days - 1)
            if earliest_allowed is not None:
                ra_frm = max(ra_frm, earliest_allowed)
            if ra_frm <= ra_too:
                await self.warm_minute(
                    code=code, frm=ra_frm, too=ra_too, today_d=today_d, policy=policy,
                )
        return out

    async def _collect_minute_inner(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
    ) -> LiveMinuteCandleBackfillResult:
        if policy != "KRX":
            primary_out = await self._collect_for_venue(
                policy,
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
            )
            dates = list(_date_iter(frm, too))
            primary_dates = _dates_for_candles(primary_out.candles)
            warning_dates = _fallback_blocking_warning_dates(primary_out.data_warnings)
            covered_dates = primary_dates | set(primary_out.cached_dates) | warning_dates
            missing_dates = [
                date_s
                for date_s in dates
                if date_s not in covered_dates
            ]
            if not missing_dates:
                return primary_out
            missing_set = set(missing_dates)
            fallback_outs = await asyncio.gather(
                *(
                    self._collect_for_venue(
                        "KRX",
                        code=code,
                        frm=run_start,
                        too=run_end,
                        today_d=today_d,
                    )
                    for run_start, run_end in _contiguous_date_ranges(missing_dates)
                )
            )
            fallback_candles = [
                candle
                for fallback_out in fallback_outs
                for candle in fallback_out.candles
                if _date_from_t_ms(candle["t_ms"]) in missing_set
            ]
            fallback_warnings = [
                warning
                for fallback_out in fallback_outs
                for warning in fallback_out.data_warnings
            ]
            if not fallback_candles:
                return LiveMinuteCandleBackfillResult(
                    candles=primary_out.candles,
                    cached_dates=primary_out.cached_dates,
                    fresh_dates=primary_out.fresh_dates,
                    data_warnings=primary_out.data_warnings + fallback_warnings,
                    effective_sessions=primary_out.effective_sessions,
                )
            used_fallback_dates = _dates_for_candles(fallback_candles)
            for date_s in used_fallback_dates:
                self._cache.delete_past(policy, code, date_s)
            cached_dates = sorted(
                set(primary_out.cached_dates)
                | {
                    date_s
                    for fallback_out in fallback_outs
                    for date_s in fallback_out.cached_dates
                    if date_s in used_fallback_dates
                }
            )
            fresh_dates = sorted(
                set(primary_out.fresh_dates)
                | {
                    date_s
                    for fallback_out in fallback_outs
                    for date_s in fallback_out.fresh_dates
                    if date_s in used_fallback_dates
                }
            )
            return LiveMinuteCandleBackfillResult(
                candles=_merge_minute_fallback(
                    primary_out.candles,
                    fallback_candles,
                    fallback_dates=missing_set,
                ),
                cached_dates=cached_dates,
                fresh_dates=fresh_dates,
                data_warnings=primary_out.data_warnings + fallback_warnings + [
                    _minute_fallback_to_krx_warning(policy, sorted(used_fallback_dates))
                ],
                effective_sessions=_merge_effective_sessions(
                    primary_out.effective_sessions,
                    [
                        row
                        for fallback_out in fallback_outs
                        for row in fallback_out.effective_sessions
                    ],
                    fallback_dates=used_fallback_dates,
                ),
            )
        return await self._collect_for_venue(
            policy,
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
        )

    async def warm_minute(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
    ) -> str:
        """[frm, too]의 미캐시 과거 날짜를 background 우선순위로 순차 fetch해
        캐시를 데운다(fire-and-forget). (venue, code)별 단일 비행;
        "started" | "already_running" 반환. 태스크는 supervised — 실패는
        로그로 남고 침묵 사망하지 않는다(ADR-0088).

        일부러 순차(동시성 1): 워밍이 사용자 경로의 세마포어(3)나 KIS 예산을
        점유하지 않게 한다. KRX 폴백은 하지 않는다 — 폴백이 필요한 날짜는
        인터랙션 경로의 collect_minute가 그때 처리한다.

        latest-wins: 다른 (venue, code)의 진행 중 warm은 시작 전에 취소한다.
        종목 전환마다 warm 스트림이 누적되면(종목당 ~240 KIS 콜) 분봉 엔드포인트가
        지속 포화돼 EGW00201 폭풍 → 공유 쿨다운이 사용자 fetch까지 abort하는
        회귀가 있었다(/investigate 2026-07-07). 사용자의 현재 관심사는 항상
        마지막으로 활성화된 종목이므로 최신 warm 하나만 남긴다. 취소는 공유
        _inflight 태스크를 건드리지 않아(awaiter만 취소) 진행 중 1콜은 완주한다."""
        key = (policy, code)
        existing = self._warm_tasks.get(key)
        if existing is not None and not existing.done():
            return "already_running"
        for other_key, other_task in list(self._warm_tasks.items()):
            if other_key != key and not other_task.done():
                other_task.cancel()
        task = asyncio.create_task(
            self._warm_run(policy, code, frm=frm, too=too, today_d=today_d),
            name=f"live-candle-warm:{policy}:{code}",
        )
        self._warm_tasks[key] = task

        def _done(t: asyncio.Task, k: tuple[KisVenue, str] = key) -> None:
            if self._warm_tasks.get(k) is t:
                self._warm_tasks.pop(k, None)
            if t.cancelled():
                return
            exc = t.exception()
            if exc is not None:
                log.warning(
                    "live candle warm failed venue=%s code=%s: %s", k[0], k[1], exc,
                )

        task.add_done_callback(_done)
        return "started"

    async def _warm_run(
        self,
        venue: KisVenue,
        code: str,
        *,
        frm: date,
        too: date,
        today_d: date,
    ) -> None:
        today_s = today_d.strftime("%Y%m%d")
        for date_s in reversed(list(_date_iter(frm, too))):
            if date_s >= today_s:
                continue
            if self._cache.get_past(venue, code, date_s) is not None:
                continue
            if trading_calendar.is_trading_day(date_s) is False:
                self._cache.store_past(venue, code, date_s, [])
                continue
            if self._rate_limited_now():
                return
            try:
                bars, _write_err = await self._fetch_past_shared(
                    venue, code, date_s, priority="background"
                )
            except KisRateLimitError:
                self._mark_rate_limited()
                return
            except (KisCapacityCooldown, KisCapacityOverloaded, KisApiError):
                # 워밍은 best-effort: 이 날짜는 인터랙션 경로가 나중에 다시 시도.
                continue
            # 비-KRX venue가 거래일에 빈 결과를 주면, 그건 KRX 폴백을 트리거해야
            # 하는 신호다(인터랙션 경로가 폴백+delete_past로 관리). 워밍이 이 빈
            # 항목을 캐시에 남기면 이후 읽기가 cached=[]를 covered로 오인해 KRX
            # 폴백을 억제하므로(_collect_minute_inner covered_dates), 비-KRX 빈
            # 결과는 캐시에서 제거해 인터랙션 경로가 폴백하도록 한다.
            if venue != "KRX" and not bars:
                self._cache.delete_past(venue, code, date_s)

    async def collect_minute_cache_only(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
    ) -> LiveMinuteCandleBackfillResult:
        t0 = perf_debug.now()
        rows: list[dict] = []
        cached_dates: list[str] = []
        warnings: list[dict] = []
        effective_session_venues: dict[str, KisVenue] = {}
        today_s = today_d.strftime("%Y%m%d")

        for date_s in _date_iter(frm, too):
            if date_s < today_s:
                bars = self._cache.get_past(policy, code, date_s)
                session_venue = policy
                if bars is None and policy != "KRX":
                    bars = self._cache.get_past("KRX", code, date_s)
                    session_venue = "KRX"
                if bars is None:
                    warnings.append(_kis_rest_bypassed_warning(date_s))
                    continue
                rows.extend(bars)
                cached_dates.append(date_s)
                effective_session_venues[date_s] = session_venue
                continue

            state, today_bars = self._cache.get_today_tri(policy, code)
            session_venue = policy
            if state in {"miss", "negative"} and policy != "KRX":
                state, today_bars = self._cache.get_today_tri("KRX", code)
                session_venue = "KRX"
            if state == "hit":
                assert today_bars is not None
                rows.extend(today_bars)
                cached_dates.append(date_s)
                effective_session_venues[date_s] = session_venue
            elif state == "miss":
                warnings.append(_kis_rest_bypassed_warning(date_s))

        rows.sort(key=lambda candle: candle["t_ms"])
        result = LiveMinuteCandleBackfillResult(
            candles=rows,
            cached_dates=cached_dates,
            fresh_dates=[],
            data_warnings=warnings,
            effective_sessions=[
                _effective_session(date_s, venue)
                for date_s, venue in sorted(effective_session_venues.items())
            ],
        )
        if perf_debug.enabled():
            log.warning(
                "hoga_perf past_candles_cache_only code=%s venue=%s from=%s to=%s "
                "days=%d cached_dates=%d candles=%d warnings=%d duration_ms=%.1f",
                code,
                policy,
                frm.strftime("%Y%m%d"),
                too.strftime("%Y%m%d"),
                (too - frm).days + 1,
                len(result.cached_dates),
                len(result.candles),
                len(result.data_warnings),
                perf_debug.elapsed_ms(t0),
            )
        return result

    async def _collect_for_venue(
        self,
        venue: KisVenue,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
    ) -> LiveMinuteCandleBackfillResult:
        t0 = perf_debug.now()
        today_s = today_d.strftime("%Y%m%d")
        rows: dict[str, list[dict]] = {}
        cached_dates: list[str] = []
        pending: list[str] = []
        warnings_by_date: dict[str, dict] = {}
        fresh: set[str] = set()

        for date_s in _date_iter(frm, too):
            if date_s >= today_s:
                continue
            bars = self._cache.get_past(venue, code, date_s)
            if bars is not None:
                rows[date_s] = bars
                cached_dates.append(date_s)
                continue
            if trading_calendar.is_trading_day(date_s) is False:
                empty_bars: list[dict] = []
                self._cache.store_past(venue, code, date_s, empty_bars)
                rows[date_s] = empty_bars
                cached_dates.append(date_s)
                continue
            pending.append(date_s)

        blocked = asyncio.Event()

        async def one(date_s: str) -> None:
            async with self._sem:
                if blocked.is_set() or self._rate_limited_now():
                    warnings_by_date[date_s] = self._rate_limit_aborted_warning(date_s)
                    return
                try:
                    bars, write_err = await self._fetch_past_shared(venue, code, date_s)
                except KisCapacityOverloaded:
                    warnings_by_date[date_s] = _capacity_overloaded_warning(date_s)
                    return
                except KisCapacityCooldown:
                    warnings_by_date[date_s] = self._rate_limit_aborted_warning(date_s)
                    return
                except KisRateLimitError as e:
                    blocked.set()
                    self._mark_rate_limited()
                    warnings_by_date[date_s] = {
                        "date": date_s,
                        "reason": "kis_rate_limit",
                        "msg": str(e),
                    }
                    return
                except KisApiError as e:
                    warnings_by_date[date_s] = {
                        "date": date_s,
                        "reason": "kis_api_error",
                        "msg": e.msg_cd,
                    }
                    return
                rows[date_s] = bars
                fresh.add(date_s)
                if write_err is not None:
                    warnings_by_date[date_s] = {
                        "date": date_s,
                        "reason": "cache_write_failed",
                        "msg": write_err,
                    }

        await asyncio.gather(*(one(d) for d in pending))

        candles_all: list[dict] = []
        fresh_dates: list[str] = []
        warnings: list[dict] = []
        kis_blocked = blocked.is_set()

        for date_s in _date_iter(frm, too):
            if date_s < today_s:
                if date_s in rows:
                    candles_all.extend(rows[date_s])
                    if date_s in fresh:
                        fresh_dates.append(date_s)
                if date_s in warnings_by_date:
                    warnings.append(warnings_by_date[date_s])
                continue
            try:
                state, today_bars = self._cache.get_today_tri(venue, code)
                if state == "hit":
                    assert today_bars is not None
                    bars = today_bars
                    cached_dates.append(date_s)
                elif state == "negative":
                    bars = []
                else:
                    if today_d.weekday() >= _WEEKEND_START_WEEKDAY:
                        self._cache.store_today(venue, code, None)
                        continue
                    if kis_blocked or self._rate_limited_now():
                        warnings.append(self._rate_limit_aborted_warning(date_s))
                        continue
                    bars, _write_err = await kis_access.run_with_capacity(
                        self._scheduler,
                        data_dir=self._data_dir,
                        key=("live-candle-backfill", "minute", venue, code, date_s, "today"),
                        endpoint=kis_access.KisRestEndpoint.PAST_MINUTE,
                        priority="user_visible",
                        cooldown_scope=venue,
                        fetch_fn=lambda kis: self._fetch_past_today_once(
                            kis,
                            venue,
                            code,
                            date_s,
                        ),
                    )
                    if bars:
                        self._cache.store_today(venue, code, bars)
                        fresh_dates.append(date_s)
                    else:
                        self._cache.store_today(venue, code, None)
                candles_all.extend(bars)
            except KisRateLimitError as e:
                warnings.append({"date": date_s, "reason": "kis_rate_limit", "msg": str(e)})
                self._mark_rate_limited()
                kis_blocked = True
            except KisCapacityCooldown:
                warnings.append(self._rate_limit_aborted_warning(date_s))
            except KisCapacityOverloaded:
                warnings.append(_capacity_overloaded_warning(date_s))
            except KisApiError as e:
                warnings.append({"date": date_s, "reason": "kis_api_error", "msg": e.msg_cd})

        result = LiveMinuteCandleBackfillResult(
            candles=candles_all,
            cached_dates=cached_dates,
            fresh_dates=fresh_dates,
            data_warnings=warnings,
            effective_sessions=_effective_sessions_for_candles(candles_all, venue),
        )
        if perf_debug.enabled():
            log.warning(
                "hoga_perf past_candles_collect code=%s venue=%s from=%s to=%s "
                "days=%d pending_dates=%d cached_dates=%d fresh_dates=%d candles=%d "
                "warnings=%d rate_limited=%s duration_ms=%.1f",
                code,
                venue,
                frm.strftime("%Y%m%d"),
                too.strftime("%Y%m%d"),
                (too - frm).days + 1,
                len(pending),
                len(result.cached_dates),
                len(result.fresh_dates),
                len(result.candles),
                len(result.data_warnings),
                kis_blocked,
                perf_debug.elapsed_ms(t0),
            )
        return result

    async def _fetch_past_shared(
        self,
        venue: KisVenue,
        code: str,
        date_s: str,
        *,
        priority: kis_access.KisRequestPriority = "user_visible",
    ) -> tuple[list[dict], str | None]:
        # 단일 비행 키는 priority를 포함하지 않는다: warm(background)이 먼저 띄운
        # 태스크에 사용자 요청이 올라타면 background 우선순위로 대기하게 되지만,
        # ADR-0087의 background 비굶주림 보장으로 진전은 유지된다. 반대 방향
        # (user_visible 태스크에 warm이 올라탐)은 순수 이득.
        key = (venue, code, date_s)
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(
                self._fetch_past_scheduled(venue, code, date_s, priority=priority)
            )
            self._inflight[key] = task
            task.add_done_callback(lambda _t, k=key: self._inflight.pop(k, None))
        return await task

    async def _fetch_past_scheduled(
        self,
        venue: KisVenue,
        code: str,
        date_s: str,
        *,
        priority: kis_access.KisRequestPriority = "user_visible",
    ) -> tuple[list[dict], str | None]:
        t0 = perf_debug.now()
        try:
            result = await kis_access.run_with_capacity(
                self._scheduler,
                data_dir=self._data_dir,
                key=("live-candle-backfill", "minute", venue, code, date_s),
                endpoint=kis_access.KisRestEndpoint.PAST_MINUTE,
                priority=priority,
                cooldown_scope=venue,
                fetch_fn=lambda kis: self._fetch_past_once(
                    kis,
                    venue,
                    code,
                    date_s,
                    # ADR-0087 2층(토큰버킷) 우선순위를 스케줄러 priority와 일치:
                    # warm(background)이 foreground를 참칭하면 사용자 호출에
                    # 토큰을 양보하지 않아 EGW00201 폭풍의 원인이 된다.
                    foreground=(priority == "user_visible"),
                ),
            )
        except Exception:
            if perf_debug.enabled():
                log.warning(
                    "hoga_perf past_candles_fetch status=error code=%s venue=%s date=%s "
                    "duration_ms=%.1f",
                    code, venue, date_s, perf_debug.elapsed_ms(t0),
                )
            raise
        if perf_debug.enabled():
            log.warning(
                "hoga_perf past_candles_fetch status=ok code=%s venue=%s date=%s "
                "candles=%d cache_write_error=%s duration_ms=%.1f",
                code,
                venue,
                date_s,
                len(result[0]),
                result[1] is not None,
                perf_debug.elapsed_ms(t0),
            )
        return result

    async def _fetch_past_once(
        self,
        kis: KisClient,
        venue: KisVenue,
        code: str,
        date_s: str,
        *,
        foreground: bool = True,
    ) -> tuple[list[dict], str | None]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=foreground,
        )
        bars = [_candle_to_dict(c) for c in raw]
        try:
            self._cache.store_past(venue, code, date_s, bars)
        except OSError as e:
            return bars, str(e)
        return bars, None

    async def _fetch_past_today_once(
        self,
        kis: KisClient,
        venue: KisVenue,
        code: str,
        date_s: str,
    ) -> tuple[list[dict], str | None]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=True,
        )
        return [_candle_to_dict(c) for c in raw], None

    def _rate_limited_now(self) -> bool:
        return monotonic_time.monotonic() < self._rate_limit_until

    def _mark_rate_limited(self) -> None:
        self._rate_limit_until = max(
            self._rate_limit_until,
            monotonic_time.monotonic() + self._rate_limit_cooldown_s,
        )

    def _rate_limit_aborted_warning(self, date_s: str) -> dict:
        return {
            "date": date_s,
            "reason": "rate_limit_aborted",
            "msg": "KIS rate limit cooldown active",
        }


def _date_iter(frm: date, to: date):
    cur = frm
    while cur <= to:
        yield cur.strftime("%Y%m%d")
        cur = cur + timedelta(days=1)


def _contiguous_date_ranges(date_strings: list[str]) -> list[tuple[date, date]]:
    dates = [datetime.strptime(date_s, "%Y%m%d").date() for date_s in date_strings]
    if not dates:
        return []
    ranges: list[tuple[date, date]] = []
    start = prev = dates[0]
    for cur in dates[1:]:
        if cur == prev + timedelta(days=1):
            prev = cur
            continue
        ranges.append((start, prev))
        start = prev = cur
    ranges.append((start, prev))
    return ranges


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms,
        "open": c.open,
        "high": c.high,
        "low": c.low,
        "close": c.close,
        "volume": c.volume,
    }


def _date_from_t_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=_KST).strftime("%Y%m%d")


def _dates_for_candles(candles: list[dict]) -> set[str]:
    return {
        _date_from_t_ms(t_ms)
        for candle in candles
        if isinstance((t_ms := candle.get("t_ms")), int)
    }


def _session_bound_ms(date_s: str, hhmmss: str) -> int:
    return int(
        datetime(
            int(date_s[:4]),
            int(date_s[4:6]),
            int(date_s[6:8]),
            int(hhmmss[:2]),
            int(hhmmss[2:4]),
            int(hhmmss[4:6]),
            tzinfo=_KST,
        ).timestamp() * 1000
    )


def _effective_session(date_s: str, venue: KisVenue) -> dict:
    open_hhmmss, close_hhmmss = session_window_hhmmss(venue)
    return {
        "date": date_s,
        "venue": venue,
        "open_ms": _session_bound_ms(date_s, open_hhmmss),
        "close_ms": _session_bound_ms(date_s, close_hhmmss),
    }


def _effective_sessions_for_candles(candles: list[dict], venue: KisVenue) -> list[dict]:
    return [
        _effective_session(date_s, venue)
        for date_s in sorted(_dates_for_candles(candles))
    ]


def _merge_effective_sessions(
    primary: list[dict],
    fallback: list[dict],
    *,
    fallback_dates: set[str],
) -> list[dict]:
    by_date = {
        str(row["date"]): row
        for row in primary
        if str(row.get("date", "")) not in fallback_dates
    }
    for row in fallback:
        date_s = str(row.get("date", ""))
        if date_s in fallback_dates:
            by_date[date_s] = row
    return [by_date[date_s] for date_s in sorted(by_date)]


def _merge_minute_fallback(
    primary: list[dict],
    fallback: list[dict],
    *,
    fallback_dates: set[str],
) -> list[dict]:
    out = [
        candle
        for candle in primary
        if _date_from_t_ms(candle["t_ms"]) not in fallback_dates
    ]
    out.extend(
        candle
        for candle in fallback
        if _date_from_t_ms(candle["t_ms"]) in fallback_dates
    )
    return sorted(out, key=lambda candle: candle["t_ms"])


def _fallback_blocking_warning_dates(warnings: list[dict]) -> set[str]:
    blocking_reasons = {
        "capacity_overloaded",
        "kis_api_error",
        "kis_rate_limit",
        "rate_limit_aborted",
    }
    return {
        str(warning.get("date", ""))
        for warning in warnings
        if warning.get("reason") in blocking_reasons
    }


def _capacity_overloaded_warning(date_s: str) -> dict:
    return {
        "date": date_s,
        "reason": "capacity_overloaded",
        "msg": "KIS capacity scheduler pending request limit reached",
    }


def _kis_rest_bypassed_warning(date_s: str) -> dict:
    return {
        "date": date_s,
        "reason": "kis_rest_bypassed",
        "msg": "KIS REST bypass is enabled; served cache-only data",
    }


def _minute_fallback_to_krx_warning(primary_venue: KisVenue, dates: list[str]) -> dict:
    label = _format_date_label(dates)
    return {
        "date": label,
        "reason": "minute_fallback_to_krx",
        "msg": (
            f"{primary_venue} minute returned no candles; using KRX minute "
            "candles for this request"
        ),
    }


def _format_date_label(dates: list[str]) -> str:
    if not dates:
        return ""
    if len(dates) == 1:
        return dates[0]
    ranges = _contiguous_date_ranges(dates)
    if len(ranges) == 1:
        return f"{dates[0]}__{dates[-1]}"
    return ",".join(dates)
