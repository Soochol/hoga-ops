"""KIS Open API HTTP client (직접 구현, ADR-0038 — 의존성 최소화).

Live Capture write-path uses this client. Per ADR-0038's invariant the
hot-path module never imports pyarrow/polars; this file should not either.

See Deep Sample Audit §C (Audit-3) for the 1-minute token cool-down and
KIS's 6-hour same-token reissue policy.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Literal, Optional

if TYPE_CHECKING:
    from hoga.live.kis_token_provider import KisTokenProvider

log = logging.getLogger(__name__)

import httpx

from hoga.live.kis_models import (
    InvestorNetPoint,
    KisBrokerEntry,
    KisBrokers,
    KisCandle,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)

KIS_KST = timezone(timedelta(hours=9))
_BASE_REAL = "https://openapi.koreainvestment.com:9443"

# KIS auth-failure msg_cds that mean "this TOKEN is bad" (expired/invalid) as
# opposed to "this request is bad". On these, `_get` invalidates the provider
# cache and retries once — without it a server-side revocation had no recovery
# path: the dead token was served from memory+disk until expires_at (~24h).
_TOKEN_INVALID_MSG_CDS = ("EGW00121", "EGW00123")

# KIS market-division code for KOSPI/KOSDAQ stocks (single value covers both).
# Justified by the watchlist boundary in `lifecycle.start_live_stream`, which
# filters codes through `symbols._cache` — only KOSPI/KOSDAQ stocks reach the
# stream. Supporting ETF/ETN/ELW would require lifting this to a per-call
# argument derived from the symbol-master entry's `market`/`asset_class`.
_STOCK_MRKT_DIV = "J"

# Conservative cap on KIS data calls per second across all callers (backfill +
# backfill + future). KIS doesn't publish an exact retail limit — 20/sec is
# the commonly-cited figure; 15 gives ~25% headroom so we stay clear of the
# EGW00201 boundary under burst.
_RATE_LIMIT_CALLS_PER_SEC = 15.0

# Exponential backoff sequence on EGW00201 — applied inside ``_get`` so EVERY
# KIS call gets retry-on-rate-limit for free. Centralised here (instead of in
# each caller) because the previous caller-by-caller policy let asymmetries
# slip in (e.g. `_get_past_candles` aborted after one error while another caller
# retried, turning a single transient EGW00201 into a wall of cascading
# "rate_limit_aborted" warnings for ~50 dates). 4 attempts total: 1 immediate
# + 3 retries with 1s/2s/4s waits between attempts. KisAuthError and
# KisApiError are NOT retried — those are caller-actionable. See ADR-0050.
_RATE_LIMIT_BACKOFF: tuple[float, ...] = (1.0, 2.0, 4.0)

# Transport-error retry (distinct from EGW00201 above). A connection-level
# failure on an idempotent GET — most often ``RemoteProtocolError`` ("server
# disconnected", a stale-keepalive / load-shed symptom) — is fixed by a fresh
# pooled connection, so ONE near-immediate retry recovers it. Kept tiny (not
# the (1,2,4)s rate sequence): the wait is to avoid hammering a shedding
# server, not to clear a quota. ``len`` = retry count. NOT all transport
# errors retry — only the connection-level set (``_RETRYABLE_TRANSPORT``);
# read-timeouts normalize-but-don't-retry to avoid doubling latency into an
# already-slow upstream. See ADR-0050 amendment (2026-06-11).
_TRANSPORT_RETRY_BACKOFF: tuple[float, ...] = (0.1,)

# Which transport failures are worth replaying. The connection-level set:
# the request either never reached KIS or the socket broke, so a fresh
# connection is likely to succeed and a replay is cheap. Deliberately EXCLUDES
# read/write *timeouts* (KIS got the request but is slow — replaying doubles
# the 10s wait and adds load to a struggling upstream) and LocalProtocolError
# (our bug, not transient). Non-retryable transport errors still normalize to
# KisTransportError — they just skip the replay and degrade immediately.
_RETRYABLE_TRANSPORT: tuple[type[httpx.TransportError], ...] = (
    httpx.RemoteProtocolError,
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpx.PoolTimeout,
)

# 우선순위 레인 기본값 (2026-06-09). 백그라운드가 foreground 대기자에게 토큰을
# 양보할 때 재확인 간격(busy-loop 방지) + 기아 방지 상한(누적 양보가 이를 넘으면
# 백그라운드도 강제 획득). foreground 버스트는 본질상 짧으므로(전환 1회 ~20콜 ≈
# 1.5s@15/s) 상한 1.5s면 실제 기아는 드물고, 폭주가 길어도 백그라운드가 영구히 굶지 않음.
_FG_YIELD_S = 0.02
_BG_MAX_YIELD_S = 1.5


class _TokenBucket:
    """Leaky-bucket rate limiter shared by all KIS data callers, with a
    foreground priority lane.

    Single instance per ``KisClient`` so on-demand backfill, quote overlay,
    and any future caller draw from one budget — matching KIS's per-API-
    key quota model. The bucket starts full so short bursts under
    capacity don't pay an artificial penalty; once drained, ``acquire``
    sleeps just long enough for one token to replenish.

    Priority (2026-06-09): ``acquire(foreground=True)`` marks the call as
    user-visible (the chart the user is waiting on — past-candles/daily).
    A BACKGROUND acquirer (rest_poller / periodic refetch / investor walk,
    the default) YIELDS its turn while any foreground acquirer is waiting:
    it declines an available token and re-checks after ``_yield_s`` until
    the foreground burst drains. The single 15/s budget is unchanged — this
    only reorders who spends it, so a user-facing fetch jumps ahead of the
    continuous background load instead of queueing behind it. A starvation
    backstop (``_bg_max_yield_s`` wall-clock from first yield) lets a
    long-blocked background caller stop yielding and fairly compete for the
    next token, so sustained foreground load can't starve it (even when the
    bucket is drained and the background caller never observes a free token).

    Concurrency: token bookkeeping happens under ``_lock`` so concurrent
    acquirers see consistent state. ``_fg_waiters`` is mutated only between
    awaits (atomic on the single-threaded event loop). The ``await
    asyncio.sleep`` is intentionally OUTSIDE the lock so other tasks can
    recompute their own wait while one task sleeps. CancelledError during
    sleep is safe — the token is only deducted after the lock confirms
    availability, never before the sleep, so cancellation never leaks tokens;
    the ``finally`` always releases the foreground-waiter count.
    """

    def __init__(
        self,
        rate: float,
        *,
        yield_s: float = _FG_YIELD_S,
        bg_max_yield_s: float = _BG_MAX_YIELD_S,
    ):
        if rate <= 0:
            raise ValueError("rate must be positive")
        # yield_s는 양보 중 재확인 간격이자 sleep 길이 — 0/음수면 양보 모드가
        # CPU busy-spin(라이브락)이 된다. bg_max_yield_s는 기아 백스톱 상한이라
        # 음수면 background가 즉시 강제 획득해 우선순위 자체가 무력화된다.
        if yield_s <= 0:
            raise ValueError("yield_s must be positive")
        if bg_max_yield_s < 0:
            raise ValueError("bg_max_yield_s must be non-negative")
        self._rate = float(rate)
        self._tokens = float(rate)
        self._last = time.monotonic()
        self._lock = asyncio.Lock()
        self._fg_waiters = 0
        self._yield_s = float(yield_s)
        self._bg_max_yield_s = float(bg_max_yield_s)

    async def acquire(self, *, foreground: bool = False) -> None:
        # Register as a foreground waiter so concurrent background acquirers
        # yield to us. Released in `finally` even on CancelledError.
        if foreground:
            self._fg_waiters += 1
        # 기아 방지 백스톱은 '실제 경과시간'(벽시계) 기준이다. 양보-분기 sleep을
        # 누적하던 이전 방식은 토큰 드레인 상태(tokens<1)에서 진전하지 않아, 지속
        # foreground 부하가 모든 리필 토큰을 가져가면 background가 토큰을 한 번도
        # 보지 못해 누적이 0에 머물러 영구 기아했다(적대리뷰 L2 P1). deadline은
        # background가 처음 양보해야 하는 순간 스탬프되고, 그 시각을 넘으면 토큰
        # 가용 여부와 무관하게 양보를 중단해 다음 토큰을 공정 경쟁으로 가져간다.
        deadline: float | None = None
        try:
            while True:
                async with self._lock:
                    now = time.monotonic()
                    self._tokens = min(
                        self._rate,
                        self._tokens + (now - self._last) * self._rate,
                    )
                    self._last = now
                    if not foreground and self._fg_waiters > 0:
                        # 양보 필요 — 첫 양보 시 벽시계 데드라인을 건다.
                        if deadline is None:
                            deadline = now + self._bg_max_yield_s
                        yield_to_fg = now < deadline
                    else:
                        # foreground 없음 → 양보 불필요, 다음 양보 에피소드 위해 리셋.
                        deadline = None
                        yield_to_fg = False
                    if self._tokens >= 1.0 and not yield_to_fg:
                        self._tokens -= 1.0
                        return
                    if self._tokens >= 1.0:
                        # 토큰은 있으나 foreground에 양보(데드라인 전) → 짧게 재확인.
                        wait = self._yield_s
                    else:
                        # 토큰 없음 → 보충 대기.
                        wait = (1.0 - self._tokens) / self._rate
                await asyncio.sleep(wait)
        finally:
            if foreground:
                self._fg_waiters -= 1


def classify_side(
    t_ms: int, prpr: int, askp: int, bidp: int
) -> tuple[Literal[-1, 0, 1, 2], Literal["inferred", "auction"]]:
    """Lee-Ready trade direction inference + auction window guard.

    Returns (side, side_source). See Deep Sample Audit §B (Audit-2) and §H (Audit-5).
    side: -1=sell, 0=mid, 1=buy, 2=auction
    side_source: "inferred" | "auction"
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    h, m = kst.hour, kst.minute
    in_open_auction = (h == 8 and m >= 50) or (h == 9 and m == 0)
    in_close_auction = h == 15 and 20 <= m < 30
    if in_open_auction or in_close_auction:
        return 2, "auction"
    if prpr >= askp:
        return 1, "inferred"
    if prpr <= bidp:
        return -1, "inferred"
    return 0, "inferred"


