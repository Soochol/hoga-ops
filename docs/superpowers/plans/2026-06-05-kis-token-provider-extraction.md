# KisTokenProvider 추출 Implementation Plan (Phase 1/4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KIS 액세스 토큰 획득을 `KisClient`에서 독립 모듈 `KisTokenProvider`로 추출해, async fetch 경로와 (Phase 3에서 추가될) 동기 휴장일 경로가 하나의 토큰 캐시·쿨다운을 공유하게 한다.

**Architecture:** 현재 `KisClient`에 갇힌 토큰 3단계 캐시(메모리→디스크→발급)·1분 쿨다운·chmod 600 로직을 동기 `KisTokenProvider.get_token()` 뒤로 옮긴다. 발급을 동기 `httpx.Client`로 하여 이벤트루프와 무관하게 만들고, `threading.Lock`으로 멀티스레드 호출(이벤트루프 스레드 + executor + 동기 라우트 threadpool)을 보호한다. `KisClient`는 provider를 주입받아 `_do_get_once`에서 동기로 토큰을 얻고, `httpx.AsyncClient`는 데이터 fetch 전용으로 남는다. 이 Phase는 KRX→KIS 이전과 독립이며 라이브 트레이딩 클라이언트 상대로 단독 검증된다.

**Tech Stack:** Python 3, httpx (sync `Client` + async `AsyncClient`), pytest + pytest-asyncio, `httpx.MockTransport`.

**참조 spec/ADR:** `docs/superpowers/specs/2026-06-05-krx-to-kis-migration-design.md` §3.1·§5.5, `docs/adr/0050-kis-rate-limit-retry-in-client.md` Amendment(2026-06-05).

**테스트 실행 규칙:** 이 repo는 dev 의존성이 optional group이라 `uv run --extra dev pytest ...`로 실행한다(`uv run pytest`는 "No module named pytest"로 죽는다).

---

## File Structure

- **Create** `hoga/live/kis_token_provider.py` — `KisTokenProvider` 클래스. 책임: 유효한 KIS bearer 토큰 하나를 동기로 공급(캐시·발급·쿨다운·만료·락 은폐). 외부 인터페이스는 `get_token() -> str` + `close()`.
- **Modify** `hoga/live/kis_client.py` — 토큰 메서드 4개(`get_access_token`/`_issue_token`/`_read_cache`/`_write_cache`) 제거, 생성자가 `token_provider`를 주입받음, `_do_get_once`가 provider에서 동기로 토큰 취득. `httpx.AsyncClient`는 fetch 전용.
- **Modify** `hoga/live/lifecycle.py` — `KisTokenProvider` 프로세스 싱글턴 소유 + 토큰 경로 결정(현 `:148`), `ensure_kis_client`가 provider를 받아 `KisClient`에 주입, shutdown 시 provider도 close.
- **Create** `tests/unit/live/test_kis_token_provider.py` — 토큰 캐시/발급/만료/쿨다운/스레드안전 테스트(현 `test_kis_client.py`의 토큰 테스트를 동기로 이전).
- **Modify** `tests/unit/live/test_kis_client.py` — 토큰 테스트 4개 제거, fetch 테스트의 `KisClient(...)` 생성을 fake provider 주입으로 교체.

---

## Task 1: KisTokenProvider 모듈

**Files:**
- Create: `hoga/live/kis_token_provider.py`
- Test: `tests/unit/live/test_kis_token_provider.py`

- [ ] **Step 1: Write the failing tests**

`tests/unit/live/test_kis_token_provider.py`:

