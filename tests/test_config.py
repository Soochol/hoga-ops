from __future__ import annotations

from pathlib import Path

import pytest

from hoga.config import Config, CookieMissingError


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
