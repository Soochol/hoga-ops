"""KIS Open API HTTP client (직접 구현, ADR-0038 — 의존성 최소화).

Live Capture write-path uses this client. Per ADR-0038's invariant the
hot-path module never imports pyarrow/polars; this file should not either.

See Deep Sample Audit §C (Audit-3) for the 1-minute token cool-down and
KIS's 6-hour same-token reissue policy.

Stage 4 (2026-07-08) split the 13 endpoint fetch methods into
``kis_endpoints.KisEndpointsMixin`` and the error types into ``kis_errors``;
this file now owns the transport core (token bucket, retry ladder, _get). It
re-exports the moved symbols so the ~60 existing ``from hoga.live.kis_client
import ...`` sites stay unchanged (ADR-0050 single-ingress facade preserved).
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Optional

if TYPE_CHECKING:
    from hoga.live.kis_token_provider import KisTokenProvider

log = logging.getLogger(__name__)

import httpx

from hoga.live.kis_venue import KIS_KST  # noqa: F401  (re-export facade)
from hoga.live.kis_errors import (
    KisApiError,
    KisAuthError,
    KisRateLimitError,
    KisTransportError,
)

# Re-export facade (ADR-0050): these moved to kis_endpoints in Stage 4 but are
# re-exported here so existing ``from hoga.live.kis_client import ...`` callers
# and tests keep importing them from this module. Not referenced in-module.
from hoga.live.kis_endpoints import (  # noqa: F401
    KisEndpointsMixin,
    DailyCandleFetchResult,
    DailyInvariantViolation,
    IndexCandleFetchResult,
    IndexQuoteSnapshot,
    InvestorNetFetchResult,
    InvestorNetInvariantViolation,
    KisQuote,
    classify_side,
    _build_multi_price_params,
    _fetch_multi_price,
    _parse_index_daily_row,
    _parse_index_minute_row,
    _parse_market_investor_daily_row,
    _parse_quote,
    _prev_day_yyyymmdd,
)

_BASE_REAL = "https://openapi.koreainvestment.com:9443"

# KIS auth-failure msg_cds that mean "this TOKEN is bad" (expired/invalid) as
# opposed to "this request is bad". On these, `_get` invalidates the provider
# cache and retries once — without it a server-side revocation had no recovery
# path: the dead token was served from memory+disk until expires_at (~24h).
_TOKEN_INVALID_MSG_CDS = ("EGW00121", "EGW00123")

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

# EGW00201 바운스(rate-limit 후 재시도)의 프로세스 전역 단조 카운터. 설계상
# 포화 부하에서 ~9-12%의 요청이 EGW00201로 튕겼다가 재시도로 복구되는 것은
# '에러'가 아니라 흐름제어 신호다(ADR-0100) — 그래서 개별 이벤트를 WARN 로그로
# 흘리는 대신(로그 벽·경보 무뎌짐), 여기서 율로 집계해 사이클 단위 관측(레코더)에
# 넘긴다. 모든 계정별 KisClient가 공유하는 계정-합산 카운터라 모듈 전역이 맞다.
# 증가는 전부 이벤트루프(_get_with_rate_retry의 except)에서 일어나므로 락 불필요.
_rate_limit_bounces = 0


def rate_limit_bounces_total() -> int:
    """프로세스 시작 이후 누적 EGW00201 바운스 수(계정 합산). 소비자는 두 시점의
    델타를 떠서 사이클 바운스율을 계산한다 — Rest30sRecorder.poll_once 참조."""
    return _rate_limit_bounces


def reset_bounces_for_tests() -> None:
    """테스트 격리 — 전역 바운스 카운터를 0으로 되돌린다."""
    global _rate_limit_bounces
    _rate_limit_bounces = 0


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
        capacity: float | None = None,
        yield_s: float = _FG_YIELD_S,
        bg_max_yield_s: float = _BG_MAX_YIELD_S,
    ):
        if rate <= 0:
            raise ValueError("rate must be positive")
        # capacity = burst 상한(버킷 최대 토큰). None이면 기존 동작(= rate, 가득
        # 차서 시작). rate보다 작게 주면 유휴→포화 전이의 첫 1초 송신이
        # 'capacity + rate 리필'로 묶여 KIS 고정윈도 한도를 넘지 않는다.
        if capacity is not None and capacity <= 0:
            raise ValueError("capacity must be positive")
        # yield_s는 양보 중 재확인 간격이자 sleep 길이 — 0/음수면 양보 모드가
        # CPU busy-spin(라이브락)이 된다. bg_max_yield_s는 기아 백스톱 상한이라
        # 음수면 background가 즉시 강제 획득해 우선순위 자체가 무력화된다.
        if yield_s <= 0:
            raise ValueError("yield_s must be positive")
        if bg_max_yield_s < 0:
            raise ValueError("bg_max_yield_s must be non-negative")
        self._rate = float(rate)
        self._capacity = float(capacity if capacity is not None else rate)
        self._tokens = min(self._rate, self._capacity)
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
                        self._capacity,
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


class KisClient(KisEndpointsMixin):
    def __init__(
        self,
        credentials: KisCredentials,
        token_provider: "KisTokenProvider",
        *,
        rate_limiter: "_TokenBucket | None" = None,
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
        # ``rate_limiter`` 주입 시 그 버킷을 그대로 쓴다: KIS 유량제한은 앱키
        # 단위로 독립 집행되므로(실측 2026-07-10, ADR-0100) kis_runtime이 계정마다
        # 전용 버킷을 준다(kis_runtime._account_rate_limiter). 계정 수에 비례해
        # REST 콜레이트가 늘어난다. 미주입이면 자기 버킷(단독 클라이언트/테스트 backcompat).
        self._rate_limiter = (
            rate_limiter
            if rate_limiter is not None
            else _TokenBucket(rate=_rate_limit_per_sec)
        )
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
                global _rate_limit_bounces
                _rate_limit_bounces += 1
                if attempt + 1 >= attempts:
                    raise
                # 로그 레벨(2026-07-13 개정, ADR-0097/0102로 대상이 동시5→수백종목·
                # 10초주기로 커진 뒤): background 호출의 첫 바운스는 '설계된 손실률'이라
                # 개별 이벤트가 신호가 아니다 → DEBUG(레코더가 사이클 율로 집계). foreground
                # (사용자가 기다리는 차트 fetch)의 첫 바운스만 사용자 지연 신호이므로 WARNING
                # 유지. 소진 후 최종 raise는 불변 — 호출부의 kis_rate_limit data_warning /
                # cycle_failed 가 최종 신호를 담당한다.
                log_fn = log.warning if (attempt == 0 and foreground) else log.debug
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