```python
"""KisTokenProvider — sync token acquisition tests (Phase 1, ADR-0050 amendment)."""
import json
import threading
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_client import KIS_KST, KisAuthError, KisCredentials
from hoga.live.kis_token_provider import KisTokenProvider


def _creds() -> KisCredentials:
    return KisCredentials(app_key="K", app_secret="S", env="real")


def test_issue_token_caches_to_disk(tmp_path: Path) -> None:
    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            200,
            json={"access_token": "MOCK_TOKEN", "expires_in": 86400, "token_type": "Bearer"},
        )
    )
    cache = tmp_path / "token.json"
    provider = KisTokenProvider(_creds(), cache, _transport=transport)
    try:
        assert provider.get_token() == "MOCK_TOKEN"
        assert cache.exists()
        assert json.loads(cache.read_text())["access_token"] == "MOCK_TOKEN"
    finally:
        provider.close()


def test_issue_token_failure_raises(tmp_path: Path) -> None:
    transport = httpx.MockTransport(
        lambda req: httpx.Response(401, json={"error_code": "E001", "error_description": "bad"})
    )
    provider = KisTokenProvider(_creds(), tmp_path / "token.json", _transport=transport)
    try:
        with pytest.raises(KisAuthError):
            provider.get_token()
    finally:
        provider.close()


def test_token_near_expiry_triggers_reissue(tmp_path: Path) -> None:
    near_expiry = (datetime.now(KIS_KST) + timedelta(minutes=5)).isoformat()
    cache = tmp_path / "token.json"
    cache.write_text(json.dumps({"access_token": "STALE", "expires_at": near_expiry}))
    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            200,
            json={"access_token": "FRESH", "expires_in": 86400, "token_type": "Bearer"},
        )
    )
    provider = KisTokenProvider(_creds(), cache, _transport=transport)
    try:
        assert provider.get_token() == "FRESH"
    finally:
        provider.close()


def test_reissue_cooldown_blocks_second_call_within_60s(tmp_path: Path) -> None:
    """Audit-3: KIS limits token issuance to 1 per minute."""
    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            200,
            json={"access_token": "TOK", "expires_in": 86400, "token_type": "Bearer"},
        )
    )
    cache = tmp_path / "token.json"
    provider = KisTokenProvider(_creds(), cache, _transport=transport)
    try:
        assert provider.get_token() == "TOK"
        # Force a SECOND issue: blank in-memory state + delete disk cache.
        provider._token = None
        provider._token_expires_at = None
        cache.unlink()
        with pytest.raises(KisAuthError, match="cooldown"):
            provider.get_token()
    finally:
        provider.close()


def test_memory_cache_hit_avoids_second_issue(tmp_path: Path) -> None:
    """Second get_token within validity returns cached token without a new POST."""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            200,
            json={"access_token": "TOK", "expires_in": 86400, "token_type": "Bearer"},
        )

    provider = KisTokenProvider(_creds(), tmp_path / "token.json", _transport=httpx.MockTransport(handler))
    try:
        assert provider.get_token() == "TOK"
        assert provider.get_token() == "TOK"
        assert calls["n"] == 1  # issued once, second call is a memory hit
    finally:
        provider.close()


def test_get_token_is_thread_safe(tmp_path: Path) -> None:
    """Concurrent get_token from many threads issues exactly once (lock holds)."""
    calls = {"n": 0}
    lock = threading.Lock()

    def handler(req: httpx.Request) -> httpx.Response:
        with lock:
            calls["n"] += 1
        return httpx.Response(
            200,
            json={"access_token": "TOK", "expires_in": 86400, "token_type": "Bearer"},
        )

    provider = KisTokenProvider(_creds(), tmp_path / "token.json", _transport=httpx.MockTransport(handler))
    results: list[str] = []
    results_lock = threading.Lock()

    def worker() -> None:
        tok = provider.get_token()
        with results_lock:
            results.append(tok)

    try:
        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert results == ["TOK"] * 8
        assert calls["n"] == 1  # the lock serialized issuance to exactly one POST
    finally:
        provider.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_token_provider.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.live.kis_token_provider'`

- [ ] **Step 3: Write the module**

`hoga/live/kis_token_provider.py`:

