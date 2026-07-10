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
        max_fresh_dates_per_collect: int = 12,
    ) -> None:
        self._data_dir = data_dir
        self._cache = cache
        self._scheduler = scheduler
        self._sem = asyncio.Semaphore(concurrency)
        self._rate_limit_cooldown_s = rate_limit_cooldown_s
        # 한 collect 호출이 KIS에서 새로 가져올 수 있는 날짜 수 상한.
        # 기준선을 잃은 프론트가 수백 일 창을 통째로 재요청하면(2026-07-07
        # 실측 최대 243일/25분) foreground로 KIS 예산을 독점해 다른 종목이
        # 굶는다. 초과분은 fetch_budget_exhausted 경고(blocking)로 유예 —
        # 프론트가 박제하지 않으므로 다음 사이클에 이어서 받는다.
        # 불변식: 이 값(12)은 프론트 청크 폭(PAST_CHUNK_CALENDAR_DAYS=15캘린더일
        # ≈ 11거래일)보다 커야 한다 — 그래야 한 청크 요청이 항상 예산 안에서
        # 완결된다. 이 아래로 낮추면 청크가 예산 경고를 받아 60s 주기로만
        # 전진한다(기능은 유지, 속도 저하).
        self._max_fresh_dates_per_collect = max(1, int(max_fresh_dates_per_collect))
        self._inflight: dict[
            tuple[KisVenue, str, str],
            asyncio.Task[list[dict]],
        ] = {}
        self._rate_limit_until = 0.0
        # Fresh KIS past-minute fetches — the true cold re-spend metric (PR-1 (a)):
        # counted at the deduped fetch chokepoint (_fetch_past_scheduled), so it
        # measures KIS quota actually spent, not cache-layer get_past misses (which
        # diverge via inflight dedup + warming). Post-restart this rises steeply;
        # the PR-6 disk-persistence ROI reads directly off it.
        self._fresh_past_fetches = 0
        self._fresh_past_fetch_errors = 0

    def stats_snapshot(self) -> dict[str, object]:
        return {
            "fresh_past_fetches": self._fresh_past_fetches,
            "fresh_past_fetch_errors": self._fresh_past_fetch_errors,
            "inflight": len(self._inflight),
        }

    async def collect_minute(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
    ) -> LiveMinuteCandleBackfillResult:
        return await self._collect_minute_inner(
            code=code, frm=frm, too=too, today_d=today_d, policy=policy,
        )

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

        deferred = 0
        if len(pending) > self._max_fresh_dates_per_collect:
            # 최신 날짜 우선(차트는 우측=최신부터 보인다). 유예분은 blocking
            # 경고 → 비-KRX 폴백의 covered 처리 + 프론트 비박제까지 한 사유로
            # 일관 처리된다.
            overflow = pending[: -self._max_fresh_dates_per_collect]
            pending = pending[-self._max_fresh_dates_per_collect :]
            deferred = len(overflow)
            for date_s in overflow:
                warnings_by_date[date_s] = _fetch_budget_exhausted_warning(date_s)

        blocked = asyncio.Event()

        async def one(date_s: str) -> None:
            async with self._sem:
                if blocked.is_set() or self._rate_limited_now():
                    warnings_by_date[date_s] = self._rate_limit_aborted_warning(date_s)
                    return
                try:
                    bars = await self._fetch_past_shared(venue, code, date_s)
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
                    bars = await kis_access.run_with_capacity(
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
                "days=%d pending_dates=%d deferred_dates=%d cached_dates=%d fresh_dates=%d candles=%d "
                "warnings=%d rate_limited=%s duration_ms=%.1f",
                code,
                venue,
                frm.strftime("%Y%m%d"),
                too.strftime("%Y%m%d"),
                (too - frm).days + 1,
                len(pending),
                deferred,
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
    ) -> list[dict]:
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
        # shield 필수: bare `await task`는 대기자 취소를 _fut_waiter.cancel()로
        # 공유 태스크까지 전파해, 같은 (venue, code, date)를 inflight dedup으로
        # 공유하는 다른 대기자를 전부 CancelledError로 죽인다. 한 사용자 요청이
        # 취소되면(예: 타임프레임 전환 abort) 같은 날짜에 올라탄 다른 /past-candles
        # 요청까지 죽는 회귀가 실제로 있었다(/investigate 2026-07-10).
        return await asyncio.shield(task)

    async def _fetch_past_scheduled(
        self,
        venue: KisVenue,
        code: str,
        date_s: str,
        *,
        priority: kis_access.KisRequestPriority = "user_visible",
    ) -> list[dict]:
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
            self._fresh_past_fetch_errors += 1
            if perf_debug.enabled():
                log.warning(
                    "hoga_perf past_candles_fetch status=error code=%s venue=%s date=%s "
                    "duration_ms=%.1f",
                    code, venue, date_s, perf_debug.elapsed_ms(t0),
                )
            raise
        self._fresh_past_fetches += 1
        if perf_debug.enabled():
            log.warning(
                "hoga_perf past_candles_fetch status=ok code=%s venue=%s date=%s "
                "candles=%d duration_ms=%.1f",
                code,
                venue,
                date_s,
                len(result),
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
    ) -> list[dict]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=foreground,
        )
        bars = [_candle_to_dict(c) for c in raw]
        self._cache.store_past(venue, code, date_s, bars)
        return bars

    async def _fetch_past_today_once(
        self,
        kis: KisClient,
        venue: KisVenue,
        code: str,
        date_s: str,
    ) -> list[dict]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=True,
        )
        return [_candle_to_dict(c) for c in raw]

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
        "fetch_budget_exhausted",
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


def _fetch_budget_exhausted_warning(date_s: str) -> dict:
    return {
        "date": date_s,
        "reason": "fetch_budget_exhausted",
        "msg": "uncached-date fetch budget exhausted for this request; older dates deferred",
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
