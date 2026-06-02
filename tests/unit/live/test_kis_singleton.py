from pathlib import Path

import pytest

from hoga.live import lifecycle
from hoga.live.kis_client import KisCredentials


@pytest.fixture(autouse=True)
def _reset_singleton():
    # Reset before AND after each test so no test leaks a fake-cred KisClient
    # into the module-global _kis_client (which would make later tests in the
    # same process order-dependent — see code-review #10).
    lifecycle.reset_for_tests()
    yield
    lifecycle.reset_for_tests()


def test_ensure_returns_same_instance(tmp_path: Path):
    creds = KisCredentials(app_key="k", app_secret="s")
    a = lifecycle.ensure_kis_client(tmp_path / "t.json", creds)
    b = lifecycle.ensure_kis_client(tmp_path / "t.json", creds)
    assert a is b  # 단일 인스턴스(단일 토큰버킷)


def test_from_env_returns_none_without_creds(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)
    assert lifecycle.ensure_kis_client_from_env(tmp_path) is None


def test_from_env_resolves_and_reuses_singleton(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k")
    monkeypatch.setenv("KIS_APP_SECRET", "s")
    a = lifecycle.ensure_kis_client_from_env(tmp_path)
    b = lifecycle.ensure_kis_client_from_env(tmp_path)
    assert a is not None and a is b  # single env→creds resolver → single bucket