class KisAuthError(RuntimeError):
    """Token issue failed or cool-down breached."""


class KisRateLimitError(RuntimeError):
    """msg_cd == 'EGW00201'.

    Originally documented as "backoff caller's responsibility" (Audit-4).
    Post-ADR-0050 the backoff lives in ``KisClient._get`` itself — this
    exception only surfaces to callers AFTER the client's retry sequence
    has been exhausted. Caller-actionable response is "this caller's range
    is blocked for now, move on".
    """


class KisApiError(RuntimeError):
    """rt_cd != '0' generic failure."""

    def __init__(self, msg_cd: str, msg1: str):
        self.msg_cd = msg_cd
        self.msg1 = msg1
        super().__init__(f"KIS api error {msg_cd}: {msg1}")


class KisTransportError(KisApiError):
    """An httpx ``TransportError`` (TCP disconnect, connect failure, read
    timeout) normalized into the KIS domain. KIS closing the connection
    without a response surfaces as ``httpx.RemoteProtocolError``, which is a
    ``TransportError`` *sibling* of ``HTTPStatusError`` — so ``_do_get_once``'s
    status-only catch let it escape as an unhandled 500 (2026-06-11 daily
    backfill regression). Subtyping ``KisApiError`` is deliberate: every
    existing ``except KisApiError`` site (the walk-back orchestrator's
    degrade-and-continue arms) absorbs it without modification, so no caller
    can forget to handle it (ADR-0050's anti-asymmetry principle). The
    synthetic ``msg_cd`` ('TRANSPORT/<httpx class>') names the failure without
    colliding with EGW token codes, so ``_get``'s token-invalid branch never
    false-triggers on it."""

    def __init__(self, exc: httpx.TransportError):
        # Classified at raise time so the retry loop stays dumb: connection-
        # level failures replay, timeouts/local-protocol errors degrade.
        self.retryable = isinstance(exc, _RETRYABLE_TRANSPORT)
        super().__init__(msg_cd=f"TRANSPORT/{type(exc).__name__}", msg1=str(exc)[:200])