```python
"""KIS access-token provider — sync token acquisition.

Extracted from KisClient (ADR-0050 amendment 2026-06-05) so token lifecycle
lives in ONE place and both the event-loop fetch path (KisClient) and the
sync executor/threadpool holiday path (Phase 3) share one cache + cooldown.

Issuance is synchronous (httpx.Client) so this module never touches an event
loop — that is precisely what lets the sync calendar path reuse it without
the AsyncClient loop-binding hazard. get_token() is guarded by a
threading.Lock because it is called from three thread contexts at once:
the event-loop thread, executor threads, and FastAPI's sync-route threadpool.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx

from hoga.live.kis_client import (
    KIS_KST,
    _REISSUE_COOLDOWN_MS,
    KisAuthError,
    KisCredentials,
)


class KisTokenProvider:
    """Sync provider of a valid KIS bearer token.

    Interface: ``get_token() -> str`` (+ ``close()``). Hides the 3-tier cache
    (memory → disk → issue), the 10-minute early-refresh buffer, the
    1-per-minute reissue cooldown, and chmod-600 persistence. Thread-safe:
    cache hits lock-and-return with no I/O; only a genuine issue does network,
    inside the lock, so concurrent callers serialize to a single POST.
    """

    def __init__(
        self,
        credentials: KisCredentials,
        token_cache_path: Path,
        *,
        _transport: Optional[httpx.BaseTransport] = None,
    ):
        self._creds = credentials
        self._cache_path = token_cache_path
        self._client = httpx.Client(
            base_url=credentials.base_url, transport=_transport, timeout=10.0
        )
        self._token: Optional[str] = None
        self._token_expires_at: Optional[datetime] = None
        # monotonic clock so NTP steps / DST don't confuse the cooldown.
        self._last_issued_monotonic_ms: Optional[int] = None
        self._lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def get_token(self) -> str:
        with self._lock:
            # in-memory hit (early-refresh 10 min before expiry)
            if (
                self._token
                and self._token_expires_at
                and datetime.now(KIS_KST) < self._token_expires_at - timedelta(minutes=10)
            ):
                return self._token
            # disk cache hit
            cached = self._read_cache()
            if cached:
                self._token, self._token_expires_at = cached
                return self._token
            return self._issue_token()

    def _issue_token(self) -> str:
        """Issue a fresh access_token via POST /oauth2/tokenP.

        Caller holds ``self._lock``. KIS limits issuance to 1/min and returns
        the SAME token for any reissue within 6 hours — so the disk cache is
        essential and a real issue is rare in steady state.
        """
        now_ms = int(time.monotonic() * 1000)
        if (
            self._last_issued_monotonic_ms is not None
            and now_ms - self._last_issued_monotonic_ms < _REISSUE_COOLDOWN_MS
        ):
            raise KisAuthError(
                "token reissue cooldown: KIS allows 1 issuance per minute"
            )
        resp = self._client.post(
            "/oauth2/tokenP",
            json={
                "grant_type": "client_credentials",
                "appkey": self._creds.app_key,
                "appsecret": self._creds.app_secret,
            },
        )
        if resp.status_code != 200:
            raise KisAuthError(
                f"token issue failed: HTTP {resp.status_code} {resp.text[:200]}"
            )
        body = resp.json()
        token: str = body["access_token"]
        expires_in = int(body.get("expires_in", 86400))
        expires_at = datetime.now(KIS_KST) + timedelta(seconds=expires_in)
        self._token = token
        self._token_expires_at = expires_at
        self._last_issued_monotonic_ms = now_ms
        self._write_cache(token, expires_at)
        return token

    def _read_cache(self) -> Optional[tuple[str, datetime]]:
        if not self._cache_path.exists():
            return None
        try:
            data = json.loads(self._cache_path.read_text())
            exp = datetime.fromisoformat(data["expires_at"])
            if datetime.now(KIS_KST) >= exp - timedelta(minutes=10):
                return None
            return data["access_token"], exp
        except (json.JSONDecodeError, KeyError, ValueError):
            return None

    def _write_cache(self, token: str, expires_at: datetime) -> None:
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._cache_path.write_text(
            json.dumps({"access_token": token, "expires_at": expires_at.isoformat()})
        )
        self._cache_path.chmod(0o600)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_token_provider.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_token_provider.py tests/unit/live/test_kis_token_provider.py
git commit -m "feat(kis): KisTokenProvider — sync token acquisition (ADR-0050 amendment)"
```

