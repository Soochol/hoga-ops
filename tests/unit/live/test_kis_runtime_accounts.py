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