@dataclass(frozen=True)
class DailyInvariantViolation:
    """A row dropped by fetch_past_daily_candles boundary defense.

    Surfaced to the handler so wire data_warnings can tell operators which
    dates were silently lost — ADR-0040's defensive-parse policy made explicit
    (grill Q3 decision in 2026-05-28 daily backfill spec).
    """
    date_yyyymmdd: str
    reason: Literal[
        "close_nonpositive", "ohlc_inconsistent", "malformed_row", "out_of_range"
    ]
    detail: str


@dataclass(frozen=True)
class DailyCandleFetchResult:
    """Return value of fetch_past_daily_candles.

    `candles` is the cleaned, ASC-sorted result; `violations` is the per-row
    drop log so the caller can surface them to data_warnings.
    """
    candles: list["KisCandle"]
    violations: list[DailyInvariantViolation] = field(default_factory=list)


@dataclass(frozen=True)
class KisQuote:
    """One row of intstock-multprice (현재가 + 등락률 + 전일대비 등락액 + 당일 OHLC) for a Code."""
    code: str
    price: int
    change_pct: float | None
    change_won: int | None = None
    # 당일 OHLC(inter2_oprc/hgpr/lwpr). 기본 None — positional 생성자/동등성 테스트 보존.
    open: int | None = None
    high: int | None = None
    low: int | None = None


@dataclass(frozen=True)
class InvestorNetInvariantViolation:
    """A row dropped by fetch_investor_net boundary defense.

    Investor rows carry no OHLC invariant, so the only drop reason is a
    malformed/missing trading date. Surfaced to wire data_warnings.
    """
    date_yyyymmdd: str
    reason: Literal["malformed_row"]
    detail: str


@dataclass(frozen=True)
class InvestorNetFetchResult:
    """Return value of fetch_investor_net.

    `points` is ASC-sorted by t_ms; `violations` is the per-row drop log.
    """
    points: list["InvestorNetPoint"]
    violations: list[InvestorNetInvariantViolation] = field(default_factory=list)


def _daily_anchor_t_ms(date_yyyymmdd: str) -> int:
    """Epoch-ms anchor for a daily datum: 09:00:00 KST of the trading day.

    Single source of truth shared by daily candles and investor-net so the
    frontend pins both series to the same x-coordinate. Callers must pass a
    validated 8-char YYYYMMDD (boundary defense lives in the caller).
    """
    dt = datetime(
        int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8]),
        9, 0, tzinfo=KIS_KST,
    )
    return int(dt.timestamp() * 1000)


def _prev_day_yyyymmdd(yyyymmdd: str) -> str:
    """YYYYMMDD of the calendar day before *yyyymmdd*. The one piece the two
    daily KIS walk-backs (``fetch_past_daily_candles`` / ``fetch_investor_net``)
    genuinely share — both step the cursor to (page oldest − 1 day). Their loop
    skeletons otherwise differ (cursor param slot, anchor semantics, termination)
    enough that a unified driver would be leaky — see ADR-0060."""
    d = datetime(
        int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]), tzinfo=KIS_KST,
    )
    return (d - timedelta(days=1)).strftime("%Y%m%d")


@dataclass(frozen=True)
class KisCredentials:
    app_key: str
    app_secret: str
    env: Literal["real"] = "real"  # paper unsupported (spec §10)

    @property
    def base_url(self) -> str:
        if self.env != "real":
            raise ValueError("Only 'real' env is supported (spec §10)")
        return _BASE_REAL


