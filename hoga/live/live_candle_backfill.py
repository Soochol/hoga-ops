from __future__ import annotations

import asyncio
import logging
import time as monotonic_time
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Protocol

from hoga import perf_debug
from hoga.api import calendar as trading_calendar
from hoga.live import (
    kiwoom_access,
    kiwoom_adjust_factors,
    kiwoom_minute_candles,
    kiwoom_rest_runtime,
)
from hoga.live.data_warnings import make_data_warning
from hoga.live.error_policy import classify_live_error
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded, Priority
from hoga.live.kiwoom_errors import KiwoomRateLimitError, KiwoomRestError
from hoga.live.past_candles_cache import PastCandlesCache
from hoga.live.venue import LiveVenuePolicy, Venue, session_window_hhmmss
from hoga.util.timeenc import KST

# 정본은 hoga.util.timeenc.KST 하나다 — 벤더별로 다른 값이 아니다.
_KST = KST
_WEEKEND_START_WEEKDAY = 5

# 미캐시 날짜 fetch가 이 시간을 넘으면 HOGA_PERF_DEBUG 없이도 WARNING 1줄(ADR-0120).
# 한 스텝(5거래일)의 정상 콜드는 KIS 날짜병렬로 0.3~3.3s(실측 2026-07-20)라, 이 위는
# 예산·쿨다운·유량 이상을 뜻한다. 프론트 스텝이 직렬이라 여기서 새는 초는 팬 지연에
# 그대로 곱해진다 — 회귀를 로그만으로 판별하기 위한 상시 신호.
_SLOW_COLLECT_WARN_MS = 5000.0
log = logging.getLogger(__name__)


class KiwoomRestScheduler(Protocol):
    """PR-G(#1043) 칼 컷오버 — 계정 차원(`endpoint`·`cooldown_scope`)이 사라졌다.

    키움 유량은 TR별이라 고를 계정이 없다(#1015). 버킷 키는 `api_id` 다.
    """

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[], Awaitable],
    ): ...


@dataclass(frozen=True)
class LiveMinuteCandleBackfillResult:
    candles: list[dict]
    cached_dates: list[str]
    fresh_dates: list[str]
    data_warnings: list[dict]
    effective_sessions: list[dict]
    adjust_factors: dict[str, float] = field(default_factory=dict)
    """이 응답의 봉에 **실제로 곱해진** 날짜별 수정계수 (#1229 의 척도를 소비자에게 노출).

    호가 유래 지표(`/api/range` 의 히트맵·매물대·최대벽 등)는 디스크 캡처라 **원주가**
    인데 이 봉은 수정주가다. 같은 price scale 에 그리면 계수 ≠ 1 인 구간이 통째로
    어긋난다(009830 2026-06-12 실측: 캔들 34,662~36,596 vs 히트맵 36,300~39,250,
    비율 0.9430 단일값). 프론트가 지표를 같은 척도로 옮기려면 **이 봉에 쓰인 바로 그
    계수**를 알아야 하고, 그것을 따로 조회하게 하면 두 곳이 각자 다른 기준일의 값을
    쥘 수 있다 — 그래서 봉과 **같은 응답에** 실어 lockstep 으로 움직인다.

    계수를 모르는 날짜는 **키가 없다**. 그런 날짜는 애초에 봉도 안 실리므로
    (`_apply_walk_result` 의 무척도 봉 방출 금지) 소비자 입장에서 규칙이 하나다:
    봉이 없으면 지표도 그리지 않는다.
    """

    def model_dump(self) -> dict:
        return {
            "candles": self.candles,
            "cached_dates": self.cached_dates,
            "fresh_dates": self.fresh_dates,
            "data_warnings": self.data_warnings,
            "effective_sessions": self.effective_sessions,
            "adjust_factors": self.adjust_factors,
        }


