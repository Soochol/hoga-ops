"""KRX closing-auction price, isolated from aftermarket current/daily prices."""
from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from pathlib import Path

from pydantic import BaseModel

from hoga.api.calendar import is_trading_session_today
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

_MISS_TTL_MS = 60_000


class KrxCloseResponse(BaseModel):
    code: str
    date: str
    price: int | None = None
    close_at_ms: int
    fetched_at_ms: int | None = None


def auction_price(rows: list[dict], stamp: str) -> int | None:
    """Require the exact closing-auction minute, never the latest row."""
    for row in rows:
        if row.get("cntr_tm") != stamp:
            continue
        raw = str(row.get("cur_prc") or "").strip().lstrip("+-")
        if raw.isdigit() and int(raw) > 0:
            return int(raw)
    return None


class KrxCloseStore:
    def __init__(self, data_dir: Path | None):
        self.data_dir = data_dir
        self.lock = asyncio.Lock()
        self.recent: dict[str, KrxCloseResponse] = {}

    def closing_time(self, code: str, now: datetime) -> datetime:
        # Capture metadata can describe special trading hours.
        close = now.replace(hour=15, minute=30, second=0, microsecond=0)
        if self.data_dir is not None:
            path = self.data_dir / "parquet" / now.strftime("%Y%m%d") / code / "hogaplay" / "meta.json"
            try:
                value = int(json.loads(path.read_text())["regular_session_close_ms"])
                clock = f"{value // 1000:06d}"
                close = now.replace(hour=int(clock[:2]), minute=int(clock[2:4]), second=int(clock[4:]), microsecond=0)
            except (OSError, ValueError, KeyError, TypeError):
                pass
        return close

    async def get(
        self, code: str, now: datetime, fetch: Callable[[], Awaitable[list[dict]]],
    ) -> KrxCloseResponse:
        now = now.astimezone(KST)
        date = now.strftime("%Y%m%d")
        close = self.closing_time(code, now)
        empty = KrxCloseResponse(code=code, date=date, close_at_ms=int(close.timestamp() * 1000))
        # Unknown calendar coverage may query: only an exact same-day auction row can supply a price.
        if now < close + timedelta(minutes=1) or is_trading_session_today(date) is False:
            return empty
        path = self.data_dir / "krx-close" / date / f"{code}.json" if self.data_dir else None
        async with self.lock:
            if path is not None:
                try:
                    saved = KrxCloseResponse.model_validate_json(path.read_text())
                    if (
                        saved.code == code and saved.date == date
                        and saved.price is not None and saved.price > 0
                        and saved.close_at_ms == empty.close_at_ms
                    ):
                        return saved
                except (OSError, ValueError):
                    pass
            key = f"{date}:{code}"
            previous = self.recent.get(key)
            now_ms = int(now.timestamp() * 1000)
            if previous and previous.fetched_at_ms and now_ms - previous.fetched_at_ms < _MISS_TTL_MS:
                return previous
            rows = await fetch()
            result = empty.model_copy(update={
                "price": auction_price(rows, close.strftime("%Y%m%d%H%M%S")),
                "fetched_at_ms": now_ms,
            })
            self.recent = {k: v for k, v in self.recent.items() if v.date == date}
            self.recent[key] = result
            if result.price is not None and path is not None:
                atomic_write_json(path, result.model_dump())
            return result