class KisClient:
    def __init__(
        self,
        credentials: KisCredentials,
        token_provider: "KisTokenProvider",
        *,
        _transport: Optional[httpx.AsyncBaseTransport] = None,
        _rate_limit_per_sec: float = _RATE_LIMIT_CALLS_PER_SEC,
        _rate_limit_backoff: tuple[float, ...] = _RATE_LIMIT_BACKOFF,
        _transport_retry_backoff: tuple[float, ...] = _TRANSPORT_RETRY_BACKOFF,
    ):
        self._creds = credentials
        self._token_provider = token_provider
        self._client = httpx.AsyncClient(
            base_url=credentials.base_url, transport=_transport, timeout=10.0
        )
        # Single rate limiter shared by all data calls — `_get` acquires
        # one token per HTTP request. Token issuance lives in the injected
        # KisTokenProvider (ADR-0050 amendment) and bypasses this bucket.
        self._rate_limiter = _TokenBucket(rate=_rate_limit_per_sec)
        # Tests pass (0.0, 0.0, 0.0) here to exercise the retry shape without
        # paying the real wall-clock sleeps; production callers leave the
        # default. See ADR-0050.
        self._rate_limit_backoff = _rate_limit_backoff
        # Transport retry sleeps (default one ~immediate retry). Tests pass
        # () to assert the no-retry raise shape or (0.0,) for instant retry.
        self._transport_retry_backoff = _transport_retry_backoff

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_approval_key(self) -> str:
        """WS 접속키 발급 (POST /oauth2/Approval). ADR-0050 단일 ingress —
        WS 클라이언트도 KIS HTTP는 이 클라이언트를 경유한다.

        연결할 때마다 1회 발급(공식 샘플과 동일). 데이터 호출이 아니므로
        15/s 토큰버킷은 통과하지 않는다(토큰 발급과 같은 취급).
        주의: KIS가 이 엔드포인트만 필드명을 ``secretkey``로 받는다.
        """
        resp = await self._client.post(
            "/oauth2/Approval",
            json={
                "grant_type": "client_credentials",
                "appkey": self._creds.app_key,
                "secretkey": self._creds.app_secret,
            },
        )
        if resp.status_code != 200:  # noqa: PLR2004 — HTTP 상수
            raise KisAuthError(
                f"/oauth2/Approval HTTP {resp.status_code}: {resp.text[:200]}"
            )
        key = resp.json().get("approval_key")
        if not key:
            raise KisAuthError(
                f"approval_key missing in /oauth2/Approval response: {resp.text[:200]}"
            )
        return str(key)

    async def _get(
        self,
        path: str,
        tr_id: str,
        params: dict[str, Any],
        *,
        retry: bool = True,
        foreground: bool = False,
    ) -> dict:
        """Authenticated GET to KIS API with built-in EGW00201 retry and a
        single invalidate-and-retry on token-invalid responses.

        Contract: returns a validated body or raises a typed Kis*Error.
        ``KisRateLimitError`` is retried in-place per ``self._rate_limit_backoff``
        (see ADR-0050); ``KisAuthError`` and non-token ``KisApiError`` propagate
        on the first attempt. A token-invalid ``KisApiError`` (EGW00121/00123 —
        revoked or expired server-side) invalidates the provider's cached token
        and retries ONCE with a fresh one; repeating failures propagate.
        Pass ``retry=False`` for diagnostic callers that want the raw
        single-shot behavior. ``foreground=True`` marks the call as user-visible
        (the chart the user is waiting on) so it takes priority over background
        callers at the shared rate limiter (2026-06-09).
        """
        try:
            return await self._get_with_rate_retry(path, tr_id, params, retry=retry, foreground=foreground)
        except KisApiError as e:
            if not any(cd in e.msg_cd for cd in _TOKEN_INVALID_MSG_CDS):
                raise
            await asyncio.to_thread(self._token_provider.invalidate)
            return await self._get_with_rate_retry(path, tr_id, params, retry=retry, foreground=foreground)

    async def _get_with_rate_retry(
        self,
        path: str,
        tr_id: str,
        params: dict[str, Any],
        *,
        retry: bool,
        foreground: bool = False,
    ) -> dict:
        """EGW00201 retry loop. The loop wraps the whole acquire+send+unwrap
        sequence, so each attempt re-acquires a token from the shared bucket —
        replays of the same call don't get a free ride past the rate limiter.
        """
        backoff = self._rate_limit_backoff if retry else ()
        attempts = len(backoff) + 1
        for attempt in range(attempts):
            try:
                return await self._send_with_transport_retry(
                    path, tr_id, params, retry=retry, foreground=foreground
                )
            except KisRateLimitError:
                if attempt + 1 >= attempts:
                    raise
                # 가시화(스펙 2026-06-08 ⑤): 첫 재시도만 WARNING — 지속 장애 시
                # 병렬 fetch(동시 5)의 동시 재시도가 로그 벽이 되지 않게 이후는
                # DEBUG. 소진 후엔 호출부의 kis_rate_limit data_warning이 최종 신호.
                log_fn = log.warning if attempt == 0 else log.debug
                log_fn("KIS rate-limited (EGW00201) path=%s — retry %d/%d in %.0fs",
                       path, attempt + 1, attempts - 1, backoff[attempt])
                await asyncio.sleep(backoff[attempt])
        # Unreachable: loop either returns or re-raises on the final iteration.
        raise AssertionError("unreachable")

    async def _send_with_transport_retry(
        self,
        path: str,
        tr_id: str,
        params: dict[str, Any],
        *,
        retry: bool = True,
        foreground: bool = False,
    ) -> dict:
        """Innermost retry layer: replays a connection-level transport failure
        on a fresh pooled connection. Nested BELOW the EGW00201 loop so the two
        concerns compose cleanly — a replay that then hits a rate limit is
        handled by the outer loop; a rate-limited call never enters here twice.

        Each replay re-calls ``_do_get_once`` (re-acquiring a rate token), so a
        retry burst can't skip the per-API-key budget — same invariant as the
        EGW00201 loop. ``_do_get_once`` already normalized the failure to
        ``KisTransportError``; on exhaustion it propagates and, being a
        ``KisApiError`` subtype, degrades at the caller's ``except KisApiError``
        boundary instead of 500ing. ``retry=False`` (raw single-shot diagnostic
        callers) disables the replay too, not just the EGW00201 backoff. See
        ADR-0050 amendment (2026-06-11)."""
        backoff = self._transport_retry_backoff if retry else ()
        attempts = len(backoff) + 1
        for attempt in range(attempts):
            try:
                return await self._do_get_once(path, tr_id, params, foreground=foreground)
            except KisTransportError as e:
                if not e.retryable or attempt + 1 >= attempts:
                    raise
                log.warning(
                    "KIS transport error (%s) path=%s — retry %d/%d in %.1fs",
                    e.msg_cd, path, attempt + 1, attempts - 1, backoff[attempt],
                )
                await asyncio.sleep(backoff[attempt])
        # Unreachable: loop either returns or re-raises on the final iteration.
        raise AssertionError("unreachable")

    async def _do_get_once(
        self, path: str, tr_id: str, params: dict[str, Any], *, foreground: bool = False
    ) -> dict:
        """One unretried KIS GET. Extracted from ``_get`` so the retry loop
        sees a single call site; do not call directly from non-test code —
        callers should go through ``_get`` to get the retry contract.

        Normalizes upstream HTTP errors into domain exceptions so callers
        don't have to know about httpx. Without this normalization a
        transient KIS 500 (common per-code) bubbles up as httpx.HTTPStatusError
        and forces the caller to log a full traceback at `unexpected_error`
        level, drowning real bugs in noise. Found by /qa: KIS regularly
        returns 500 for codes outside the regular session window — expected,
        not a defect.

        Rate limit: passes through ``self._rate_limiter`` so the per-API-key
        budget is honoured across all callers (quote + backfill). Acquire
        happens before the HTTP send so token waiters block on the rate
        budget, not on KIS response time. ``foreground`` routes to the
        priority lane so a user-visible fetch jumps ahead of background load.
        """
        await self._rate_limiter.acquire(foreground=foreground)
        # to_thread: get_token() is sync-blocking by design (threading.Lock +
        # disk I/O + up to a 10s POST on cache miss). Calling it bare here
        # froze the entire event loop at every issuance boundary (~daily) and
        # whenever an executor thread held the provider lock mid-issuance.
        token = await asyncio.to_thread(self._token_provider.get_token)
        headers = {
            "authorization": f"Bearer {token}",
            "appkey": self._creds.app_key,
            "appsecret": self._creds.app_secret,
            "tr_id": tr_id,
            "custtype": "P",
        }
        try:
            resp = await self._client.get(path, params=params, headers=headers)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            # 4xx/5xx from KIS — surface as KisApiError so the caller can
            # log it once at WARN/INFO without a full traceback. When KIS
            # ships a JSON body on 5xx (it sometimes does — e.g. session-
            # window or temporarily-suspended-stock cases), preserve the
            # upstream ``msg_cd`` next to the HTTP status so the operator
            # log distinguishes "real gateway 5xx" from "5xx-wrapped
            # domain error". Non-JSON bodies (HTML gateway pages, plain
            # text) fall through to the raw-text branch unchanged.
            upstream_msg_cd = ""
            upstream_msg1 = e.response.text[:200]
            try:
                body = e.response.json()
                if isinstance(body, dict):
                    upstream_msg_cd = str(body.get("msg_cd", ""))
                    upstream_msg1 = str(body.get("msg1", upstream_msg1))[:200]
            except ValueError:
                pass
            http_part = f"HTTP_{e.response.status_code}"
            msg_cd = f"{http_part}/{upstream_msg_cd}" if upstream_msg_cd else http_part
            # EGW00201 = KIS rate-limit code. KIS sometimes wraps it in a 5xx
            # envelope instead of the documented 200/rt_cd!=0 path. Both paths
            # raise KisRateLimitError so the ``_get`` retry loop catches the
            # same exception type regardless of which envelope KIS used.
            if upstream_msg_cd == "EGW00201":
                raise KisRateLimitError(f"rate limit ({msg_cd}): {upstream_msg1}") from e
            raise KisApiError(msg_cd=msg_cd, msg1=upstream_msg1) from e
        except httpx.TransportError as e:
            # Connection-level failure BEFORE any HTTP status: KIS closed the
            # socket without a response (RemoteProtocolError), a connect/read
            # failure, etc. This is a TransportError, a *sibling* of
            # HTTPStatusError above — the status-only catch used to let it
            # escape ``_do_get_once`` as a bare httpx error and bubble to a
            # 500 (2026-06-11). Normalize ALL of them so no transport failure
            # can ever surface uncaught; the caller's retry loop decides which
            # to replay. See ADR-0050 amendment.
            raise KisTransportError(e) from e
        return self._unwrap(resp.json())

    def _unwrap(self, body: dict) -> dict:
        """Validate rt_cd and raise typed errors. Returns the raw body dict."""
        rt_cd = body.get("rt_cd", "")
        msg_cd = body.get("msg_cd", "")
        msg1 = body.get("msg1", "")
        if rt_cd != "0":
            if msg_cd == "EGW00201":
                raise KisRateLimitError(f"rate limit: {msg1}")
            raise KisApiError(msg_cd=msg_cd, msg1=msg1)
        return body

    async def fetch_past_minute_candles(
        self, code: str, date_yyyymmdd: str, *, foreground: bool = False
    ) -> list[KisCandle]:
        """Fetch 1-minute candles for *code* on *date_yyyymmdd* (KST).

        KIS endpoint `inquire-time-dailychartprice` returns at most 120 rows
        per call (about 2 hours of 1-minute bars). A full regular-session day
        (09:00-15:30 KST = 390 minutes) needs ~4 paginated calls — we anchor
        from 15:30 KST and walk the anchor backwards by the earliest received
        candle's HHMMSS until we cover 09:00 or stop receiving new bars.

        KIS retains roughly 1 year of historical minute candles per the
        portal docs (https://apiportal.koreainvestment.com/).
        """
        path = "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice"
        tr_id = "FHKST03010230"
        # Walk anchor from 15:30 backwards. Stop when the response is empty
        # or the earliest received bar is at/before 09:00.
        anchor_hhmmss = "153000"
        seen_t_ms: set[int] = set()
        all_candles: list[KisCandle] = []
        # Hard cap so a misbehaving KIS response never spirals into infinite
        # pages. 6 calls × 120 bars = 720 rows, well past one regular session.
        for _ in range(6):
            params = {
                "FID_COND_MRKT_DIV_CODE": _STOCK_MRKT_DIV,
                "FID_INPUT_ISCD": code,
                "FID_INPUT_HOUR_1": anchor_hhmmss,
                "FID_INPUT_DATE_1": date_yyyymmdd,
                "FID_PW_DATA_INCU_YN": "N",
                "FID_FAKE_TICK_INCU_YN": "",
            }
            body = await self._get(path=path, tr_id=tr_id, params=params, foreground=foreground)
            rows = body.get("output2") or []
            page_candles: list[KisCandle] = []
            for row in rows:
                date_str = row.get("stck_bsop_date") or ""
                hhmmss = row.get("stck_cntg_hour") or ""
                if len(date_str) != 8 or len(hhmmss) != 6:
                    # Defensive: malformed row, skip rather than crash the page.
                    continue
                if date_str != date_yyyymmdd:
                    # KIS quirk: queries against a non-trading-day (Sat/Sun/
                    # holiday) return the PRIOR trading day's bars instead of an
                    # empty list. Without this guard the caller's per-date loop
                    # accumulates the same bars under multiple dates, breaking
                    # lightweight-charts' monotonic-time invariant downstream.
                    # Discovered via /investigate 2026-05-28 against /live.
                    continue
                dt = datetime(
                    int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]),
                    int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:6]),
                    tzinfo=KIS_KST,
                )
                t_ms = int(dt.timestamp() * 1000)
                if t_ms in seen_t_ms:
                    continue
                seen_t_ms.add(t_ms)
                page_candles.append(KisCandle(
                    t_ms=t_ms,
                    open=int(row["stck_oprc"]),
                    high=int(row["stck_hgpr"]),
                    low=int(row["stck_lwpr"]),
                    close=int(row["stck_prpr"]),
                    volume=int(row["cntg_vol"]),
                ))
            if not page_candles:
                break
            all_candles.extend(page_candles)
            # Next anchor = HHMMSS of the earliest bar minus 1 minute. KIS
            # responses come newest-first; the earliest bar's hour drives the
            # next page's anchor.
            earliest_t_ms = min(c.t_ms for c in page_candles)
            earliest_dt = datetime.fromtimestamp(earliest_t_ms / 1000, tz=KIS_KST)
            # If we already covered the session open, stop.
            if earliest_dt.hour < 9 or (earliest_dt.hour == 9 and earliest_dt.minute == 0):
                break
            # Step the anchor back by 1 minute from the earliest bar.
            next_anchor_dt = earliest_dt - timedelta(minutes=1)
            anchor_hhmmss = (
                f"{next_anchor_dt.hour:02d}{next_anchor_dt.minute:02d}{next_anchor_dt.second:02d}"
            )
        # Return in ascending order by t_ms — frontend / aggregator expects ASC.
        all_candles.sort(key=lambda c: c.t_ms)
        return all_candles

    # ------------------------------------------------------------------
    # fetch_past_daily_candles (FHKST03010100, inquire-daily-itemchartprice)
    # ------------------------------------------------------------------

    async def fetch_past_daily_candles(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        adjust: bool = True,
        foreground: bool = False,
    ) -> DailyCandleFetchResult:
        """Fetch daily OHLCV for *code* across [from, to] (KST).

        KIS TR_ID: FHKST03010100 (inquire-daily-itemchartprice), period='D'.
        KIS retains roughly 20-30 years of daily candles per the portal docs.

        Returns DailyCandleFetchResult with:
        - candles: ASC by t_ms; t_ms anchors at regular_session_open (KST 09:00:00)
          of each trading day. Non-trading days are absent (KIS doesn't emit them).
        - violations: per-row drop reasons (close<=0, OHLC inconsistent, malformed,
          out of requested range). Surfaced to caller for data_warnings.
        """
        path = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"
        tr_id = "FHKST03010100"
        cursor_to = to_yyyymmdd
        # Tracks every row we've already processed (valid or violation) so that
        # paginated re-reads — or mock-server tests that replay the same payload
        # for every cursor — don't double-count violations or candles. Keys are
        # the YYYYMMDD date; for malformed rows missing a date we fall back to
        # a stable hash of the row content.
        seen_keys: set[str] = set()
        all_candles: list[KisCandle] = []
        violations: list[DailyInvariantViolation] = []

        for _ in range(60):
            params = {
                "FID_COND_MRKT_DIV_CODE": _STOCK_MRKT_DIV,
                "FID_INPUT_ISCD": code,
                "FID_INPUT_DATE_1": from_yyyymmdd,
                "FID_INPUT_DATE_2": cursor_to,
                "FID_PERIOD_DIV_CODE": "D",
                # 0=수정주가(/live 기본·ADR-0048), 1=원주가(스크리너)
                "FID_ORG_ADJ_PRC": "0" if adjust else "1",
            }
            body = await self._get(path=path, tr_id=tr_id, params=params, foreground=foreground)
            rows = body.get("output2") or []
            page_candles: list[KisCandle] = []
            page_earliest: str | None = None
            page_progress = False

            for row in rows:
                date_str = row.get("stck_bsop_date") or ""
                if len(date_str) != 8:
                    row_key = "malformed:" + json.dumps(row, sort_keys=True)
                    if row_key in seen_keys:
                        continue
                    seen_keys.add(row_key)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str or "(empty)",
                        reason="malformed_row",
                        detail="stck_bsop_date missing or wrong length",
                    ))
                    page_progress = True
                    continue
                if date_str in seen_keys:
                    continue
                # Lexicographic comparison of YYYYMMDD is equivalent to chronological.
                if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
                    seen_keys.add(date_str)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="out_of_range",
                        detail=f"row date outside [{from_yyyymmdd}, {to_yyyymmdd}]",
                    ))
                    page_progress = True
                    continue
                try:
                    o = int(row["stck_oprc"])
                    h = int(row["stck_hgpr"])
                    l_ = int(row["stck_lwpr"])
                    c = int(row.get("stck_clpr") or row.get("stck_prpr") or "0")
                    v = int(row.get("acml_vol") or row.get("cntg_vol") or "0")
                except (KeyError, ValueError, TypeError) as e:
                    seen_keys.add(date_str)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="malformed_row",
                        detail=f"OHLCV parse: {e}",
                    ))
                    page_progress = True
                    continue
                if c <= 0:
                    seen_keys.add(date_str)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str, reason="close_nonpositive",
                        detail=f"close={c}",
                    ))
                    page_progress = True
                    continue
                if h < max(o, c) or l_ > min(o, c) or h < l_:
                    seen_keys.add(date_str)
                    violations.append(DailyInvariantViolation(
                        date_yyyymmdd=date_str, reason="ohlc_inconsistent",
                        detail=f"o={o} h={h} l={l_} c={c}",
                    ))
                    page_progress = True
                    continue

                t_ms = _daily_anchor_t_ms(date_str)
                seen_keys.add(date_str)
                page_progress = True
                page_candles.append(KisCandle(
                    t_ms=t_ms, open=o, high=h, low=l_, close=c, volume=v,
                ))
                if page_earliest is None or date_str < page_earliest:
                    page_earliest = date_str

            all_candles.extend(page_candles)
            # Stop when KIS returns an empty page or this iteration produced no
            # new rows (e.g. test fixture replays the same payload on every call).
            if not rows or not page_progress:
                break
            if page_earliest is None:
                # No new valid candle to anchor cursor walk-back; rely on the
                # next iteration's empty/no-progress check to terminate.
                continue
            if page_earliest <= from_yyyymmdd:
                # 요청 시작일까지 도달 — 즉시 종료(스펙 2026-06-08 ⑦,
                # fetch_investor_net과 동일 분기). 이 분기가 없으면 빈 응답을
                # 받는 헛 콜이 1회 더 나간다.
                break
            cursor_to = _prev_day_yyyymmdd(page_earliest)

        all_candles.sort(key=lambda c: c.t_ms)
        return DailyCandleFetchResult(candles=all_candles, violations=violations)

    # ------------------------------------------------------------------
    # fetch_multi_price (FHKST11300006, intstock-multprice)
    # ------------------------------------------------------------------

    async def fetch_multi_price(self, codes: list[str]) -> list[KisQuote]:
        """관심종목/스크리너 결과 코드들의 현재가+등락률 (intstock-multprice)."""
        return await _fetch_multi_price(
            lambda *, path, tr_id, params: self._get(path=path, tr_id=tr_id, params=params),
            codes,
        )

    # ------------------------------------------------------------------
    # fetch_investor_net (FHPTJ04160001, investor-trade-by-stock-daily)
    # ------------------------------------------------------------------

    async def fetch_investor_net(
        self, code: str, from_yyyymmdd: str, to_yyyymmdd: str
    ) -> InvestorNetFetchResult:
        """Fetch daily foreign/institution net-buy quantities for *code* across
        [from, to] (KST).

        KIS TR_ID: FHPTJ04160001 (investor-trade-by-stock-daily, 종목별 일별동향).
        Each call returns ``FID_INPUT_DATE_1`` (an anchor day) plus the prior
        ~30 trading days under ``output2``; we re-anchor to (page oldest − 1)
        and walk backward until the requested ``from`` is covered — the same
        cursor walk-back as ``fetch_past_daily_candles``. Net-buy *quantity*
        (frgn/orgn ``_ntby_qty``) is signed: positive = net buy, negative = net
        sell. Won-value siblings (``_ntby_tr_pbmn``) and the individual investor
        (``prsn``) are intentionally ignored.

        Returns InvestorNetFetchResult with:
        - points: ASC by t_ms; t_ms anchors at 09:00 KST of each trading day
          (same anchor as fetch_past_daily_candles via ``_daily_anchor_t_ms``).
        - violations: per-row drop reasons (malformed). Surfaced to data_warnings.

        Note: KIS finalizes the current day only after ~15:40 (가집계);
        historical rows are confirmed.
        """
        path = "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily"
        tr_id = "FHPTJ04160001"
        cursor_to = to_yyyymmdd  # FID_INPUT_DATE_1 anchor; walks back each page.
        points: list[InvestorNetPoint] = []
        violations: list[InvestorNetInvariantViolation] = []
        seen: set[str] = set()

        for _ in range(60):  # safety cap; ~30 rows/page → ~5 years of history
            params = {
                "FID_COND_MRKT_DIV_CODE": _STOCK_MRKT_DIV,
                "FID_INPUT_ISCD": code,
                "FID_INPUT_DATE_1": cursor_to,
                "FID_ORG_ADJ_PRC": "",
                "FID_ETC_CLS_CODE": "",
            }
            body = await self._get(path=path, tr_id=tr_id, params=params)
            # output2 holds the daily array (output1 is a current-price summary).
            rows = body.get("output2")
            if not isinstance(rows, list):
                rows = []
            page_oldest: str | None = None
            page_progress = False

            for row in rows:
                date_str = row.get("stck_bsop_date") or ""
                if len(date_str) != 8:
                    row_key = "malformed:" + json.dumps(row, sort_keys=True)
                    if row_key in seen:
                        continue
                    seen.add(row_key)
                    violations.append(InvestorNetInvariantViolation(
                        date_yyyymmdd=date_str or "(empty)",
                        reason="malformed_row",
                        detail="stck_bsop_date missing or wrong length",
                    ))
                    page_progress = True
                    continue
                if date_str in seen:
                    continue
                seen.add(date_str)
                page_progress = True
                if page_oldest is None or date_str < page_oldest:
                    page_oldest = date_str
                # Range filter — a page can overshoot the requested window.
                if date_str < from_yyyymmdd or date_str > to_yyyymmdd:
                    continue
                try:
                    frgn = int(row.get("frgn_ntby_qty") or "0")
                    orgn = int(row.get("orgn_ntby_qty") or "0")
                except (ValueError, TypeError) as e:
                    violations.append(InvestorNetInvariantViolation(
                        date_yyyymmdd=date_str,
                        reason="malformed_row",
                        detail=f"net-qty parse: {e}",
                    ))
                    continue
                points.append(InvestorNetPoint(
                    t_ms=_daily_anchor_t_ms(date_str),
                    foreign_net=frgn,
                    institution_net=orgn,
                ))

            # Stop on an empty page, no new rows (fixture replays same payload),
            # or once we've paged back to/past the requested start.
            if not rows or not page_progress:
                break
            if page_oldest is None or page_oldest <= from_yyyymmdd:
                break
            cursor_to = _prev_day_yyyymmdd(page_oldest)

        points.sort(key=lambda p: p.t_ms)
        return InvestorNetFetchResult(points=points, violations=violations)

    # ------------------------------------------------------------------
    # fetch_orderbook (FHKST01010200, inquire-asking-price-exp-ccn)
    # ------------------------------------------------------------------

    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        """Fetch 10-level real-time orderbook for *code* (e.g. '005930').

        ADR-0067 보는종목 표시폴러용. _get_with_rate_retry·토큰버킷 재사용.
        """
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
            tr_id="FHKST01010200",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
            },
        )
        out1 = body["output1"]
        asks = [
            OrderbookLevel(price=int(out1[f"askp{i}"]), qty=int(out1[f"askp_rsqn{i}"]))
            for i in range(1, 11)
        ]
        bids = [
            OrderbookLevel(price=int(out1[f"bidp{i}"]), qty=int(out1[f"bidp_rsqn{i}"]))
            for i in range(1, 11)
        ]
        return KisOrderbook(
            code=code,
            asks=asks,
            bids=bids,
            total_ask_qty=int(out1["total_askp_rsqn"]),
            total_bid_qty=int(out1["total_bidp_rsqn"]),
            t_ms=int(datetime.now(KIS_KST).timestamp() * 1000),
        )

    # ------------------------------------------------------------------
    # fetch_trades (FHPST01060000, inquire-time-itemconclusion)
    # ------------------------------------------------------------------

    async def fetch_trades(self, code: str) -> list[KisTrade]:
        """Fetch per-trade history via inquire-time-itemconclusion (FHPST01060000).

        ADR-0067 보는종목 표시폴러용. Lee-Ready side 분류 적용.
        Auction window trades get side=2.
        """
        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion",
            tr_id="FHPST01060000",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
                "fid_input_hour_1": "153000",
            },
        )
        today_kst = datetime.now(KIS_KST).date()
        trades: list[KisTrade] = []
        for row in body["output2"]:
            hhmmss = row["stck_cntg_hour"]
            hh = int(hhmmss[:2])
            mm = int(hhmmss[2:4])
            ss = int(hhmmss[4:6])
            dt = datetime(
                today_kst.year, today_kst.month, today_kst.day,
                hh, mm, ss, tzinfo=KIS_KST
            )
            t_ms = int(dt.timestamp() * 1000)
            prpr = int(row["stck_prpr"])
            askp = int(row.get("askp", "0") or "0")
            bidp = int(row.get("bidp", "0") or "0")
            side, side_source = classify_side(t_ms, prpr, askp, bidp)
            trades.append(KisTrade(
                price=prpr,
                qty=int(row["cnqn"]),
                side=side,
                side_source=side_source,
                t_ms=t_ms,
            ))
        return trades

    # ------------------------------------------------------------------
    # fetch_brokers (FHKST01010600, inquire-member)
    # ------------------------------------------------------------------

    async def fetch_brokers(self, code: str) -> KisBrokers:
        """Fetch top-5 buy/sell broker breakdown for *code*.

        ADR-0067 보는종목 표시폴러용. Broker names are canonicalized at the
        boundary so downstream sees the same canonical KRX member-firm name
        (see ``hoga.broker_names`` and CONTEXT.md).
        """
        from hoga.broker_names import canonical

        body = await self._get(
            path="/uapi/domestic-stock/v1/quotations/inquire-member",
            tr_id="FHKST01010600",
            params={
                "fid_cond_mrkt_div_code": _STOCK_MRKT_DIV,
                "fid_input_iscd": code,
            },
        )
        out = body["output"][0]  # KIS returns a 1-element list (Audit-3)
        buy_top = [
            KisBrokerEntry(
                name=canonical(out[f"shnu_mbcr_name{i}"]),
                qty=int(out[f"total_shnu_qty{i}"]),
            )
            for i in range(1, 6)
        ]
        sell_top = [
            KisBrokerEntry(
                name=canonical(out[f"seln_mbcr_name{i}"]),
                qty=int(out[f"total_seln_qty{i}"]),
            )
            for i in range(1, 6)
        ]
        return KisBrokers(code=code, buy_top=buy_top, sell_top=sell_top)

