"""Display-only last Kiwoom book. ka10004 supplies a clock, never a trading date.

Keep this separate from WS history and order freshness. A weekend REST read must
not turn Friday's ladder into a fresh Saturday observation. Only usable ladders
replace the saved copy; empty resets and failed reads preserve it across restart.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from hoga.tables.snapshots import ApiOrderbookLevel
from hoga.util.atomic_write import atomic_write_json

from .venue import Venue

log = logging.getLogger(__name__)
RestOrderbookSource = Literal["kiwoom_rest", "stored"]
_LEVELS = 10
_TTL_MS = 60_000
_MAX_KEYS = 512


class RestOrderbook(BaseModel):
    ask: list[ApiOrderbookLevel]
    bid: list[ApiOrderbookLevel]
    tot_ask: int
    tot_bid: int
    book_time: str | None


class RestOrderbookResponse(BaseModel):
    code: str
    venue: Venue
    book: RestOrderbook | None = None
    source: RestOrderbookSource = "kiwoom_rest"
    fetched_at_ms: int | None = None
    checked_at_ms: int
    refresh_failed: bool = False
    storage_failed: bool = False


def _number(value: object) -> int:
    text = str(value or "").strip().lstrip("+-")
    return int(text) if text.isdecimal() else 0


def parse_book(body: dict) -> RestOrderbook | None:
    def levels(side: str) -> list[ApiOrderbookLevel]:
        return [ApiOrderbookLevel(
            price=_number(body.get(f"{side}_fpr_bid" if rank == 1 else f"{side}_{rank}th_pre_bid")),
            qty=_number(body.get(f"{side}_fpr_req" if rank == 1 else f"{side}_{rank}th_pre_req")),
        ) for rank in range(1, _LEVELS + 1)]

    ask, bid = levels("sel"), levels("buy")
    if not any(level.price > 0 for level in ask + bid):
        return None
    clock = str(body.get("bid_req_base_tm") or "").strip()
    valid_clock = re.fullmatch(r"(?:[01]\d|2[0-3])[0-5]\d[0-5]\d", clock)
    return RestOrderbook(ask=ask, bid=bid,
                         tot_ask=_number(body.get("tot_sel_req")), tot_bid=_number(body.get("tot_buy_req")),
                         book_time=f"{clock[:2]}:{clock[2:4]}:{clock[4:]}" if valid_clock else None)


class RestOrderbookStore:
    def __init__(self, data_dir: Path | None):
        self.data_dir = data_dir
        self.recent: OrderedDict[tuple[str, Venue], RestOrderbookResponse] = OrderedDict()
        self.flights: dict[tuple[str, Venue], asyncio.Task[RestOrderbookResponse]] = {}

    async def get(self, code: str, venue: Venue, fetch: Callable[[], Awaitable[dict]]) -> RestOrderbookResponse:
        key = (code, venue)
        now = int(time.time() * 1000)
        hit = self.recent.get(key)
        if hit and not hit.refresh_failed and not hit.storage_failed and 0 <= now - hit.checked_at_ms < _TTL_MS:
            self.recent.move_to_end(key)
            return hit
        task = self.flights.get(key)
        if task is None:
            task = asyncio.create_task(self._refresh(code, venue, fetch))
            self.flights[key] = task
            task.add_done_callback(lambda _task: self.flights.pop(key, None))
        return await asyncio.shield(task)

    async def _refresh(self, code: str, venue: Venue, fetch: Callable[[], Awaitable[dict]]) -> RestOrderbookResponse:
        key = (code, venue)
        path = self.data_dir / "last_rest_orderbook" / f"{code}-{venue}.json" if self.data_dir else None
        saved = self.recent.get(key)
        if (saved is None or saved.book is None) and path is not None:
            try:
                candidate = RestOrderbookResponse.model_validate_json(await asyncio.to_thread(path.read_text))
                if (candidate.code == code and candidate.venue == venue and candidate.book
                        and any(level.price > 0 for level in candidate.book.ask + candidate.book.bid)):
                    saved = candidate
            except (OSError, ValueError):
                pass
        failed = False
        try:
            book = parse_book(await fetch())
        except Exception:  # noqa: BLE001 — preserve the last display book on upstream failure
            log.warning("live.rest_orderbook.read_failed code=%s venue=%s", code, venue)
            book, failed = None, True
        now = int(time.time() * 1000)
        response = RestOrderbookResponse(code=code, venue=venue, book=book,
                                         fetched_at_ms=now if book else None, checked_at_ms=now,
                                         refresh_failed=failed)
        if book is None and saved and saved.book:
            response = saved.model_copy(update={"source": "stored", "checked_at_ms": now,
                                                "refresh_failed": failed})
        if book is not None and path is not None:
            try:
                await asyncio.to_thread(atomic_write_json, path, response.model_dump())
            except OSError:
                log.warning("live.rest_orderbook.save_failed code=%s venue=%s", code, venue)
                response = response.model_copy(update={"storage_failed": True})
        self.recent[key] = response
        self.recent.move_to_end(key)
        while len(self.recent) > _MAX_KEYS:
            self.recent.popitem(last=False)
        return response
