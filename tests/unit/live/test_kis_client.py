"""Stage 1 / Task 1.1 + 1.2 — KIS HTTP client tests."""
import json
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_client import KIS_KST, KisAuthError, KisClient, KisCredentials


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