class LiveMinuteCandleBackfill:
    """Owns Live Candle Backfill minute cache, scheduling, and warnings."""

    def __init__(
        self,
        *,
        data_dir,
        cache: PastCandlesCache,
        scheduler: KiwoomRestScheduler,
        concurrency: int = 3,
        rate_limit_cooldown_s: float = 10.0,
        max_fresh_dates_per_collect: int = 12,
    ) -> None:
        self._data_dir = data_dir
        self._cache = cache
        self._scheduler = scheduler
        self._sem = asyncio.Semaphore(concurrency)
        self._rate_limit_cooldown_s = rate_limit_cooldown_s
        # 한 collect 호출이 벤더에서 새로 가져올 수 있는 날짜 수 상한 — **1분
        # 기준값**. 실효 예산은 `_fresh_budget_for(tic_scope)` 가 tic_scope 분 수를
        # 곱해 낸다: 예산의 실체는 "collect당 벤더 콜 상한(~5페이지)"인데 페이지
        # 커버리지가 tic_scope 에 비례하므로(#1091), 날짜 단위 상수를 고정하면 넓은
        # 스코프에서 예산이 실제 비용의 1/m 로 조여져 dispatch(10m 거래일)가 경고를
        # 받는다. 스텝·청크와 함께 m 배로 스케일되는 3-상수 불변식의 한 축이다
        # (liveDateTime.ts MAX_BATCH_STEPS_PER_DISPATCH 주석, ADR-0105 개정).
        #
        # 원 목적(그대로 유효): 기준선을 잃은 프론트가 수백 일 창을 통째로
        # 재요청하면(2026-07-07 실측 최대 243일/25분) foreground로 벤더 예산을
        # 독점해 다른 종목이 굶는다. 초과분은 fetch_budget_exhausted 경고(blocking)
        # 로 유예 — 프론트가 박제하지 않으므로 다음 사이클에 이어서 받는다.
        # 불변식: 실효 예산(12m 거래일)은 프론트 실효 청크 폭(15m 캘린더일 ≈ 11m
        # 거래일)보다 커야 한다 — 그래야 한 청크 요청이 항상 예산 안에서 완결된다.
        self._max_fresh_dates_per_collect = max(1, int(max_fresh_dates_per_collect))
        self._inflight: dict[
            tuple[Venue, str, str],
            asyncio.Task[list[dict]],
        ] = {}
        self._rate_limit_until = 0.0
        # 수정계수 테이블 캐시 — 키는 (code, 기준일). 값이 `None` 이면 "그 기준일에
        # 받아 봤는데 실패했다" 가 아니라 **아직 안 받았다**를 뜻하지 않는다: 실패는
        # 캐시하지 않고 다음 collect 가 다시 시도한다(수정계수를 못 얻으면 그 날짜
        # 봉을 아예 내보내지 않으므로, 실패를 박제하면 종목이 기준일 내내 막힌다).
        #
        # 기준일이 바뀌면(자정) 옛 항목은 자연히 미스가 되므로 별도 만료가 없다.
        # 종목당 float 600개라 남아 있어도 무해하지만, `/live` 가 종목을 계속 갈면
        # 무한 증식하므로 기준일이 바뀔 때 통째로 비운다.
        self._factors: dict[tuple[str, str], kiwoom_adjust_factors.AdjustFactors] = {}
        self._factors_as_of: str | None = None
        # 기준일이 넘어갈 때 옆으로 옮겨 둔 어제 테이블. 새 테이블과 대조해 밤사이
        # 척도가 바뀐 종목의 봉 캐시를 버리는 데만 쓴다(`_drop_cached_bars_if_rescaled`).
        self._stale_factors: dict[str, kiwoom_adjust_factors.AdjustFactors] = {}
        # Fresh KIS past-minute fetches — the true cold re-spend metric (PR-1 (a)):
        # counted at the deduped fetch chokepoint (_fetch_past_scheduled), so it
        # measures KIS quota actually spent, not cache-layer get_past misses (which
        # diverge via inflight dedup + warming). Post-restart this rises steeply;
        # the PR-6 disk-persistence ROI reads directly off it.
        self._fresh_past_fetches = 0
        self._fresh_past_fetch_errors = 0

    def _fresh_budget_for(self, tic_scope: str) -> int:
        """collect당 신선-날짜 예산 = 1분 기준값 × tic_scope 분.

        예산의 실체는 벤더 **콜** 상한이다: 페이지가 tic_scope 에 비례해 넓어지므로
        (900행 ≈ 2.35×m 거래일) 날짜 수를 m 배로 늘려야 콜 수 상한(~5페이지)이
        유지된다. tic_scope 는 `BUCKET_MS_TO_TIC_SCOPE` 산출값이라 항상 숫자
        문자열이지만, 방어적으로 파싱 실패 시 1분 예산으로 떨어진다(조여질지언정
        넓어지지는 않는 방향)."""
        try:
            scope_minutes = max(1, int(tic_scope))
        except ValueError:
            scope_minutes = 1
        return self._max_fresh_dates_per_collect * scope_minutes

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
        tic_scope: str = kiwoom_minute_candles.TIC_SCOPE_1MIN,
    ) -> LiveMinuteCandleBackfillResult:
        """`tic_scope` 는 **과거 날짜에만** 적용된다.

        오늘분은 언제나 1분으로 받는다 — 실시간 tail(WS 체결틱 1분 합성,
        ADR-0125)과 같은 격자여야 병합이 성립하기 때문이다. 표시 버킷으로 접는
        일은 프론트 `aggregateCandles` 가 하고, 그 집계는 이미 버킷된 과거분에
        대해 멱등이라 두 해상도가 한 시리즈에 섞여도 결과가 같다.
        """
        return await self._collect_minute_inner(
            code=code, frm=frm, too=too, today_d=today_d, policy=policy,
            tic_scope=tic_scope,
        )

    async def _collect_minute_inner(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
        tic_scope: str,
    ) -> LiveMinuteCandleBackfillResult:
        if policy != "KRX":
            primary_out = await self._collect_for_venue(
                policy,
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
                tic_scope=tic_scope,
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
                        tic_scope=tic_scope,
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
                    adjust_factors=primary_out.adjust_factors,
                )
            used_fallback_dates = _dates_for_candles(fallback_candles)
            for date_s in used_fallback_dates:
                self._cache.delete_past(policy, code, date_s, tic_scope)
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
                # 계수는 **종목의 성질**이라 venue 로 갈리지 않는다(법인 이벤트는
                # 거래소별로 다르지 않다). 그래서 병합은 합집합이면 충분하고, 겹치는
                # 날짜는 두 값이 같다 — primary 를 나중에 얹어 그 사실을 명시한다.
                adjust_factors={
                    **{
                        date_s: factor
                        for fallback_out in fallback_outs
                        for date_s, factor in fallback_out.adjust_factors.items()
                    },
                    **primary_out.adjust_factors,
                },
            )
        return await self._collect_for_venue(
            policy,
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
            tic_scope=tic_scope,
        )

    async def collect_minute_cache_only(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
        tic_scope: str = kiwoom_minute_candles.TIC_SCOPE_1MIN,
    ) -> LiveMinuteCandleBackfillResult:
        t0 = perf_debug.now()
        rows: list[dict] = []
        cached_dates: list[str] = []
        warnings: list[dict] = []
        effective_session_venues: dict[str, Venue] = {}
        today_s = today_d.strftime("%Y%m%d")

        for date_s in _date_iter(frm, too):
            if date_s < today_s:
                bars = self._cache.get_past(policy, code, date_s, tic_scope)
                session_venue = policy
                if bars is None and policy != "KRX":
                    bars = self._cache.get_past("KRX", code, date_s, tic_scope)
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
        # 이 경로는 계수를 **조회하지 않는다**(rest_bypass 의 요점이 벤더 콜 0 이다).
        # 대신 메모리에 남아 있으면 그것을 쓴다 — 캐시된 봉과 이 테이블은 같은 척도임이
        # 보장된다: 척도가 바뀌는 유일한 경로가 `_ensure_factors` 이고 거기서
        # `_drop_cached_bars_if_rescaled` 가 옛 척도 봉을 버리기 때문이다. 테이블이
        # 없으면(프로세스 기동 후 이 종목을 한 번도 안 받았다) 빈 dict 이고, 프론트는
        # 환산 없이 **지금과 같은 화면**으로 degrade 한다.
        cached_factors = self._factors.get((code, today_s))
        result = LiveMinuteCandleBackfillResult(
            candles=rows,
            cached_dates=cached_dates,
            fresh_dates=[],
            data_warnings=warnings,
            effective_sessions=[
                _effective_session(date_s, venue)
                for date_s, venue in sorted(effective_session_venues.items())
            ],
            adjust_factors=_factors_for_candles(rows, cached_factors),
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

    async def _collect_for_venue(  # noqa: PLR0912, PLR0915
        self,
        venue: Venue,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        tic_scope: str,
    ) -> LiveMinuteCandleBackfillResult:
        t0 = perf_debug.now()
        today_s = today_d.strftime("%Y%m%d")
        rows: dict[str, list[dict]] = {}
        cached_dates: list[str] = []
        pending: list[str] = []
        warnings_by_date: dict[str, dict] = {}
        fresh: set[str] = set()

        # **캐시를 읽기 전에 수정계수를 세운다**(#1229). 기준일이 넘어가면서 척도가
        # 바뀐 종목은 여기서 옛 봉 캐시가 폐기되는데, 그보다 먼저 캐시를 읽으면
        # 그 응답 하나가 옛 척도와 새 척도를 섞어 나간다. 계수는 (종목, 기준일)
        # 캐시라 이 앞당김이 무는 비용은 종목당 하루 2콜이 전부다.
        factors, factor_failure, factor_blocked = await self._factors_or_failure(
            code, as_of=today_s,
        )

        for date_s in _date_iter(frm, too):
            if date_s >= today_s:
                continue
            bars = self._cache.get_past(venue, code, date_s, tic_scope)
            if bars is not None:
                rows[date_s] = bars
                cached_dates.append(date_s)
                continue
            if trading_calendar.is_trading_day(date_s) is False:
                empty_bars: list[dict] = []
                self._cache.store_past(venue, code, date_s, empty_bars, tic_scope)
                rows[date_s] = empty_bars
                cached_dates.append(date_s)
                continue
            pending.append(date_s)

        deferred = 0
        fresh_budget = self._fresh_budget_for(tic_scope)
        if len(pending) > fresh_budget:
            # 최신 날짜 우선(차트는 우측=최신부터 보인다). 유예분은 blocking
            # 경고 → 비-KRX 폴백의 covered 처리 + 프론트 비박제까지 한 사유로
            # 일관 처리된다.
            overflow = pending[:-fresh_budget]
            pending = pending[-fresh_budget:]
            deferred = len(overflow)
            for date_s in overflow:
                warnings_by_date[date_s] = _fetch_budget_exhausted_warning(date_s)

        # PR-G(#1043) 칼 컷오버 — **팬이 walk-back 으로 바뀐다**(ADR-0136 §3).
        #
        # KIS 분봉은 날짜당 1콜(120행)이라 날짜 N개를 asyncio.gather 로 병렬
        # 부채질하는 것이 최적이었다. 키움은 1콜이 900행 ≈ 2.35 거래일이라 같은
        # 팬을 쓰면 이웃 콜끼리 같은 날짜를 중복 수신한다 — 콜당 효율이 그대로
        # 낭비가 된다. 순차 walk 로 콜 수가 절반 이하로 떨어진다(#1012 실측:
        # 20거래일 10콜 2.8초, ADR-0120 시절 46거래일 98초).
        blocked = False
        if pending and factors is not None:
            blocked = await self._walk_pending(
                venue, code, pending, rows=rows, fresh=fresh,
                warnings_by_date=warnings_by_date, tic_scope=tic_scope,
                factors=factors,
            )
        elif pending and factor_failure is not None:
            # 계수를 못 얻었으면 walk 를 아예 돌리지 않는다 — 받아 봐야 척도가
            # 없어 저장도 표시도 못 한다. 캐시분은 그대로 낸다(자기들끼리는 한
            # 척도라 일관적이고, 계수 실패는 척도가 바뀌었다는 증거도 아니다).
            for date_s in pending:
                warnings_by_date[date_s] = factor_failure(date_s)
            blocked = factor_blocked

        candles_all: list[dict] = []
        fresh_dates: list[str] = []
        warnings: list[dict] = []
        kis_blocked = blocked

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
                    today_client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
                    if today_client is None:
                        warnings.append(self._rate_limit_aborted_warning(date_s))
                        continue
                    bars = await kiwoom_access.run_with_capacity(
                        self._scheduler,
                        key=("live-candle-backfill", "minute", venue, code, date_s, "today"),
                        api_id=kiwoom_minute_candles.API_ID,
                        priority="user_visible",
                        client=today_client,
                        fetch_fn=lambda c: self._fetch_past_today_once(
                            c,
                            venue,
                            code,
                            date_s,  # noqa: B023 — await 로 즉시 소비 — 지연 실행 아님
                        ),
                    )
                    if bars:
                        self._cache.store_today(venue, code, bars)
                        fresh_dates.append(date_s)
                    else:
                        self._cache.store_today(venue, code, None)
                candles_all.extend(bars)
            except KiwoomRateLimitError as e:
                warnings.append(
                    make_data_warning("rate_limit_upstream", str(e), date=date_s),
                )
                self._mark_rate_limited()
                kis_blocked = True
            except KiwoomCapacityOverloaded as e:
                warnings.append(_rest_error_warning(date_s, e))
            except KiwoomRestError as e:
                warnings.append(_rest_error_warning(date_s, e))

        result = LiveMinuteCandleBackfillResult(
            candles=candles_all,
            cached_dates=cached_dates,
            fresh_dates=fresh_dates,
            data_warnings=warnings,
            effective_sessions=_effective_sessions_for_candles(candles_all, venue),
            adjust_factors=_factors_for_candles(candles_all, factors),
        )
        elapsed_ms = perf_debug.elapsed_ms(t0)
        # 상시 느림 신호(ADR-0120): perf_debug 게이트 밖에서도 임계 초과는 한 줄 남긴다.
        # 팬 스텝은 프론트에서 직렬이라 여기서 새는 초가 체감 지연에 그대로 곱해지는데,
        # 기존 로그가 HOGA_PERF_DEBUG 전용이라 키움 프리페치 회귀(스텝당 11~29s)가
        # 나흘간 로그에 흔적을 안 남겼다.
        if elapsed_ms >= _SLOW_COLLECT_WARN_MS:
            log.warning(
                "live.past_candles.slow_collect code=%s venue=%s from=%s to=%s "
                "pending_dates=%d deferred_dates=%d fresh_dates=%d rate_limited=%s "
                "duration_ms=%.0f",
                code,
                venue,
                frm.strftime("%Y%m%d"),
                too.strftime("%Y%m%d"),
                len(pending),
                deferred,
                len(result.fresh_dates),
                kis_blocked,
                elapsed_ms,
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
                elapsed_ms,
            )
        return result

    async def _walk_pending(
        self,
        venue: Venue,
        code: str,
        pending: list[str],
        *,
        rows: dict[str, list[dict]],
        fresh: set[str],
        warnings_by_date: dict[str, dict],
        tic_scope: str,
        factors: kiwoom_adjust_factors.AdjustFactors,
    ) -> bool:
        """미캐시 날짜들을 **한 번의 walk-back** 으로 채운다. 유량 차단이면 True.

        `pending` 은 오름차순이다. walk 는 최신(`pending[-1]`)에서 시작해 가장
        오래된 날(`pending[0]`)보다 더 오래된 날짜를 볼 때까지 커서를 뒤로 민다.

        `factors` 는 호출자가 **캐시를 읽기 전에** 세운 것이다(#1229) — 이유는
        `_collect_for_venue` 의 그 자리 주석에 있다.
        """
        newest, oldest = pending[-1], pending[0]
        if self._rate_limited_now():
            for date_s in pending:
                warnings_by_date[date_s] = self._rate_limit_aborted_warning(date_s)
            return True

        t0 = perf_debug.now()
        try:
            result = await self._walk_scheduled(venue, code, newest, oldest, tic_scope)
        except KiwoomCapacityOverloaded as e:
            for date_s in pending:
                warnings_by_date[date_s] = _rest_error_warning(date_s, e)
            return False
        except KiwoomRateLimitError as e:
            self._mark_rate_limited()
            for date_s in pending:
                warnings_by_date[date_s] = make_data_warning(
                    "rate_limit_upstream", str(e), date=date_s,
                )
            return True
        except KiwoomRestError as e:
            for date_s in pending:
                warnings_by_date[date_s] = _rest_error_warning(date_s, e)
            return False
        self._fresh_past_fetches += 1
        if perf_debug.enabled():
            log.warning(
                "hoga_perf past_candles_walk code=%s venue=%s from=%s to=%s "
                "pages=%d days=%d exhausted=%s wedged=%s duration_ms=%.1f",
                code, venue, oldest, newest, result.pages,
                len(result.bars_by_date), result.exhausted, result.wedged,
                perf_debug.elapsed_ms(t0),
            )

        self._apply_walk_result(
            venue, code, pending, result,
            rows=rows, fresh=fresh, warnings_by_date=warnings_by_date,
            tic_scope=tic_scope, factors=factors,
        )
        return False

    async def _factors_or_failure(self, code: str, *, as_of: str) -> tuple[
        kiwoom_adjust_factors.AdjustFactors | None,
        Callable[[str], dict] | None,
        bool,
    ]:
        """`(계수, 실패시 경고 팩토리, 유량차단)`. 실패 분류는 walk 와 같은 표다.

        분류를 walk 와 맞추는 이유: 프론트는 사유 문자열로 박제 여부를 가르므로
        (`_FALLBACK_BLOCKING_REASONS`), 같은 원인이 어느 콜에서 났느냐에 따라 다른
        사유가 나가면 폴백·재시도 정책이 갈린다.
        """
        if self._rate_limited_now():
            return None, self._rate_limit_aborted_warning, True
        try:
            return await self._ensure_factors(code, as_of=as_of), None, False
        except KiwoomCapacityOverloaded as e:
            # 바로 아래 `rate_msg` 와 같은 이유로 로컬에 묶는다 — `except ... as e` 는
            # 블록 끝에서 이름을 지우므로 클로저가 `e` 를 그대로 참조하면 호출 시점에
            # NameError 다.
            capacity_exc = e
            return None, lambda date_s: _rest_error_warning(date_s, capacity_exc), False
        except KiwoomRateLimitError as e:
            self._mark_rate_limited()
            # **`except ... as e` 는 블록 끝에서 이름을 지운다** — 클로저가 그대로
            # 참조하면 호출 시점에 NameError 다. 로컬에 다시 묶어서 가둔다.
            rate_msg = str(e)
            return None, lambda date_s: make_data_warning(
                "rate_limit_upstream", rate_msg, date=date_s,
            ), True
        except KiwoomRestError as e:
            rest_exc = e
            return None, lambda date_s: _rest_error_warning(date_s, rest_exc), False

    async def _ensure_factors(
        self, code: str, *, as_of: str
    ) -> kiwoom_adjust_factors.AdjustFactors:
        """(종목, 기준일) 수정계수 테이블. 캐시 히트면 벤더 콜 0.

        기준일이 넘어가면 테이블 전체를 버린다 — 어제 앵커로 만든 계수를 오늘
        봉에 곱하면 오늘 효력인 수정 이벤트가 빠진 채 굳는다.
        """
        if self._factors_as_of != as_of:
            # 어제 테이블은 지우지 않고 **옆으로 옮긴다** — 새 테이블과 대조해
            # 밤사이 척도가 바뀌었는지 봐야 하기 때문이다(아래 `_drop_if_rescaled`).
            self._stale_factors = {c: f for (c, _), f in self._factors.items()}
            self._factors = {}
            self._factors_as_of = as_of
        cached = self._factors.get((code, as_of))
        if cached is not None:
            return cached

        client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
        if client is None:
            raise KiwoomRestError("kiwoom client not initialized")

        async def _paced_call(upd: str, fetch_fn):
            return await kiwoom_access.run_with_capacity(
                self._scheduler,
                # 키에 기준일이 있어야 자정을 넘긴 두 요청이 조인되지 않고, `upd` 가
                # 있어야 수정·원 두 콜이 서로 조인되지 않는다(`CallRunner` 주석).
                key=("live-candle-backfill", "adjust-factors", code, as_of, upd),
                api_id=kiwoom_adjust_factors.API_ID,
                priority="user_visible",
                client=client,
                fetch_fn=fetch_fn,
            )

        factors = await kiwoom_adjust_factors.fetch_adjust_factors(
            client, code, as_of_yyyymmdd=as_of, run_call=_paced_call,
        )
        self._factors[(code, as_of)] = factors
        self._drop_cached_bars_if_rescaled(code, factors)
        return factors

    def _drop_cached_bars_if_rescaled(
        self, code: str, factors: kiwoom_adjust_factors.AdjustFactors
    ) -> None:
        """밤사이 척도가 바뀌었으면 그 종목의 과거 봉 캐시를 버린다.

        캐시에 담긴 봉은 **계수가 이미 곱해진 표시값**이다. 액면분할이 효력을
        얻으면 어제 담긴 항목만 옛 척도로 남아 같은 차트에 두 척도가 섞인다 —
        이 PR 이 없애려던 바로 그 상태다.

        섞임을 만드는 유일한 경로가 **새 fetch** 이고 모든 fetch 가 이 함수를
        지나므로, 여기서 끊으면 섞임이 원천적으로 생기지 않는다. 아무것도 새로
        안 받는 동안은 캐시가 전부 어제 척도라 자체 일관적이다.

        **일봉(#1231 `PastDailyCandlesCache.clear_batches`)은 날짜가 넘어가면
        조건 없이 전부 버린다 — 분봉은 그럴 수 없다.** 저쪽은 배치 단위라 척도가
        바뀌었는지 싸게 알 방법이 없고 재획득이 코드당 깊은 walk 한 번이다.
        여기는 ① 계수 테이블을 어차피 받으므로 대조가 공짜이고 ② 캐시가 종목당
        최대 320일치 1분봉(ADR-0090 read-ahead)이라 매일 통째로 버리면 그
        read-ahead 투자를 아침마다 되산다. 축이 달라서 처방이 다른 것이지
        한쪽이 덜 엄격한 것이 아니다.
        """
        previous = self._stale_factors.pop(code, None)
        if previous is None:
            return
        for date_s in previous.dates:
            if previous.factor_for(date_s) != factors.factor_for(date_s):
                dropped = self._cache.drop_past_code(code)
                log.warning(
                    "adjust factor changed code=%s %s→%s — 과거 봉 캐시 %d슬롯 폐기",
                    code, previous.as_of, factors.as_of, dropped,
                )
                return

    def _apply_walk_result(
        self,
        venue: Venue,
        code: str,
        pending: list[str],
        result,
        *,
        rows: dict[str, list[dict]],
        fresh: set[str],
        warnings_by_date: dict[str, dict],
        tic_scope: str,
        factors: kiwoom_adjust_factors.AdjustFactors,
    ) -> None:
        """walk 결과를 캐시·행·경고로 흩뿌린다.

        **여기서 수정계수를 곱한다**(#1229). walk 는 원주가를 주므로 `store_past`
        직전이 척도가 정해지는 유일한 지점이다 — 저장 후에 곱하면 `rest_bypass`
        경로(`collect_minute_cache_only`)가 벤더 콜 없이 캐시만 읽어서 계수를
        만들 수 없다. **저장값이 곧 표시값**이라는 것이 이 캐시의 계약이다.

        계수를 모르는 날짜(테이블 밖)는 **저장하지도 응답에 싣지도 않는다**.
        무척도 봉을 흘려보내면 화면에 정상처럼 보이는 절벽이 남는다.

        `bars_by_date` 에는 요청 창보다 오래된 **수확분**(순회분 전량 적재)이 섞여
        있다. 전부 캐시에 넣되 응답(`rows`/`fresh`)은 `pending` 루프가 만들므로
        수확분이 응답에 새지 않는다 — 다음 팬 청크가 그 날짜들을 캐시 히트로 얻는다.

        **walk 가 깨끗이 끝났으면** `[oldest, newest]` 를 전부 지나왔다는 뜻이라,
        응답에 없는 날짜는 비거래일이다 — 빈 배열로 캐시해 재요청을 막는다.
        **중간에 멈췄으면**(보유 바닥·페이지 상한) 도달한 곳 아래는 **모른다**.
        그 구간을 "데이터 없음" 으로 흘려보내면 프론트가 빈 캔들을 진실로 그린다.
        수확분 덕에 non-clean `floor`(= 도달 증명선)가 실제 도달점까지 내려가므로
        판정은 종전보다 덜 보수적이면서 여전히 안전하다 — floor 보다 새로운 pending
        누락일은 "지나왔는데 없음" = 비거래일이 맞다.
        """
        scaled: dict[str, list] = {}
        unscalable: list[str] = []
        for date_s, bars in result.bars_by_date.items():
            factor = factors.factor_for(date_s)
            if factor is None:
                unscalable.append(date_s)
                continue
            scaled[date_s] = kiwoom_adjust_factors.scale_bars(bars, factor)
        if unscalable:
            log.warning(
                "adjust factor missing code=%s as_of=%s dates=%d oldest=%s "
                "(일봉 테이블이 분봉 보유를 못 덮는다)",
                code, factors.as_of, len(unscalable), min(unscalable),
            )

        for date_s, bars in scaled.items():
            self._cache.store_past(
                venue, code, date_s, [_candle_to_dict(c) for c in bars], tic_scope
            )

        clean = not (result.exhausted or result.wedged)
        floor = pending[0] if clean else min(result.bars_by_date, default=None)
        msg = (
            "kiwoom minute retention floor" if result.wedged
            else f"walk exhausted after {result.pages} pages"
        )
        unscalable_set = set(unscalable)
        for date_s in pending:
            bars = scaled.get(date_s)
            if bars is None and date_s in unscalable_set:
                # 계수를 모르는 날짜는 "비거래일이라 비었다" 로 접히면 안 된다 —
                # 아래 `floor` 분기가 빈 배열을 진실로 캐시해 버린다.
                warnings_by_date[date_s] = make_data_warning(
                    "api_error",
                    f"adjust factor unavailable (as_of={factors.as_of})",
                    date=date_s,
                )
            elif bars is not None:
                rows[date_s] = [_candle_to_dict(c) for c in bars]
                fresh.add(date_s)
            elif floor is not None and date_s >= floor:
                empty: list[dict] = []
                self._cache.store_past(venue, code, date_s, empty, tic_scope)
                rows[date_s] = empty
                fresh.add(date_s)
            else:
                warnings_by_date[date_s] = make_data_warning(
                    "api_error", msg, date=date_s,
                )

    async def _walk_scheduled(
        self,
        venue: Venue,
        code: str,
        newest: str,
        oldest: str,
        tic_scope: str = kiwoom_minute_candles.TIC_SCOPE_1MIN,
        *,
        priority: Priority = "user_visible",
    ):
        client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
        if client is None:
            raise KiwoomRestError("kiwoom client not initialized")

        async def _paced_page(cursor: str):
            """walk 의 페이지 1장 = 거버너 submit 1건.

            **walk 전체를 감싸면 안 된다.** 거버너는 submit 진입 전에 버킷을 한 번만
            소비하므로, 바깥에서 감싸면 안쪽 최대 40콜이 페이싱 없이 나가 `1700
            유량=5` 를 맞는다(2026-08-04 실측). 이중으로 감싸는 것도 금지다 — 바깥
            submit 이 `ka10080` 버킷 토큰을 쥔 채 안쪽 submit 이 같은 버킷을 기다려
            자기 자신을 굶긴다.

            key 가 구간이 아니라 **커서** 단위인 것은 부수 이득이다: 겹치는 구간을
            보는 두 요청이 공통 페이지에서 조인된다.

            **`tic_scope` 가 key 에 있어야 한다.** 같은 커서라도 스코프가 다르면
            다른 봉인데, key 에서 빠지면 그 조인이 1분 요청과 10분 요청을 하나로
            묶어 **먼저 온 쪽의 해상도를 양쪽에 준다**. 조인은 여기서 이득이 아니라
            오염이다.
            """
            return await kiwoom_access.run_with_capacity(
                self._scheduler,
                key=(
                    "live-candle-backfill", "minute-page",
                    venue, code, cursor, tic_scope,
                ),
                api_id=kiwoom_minute_candles.API_ID,
                priority=priority,
                client=client,
                fetch_fn=lambda c: kiwoom_minute_candles.fetch_minute_page(
                    c, code, cursor, venue=venue, tic_scope=tic_scope,
                ),
            )

        try:
            return await kiwoom_minute_candles.walk_minute_days(
                client, code,
                newest_yyyymmdd=newest, oldest_yyyymmdd=oldest, venue=venue,
                # `fetch_page` 주입이 실제 스코프를 쥐므로 아래 인자는 지금 경로에서
                # 쓰이지 않는다. 그래도 넘긴다 — 주입을 걷어내는 변경이 오면 조용히
                # 1분으로 돌아가는 대신 의도한 스코프가 남는다.
                tic_scope=tic_scope,
                fetch_page=_paced_page,
            )
        except Exception:
            self._fresh_past_fetch_errors += 1
            raise

    async def _fetch_past_today_once(
        self,
        client,
        venue: Venue,
        code: str,
        date_s: str,
    ) -> list[dict]:
        """오늘치. `base_dt=오늘` 이면 오늘이 응답의 **최新** 이라 온전하다.

        **`tic_scope` 를 받지 않는다 — 오늘은 언제나 1분이다.** 오늘분은 WS 체결틱
        1분 합성 tail(ADR-0125)과 같은 시리즈에서 병합되므로 격자가 1분이어야 한다.
        표시 버킷 집계는 프론트 `aggregateCandles` 가 과거분과 함께 처리한다.
        """
        raw = await kiwoom_minute_candles.fetch_day(
            client, code, date_s, venue=venue,
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
        return make_data_warning(
            "rate_limit_aborted", "rate limit cooldown active", date=date_s,
        )


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


def _effective_session(date_s: str, venue: Venue) -> dict:
    open_hhmmss, close_hhmmss = session_window_hhmmss(venue)
    return {
        "date": date_s,
        "venue": venue,
        "open_ms": _session_bound_ms(date_s, open_hhmmss),
        "close_ms": _session_bound_ms(date_s, close_hhmmss),
    }


def _effective_sessions_for_candles(candles: list[dict], venue: Venue) -> list[dict]:
    return [
        _effective_session(date_s, venue)
        for date_s in sorted(_dates_for_candles(candles))
    ]


def _factors_for_candles(
    candles: list[dict],
    factors: kiwoom_adjust_factors.AdjustFactors | None,
) -> dict[str, float]:
    """실린 봉의 날짜별 수정계수. 테이블 밖 날짜는 **키가 없다**(모른다 ≠ 1.0).

    `factors` 가 `None` 인 경우(계수 조회 실패)는 빈 dict 다 — 그때는 과거 봉 자체가
    안 실리므로(`_apply_walk_result`) 소비자가 볼 것도 없다. **오늘분은 예외로
    실린다**: 오늘은 정의상 계수 1.0 이고 테이블의 `as_of` 쪽 끝도 1.0 이라 값이
    같지만, 계수 테이블은 `as_of` 까지만 덮으므로 오늘이 비거래일 취급이면
    `factor_for` 가 `None` 을 줄 수 있다. 그 경우 키가 빠지고, 오늘 지표는 어차피
    실시간 원주가라 환산 대상이 아니므로 결과가 같다.
    """
    if factors is None:
        return {}
    out: dict[str, float] = {}
    for date_s in sorted(_dates_for_candles(candles)):
        factor = factors.factor_for(date_s)
        if factor is not None:
            out[date_s] = factor
    return out


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


def _rest_error_warning(date_s: str, exc: BaseException) -> dict:
    """벤더·거버너 실패를 와이어 경고로. **사유는 `error_policy` 가 정한다.**

    타입이 `BaseException` 인 것은 의도다 — 정책 테이블이 분류할 수 있는 예외면
    무엇이든 지난다. 예전엔 `KiwoomRestError` 로 좁혀 있어서 거버너 큐 포화
    (`KiwoomCapacityOverloaded`, `RuntimeError` 상속)가 **별도 생성기를 따로 갖고
    있었고**, 그래서 같은 사유의 `msg` 가 두 벌로 갈렸다(ADR-0143).

    이전 판은 전부 `api_error` 한 단어로 접었다. 그래서 프론트가 진짜 전송 실패를
    가려내려고 `msg` 에서 `'TRANSPORT/'` 문자열을 뒤져야 했다 — 벤더 거절과 네트워크
    끊김은 처방이 다른데(전자는 대기, 후자는 회선 점검) 같은 얼굴이었다(ADR-0137).

    `kind`·`is_failure` 는 `make_data_warning` 이 붙인다(ADR-0143). 여기서
    `policy.kind` 를 직접 넘기지 않는 이유: 정책 밖 생성기와 **같은 표**를 지나야
    두 경로가 갈리지 않는다. 일치 여부는 `test_data_warnings` 가 대조한다.
    """
    policy = classify_live_error(exc)
    return make_data_warning(policy.reason, policy.message, date=date_s)


# 폴백(NXT/UN → KRX)을 막는 사유들. **표시 계약과 같은 문자열을 공유하므로 사유를
# 세분화할 때 반드시 함께 넓힌다** — `api_error` 하나가 전송·인증·배치상한을 모두
# 덮고 있었기 때문에, 세분화만 하고 여기를 놔두면 폴백이 조용히 켜진다(막아야 할
# 날짜가 '안 막힌 날짜' 로 분류되어 KRX 재조회가 돈다).
_FALLBACK_BLOCKING_REASONS = frozenset({
    "capacity_overloaded",
    "fetch_budget_exhausted",
    "api_error",
    "rate_limit_upstream",
    "rate_limit_aborted",
    # `_rest_error_warning` 이 내는 세분화 사유들(error_policy).
    "transport_error",
    "auth_error",
    "batch_limit_exceeded",
    "unexpected_error",
})


def _fallback_blocking_warning_dates(warnings: list[dict]) -> set[str]:
    blocking_reasons = _FALLBACK_BLOCKING_REASONS
    return {
        str(warning.get("date", ""))
        for warning in warnings
        if warning.get("reason") in blocking_reasons
    }


def _fetch_budget_exhausted_warning(date_s: str) -> dict:
    return make_data_warning(
        "fetch_budget_exhausted",
        "uncached-date fetch budget exhausted for this request; older dates deferred",
        date=date_s,
    )


def _kis_rest_bypassed_warning(date_s: str) -> dict:
    return make_data_warning(
        "rest_bypassed", "REST bypass is enabled; served cache-only data", date=date_s,
    )


def _minute_fallback_to_krx_warning(primary_venue: Venue, dates: list[str]) -> dict:
    return make_data_warning(
        "minute_fallback_to_krx",
        f"{primary_venue} minute returned no candles; using KRX minute "
        "candles for this request",
        date=_format_date_label(dates),
    )


def _format_date_label(dates: list[str]) -> str:
    if not dates:
        return ""
    if len(dates) == 1:
        return dates[0]
    ranges = _contiguous_date_ranges(dates)
    if len(ranges) == 1:
        return f"{dates[0]}__{dates[-1]}"
    return ",".join(dates)
