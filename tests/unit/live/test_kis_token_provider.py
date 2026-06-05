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