---

## Task 2: KisClient가 provider를 주입받도록 수정

`KisClient`에서 토큰 4개 메서드를 제거하고, 생성자가 `token_provider`를 받아 `_do_get_once`에서 동기로 토큰을 얻게 한다. `httpx.AsyncClient`는 fetch 전용으로 남는다.

**Files:**
- Modify: `hoga/live/kis_client.py:243-347` (생성자 + 토큰 메서드 4개), `hoga/live/kis_client.py:401-402` (`_do_get_once` 토큰 취득)
- Create: `tests/unit/live/_fakes.py` (공유 `FakeTokenProvider`)
- Test: `tests/unit/live/test_kis_client.py`, `tests/unit/live/test_kis_rest_methods.py`(8곳), `tests/unit/live/test_kis_daily_adjust_flag.py`(1곳) — **생성자 시그니처 변경은 `KisClient(...)`를 생성하는 모든 live 테스트 파일에 fallout을 낸다. 한 파일만 고치면 전체 스위트가 RED로 남는다.**

- [ ] **Step 1: Add a TYPE_CHECKING import for the provider**

`hoga/live/kis_client.py` 상단 import 블록(`from typing import Any, Literal, Optional` 줄 아래)에 추가:

```python
from typing import TYPE_CHECKING, Any, Literal, Optional

if TYPE_CHECKING:
    from hoga.live.kis_token_provider import KisTokenProvider
```

(기존 `from typing import Any, Literal, Optional` 줄을 위 두 줄로 교체. 런타임 import가 아니므로 순환이 생기지 않는다 — provider가 kis_client를 import할 때 kis_client는 provider를 런타임 import하지 않는다.)

- [ ] **Step 2: Replace the constructor and delete the four token methods**

`hoga/live/kis_client.py`의 `__init__`(243-270) + `get_access_token`/`_issue_token`/`_read_cache`/`_write_cache`(275-347) 전체를 아래로 교체:

```python
    def __init__(
        self,
        credentials: KisCredentials,
        token_provider: "KisTokenProvider",
        *,
        _transport: Optional[httpx.AsyncBaseTransport] = None,
        _rate_limit_per_sec: float = _RATE_LIMIT_CALLS_PER_SEC,
        _rate_limit_backoff: tuple[float, ...] = _RATE_LIMIT_BACKOFF,
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

    async def aclose(self) -> None:
        await self._client.aclose()
```

(즉 `aclose` 바로 다음에 있던 `get_access_token`·`_issue_token`·`_read_cache`·`_write_cache` 네 메서드를 통째로 삭제한다. `_get`(349~)은 그대로 둔다. 토큰 상태 필드 `_token`/`_token_expires_at`/`_last_issued_monotonic_ms`/`_cache_path`도 함께 사라진다.)

- [ ] **Step 3: Update `_do_get_once` to get the token synchronously**

`hoga/live/kis_client.py:401-402`의 두 줄

```python
        await self._rate_limiter.acquire()
        token = await self.get_access_token()
```

를 다음으로 교체:

```python
        await self._rate_limiter.acquire()
        token = self._token_provider.get_token()
```

(나머지 `_do_get_once` 본문은 그대로. `get_token()`은 동기이고 캐시 히트면 즉시 반환하며, 6시간에 한 번 발급 시에만 ~200ms 블로킹한다.)

- [ ] **Step 4: Update test_kis_client.py — remove token tests, inject a fake provider**

`tests/unit/live/test_kis_client.py`에서:

(a) import에서 토큰 관련을 정리하고 fake provider를 추가한다. 파일 상단 import 블록을 다음으로 교체:

