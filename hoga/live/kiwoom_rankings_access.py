"""Composition-root injection for the shared Kiwoom ranking fetcher."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hoga.live.kiwoom_rankings import KiwoomRankingsFetcher

_getter: Callable[[], KiwoomRankingsFetcher | None] | None = None


def set_rankings_fetcher_getter(getter: Callable[[], KiwoomRankingsFetcher | None]) -> None:
    global _getter  # noqa: PLW0603 — the composition root owns the process singleton
    _getter = getter


def rankings_fetcher() -> KiwoomRankingsFetcher | None:
    return _getter() if _getter is not None else None
