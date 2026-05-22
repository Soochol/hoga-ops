"""Repo-root .env loader for hoga-ops secrets (ADR-0008).

Discovery order:
    1. <working-tree>/.env (resolved relative to this file).
    2. <main-repo-root>/.env via `git rev-parse --git-common-dir` —
       used only when (1) is absent AND we're inside a git worktree.
       In a normal checkout, (1) and (2) point to the same path.

The discovery result is cached at module level — the subprocess git call
runs at most once per process. ``load_env`` itself can be safely called
under the asyncio Lock in symbols.refresh() without blocking the event
loop on subprocess I/O.

Loaded keys (all optional — missing keys fall back to other sources):
    KRX_ID, KRX_PW         pykrx login (Symbol Master fetch)
    HOGAPLAY_COOKIE        hogaplay session cookie

Precedence: shell env > .env > .cookie file (legacy, for HOGAPLAY_COOKIE only).
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

_WORKING_TREE: Path = Path(__file__).resolve().parent.parent

# Sentinel distinct from None so we can tell "not yet discovered" from
# "discovered, no .env exists". Reset between tests via reset_discovery_for_tests().
_NOT_DISCOVERED: Any = object()
_discovered: Any = _NOT_DISCOVERED  # Path | None | _NOT_DISCOVERED


def _main_repo_root() -> Path | None:
    """Return the main repo root via `git rev-parse --git-common-dir`.

    In a worktree the common dir is the main repo's `.git` directory;
    its parent is the main repo root. Returns None when git is unavailable
    or we're not inside a repo.
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=_WORKING_TREE,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None
    common = Path(out)
    if not common.is_absolute():
        common = (_WORKING_TREE / common).resolve()
    if common.name != ".git":
        return None
    return common.parent


def _discover_env_file() -> Path | None:
    """Return the .env path to load, or None if none exists.

    Called at most once per process (cached in ``_discovered``). Reset
    between tests via :func:`reset_discovery_for_tests`.
    """
    local = _WORKING_TREE / ".env"
    if local.exists():
        return local
    main = _main_repo_root()
    if main is not None and main != _WORKING_TREE:
        candidate = main / ".env"
        if candidate.exists():
            return candidate
    return None


def load_env(*, override: bool = False) -> Path | None:
    """Load discovered .env into os.environ. Returns path loaded, or None.

    - ``override=False`` (default): shell env wins over .env. Use at startup.
      Discovery result is cached so the subprocess git call runs at most
      once per process on this path.
    - ``override=True``: .env wins over shell env. Use after the user has
      edited .env and explicitly triggered a refresh. **Always re-discovers**
      because the user's signal ("I changed something on disk") includes the
      possibility that ``.env`` was created or removed since boot — caching a
      ``None`` discovery from cold boot would otherwise block hot-reload after
      the user creates ``.env`` for the first time.

    Safe to call under an asyncio Lock — when the local worktree ``.env``
    exists, no subprocess is involved on either path (it's a single
    ``Path.exists()`` check). The git-based fallback subprocess only fires
    when the local ``.env`` is absent.
    """
    global _discovered  # noqa: PLW0603
    if override or _discovered is _NOT_DISCOVERED:
        _discovered = _discover_env_file()
    if _discovered is None:
        return None
    load_dotenv(dotenv_path=_discovered, override=override)
    return _discovered  # type: ignore[no-any-return]


def reset_discovery_for_tests() -> None:
    """Test helper — clear the cached discovery result so the next
    ``load_env()`` re-runs ``_discover_env_file()``. Needed because tests
    monkeypatch ``_WORKING_TREE`` and ``_main_repo_root`` per test.
    """
    global _discovered  # noqa: PLW0603
    _discovered = _NOT_DISCOVERED


def krx_creds_present() -> bool:
    """True iff KRX_ID and KRX_PW are set to non-empty strings in os.environ."""
    return bool(os.environ.get("KRX_ID")) and bool(os.environ.get("KRX_PW"))