```python
"""Stage 1 / Task 1.1 + 1.2 — KIS HTTP client tests."""
import asyncio
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_client import (
    KisApiError,
    KisClient,
    KisCredentials,
    KisRateLimitError,
    _TokenBucket,
)


class _FakeTokenProvider:
    """Minimal sync provider stub for KisClient fetch tests — fetch paths
    don't exercise issuance, so a constant token is sufficient."""

    def __init__(self, token: str = "MOCK_TOKEN") -> None:
        self._token = token

    def get_token(self) -> str:
        return self._token

    def close(self) -> None:
        pass
```

(b) 토큰 테스트 4개 — `test_issue_token_caches_to_disk`, `test_issue_token_failure_raises`, `test_token_near_expiry_triggers_reissue`, `test_reissue_cooldown_blocks_second_call_within_60s`(현 23-113) — 를 **삭제**한다. 이들은 Task 1의 `test_kis_token_provider.py`로 이전되었다.

(c) 남은 fetch 테스트에서 `KisClient(...)`를 생성하는 모든 곳의 `token_cache_path=...` 인자를 `_FakeTokenProvider()`로 교체한다. 패턴:

```python
# 변경 전:
client = KisClient(
    credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
    token_cache_path=tmp_path / "token.json",
    _transport=transport,
)
# 변경 후:
client = KisClient(
    credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
    token_provider=_FakeTokenProvider(),
    _transport=transport,
)
```

`_make_client_with_5xx` 헬퍼(116~)를 포함해 `token_cache_path=`가 나오는 모든 생성 지점에 적용한다. **여기서 그치지 말 것** — `test_kis_rest_methods.py`(8곳)와 `test_kis_daily_adjust_flag.py`(1곳)도 `KisClient(token_cache_path=...)`로 생성하므로, 공유 `_fakes.FakeTokenProvider`를 두 파일에 import해 모두 변환한다. 확인:

Run: `grep -rn "token_cache_path" tests/unit/live/`
Expected: 0줄 (세 파일 전부 변환되어야 한다 — 한 파일만 고치면 시그니처 fallout으로 전체 스위트가 RED).

- [ ] **Step 5: Run the full kis_client + provider test set**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_client.py tests/unit/live/test_kis_token_provider.py -v`
Expected: PASS (fetch 테스트 전부 + provider 6개). 토큰 테스트는 provider 파일에만 존재.

- [ ] **Step 6: Commit**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_client.py
git commit -m "refactor(kis): KisClient injects KisTokenProvider, token methods removed"
```

---

## Task 3: lifecycle 싱글턴 와이어링

`KisTokenProvider`를 프로세스 싱글턴으로 소유하고, 토큰 경로를 여기서 결정하며, `ensure_kis_client`가 provider를 `KisClient`에 주입한다.

**Files:**
- Modify: `hoga/live/lifecycle.py:25` (import), `:61` (싱글턴 전역), `:110-148` (ensure_* 함수), `:151-164` (aclose)
- Test: `tests/unit/live/test_kis_singleton.py` (존재하면 시그니처 갱신)

- [ ] **Step 1: Write/adjust the failing test**

`tests/unit/live/test_kis_singleton.py`가 있으면 `ensure_kis_client` 호출 시그니처를 새 형태로 바꾼다. 없으면 아래 테스트 파일을 생성:

```python
"""lifecycle KIS singleton wiring (Phase 1 — provider injection)."""
from pathlib import Path

import hoga.live.lifecycle as lifecycle
from hoga.live.kis_client import KisCredentials


def _reset() -> None:
    lifecycle._kis_client = None
    lifecycle._kis_token_provider = None


def test_ensure_token_provider_is_singleton(tmp_path: Path) -> None:
    _reset()
    creds = KisCredentials(app_key="K", app_secret="S", env="real")
    p1 = lifecycle.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    p2 = lifecycle.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    assert p1 is p2
    _reset()


def test_ensure_kis_client_injects_shared_provider(tmp_path: Path) -> None:
    _reset()
    creds = KisCredentials(app_key="K", app_secret="S", env="real")
    provider = lifecycle.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    client = lifecycle.ensure_kis_client(creds, provider)
    assert client._token_provider is provider
    _reset()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_singleton.py -v`
