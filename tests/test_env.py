"""Tests for hoga/env.py — .env loader with worktree → main-repo fallback (ADR-0008)."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


def _purge_keys(monkeypatch: pytest.MonkeyPatch, *keys: str) -> None:
    for k in keys:
        monkeypatch.delenv(k, raising=False)


@pytest.fixture(autouse=True)
def _reset_env_discovery():
    """Reset the cached discovery between tests (cache is per-process).

    Tests monkeypatch `_WORKING_TREE` and `_main_repo_root`, but the
    discovery cache persists across tests. Without this reset, test 2
    would see test 1's cached Path.
    """
    import hoga.env as env_module
    env_module.reset_discovery_for_tests()
    yield
    env_module.reset_discovery_for_tests()


def test_returns_none_when_no_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    monkeypatch.setattr(env_module, "_main_repo_root", lambda: None)
    assert env_module.load_env() is None


def test_loads_env_file_into_os_environ(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    (tmp_path / ".env").write_text("KRX_ID=u\nKRX_PW=p\n", encoding="utf-8")
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    _purge_keys(monkeypatch, "KRX_ID", "KRX_PW")

    loaded = env_module.load_env()
    assert loaded == tmp_path / ".env"
    assert os.environ["KRX_ID"] == "u"
    assert os.environ["KRX_PW"] == "p"


def test_override_false_preserves_existing_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    (tmp_path / ".env").write_text("KRX_ID=fromfile\n", encoding="utf-8")
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    monkeypatch.setenv("KRX_ID", "fromshell")

    env_module.load_env(override=False)
    assert os.environ["KRX_ID"] == "fromshell"


def test_override_true_overwrites_existing_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    (tmp_path / ".env").write_text("KRX_ID=fromfile\n", encoding="utf-8")
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    monkeypatch.setenv("KRX_ID", "fromshell")

    env_module.load_env(override=True)
    assert os.environ["KRX_ID"] == "fromfile"


def test_worktree_fallback_to_main_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """ADR-0008: worktree has no .env → main repo .env is loaded."""
    import hoga.env as env_module

    worktree = tmp_path / "worktree"
    main_repo = tmp_path / "main"
    worktree.mkdir()
    main_repo.mkdir()
    (main_repo / ".env").write_text("KRX_ID=fromMain\n", encoding="utf-8")

    monkeypatch.setattr(env_module, "_WORKING_TREE", worktree)
    monkeypatch.setattr(env_module, "_main_repo_root", lambda: main_repo)
    _purge_keys(monkeypatch, "KRX_ID")

    loaded = env_module.load_env()
    assert loaded == main_repo / ".env"
    assert os.environ["KRX_ID"] == "fromMain"


def test_worktree_env_wins_over_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """When both exist, the worktree-local .env wins."""
    import hoga.env as env_module

    worktree = tmp_path / "worktree"
    main_repo = tmp_path / "main"
    worktree.mkdir()
    main_repo.mkdir()
    (worktree / ".env").write_text("KRX_ID=fromWorktree\n", encoding="utf-8")
    (main_repo / ".env").write_text("KRX_ID=fromMain\n", encoding="utf-8")

    monkeypatch.setattr(env_module, "_WORKING_TREE", worktree)
    monkeypatch.setattr(env_module, "_main_repo_root", lambda: main_repo)
    _purge_keys(monkeypatch, "KRX_ID")

    loaded = env_module.load_env()
    assert loaded == worktree / ".env"
    assert os.environ["KRX_ID"] == "fromWorktree"


def test_main_repo_root_returns_none_when_git_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    def _raise(*args, **kwargs):
        raise FileNotFoundError("git binary missing")

    monkeypatch.setattr(env_module.subprocess, "run", _raise)
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    assert env_module._main_repo_root() is None


def test_discovery_is_cached_across_calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Subprocess git call should run at most once per process.

    Verifies that calling load_env() N times triggers _main_repo_root() at most once.
    """
    import hoga.env as env_module

    (tmp_path / ".env").write_text("KRX_ID=u\n", encoding="utf-8")
    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)

    call_count = {"n": 0}
    def _spy() -> None:
        call_count["n"] += 1
        return None
    monkeypatch.setattr(env_module, "_main_repo_root", _spy)

    env_module.load_env()
    env_module.load_env(override=True)
    env_module.load_env()
    # _main_repo_root is only consulted when the local .env is absent,
    # so with a local .env present it should be called 0 times.
    assert call_count["n"] == 0, "local .env present should short-circuit before calling _main_repo_root"


def test_discovery_cache_only_one_subprocess_when_falling_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fallback path also caches — subprocess runs once."""
    import hoga.env as env_module

    worktree = tmp_path / "worktree"
    main_repo = tmp_path / "main"
    worktree.mkdir()
    main_repo.mkdir()
    (main_repo / ".env").write_text("KRX_ID=u\n", encoding="utf-8")

    monkeypatch.setattr(env_module, "_WORKING_TREE", worktree)
    call_count = {"n": 0}
    def _spy() -> Path:
        call_count["n"] += 1
        return main_repo
    monkeypatch.setattr(env_module, "_main_repo_root", _spy)

    env_module.load_env()
    env_module.load_env()  # cached
    env_module.load_env()  # cached
    assert call_count["n"] == 1, (
        "_main_repo_root should be called exactly once across N load_env() calls "
        "with override=False (the cache-warming path)"
    )


def test_override_true_always_rediscovers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """override=True bypasses the discovery cache.

    Cold boot with no .env caches a None discovery. If the user then creates
    .env and hits the Refresh button (which calls load_env(override=True)),
    the cached None would otherwise block hot-reload. Verifies the bug fix
    discovered during T15 manual verification.
    """
    import hoga.env as env_module

    monkeypatch.setattr(env_module, "_WORKING_TREE", tmp_path)
    monkeypatch.setattr(env_module, "_main_repo_root", lambda: None)
    _purge_keys(monkeypatch, "KRX_ID")

    # Cold boot: no .env present.
    assert env_module.load_env() is None
    assert "KRX_ID" not in os.environ

    # User creates .env after boot.
    (tmp_path / ".env").write_text("KRX_ID=appeared-after-boot\n", encoding="utf-8")

    # Refresh path should re-discover and pick up the new file.
    loaded = env_module.load_env(override=True)
    assert loaded == tmp_path / ".env"
    assert os.environ["KRX_ID"] == "appeared-after-boot"


def test_krx_creds_present_truthiness(monkeypatch: pytest.MonkeyPatch) -> None:
    import hoga.env as env_module

    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    assert env_module.krx_creds_present() is False

    monkeypatch.setenv("KRX_ID", "u")
    assert env_module.krx_creds_present() is False  # PW still missing

    monkeypatch.setenv("KRX_PW", "")
    assert env_module.krx_creds_present() is False  # empty string is falsy

    monkeypatch.setenv("KRX_PW", "p")
    assert env_module.krx_creds_present() is True