_MULTI_PRICE_CHUNK = 30  # intstock-multprice: 최대 30종목/콜 (FHKST11300006)


def _build_multi_price_params(codes_chunk: list[str]) -> dict[str, str]:
    """FID_COND_MRKT_DIV_CODE_N / FID_INPUT_ISCD_N (N=1..30) 번호 키 빌드."""
    params: dict[str, str] = {}
    for n, c in enumerate(codes_chunk, start=1):
        params[f"FID_COND_MRKT_DIV_CODE_{n}"] = _STOCK_MRKT_DIV  # "J"
        params[f"FID_INPUT_ISCD_{n}"] = c
    return params


def _parse_ohlc_field(raw: object) -> int | None:
    """당일 OHLC 한 필드 → int|None. price 파서와 달리 0으로 위조하지 않는다
    (0 은 양봉/음봉 판정·[low,high] 스케일 분모를 오염). 빈값/파싱실패/<=0 → None."""
    if raw in (None, ""):
        return None
    try:
        v = int(float(raw))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _parse_change(row: dict) -> tuple[float | None, int | None]:
    """(change_pct, change_won). prdy_ctrt 빈값/파싱실패·미인식 부호코드면 (None, None)
    — 절대값 필드라 부호 없으면 양수 위조 금지(#11)."""
    raw_ctrt = row.get("prdy_ctrt")
    if raw_ctrt in (None, ""):
        return None, None
    try:
        mag = abs(float(raw_ctrt))
    except (TypeError, ValueError):
        return None, None
    sign = str(row.get("prdy_vrss_sign", ""))
    mult = {"1": 1.0, "2": 1.0, "4": -1.0, "5": -1.0, "3": 0.0}.get(sign)
    if mult is None:
        return None, None
    change_won = _parse_change_won(row.get("inter2_prdy_vrss") or row.get("prdy_vrss"), mult)
    return mult * mag, change_won