Expected: FAIL — `AttributeError: module 'hoga.live.lifecycle' has no attribute 'ensure_kis_token_provider'`

- [ ] **Step 3: Wire the provider singleton into lifecycle**

(a) `hoga/live/lifecycle.py:25`의 import를 교체:

```python
from .kis_client import KisClient, KisCredentials
from .kis_token_provider import KisTokenProvider
```

(b) `:61`의 `_kis_client: KisClient | None = None` 아래에 추가:

```python
_kis_token_provider: KisTokenProvider | None = None
```

(c) `ensure_kis_client`(110-127)를 provider 주입 형태로 교체:

```python
def ensure_kis_token_provider(
    token_cache_path: Path, creds: KisCredentials
) -> KisTokenProvider:
    """Return the process-wide KisTokenProvider singleton, creating it once.

    Token lifecycle (cache + 1/min cooldown) must be shared by the async fetch
    path (KisClient) and the sync holiday path (Phase 3), so there is exactly
    ONE provider per process. The token cache path is decided here — the single
    source that downstream consumers inherit.
    """
    global _kis_token_provider
    if _kis_token_provider is None:
        _kis_token_provider = KisTokenProvider(creds, token_cache_path)
    return _kis_token_provider


def ensure_kis_client(creds: KisCredentials, provider: KisTokenProvider) -> KisClient:
    """Return the process-wide KisClient singleton, creating it once.

    The KIS rate-limit invariant ("one app key = one 15/s token bucket")
    requires exactly ONE KisClient per process, decoupled from poller
    start/stop. The injected ``provider`` supplies tokens; the client owns only
    the fetch AsyncClient + rate bucket. Closed at process shutdown via
    ``aclose_kis_client`` — a poller stop must NOT close it.
    """
    global _kis_client
    if _kis_client is None:
        _kis_client = KisClient(credentials=creds, token_provider=provider)
    return _kis_client
```

(d) `ensure_kis_client_from_env`(130-148)의 마지막 두 줄

```python
    creds = KisCredentials(app_key=app_key, app_secret=app_secret, env="real")
    return ensure_kis_client(data_dir / ".local" / "kis-token.json", creds)
```

를 교체:

```python
    creds = KisCredentials(app_key=app_key, app_secret=app_secret, env="real")
    provider = ensure_kis_token_provider(data_dir / ".local" / "kis-token.json", creds)
    return ensure_kis_client(creds, provider)
```

(e) `aclose_kis_client`(151-164)를 provider도 닫도록 교체:

```python
async def aclose_kis_client() -> None:
    """Close and drop the KisClient + KisTokenProvider singletons — PROCESS
    shutdown only. A poller stop must not call this.
    """
    global _kis_client, _kis_token_provider
    if _kis_client is not None:
        try:
            await _kis_client.aclose()
        except Exception:  # noqa: BLE001
            pass
        _kis_client = None
    if _kis_token_provider is not None:
        try:
            _kis_token_provider.close()
        except Exception:  # noqa: BLE001
            pass
        _kis_token_provider = None
```

- [ ] **Step 4: Run the singleton test**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_singleton.py -v`
Expected: PASS

- [ ] **Step 5: Run the full live suite to catch any caller drift**

Run: `uv run --extra dev pytest tests/unit/live/ -v`
Expected: PASS. 특히 `ensure_kis_client(...)` 시그니처 변경에 걸리는 호출자가 있으면 여기서 드러난다(현재 production 호출자는 `ensure_kis_client_from_env` 경유뿐 — (d)에서 갱신됨).

- [ ] **Step 6: Commit**

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_kis_singleton.py
git commit -m "feat(kis): lifecycle owns KisTokenProvider singleton, injects into KisClient"
```

