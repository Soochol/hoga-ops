"""Paths and cookie loading."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


class CookieMissingError(RuntimeError):
    """Raised when no cookie source is available."""


def resolve_data_dir() -> Path:
    """Return the canonical hoga-ops data directory.

    Resolution order:
      1. ``HOGA_DATA_DIR`` env var — explicit override (E2E sandboxes,
         temporary captures, scratch experiments).
      2. ``$XDG_DATA_HOME/hoga-ops/data`` if XDG_DATA_HOME is set.
      3. ``~/.local/share/hoga-ops/data`` — XDG default.

    Cwd is intentionally NOT consulted. Pre-Option-A the default was
    ``Path.cwd() / "data"``, which split captures across every git
    worktree (the same Stock-Date would be re-fetched on each branch,
    costing ~160MB and ~10 min per day per code). Captures are now
    machine-global by default.

    The legacy ``Config.from_cwd().data_dir`` (cwd/data) is left in place
    for callers that *want* a per-repo sandbox, but no production code
    path uses it.
    """
    env = os.environ.get("HOGA_DATA_DIR")
    if env:
        return Path(env)
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "hoga-ops" / "data"


def resolve_symbol_master_path() -> Path:
    """Return the canonical path for the persisted Symbol Master JSON.

    Resolution order:
      1. ``$XDG_DATA_HOME/hoga-ops/symbol-master.json`` if XDG_DATA_HOME is set.
      2. ``~/.local/share/hoga-ops/symbol-master.json`` — XDG default.

    Sibling of resolve_data_dir() but NOT inside data/. HOGA_DATA_DIR overrides
    do not apply — the Symbol Master is a machine-global KRX catalog, not
    capture data. Tests sandbox via monkeypatch on this function directly.
    """
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "hoga-ops" / "symbol-master.json"


def resolve_log_dir() -> Path:
    """Return the canonical hoga-ops log directory.

    Resolution order:
      1. ``HOGA_LOG_DIR`` env var — explicit override (tests, sandboxes).
      2. ``$XDG_DATA_HOME/hoga-ops/logs`` if XDG_DATA_HOME is set.
      3. ``~/.local/share/hoga-ops/logs`` — XDG default.

    Sibling of resolve_data_dir() but NOT inside data/ (logs are machine-
    global operational output, not capture data — HOGA_DATA_DIR does not
    apply). Mirrors resolve_symbol_master_path's placement.
    """
    env = os.environ.get("HOGA_LOG_DIR")
    if env:
        return Path(env)
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "hoga-ops" / "logs"


@dataclass(frozen=True)
class Config:
    repo_root: Path

    def cookie(self) -> str:
        env = os.environ.get("HOGAPLAY_COOKIE")
        if env:
            return env.strip()
        cookie_file = self.repo_root / ".cookie"
        if cookie_file.exists():
            return cookie_file.read_text(encoding="utf-8").strip()
        raise CookieMissingError(
            "No cookie found. Set HOGAPLAY_COOKIE env var or create .cookie file "
            "with 'k_=...; n_=...' (copy from your hogaplay browser session)."
        )

    @property
    def data_dir(self) -> Path:
        # Legacy: per-repo sandbox path. Production callers go through
        # ``resolve_data_dir()`` so captures land in the global store.
        return self.repo_root / "data"

    def raw_dir(self, date: str, code: str) -> Path:
        return self.data_dir / "raw" / date / code

    def parquet_dir(self, date: str, code: str) -> Path:
        return self.data_dir / "parquet" / date / code

    @classmethod
    def from_cwd(cls) -> Config:
        return cls(repo_root=Path.cwd())