def _parse_quote(row: dict) -> KisQuote | None:
    """multprice output 한 항목 → KisQuote.

    코드는 **행 자신의 `inter_shrn_iscd`** 에서 읽는다 — 요청 순서가 아니라 응답이
    스스로 식별한 종목코드라, KIS 가 무효 코드를 빈 placeholder 행으로 채우거나
    행 순서를 바꿔도 값이 엉뚱한 종목에 붙지 않는다. `inter_shrn_iscd` 가 비면
    (무효/placeholder 행) None 을 돌려 호출부가 건너뛰게 한다.

    price = inter2_prpr. change_pct = prdy_ctrt(절대값), change_won =
    inter2_prdy_vrss(절대값) 에 prdy_vrss_sign 을 공통 적용 (1·2 상한/상승=양수,
    4·5 하한/하락=음수, 3 보합=0). prdy_ctrt 가 빈값/파싱실패거나 부호코드가
    1·2·3·4·5 밖(방향 불명)이면 change_pct·change_won 모두 None — 필드가 절대값이라
    부호를 못 붙이므로 양수로 위조하지 않고 미표시한다.
    """
    code = (row.get("inter_shrn_iscd") or "").strip()
    if not code:
        return None
    try:
        price = int(float(row.get("inter2_prpr") or "0"))
    except (TypeError, ValueError):
        price = 0
    # change 와 OHLC 는 독립 필드군 — 끝에서 한 번만 생성해 어느 쪽 결측에도 다른 쪽 누락 없게.
    change_pct, change_won = _parse_change(row)
    return KisQuote(
        code=code, price=price, change_pct=change_pct, change_won=change_won,
        open=_parse_ohlc_field(row.get("inter2_oprc")),
        high=_parse_ohlc_field(row.get("inter2_hgpr")),
        low=_parse_ohlc_field(row.get("inter2_lwpr")),
    )


