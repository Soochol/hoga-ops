from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from datetime import date, datetime, timedelta
from typing import Protocol

from hoga.live import kiwoom_access, kiwoom_daily_candles, kiwoom_rest_runtime
from hoga.live.kiwoom_capacity import Priority
from hoga.live.kiwoom_errors import KiwoomAuthError
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
        # 캐시된 배치들이 어느 수정주가 기준일로 받아진 것인지(#1228 함정 ④).
        # 기준일이 바뀌면 그 사이 액면분할이 났을 수 있어 척도를 믿을 수 없다.
        self._basis_day: str | None = None

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
        # **수정주가 기준일은 배치가 아니라 요청 전체에서 하나다**(함정 ④).
        # 갭마다 그 갭의 끝 날짜를 기준일로 쓰면 배치 경계에서 척도가 갈려
        # 차트에 액면분할 절벽이 생긴다 — 005930 이 2018-03-05 에서 그랬다.
        as_of_s = today_d.strftime("%Y%m%d")
        if self._basis_day is not None and self._basis_day != as_of_s:
            # **날짜가 넘어갔다 → 캐시된 배치의 척도를 더는 믿을 수 없다.**
            # 그 사이 액면분할이 났다면 옛 기준일 배치는 분할 미반영이고, 새로
            # 받는 배치는 반영이라 경계에서 절벽이 생긴다. 하루 한 번 버리는
            # 비용은 코드당 깊은 walk 한 번인데, 커버리지 확장(아래 `covered_to`)
            # 덕에 그 walk 하나가 전 구간을 덮는다.
            #
            # 여기(fetch 하는 경로)에만 둔다 — REST 우회 모드는 비운 캐시를 다시
            # 채울 수단이 없어서 화면이 통째로 비게 된다.
            self._cache.clear_batches()
        self._basis_day = as_of_s

        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await self._fetch_primary_batch(
                venue=venue,
                code=code_,
                from_s=from_s,
                to_s=to_s,
                as_of_s=as_of_s,
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
                    as_of_s=as_of_s,
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
            # 세 번째 칸이 **실제로 덮은 끝 날짜**다. 어댑터는 기준일에서 걸어
            # 내려오므로 요청한 `to_s` 보다 뒤까지 받는다(#1228) — 그걸 알려야
            # 오케스트레이터가 캐시 커버리지를 넓혀 다음 갭을 없앤다.
            return (
                [_candle_to_dict(c) for c in result.candles],
                result.violations,
                today_d,
            )

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
        as_of_s: str,
    ):
        return await self._fetch(
            venue=venue,
            key=("live-candle-backfill", "daily", venue, code, from_s, to_s),
            code=code, from_s=from_s, to_s=to_s, as_of_s=as_of_s,
        )

    async def _fetch_krx_fallback_batch(
        self,
        *,
        code: str,
        from_s: str,
        to_s: str,
        as_of_s: str,
    ):
        return await self._fetch(
            venue="KRX",
            key=("live-candle-backfill", "daily", "KRX", code, from_s, to_s, "fallback"),
            code=code, from_s=from_s, to_s=to_s, as_of_s=as_of_s,
        )

    async def _fetch(
        self, *, venue: Venue, key, code: str, from_s: str, to_s: str, as_of_s: str
    ):
        """PR-F(#1042) 칼 컷오버 — 소스는 키움 `ka10081` 이다.

        **예외를 다른 벤더 타입으로 감싸지 않는다.** 예전엔 거버너 과부하와 클라이언트
        미초기화를 둘 다 `KisRateLimitError` 로 감쌌다 — 상위 walkback 이 그 타입으로만
        경고를 만들었기 때문인데, 그 편법이 두 가지 거짓을 만들었다:

        - 거버너 큐 포화가 `rate_limit_upstream` 으로 떠서 **묻지도 않은 벤더**가
          거절한 것처럼 보였다. 같은 사건을 분봉 경로는 `capacity_overloaded` 로
          부르고 있어 두 경로가 같은 일에 다른 이름을 붙였다.
        - 클라이언트 미초기화(= 자격증명 없음)가 "잠시 후 재시도" 로 안내됐다.
          고치기 전에는 영원히 같은 실패라 ADR-0137 R4 위반이다.

        이제 walkback 이 사유를 `error_policy` 에 묻고 거버너 과부하도 직접 잡으므로
        (`_STOP_WALK_ERRORS`) 감쌀 이유가 없다. 미초기화는 성격 그대로 인증 실패로
        올린다 — 정상 경로에서는 라우트가 앞서 503 `not_wired` 로 막으므로 여기까지
        오는 것은 요청 도중 자격증명이 사라진 경우뿐이다.
        """
        client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
        if client is None:
            raise KiwoomAuthError("kiwoom client not initialized")
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

        return await kiwoom_daily_candles.fetch_daily_candles(
            client, code, from_s, to_s, venue=venue,
            # `/live` 차트는 **수정주가**를 그린다. 기준일은 배치의 끝이 아니라
            # 오늘이다 — 그래야 스크롤로 쪼개진 배치들이 한 척도로 이어진다(#1228).
            adjust=True, adjusted_as_of=as_of_s,
            run_page=_run_page,
        )


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
