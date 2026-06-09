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

from .kis_client import KisClient, KisCredentials
from .kis_token_provider import KisTokenProvider

_kis_clients: dict[int, KisClient] = {}
_kis_token_providers: dict[int, KisTokenProvider] = {}
_lock = threading.Lock()


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
            prov = KisTokenProvider(creds, token_cache_path)
            _kis_token_providers[account_id] = prov
        return prov


def ensure_kis_client(
    creds: KisCredentials, provider: KisTokenProvider, account_id: int = 0
) -> KisClient:
    """Return the per-account KisClient singleton, creating it once.

    "one app key = one 15/s bucket" holds PER ACCOUNT — each account_id has at
    most one client. account 0 carries the data bucket (REST poller / quotes /
    holiday / screener); account k>0 is used ONLY for WS approval keys (spec §4).
    Closed at process shutdown via aclose_kis_client — a stream/conn stop must NOT
    close it (R1).
    """
    global _kis_clients
    with _lock:
        client = _kis_clients.get(account_id)
        if client is None:
            client = KisClient(credentials=creds, token_provider=provider)
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

    Backcompat alias for ensure_kis_client_for_account(0, ...) — the shared
    15/s-bucket client used by REST poller / quotes / holiday / screener.
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


# ── Role-based account routing (2026-06-09 account-split) ──────────────────────
# #53이 2계좌 인증을 깔면서 account 1의 REST 15/s 버킷이 통째로 유휴였다(WS approval
# 전용). 이 라우터는 사용자가 차트 그려지길 기다리는 foreground REST(past-candles/
# daily)를 account 0 전용으로, 백그라운드 REST(rest_poller·quotes·investor·screener)를
# account 1로 보내 — 사용자 fetch가 백그라운드와 아예 경합하지 않게 하고 총 REST를
# 30/s로 만든다. N=1(키 1개)이거나 account 1이 저하/미설정이면 account 0로 폴백하며,
# 이때는 ②(_TokenBucket foreground 우선순위)가 공유 버킷에서 foreground를 보호한다.

def _account_degraded(account_id: int) -> bool:
    """account_id의 WS 연결이 저하 상태인가 — background를 그 계정으로 보내기 전
    프리엠티브 폴백 신호(#53 degraded 신호 재사용). lifecycle을 late import해 순환을
    피한다(lifecycle→kis_runtime이 정방향 의존). 신호를 못 얻으면 보수적으로 False
    (저하 아님으로 간주 — 최종 가드는 ensure 단계의 None 체크와 호출부 격리)."""
    try:
        from . import lifecycle  # noqa: PLC0415 — late import: 순환 회피
        return account_id in lifecycle.degraded_account_ids()
    except Exception:  # noqa: BLE001 — 신호 조회 실패는 라우팅을 막지 않는다
        return False


def kis_for_role(role: str, data_dir: Path) -> KisClient | None:
    """role('foreground'|'background')에 따라 account별 KisClient를 반환한다(호출
    시점 평가 → degraded 동적 폴백, 별도 상태 동기화 불필요).

    - foreground: 항상 account 0(사용자 전용 15/s, 백그라운드와 경합 없음).
    - background: N≥2 & account 1 비-degraded면 account 1(ensure로 WS 유무와 무관하게
      REST 버킷 확보), 아니면 account 0 폴백.

    N=2 정상 분리에선 acct0=foreground만·acct1=background만이라 ② foreground 우선순위는
    dormant. N=1/degraded 폴백 시 공유 버킷이 되어 ②가 활성화된다.

    background가 ensure_kis_client_for_account(1)로 acct1 REST 버킷을 *직접* 확보하는
    이유: lifecycle은 작은 관심목록(≤13종목)에서 conn[1]을 안 만든다(빈 파티션 →
    연결 없음, lifecycle §6). get_kis_client(1)에 의존하면 그 흔한 경우에 acct1이
    None이라 조용히 acct0로 폴백 → 30/s 이득이 무효가 된다. ensure는 WS conn 유무와
    무관하게(관심목록 크기와 무관하게) acct1 버킷을 확보한다. 첫 REST bearer 토큰
    발급은 ensure/get 무관하게 첫 호출에서 일어나므로(FM5) 'REST 선접촉 회피' 논거는
    적용되지 않는다."""
    if role == "background" and 1 in configured_account_ids(data_dir) and not _account_degraded(1):
        client = ensure_kis_client_for_account(1, data_dir)
        if client is not None:
            return client
    # account 0 폴백: 이미 생성/주입된 싱글톤 우선(부팅 생성 + 라우트 fake 주입), 없으면
    # env에서 지연 생성(빈 관심목록·무갭일 등 싱글톤 미생성 상태 — /quotes lazy-init 승계).
    existing = get_kis_client(0)
    if existing is not None:
        return existing
    return ensure_kis_client_from_env(data_dir)


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
    global _kis_clients, _kis_token_providers
    for prov in list(_kis_token_providers.values()):
        try:
            prov.close()
        except Exception:  # noqa: BLE001
            pass
    _kis_clients = {}
    _kis_token_providers = {}
