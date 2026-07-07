"""KIS process-resource singletons (token provider + client).

Extracted from lifecycle.py (SPEC §10, 아키텍처 그릴링 2026-06-05) so that
poller-independent consumers — the sync holiday path (kis_holidays), the
screener EOD update, /api/live/quotes — obtain KIS resources without importing
the poller lifecycle module. Singleton-ness is unchanged (ADR-0038/0050):
one token provider + one client (one 15/s bucket) per process; closed only at
process shutdown via aclose_kis_client.

Thread-safety: the ensure_* getters are reached concurrently from the event
loop (poller start, /quotes lazy ensure, screener recovery) and executor
threads (calendar month fetch, captures range expansion) — ``_lock`` makes the
check-then-create atomic so two threads can't each build a provider (split
cooldown state + a leaked httpx.Client). Construction does no I/O, so the
critical section is microseconds.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

from . import account_health
from .kis_client import KisClient, KisCredentials, _TokenBucket
from .kis_token_provider import KisTokenProvider

_kis_clients: dict[int, KisClient] = {}
_kis_token_providers: dict[int, KisTokenProvider] = {}
_lock = threading.Lock()

# 같은 명의의 계좌들은 KIS 유량제한을 '명의 단위'로 공유한다(/investigate
# 2026-07-07: 3계좌 × 15/s = 45/s 송신 → ~47% EGW00201). 그래서 프로세스의
# 모든 KisClient가 하나의 전역 버킷에서 토큰을 소비해 합산 송신을 명의
# 한도(~20/s) 아래로 묶는다. capacity를 rate보다 작게 잡아 유휴→포화 전이의
# 첫 1초 burst(용량+리필)가 KIS 고정윈도를 넘지 않게 한다. foreground 양보
# (ADR-0087)도 계좌별이 아니라 전역에서 일관 동작하게 되는 부수 이득.
_GLOBAL_KIS_RATE_PER_SEC = 15.0
_GLOBAL_KIS_BURST_CAPACITY = 4.0
_global_rate_limiter: _TokenBucket | None = None


def _shared_rate_limiter() -> _TokenBucket:
    """명의-전역 토큰버킷 싱글톤 — 런타임이 만드는 모든 KisClient가 공유.

    호출자가 ``_lock``을 이미 쥔 상태에서 부른다(ensure_kis_client 내부).
    threading.Lock은 재진입 불가라 여기서 다시 잡으면 데드락 — check-then-create
    원자성은 호출자의 락이 보장한다.
    """
    global _global_rate_limiter
    if _global_rate_limiter is None:
        _global_rate_limiter = _TokenBucket(
            rate=_GLOBAL_KIS_RATE_PER_SEC,
            capacity=_GLOBAL_KIS_BURST_CAPACITY,
        )
    return _global_rate_limiter

# FM5 REST-auth latch + WS-degraded 통합 신호는 account_health(leaf)로 추출됨(2026-06-10).
# 토큰 provider 콜백이 account_health.mark_rest_auth_degraded를, KisAccountPool.eligible_accounts가
# account_health.is_rest_degraded를 쓴다(REST 라우팅은 REST latch만 — WS저하와 직교, 2026-06-10)
# — kis_runtime은 더는 lifecycle을 late import하지 않는다.


def _account_env(account_id: int) -> tuple[str, str]:
    """account_id(0-based) → (KEY 환경변수명, SECRET 환경변수명).

    0 = KIS_APP_KEY/SECRET(접미 없음, 기존). k>0 = 접미 (k+1) = '사람이 세는
    번호' → account_id=1 ↔ KIS_APP_KEY_2/KIS_APP_SECRET_2 (사장님 '2번째 키').
    스펙 §4 단일 정의 (위험 #6).
    """
    if account_id == 0:
        return "KIS_APP_KEY", "KIS_APP_SECRET"
    suffix = account_id + 1
    return f"KIS_APP_KEY_{suffix}", f"KIS_APP_SECRET_{suffix}"


def _token_cache_path(data_dir: Path, account_id: int) -> Path:
    """토큰 캐시 경로. account 0 = 기존 kis-token.json(backcompat — 기존 배포가
    토큰 재발급 강제당하지 않음), k>0 = kis-token-{k}.json (스펙 §2 결정 B)."""
    name = "kis-token.json" if account_id == 0 else f"kis-token-{account_id}.json"
    return data_dir / ".local" / name


def get_kis_client(account_id: int = 0) -> KisClient | None:
    return _kis_clients.get(account_id)


def set_kis_client(client: KisClient | None, account_id: int = 0) -> None:
    """Stage 8 hook: inject a KisClient for an account (default 0)."""
    if client is None:
        _kis_clients.pop(account_id, None)
    else:
        _kis_clients[account_id] = client


def ensure_kis_token_provider(
    token_cache_path: Path, creds: KisCredentials, account_id: int = 0
) -> KisTokenProvider:
    """Return the per-account KisTokenProvider singleton, creating it once.

    One provider per account (ADR-0038/0067). The token cache path is decided
    by the caller (see _token_cache_path) — account 0 keeps the legacy file.
    """
    global _kis_token_providers
    with _lock:
        prov = _kis_token_providers.get(account_id)
        if prov is None:
            # on_issue_failure: REST 토큰 발급 실패 시 이 account를 REST-degraded latch
            # (FM5). account_id를 클로저로 바인딩 → 토큰 chokepoint가 어느 계정인지 안다.
            prov = KisTokenProvider(
                creds,
                token_cache_path,
                on_issue_failure=lambda: account_health.mark_rest_auth_degraded(account_id),
            )
            _kis_token_providers[account_id] = prov
        return prov


def ensure_kis_client(
    creds: KisCredentials, provider: KisTokenProvider, account_id: int = 0
) -> KisClient:
    """Return the per-account KisClient singleton, creating it once.

    Each account_id has at most one client, but the RATE BUDGET is 명의-전역:
    all runtime clients share ``_shared_rate_limiter()`` (KIS enforces the
    limit per customer, not per app key — see the global-bucket comment above).
    REST capacity scheduling may lease any configured account; WS approval
    keys also reuse these per-account clients.
    Closed at process shutdown via aclose_kis_client — a stream/conn stop must NOT
    close it (R1).
    """
    global _kis_clients
    with _lock:
        client = _kis_clients.get(account_id)
        if client is None:
            client = KisClient(
                credentials=creds,
                token_provider=provider,
                rate_limiter=_shared_rate_limiter(),
            )
            _kis_clients[account_id] = client
        return client


def _reload_env_for_retry() -> None:
    """Re-read .env (non-override — shell env still wins). A dedicated seam so
    the test suite can no-op it (an autouse conftest guard does): without the
    guard, any test reaching the retry path re-loads the developer's REAL
    .env and silently un-does monkeypatch.delenv creds isolation."""
    from hoga.env import load_env  # late import: keeps module import light

    load_env()


def _resolve_env_creds(
    account_id: int = 0, *, reload_env: bool = False
) -> KisCredentials | None:
    """env → KisCredentials for the account, or None when its key/secret absent.

    ``reload_env`` re-reads .env once on a miss (user-retry paths only; boot
    paths keep boot-time env semantics). account 0 uses KIS_APP_KEY/SECRET;
    account k>0 uses the suffixed names (see _account_env).
    """
    key_name, sec_name = _account_env(account_id)
    app_key = os.environ.get(key_name)
    app_secret = os.environ.get(sec_name)
    if (not app_key or not app_secret) and reload_env:
        _reload_env_for_retry()
        app_key = os.environ.get(key_name)
        app_secret = os.environ.get(sec_name)
    if not app_key or not app_secret:
        return None
    return KisCredentials(app_key=app_key, app_secret=app_secret, env="real")


def ensure_kis_token_provider_from_env(
    data_dir: Path | None = None,
    *,
    reload_env: bool = False,
) -> tuple[KisTokenProvider, KisCredentials] | None:
    """Resolve account-0 creds from env and return (provider, creds), or None.
    For consumers that need the token + auth headers but NOT the async data
    client (e.g. the sync holiday path). account-0 only (backcompat)."""
    creds = _resolve_env_creds(0, reload_env=reload_env)
    if creds is None:
        return None
    if data_dir is None:
        from hoga.config import resolve_data_dir

        data_dir = resolve_data_dir()
    provider = ensure_kis_token_provider(_token_cache_path(data_dir, 0), creds, 0)
    return provider, creds


def ensure_kis_client_for_account(account_id: int, data_dir: Path) -> KisClient | None:
    """Resolve the account's creds from env and return its KisClient singleton,
    or None when that account's key/secret are absent.

    account 0 lands its token cache at the legacy path; k>0 at kis-token-{k}.json.
    Used by lifecycle._build_conn(account_id) for the per-account WS approval key.
    """
    creds = _resolve_env_creds(account_id)  # boot semantics (no reload_env)
    if creds is None:
        return None
    provider = ensure_kis_token_provider(
        _token_cache_path(data_dir, account_id), creds, account_id
    )
    return ensure_kis_client(creds, provider, account_id)


def ensure_kis_client_from_env(data_dir: Path) -> KisClient | None:
    """account-0 KisClient singleton, or None when creds absent.

    Backcompat alias for ensure_kis_client_for_account(0, ...) — useful for
    legacy account-0 fallback and single-account installs.
    """
    return ensure_kis_client_for_account(0, data_dir)


def configured_account_ids(data_dir: Path) -> list[int]:
    """Contiguous list of account_ids whose env key+secret are present, starting
    at 0. [0] when only account 0 is set (→ 13종목·1스트림 폴백); [0, 1] when
    KIS_APP_KEY_2/SECRET_2 also set (→ 26종목). Stops at the first gap (no skips).
    """
    ids: list[int] = []
    account_id = 0
    while _resolve_env_creds(account_id) is not None:
        ids.append(account_id)
        account_id += 1
    return ids


# account 라우팅은 KisAccountPool(kis_account_pool) + KisCapacityScheduler로 옮겨졌고
# (ADR-0082), kis_runtime은 리소스 소유(account별 싱글톤·ensure_*·env creds)만 담당한다.


async def aclose_kis_client() -> None:
    """Close and drop ALL per-account KisClient + KisTokenProvider singletons —
    PROCESS shutdown only. A stream/conn stop must not call this (R1)."""
    global _kis_clients, _kis_token_providers
    for client in list(_kis_clients.values()):
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass
    _kis_clients = {}
    for prov in list(_kis_token_providers.values()):
        try:
            prov.close()
        except Exception:  # noqa: BLE001
            pass
    _kis_token_providers = {}


def reset_for_tests() -> None:
    """Test helper — drop all per-account singletons (best-effort provider close)."""
    global _kis_clients, _kis_token_providers, _global_rate_limiter
    for prov in list(_kis_token_providers.values()):
        try:
            prov.close()
        except Exception:  # noqa: BLE001
            pass
    _kis_clients = {}
    _kis_token_providers = {}
    _global_rate_limiter = None  # 명의-전역 버킷도 초기화(테스트 격리)
    account_health.reset_for_tests()  # FM5 latch + WS probe 초기화(테스트 격리)
