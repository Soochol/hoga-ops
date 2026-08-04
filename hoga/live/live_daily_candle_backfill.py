from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from datetime import date, datetime, timedelta
from typing import Protocol

from hoga.live import kiwoom_access, kiwoom_daily_candles, kiwoom_rest_runtime
from hoga.live.kis_client import KisRateLimitError
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded, Priority
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache
from hoga.live.single_flight import SingleFlight
from hoga.live.venue import LiveVenuePolicy, Venue, daily_venue_for_policy
from hoga.util.timeenc import KST

# 정본은 hoga.util.timeenc.KST 하나다 — 벤더별로 다른 값이 아니다.
_KST = KST


class KiwoomRestScheduler(Protocol):
    """PR-F(#1042) 칼 컷오버 — 계정 차원(`endpoint`·`cooldown_scope`)이 사라졌다.

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


Walkback = Callable[
    ...,
    Awaitable[dict],
]


class LiveDailyCandleBackfill:
    """Owns Live Candle Backfill daily venue fallback and warning policy."""

    def __init__(
        self,
        *,
        data_dir,
        cache: PastDailyCandlesCache,
        scheduler: KiwoomRestScheduler,
        walkback: Walkback,
    ) -> None:
        self._data_dir = data_dir
        self._cache = cache
        self._scheduler = scheduler
        self._walkback = walkback
        # Coalesce concurrent same-(venue, code) cold walk-backs (see
        # single_flight.py): overlapping [from, today] requests share one KIS
        # fetch instead of each walking the same daily history independently.
        self._inflight = SingleFlight()

    async def collect_daily(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
        from_label: str,
        to_label: str,
    ) -> dict:
        venue = daily_venue_for_policy(policy)
        fallback_warnings: list[dict] = []

        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await self._fetch_primary_batch(
                venue=venue,
                code=code_,
                from_s=from_s,
                to_s=to_s,
            )
            if venue != "KRX" and not result.violations and _needs_krx_daily_fill(
                result.candles,
                from_s,
                to_s,
            ):
                fallback = await self._fetch_krx_fallback_batch(
                    code=code_,
                    from_s=from_s,
                    to_s=to_s,
                )
                if fallback.candles:
                    batch = f"{from_s}__{to_s}"
                    if result.candles:
                        fallback_warnings.append(
                            _daily_partial_fallback_to_krx_warning(venue, batch)
                        )
                        result = type(result)(
                            candles=_merge_daily_fallback(result.candles, fallback.candles),
                            violations=result.violations,
                        )
                    else:
                        fallback_warnings.append(
                            _daily_fallback_to_krx_warning(venue, batch)
                        )
                        result = fallback
            return [_candle_to_dict(c) for c in result.candles], result.violations

        async with self._inflight.acquire((venue, code)):
            out = await self._walkback(
                cache=_VenueDailyCacheAdapter(self._cache, venue),  # type: ignore[arg-type]
                fetch_batch=fetch_batch,
                output_key="candles",
                code=code,
                frm=frm,
                too=too,
                today_d=today_d,
            )
        out["venue"] = policy
        out["data_warnings"].extend(fallback_warnings)
        return out

    async def collect_daily_cache_only(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
        from_label: str,
        to_label: str,
    ) -> dict:
        venue = daily_venue_for_policy(policy)
        loaded: list[dict] = []
        cached_batches: list[str] = []
        covered: list[tuple[date, date]] = []
        warnings: list[dict] = []

        for batch_from, batch_to, rows in self._cache.list_batches(venue, code):
            if batch_to < frm or batch_from > too:
                continue
            covered.append((batch_from, batch_to))
            loaded.extend(rows)
            cached_batches.append(
                f"{batch_from.strftime('%Y%m%d')}__{batch_to.strftime('%Y%m%d')}"
            )

        if too >= today_d:
            today_s = today_d.strftime("%Y%m%d")
            state, today_row = self._cache.get_today(venue, code)
            if state == "hit":
                loaded.append(today_row)  # type: ignore[arg-type]
                covered.append((today_d, today_d))
                cached_batches.append(f"{today_s}__{today_s}")
            elif state == "negative":
                covered.append((today_d, today_d))

        for gap_from, gap_to in _compute_gaps(frm, too, covered):
            gap_from_s = gap_from.strftime("%Y%m%d")
            gap_to_s = gap_to.strftime("%Y%m%d")
            warnings.append(_kis_rest_bypassed_warning(f"{gap_from_s}__{gap_to_s}"))

        rows_out = _dedupe_filter_sort(loaded, frm, too)
        return {
            "code": code,
            "from": from_label,
            "to": to_label,
            "candles": rows_out,
            "cached_batches": cached_batches,
            "fresh_batches": [],
            "data_warnings": warnings,
            "venue": policy,
        }

    async def _fetch_primary_batch(
        self,
        *,
        venue: Venue,
        code: str,
        from_s: str,
        to_s: str,
    ):
        return await self._fetch(
            venue=venue,
            key=("live-candle-backfill", "daily", venue, code, from_s, to_s),
            code=code, from_s=from_s, to_s=to_s,
        )

    async def _fetch_krx_fallback_batch(
        self,
        *,
        code: str,
        from_s: str,
        to_s: str,
    ):
        return await self._fetch(
            venue="KRX",
            key=("live-candle-backfill", "daily", "KRX", code, from_s, to_s, "fallback"),
            code=code, from_s=from_s, to_s=to_s,
        )

    async def _fetch(self, *, venue: Venue, key, code: str, from_s: str, to_s: str):
        """PR-F(#1042) 칼 컷오버 — 소스는 키움 `ka10081` 이다.

        거버너 과부하를 `KisRateLimitError` 로 감싸는 것은 **의도적**이다: 상위
        walkback 오케스트레이터가 그 타입으로 "잠시 후 재시도" 경고를 만든다.
        벤더명이 붙은 예외 이름은 #1046(PR-J)에서 한꺼번에 정리한다.
        """
        client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
        if client is None:
            raise KisRateLimitError("kiwoom client not initialized")
        def _run_page(fetch_fn, page_idx: int):
            """페이지 1장 = 거버너 submit 1건.

            **walk 전체를 감싸던 자리다.** 거버너는 submit 진입 전에 버킷을 한 번만
            소비하므로, 바깥에서 감싸면 커서 walk 의 페이지 N장(최대 12)이 페이싱을
            못 받는다(ADR-0137).
            """
            return kiwoom_access.run_with_capacity(
                self._scheduler,
                key=(*key, page_idx) if isinstance(key, tuple) else (key, page_idx),
                api_id=kiwoom_daily_candles.API_ID,
                priority="user_visible",
                client=client,
                fetch_fn=fetch_fn,
            )

        try:
            return await kiwoom_daily_candles.fetch_daily_candles(
                client, code, from_s, to_s, venue=venue, run_page=_run_page,
            )
        except KiwoomCapacityOverloaded as e:
            raise KisRateLimitError(str(e)) from e


class _VenueDailyCacheAdapter:
    def __init__(self, inner: PastDailyCandlesCache, venue: Venue) -> None:
        self._inner = inner
        self._venue = venue

    def list_batches(self, code: str):
        return self._inner.list_batches(self._venue, code)

    def append_batch(self, code: str, frm: date, to: date, bars: list[dict]) -> None:
        self._inner.append_batch(self._venue, code, frm, to, bars)

    def get_today(self, code: str):
        return self._inner.get_today(self._venue, code)

    def store_today(self, code: str, bar: dict | None) -> None:
        self._inner.store_today(self._venue, code, bar)


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms,
        "open": c.open,
        "high": c.high,
        "low": c.low,
        "close": c.close,
        "volume": c.volume,
    }


def _compute_gaps(
    frm: date,
    too: date,
    existing: list[tuple[date, date]],
) -> list[tuple[date, date]]:
    relevant = [(s, e) for s, e in existing if e >= frm and s <= too]
    if not relevant:
        return [(frm, too)]
    relevant.sort()
    merged: list[tuple[date, date]] = [relevant[0]]
    for s, e in relevant[1:]:
        last_s, last_e = merged[-1]
        if s <= last_e + timedelta(days=1):
            merged[-1] = (last_s, max(last_e, e))
        else:
            merged.append((s, e))

    gaps: list[tuple[date, date]] = []
    cursor = frm
    for s, e in merged:
        if s > cursor:
            gaps.append((cursor, min(s - timedelta(days=1), too)))
        cursor = max(cursor, e + timedelta(days=1))
        if cursor > too:
            break
    if cursor <= too:
        gaps.append((cursor, too))
    return gaps


def _dedupe_filter_sort(rows: list[dict], frm: date, too: date) -> list[dict]:
    frm_ms = int(datetime(frm.year, frm.month, frm.day, tzinfo=_KST).timestamp() * 1000)
    too_ms = int(
        datetime(too.year, too.month, too.day, 23, 59, 59, tzinfo=_KST).timestamp() * 1000
    )
    by_ts: dict[int, dict] = {}
    for row in rows:
        ts = row.get("t_ms")
        if isinstance(ts, int) and frm_ms <= ts <= too_ms:
            by_ts[ts] = row
    return [by_ts[ts] for ts in sorted(by_ts)]


def _kis_rest_bypassed_warning(batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "reason": "rest_bypassed",
        "msg": "KIS REST bypass is enabled; served cache-only data",
    }


def _daily_fallback_to_krx_warning(primary_venue: Venue, batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "reason": "daily_fallback_to_krx",
        "msg": (
            f"{primary_venue} daily returned no candles; using KRX daily candles "
            "for this batch"
        ),
    }


def _daily_partial_fallback_to_krx_warning(primary_venue: Venue, batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "reason": "daily_fallback_to_krx",
        "msg": (
            f"{primary_venue} daily returned a partial range; filling missing daily "
            "candles from KRX for this batch"
        ),
    }


def _daily_candle_date(candle) -> date:
    return datetime.fromtimestamp(candle.t_ms / 1000, tz=_KST).date()


def _needs_krx_daily_fill(candles: list, from_s: str, to_s: str) -> bool:
    if not candles:
        return True
    from_d = datetime.strptime(from_s, "%Y%m%d").date()
    to_d = datetime.strptime(to_s, "%Y%m%d").date()
    dates = sorted({_daily_candle_date(c) for c in candles})
    # A few calendar days of edge slack avoids fallback for weekend/holiday
    # request edges. Month-scale holes (observed 089030 NXT/UN) must be filled.
    if dates[0] > from_d + timedelta(days=10):
        return True
    if dates[-1] < to_d - timedelta(days=10):
        return True
    # strict=False 가 의도다 — 이건 인접쌍(pairwise) 순회라 두 시퀀스의 길이가 1
    # 차이나는 것이 정상이다(dates 와 dates[1:]). 나머지 zip 은 전부 strict=True 로
    # 바꿨는데(길이 일치가 구조적으로 보장되는 곳), 여기만 그러면 정상 코드가 터진다.
    return any((b - a).days > 10 for a, b in zip(dates, dates[1:], strict=False))  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리


def _merge_daily_fallback(primary: list, fallback: list) -> list:
    by_ts = {c.t_ms: c for c in fallback}
    by_ts.update({c.t_ms: c for c in primary})
    return [by_ts[t] for t in sorted(by_ts)]
