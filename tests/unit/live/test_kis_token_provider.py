"""KisTokenProvider — sync token acquisition tests (Phase 1, ADR-0050 amendment)."""
import json
import threading
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_client import KIS_KST, KisAuthError, KisCredentials
from hoga.live.kis_token_provider import KisTokenProvider, _key_fingerprint


def _creds() -> KisCredentials:
    return KisCredentials(app_key="K", app_secret="S", env="real")


def _disk_cache_json(token: str, expires_at: str, *, app_key: str = "K") -> str:
    """Handwritten cache file in the on-disk schema (incl. app-key identity)."""
    return json.dumps({
        "access_token": token,
        "expires_at": expires_at,
        "app_key_sha256": _key_fingerprint(app_key),
    })


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
        assert (cache.stat().st_mode & 0o777) == 0o600
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
    """Concurrent get_token issues exactly once AND the lock serializes the
    issue path: at most one thread is ever inside the issuance handler.

    The sleep widens the race window so that a MISSING lock would let multiple
    threads overlap inside the handler (max > 1) — making the assertions below
    actually load-bearing, not vacuously green.
    """
    import time as _time

    calls = {"n": 0}
    concurrency = {"active": 0, "max": 0}
    state_lock = threading.Lock()

    def handler(req: httpx.Request) -> httpx.Response:
        with state_lock:
            concurrency["active"] += 1
            concurrency["max"] = max(concurrency["max"], concurrency["active"])
            calls["n"] += 1
        _time.sleep(0.02)  # hold the issue path open so a missing lock overlaps
        with state_lock:
            concurrency["active"] -= 1
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
        assert calls["n"] == 1          # exactly one issuance
        assert concurrency["max"] == 1  # the lock serialized the issue path
    finally:
        provider.close()


def test_valid_disk_cache_returns_without_issue(tmp_path: Path) -> None:
    """A fresh provider with a far-future disk token returns it without any POST."""
    far_future = (datetime.now(KIS_KST) + timedelta(hours=20)).isoformat()
    cache = tmp_path / "token.json"
    cache.write_text(_disk_cache_json("DISK", far_future))
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": "X", "expires_in": 86400})

    provider = KisTokenProvider(_creds(), cache, _transport=httpx.MockTransport(handler))
    try:
        assert provider.get_token() == "DISK"
        assert calls["n"] == 0  # served from disk, no issuance
    finally:
        provider.close()


def test_disk_cache_for_other_app_key_is_a_miss(tmp_path: Path) -> None:
    """Key rotation: a valid-looking token issued for ANOTHER app key must not
    be served — it is a guaranteed auth mismatch with the new key's headers.
    Pre-fix this was served for up to ~24h with no recovery path."""
    far_future = (datetime.now(KIS_KST) + timedelta(hours=20)).isoformat()
    cache = tmp_path / "token.json"
    cache.write_text(_disk_cache_json("OLD_KEY_TOKEN", far_future, app_key="ROTATED_AWAY"))
    transport = httpx.MockTransport(
        lambda req: httpx.Response(200, json={"access_token": "FRESH", "expires_in": 86400})
    )
    provider = KisTokenProvider(_creds(), cache, _transport=transport)
    try:
        assert provider.get_token() == "FRESH"
    finally:
        provider.close()


def test_corrupt_non_dict_cache_falls_through_to_issue(tmp_path: Path) -> None:
    """A cache file holding non-dict JSON ('[1]' → TypeError on key access)
    must fall through to re-issuance, not raise on every get_token forever."""
    cache = tmp_path / "token.json"
    cache.write_text("[1]")
    transport = httpx.MockTransport(
        lambda req: httpx.Response(200, json={"access_token": "FRESH", "expires_in": 86400})
    )
    provider = KisTokenProvider(_creds(), cache, _transport=transport)
    try:
        assert provider.get_token() == "FRESH"
    finally:
        provider.close()


def test_invalidate_drops_memory_and_disk(tmp_path: Path) -> None:
    """invalidate() clears both tiers so the next get_token issues fresh —
    the recovery path for a server-side token rejection (EGW00121/00123)."""
    tokens = iter(["FIRST", "SECOND"])
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": next(tokens), "expires_in": 86400})

    cache = tmp_path / "token.json"
    provider = KisTokenProvider(_creds(), cache, _transport=httpx.MockTransport(handler))
    try:
        assert provider.get_token() == "FIRST"
        assert cache.exists()
        provider.invalidate()
        assert not cache.exists()
        # bypass the 1/min cooldown — invalidate must not be the thing that
        # resets it (KIS limits issuance regardless of why we want a new one)
        provider._last_issued_monotonic_ms = None
        assert provider.get_token() == "SECOND"
        assert calls["n"] == 2
    finally:
        provider.close()


def test_failed_issue_attempt_still_arms_cooldown(tmp_path: Path) -> None:
    """The cooldown marker is set on ATTEMPT, not success: a failing/hanging
    KIS auth endpoint must not be re-POSTed on every cache miss (each POST
    blocks a thread up to 10s — pre-fix this was an unthrottled stall storm)."""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, text="boom")

    provider = KisTokenProvider(
        _creds(), tmp_path / "token.json", _transport=httpx.MockTransport(handler)
    )
    try:
        with pytest.raises(KisAuthError, match="HTTP 500"):
            provider.get_token()
        with pytest.raises(KisAuthError, match="cooldown"):
            provider.get_token()
        assert calls["n"] == 1  # second miss hit the cooldown, not the network
    finally:
        provider.close()
