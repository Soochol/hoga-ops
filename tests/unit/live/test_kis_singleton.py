"""lifecycle KIS singleton wiring (Phase 1 — provider injection)."""
from pathlib import Path

import pytest

import hoga.live.kis_runtime as kis_runtime
from hoga.live.kis_client import KisCredentials

# Singleton reset is provided by tests/unit/live/conftest.py (_reset_live_singletons).


def test_ensure_token_provider_is_singleton(tmp_path: Path) -> None:
    creds = KisCredentials(app_key="K", app_secret="S", env="real")
    p1 = kis_runtime.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    p2 = kis_runtime.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    assert p1 is p2


def test_ensure_kis_client_injects_shared_provider(tmp_path: Path) -> None:
    creds = KisCredentials(app_key="K", app_secret="S", env="real")
    provider = kis_runtime.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    client = kis_runtime.ensure_kis_client(creds, provider)
    assert client._token_provider is provider


def test_ensure_kis_client_is_singleton(tmp_path: Path) -> None:
    creds = KisCredentials(app_key="K", app_secret="S", env="real")
    provider = kis_runtime.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    c1 = kis_runtime.ensure_kis_client(creds, provider)
    c2 = kis_runtime.ensure_kis_client(creds, provider)
    assert c1 is c2


def test_from_env_returns_none_without_creds(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)
    assert kis_runtime.ensure_kis_client_from_env(tmp_path) is None


def test_from_env_resolves_and_reuses_singleton(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KIS_APP_KEY", "k")
    monkeypatch.setenv("KIS_APP_SECRET", "s")
    a = kis_runtime.ensure_kis_client_from_env(tmp_path)
    b = kis_runtime.ensure_kis_client_from_env(tmp_path)
    assert a is not None and a is b  # single env→creds resolver → single bucket


@pytest.mark.asyncio
async def test_aclose_closes_and_nulls_both_singletons(tmp_path: Path) -> None:
    creds = KisCredentials(app_key="K", app_secret="S", env="real")
    provider = kis_runtime.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    client = kis_runtime.ensure_kis_client(creds, provider)
    assert kis_runtime._kis_clients[0] is client
    await kis_runtime.aclose_kis_client()
    assert kis_runtime._kis_clients == {}
    assert kis_runtime._kis_token_providers == {}
