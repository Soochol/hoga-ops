"""부품1 — account_id별 KIS client/provider dict (ADR-0067 / spec §4)."""
from pathlib import Path

import pytest

import hoga.live.kis_runtime as kis_runtime


@pytest.fixture(autouse=True)
def _reset():
    kis_runtime.reset_for_tests()
    yield
    kis_runtime.reset_for_tests()


def test_account_env_suffix_convention():
    assert kis_runtime._account_env(0) == ("KIS_APP_KEY", "KIS_APP_SECRET")
    assert kis_runtime._account_env(1) == ("KIS_APP_KEY_2", "KIS_APP_SECRET_2")
    assert kis_runtime._account_env(2) == ("KIS_APP_KEY_3", "KIS_APP_SECRET_3")


def test_token_cache_path_backcompat(tmp_path: Path):
    # account 0 keeps legacy filename; account k>0 gets a per-account file.
    assert kis_runtime._token_cache_path(tmp_path, 0) == tmp_path / ".local" / "kis-token.json"
    assert kis_runtime._token_cache_path(tmp_path, 1) == tmp_path / ".local" / "kis-token-1.json"


def test_configured_account_ids_single(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)
    assert kis_runtime.configured_account_ids(tmp_path) == [0]


def test_configured_account_ids_two(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    assert kis_runtime.configured_account_ids(tmp_path) == [0, 1]


def test_configured_account_ids_stops_at_gap(tmp_path, monkeypatch):
    # account 0 only; account 1 missing → list stops (no [0, 2] skip).
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.setenv("KIS_APP_KEY_3", "k2")
    monkeypatch.setenv("KIS_APP_SECRET_3", "s2")
    assert kis_runtime.configured_account_ids(tmp_path) == [0]


def test_for_account_distinct_clients_per_account(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    assert c0 is not None and c1 is not None and c0 is not c1
    assert c0._creds.app_key == "k0"
    assert c1._creds.app_key == "k1"
    # idempotent per account (one bucket each)
    assert kis_runtime.ensure_kis_client_for_account(0, tmp_path) is c0


def test_for_account_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)
    assert kis_runtime.ensure_kis_client_for_account(1, tmp_path) is None
