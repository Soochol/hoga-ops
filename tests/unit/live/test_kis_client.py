"""Stage 1 / Task 1.1 + 1.2 — KIS HTTP client tests."""
import json
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_client import (
    KIS_KST, KisApiError, KisAuthError, KisClient, KisCredentials,
)


@pytest.mark.asyncio
async def test_issue_token_caches_to_disk(tmp_path: Path) -> None:
    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            200,
            json={"access_token": "MOCK_TOKEN", "expires_in": 86400, "token_type": "Bearer"},
        )
    )
    cache = tmp_path / "token.json"
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=cache,
        _transport=transport,
    )
    try:
        token = await client.get_access_token()
        assert token == "MOCK_TOKEN"
        assert cache.exists()
        cached = json.loads(cache.read_text())
        assert cached["access_token"] == "MOCK_TOKEN"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_issue_token_failure_raises(tmp_path: Path) -> None:
    transport = httpx.MockTransport(
        lambda req: httpx.Response(401, json={"error_code": "E001", "error_description": "bad"})
    )
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=transport,
    )
    try:
        with pytest.raises(KisAuthError):
            await client.get_access_token()
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_token_near_expiry_triggers_reissue(tmp_path: Path) -> None:
    near_expiry = (datetime.now(KIS_KST) + timedelta(minutes=5)).isoformat()
    cache = tmp_path / "token.json"
    cache.write_text(json.dumps({"access_token": "STALE", "expires_at": near_expiry}))

    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            200,
            json={"access_token": "FRESH", "expires_in": 86400, "token_type": "Bearer"},
        )
    )
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=cache,
        _transport=transport,
    )
    try:
        token = await client.get_access_token()
        assert token == "FRESH"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_reissue_cooldown_blocks_second_call_within_60s(tmp_path: Path) -> None:
    """Audit-3: KIS limits token issuance to 1 per minute."""
    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            200,
            json={"access_token": "TOK", "expires_in": 86400, "token_type": "Bearer"},
        )
    )
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=transport,
    )
    try:
        # First issue succeeds
        token = await client.get_access_token()
        assert token == "TOK"
        # Simulate immediate cache invalidation + state reset to force a SECOND _issue.
        # We blank in-memory state and delete disk cache. The cool-down should still kick.
        client._token = None
        client._token_expires_at = None
        (tmp_path / "token.json").unlink()
        with pytest.raises(KisAuthError, match="cooldown"):
            await client.get_access_token()
    finally:
        await client.aclose()


def _make_client_with_5xx(
    tmp_path: Path, status: int, body, content_type: str = "application/json"
) -> KisClient:
    """Mock both the token endpoint (200) and quote endpoint (status, body)."""
    def handler(req: httpx.Request) -> httpx.Response:
        if "oauth2/tokenP" in req.url.path:
            return httpx.Response(
                200,
                json={"access_token": "TOK", "expires_in": 86400, "token_type": "Bearer"},
            )
        if isinstance(body, dict):
            return httpx.Response(status, json=body)
        return httpx.Response(
            status, content=body, headers={"content-type": content_type},
        )
    transport = httpx.MockTransport(handler)
    return KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=transport,
    )


@pytest.mark.asyncio
async def test_5xx_with_json_body_preserves_upstream_msg_cd(tmp_path: Path) -> None:
    """KIS sometimes wraps a domain error in a 5xx — keep its msg_cd visible.

    Without this, the poller log shows `msg_cd=HTTP_500` for both a real
    gateway 5xx and a domain error like "session not open"; the operator
    can't tell them apart.
    """
    client = _make_client_with_5xx(
        tmp_path, 500, {"rt_cd": "1", "msg_cd": "EGW00121", "msg1": "장시간이 아닙니다"},
    )
    try:
        with pytest.raises(KisApiError) as exc_info:
            await client.fetch_orderbook("003490")
        err = exc_info.value
        assert err.msg_cd == "HTTP_500/EGW00121"
        assert err.msg1 == "장시간이 아닙니다"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_5xx_with_non_json_body_falls_back_to_text(tmp_path: Path) -> None:
    """Gateway HTML / plain-text 5xx bodies keep the historical raw-text path."""
    client = _make_client_with_5xx(
        tmp_path, 502, b"<html><body>502 Bad Gateway</body></html>",
        content_type="text/html",
    )
    try:
        with pytest.raises(KisApiError) as exc_info:
            await client.fetch_orderbook("003490")
        err = exc_info.value
        assert err.msg_cd == "HTTP_502"
        assert "Bad Gateway" in err.msg1
    finally:
        await client.aclose()