---

## Task 4: 전체 회귀 + Phase 1 종료 검증

- [ ] **Step 1: Run the whole backend test suite**

Run: `uv run --extra dev pytest tests/ -q`
Expected: PASS. `KisClient` 생성 시그니처·토큰 메서드 제거가 다른 테스트를 깨지 않았는지 확인(라이브 트레이딩 클라이언트 동작 불변이 Phase 1의 합격 기준).

- [ ] **Step 2: Grep for stale references**

Run: `grep -rn "get_access_token\|token_cache_path" hoga/ tests/`
Expected: `hoga/` 결과 0줄(토큰 획득은 이제 provider 내부에만). `tests/`도 0줄.

- [ ] **Step 3: Confirm the loop-binding goal holds**

`hoga/live/kis_token_provider.py`가 `httpx.Client`(동기)만 쓰고 `asyncio`를 import하지 않음을 확인:

Run: `grep -n "asyncio\|AsyncClient" hoga/live/kis_token_provider.py`
Expected: 0줄 — provider는 이벤트루프와 무관하므로 Phase 3의 동기 휴장일 경로가 그대로 재사용할 수 있다.

- [ ] **Step 4: Final commit (if Step 1-3 surfaced any fixes)**

```bash
git add -A
git commit -m "test(kis): Phase 1 regression green — token extraction complete"
```

---

## Self-Review

**Spec coverage (§3.1 Step 1 / §5.5):**
- §5.5 "동기 `get_token()` 하나" → Task 1 인터페이스. ✓
- §5.5 "메모리→디스크→동기 발급, 만료 10분 버퍼, 1분 쿨다운, chmod 600" → Task 1 구현 + 테스트. ✓
- §5.5 "`get_access_token`/`_issue_token`/`_read_cache`/`_write_cache` provider로 이사" → Task 2 Step 2. ✓
- §5.5 "`_do_get_once`의 `await get_access_token()` → `self._token.get_token()` 동기" → Task 2 Step 3. ✓
- §5.5 "`httpx.AsyncClient`는 fetch 전용" → Task 2 Step 2(생성자에 AsyncClient 유지, 토큰은 provider). ✓
- §5.5 "`threading.Lock`으로 보호, 캐시 히트 lock-and-return, 발급만 락 안" → Task 1 `get_token` 구현 + `test_get_token_is_thread_safe`. ✓
- §5.5 "lifecycle 싱글턴 소유 + 토큰 경로 결정(현 :148)" → Task 3. ✓
- §3.1 "라이브 클라이언트 단독 검증, 기존 fetch 동작 불변" → Task 4 Step 1·3. ✓
- §9 "토큰 테스트 provider로 재배치 / KisClient fetch 테스트는 fake provider 주입" → Task 1(이전) + Task 2 Step 4. ✓

**Placeholder scan:** 모든 코드 step에 실제 코드 포함. "적절한 에러 처리"류 없음. ✓

**Type consistency:** `KisTokenProvider.__init__(credentials, token_cache_path, *, _transport)` / `get_token() -> str` / `close()` — Task 1 정의가 Task 2(주입), Task 3(생성)에서 동일하게 사용됨. `KisClient.__init__(credentials, token_provider, *, _transport, ...)` — Task 2 정의가 Task 3 `ensure_kis_client`에서 동일 호출. `ensure_kis_token_provider(token_cache_path, creds)` / `ensure_kis_client(creds, provider)` — Task 3 정의가 테스트와 일치. ✓

**확인된 사실 기반:** 토큰 메서드 외부 호출자 0(grep 확정), `_REISSUE_COOLDOWN_MS`/`KIS_KST`/`KisCredentials`/`KisAuthError`는 `kis_client.py`에 정의되어 provider가 import 가능, production `KisClient` 생성은 `ensure_kis_client_from_env` 경유뿐.
