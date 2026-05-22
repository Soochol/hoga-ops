from __future__ import annotations

from pathlib import Path

import pytest

from hoga.config import Config, CookieMissingError, resolve_data_dir


def test_cookie_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOGAPLAY_COOKIE", "k_=abc; n_=xyz")
    cfg = Config(repo_root=tmp_path)
    assert cfg.cookie() == "k_=abc; n_=xyz"


def test_cookie_from_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOGAPLAY_COOKIE", raising=False)
    (tmp_path / ".cookie").write_text("k_=fromfile; n_=v\n", encoding="utf-8")
    cfg = Config(repo_root=tmp_path)
    assert cfg.cookie() == "k_=fromfile; n_=v"


def test_cookie_missing_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOGAPLAY_COOKIE", raising=False)
    cfg = Config(repo_root=tmp_path)
    with pytest.raises(CookieMissingError):
        cfg.cookie()


def test_paths(tmp_path: Path) -> None:
    cfg = Config(repo_root=tmp_path)
    assert cfg.raw_dir("20260519", "003490") == tmp_path / "data" / "raw" / "20260519" / "003490"
    assert (
        cfg.parquet_dir("20260519", "003490")
        == tmp_path / "data" / "parquet" / "20260519" / "003490"
    )


def test_resolve_data_dir_env_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path / "explicit"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    # Env takes priority over XDG.
    assert resolve_data_dir() == tmp_path / "explicit"


def test_resolve_data_dir_xdg_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("HOGA_DATA_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert resolve_data_dir() == tmp_path / "xdg" / "hoga-ops" / "data"


def test_resolve_data_dir_default_local_share(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("HOGA_DATA_DIR", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    # Falls back to ~/.local/share/hoga-ops/data (XDG default).
    assert resolve_data_dir() == tmp_path / ".local" / "share" / "hoga-ops" / "data"


def test_resolve_data_dir_ignores_cwd(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Regression: pre-Option-A default was cwd/data. Switching cwd to a
    # worktree must NOT change the resolved data dir — that's the entire
    # point (captures land in the machine-global store).
    monkeypatch.delenv("HOGA_DATA_DIR", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.chdir(tmp_path / "some" / "worktree" if False else tmp_path)
    assert resolve_data_dir() == tmp_path / ".local" / "share" / "hoga-ops" / "data"
