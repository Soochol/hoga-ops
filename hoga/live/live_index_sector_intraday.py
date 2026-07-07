from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Hashable
from pathlib import Path
from typing import Protocol

from hoga.live import kis_access
from hoga.live.index_sector_rankings import list_index_sector_ranking_codes
from hoga.live.kis_capacity_scheduler import (
    KisCapacityCooldown,
    KisCapacityOverloaded,
)
from hoga.live.kis_client import KisClient

log = logging.getLogger(__name__)


class KisRestScheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: kis_access.KisRequestPriority,
        call: Callable[[KisClient], Awaitable],
        cooldown_scope: Hashable | None = None,
    ): ...


class QuoteFetcher(Protocol):
    async def fetch_and_gate(
        self,
        kis: KisClient,
        code_list: list[str],
        phase: str,
    ) -> list: ...


class LiveIndexSectorIntradayOverlay:
    """Fetches optional intraday prices for Index Sector Ranking."""

    def __init__(
        self,
        *,
        data_dir: Path,
        scheduler: KisRestScheduler,
        quote_fetcher: QuoteFetcher,
        timeout_seconds: float = 1.0,
    ) -> None:
        self._data_dir = data_dir
        self._scheduler = scheduler
        self._quote_fetcher = quote_fetcher
        self._timeout_seconds = timeout_seconds

    async def fetch_prices(self, *, phase: str) -> dict[str, int]:
        try:
            codes = list_index_sector_ranking_codes(self._data_dir)
            if not codes:
                return {}
            quotes = await asyncio.wait_for(
                asyncio.shield(
                    kis_access.run_with_capacity(
                        self._scheduler,
                        data_dir=self._data_dir,
                        key=("index-sector-rankings-quotes", tuple(sorted(codes)), phase),
                        endpoint=kis_access.KisRestEndpoint.QUOTES,
                        priority="background",
                        cooldown_scope="quotes",
                        fetch_fn=lambda kis: self._quote_fetcher.fetch_and_gate(
                            kis,
                            codes,
                            phase,
                        ),
                    )
                ),
                timeout=self._timeout_seconds,
            )
        except (asyncio.TimeoutError, KisCapacityCooldown, KisCapacityOverloaded):
            return {}
        except Exception as exc:  # noqa: BLE001 - rankings must degrade to daily corpus.
            log.warning("index sector intraday quote fetch failed: %s", exc)
            return {}
        return {quote.code: quote.price for quote in quotes}
