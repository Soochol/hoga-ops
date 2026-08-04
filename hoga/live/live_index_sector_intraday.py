from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Hashable
from pathlib import Path
from typing import Protocol

from hoga.live import kiwoom_access, kiwoom_multi_quote, kiwoom_rest_runtime
from hoga.live.index_sector_rankings import list_index_sector_ranking_codes
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded, Priority
from hoga.live.kiwoom_rest import KiwoomRestClient

log = logging.getLogger(__name__)


class KiwoomRestScheduler(Protocol):
    """PR-J(#1046) — 계정 차원(`endpoint`·`cooldown_scope`)이 사라졌다(#1015)."""

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[], Awaitable],
    ): ...


class QuoteFetcher(Protocol):
    async def fetch_and_gate(
        self,
        client: KiwoomRestClient,
        code_list: list[str],
        phase: str,
    ) -> list: ...


class LiveIndexSectorIntradayOverlay:
    """Fetches optional intraday prices for Index Sector Ranking."""

    def __init__(
        self,
        *,
        data_dir: Path,
        scheduler: KiwoomRestScheduler,
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
            client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
            if client is None:
                return {}   # 무자격 프로필(ADR-0134) — 일봉 코퍼스로 강등된다
            quotes = await asyncio.wait_for(
                asyncio.shield(
                    kiwoom_access.run_with_capacity(
                        self._scheduler,
                        key=("index-sector-rankings-quotes", tuple(sorted(codes)), phase),
                        # 쿨다운 스코프(`quotes:KRX`)는 사라졌다 — 키움 유량은 TR별이라
                        # 계정을 고를 일이 없고, 버킷 키가 곧 `api_id` 다(#1015).
                        api_id=kiwoom_multi_quote.API_ID,
                        priority="background",
                        client=client,
                        fetch_fn=lambda c: self._quote_fetcher.fetch_and_gate(
                            c,
                            codes,
                            phase,
                        ),
                    )
                ),
                timeout=self._timeout_seconds,
            )
        except (TimeoutError, KiwoomCapacityOverloaded):
            return {}
        except Exception as exc:  # noqa: BLE001 - rankings must degrade to daily corpus.
            log.warning("index sector intraday quote fetch failed: %s", exc)
            return {}
        return {quote.code: quote.price for quote in quotes}