def _parse_change_won(raw: str | None, mult: float) -> int | None:
    """전일대비 등락액(원). raw 는 절대값(빈값/파싱실패 → None); mult(부호코드 멀티
    플라이어)로 방향을 적용한다 (호출부가 mult!=None 을 보장)."""
    if raw in (None, ""):
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    return int(mult * abs(v))


async def _fetch_multi_price(get, codes: list[str]) -> list["KisQuote"]:
    """get: async (*, path, tr_id, params)->dict (KisClient._get 와 동일 시그니처).
    30개씩 청크해 intstock-multprice 호출. 청크는 동시 호출(직렬 RTT 제거; 15/s 버킷은
    _get 가 캡). 각 행을 **응답 자신의 inter_shrn_iscd** 로 매핑(위치 의존 X — 누락/
    재정렬·빈 placeholder 행 안전). 빈/무효 행은 건너뛴다."""
    chunks = [codes[i:i + _MULTI_PRICE_CHUNK] for i in range(0, len(codes), _MULTI_PRICE_CHUNK)]
    bodies = await asyncio.gather(*(
        get(
            path="/uapi/domestic-stock/v1/quotations/intstock-multprice",
            tr_id="FHKST11300006",
            params=_build_multi_price_params(chunk),
        )
        for chunk in chunks
    ))
    out: list[KisQuote] = []
    for body in bodies:
        for row in (body.get("output") or []):
            q = _parse_quote(row)
            if q is not None:
                out.append(q)
    return out
