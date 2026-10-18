"""KIS US cash-index daily date-cursor adapter (FHKST03030100)."""

from __future__ import annotations

import asyncio
import time

import httpx

from hoga.live.kis_errors import KisApiError, KisAuthError, KisRateLimitError, KisTransportError
from hoga.live.us_daily_candles import UsDateRange, UsFetchResult, parse_bar, shift

_FIELDS = ("stck_bsop_date", "ovrs_nmix_oprc", "ovrs_nmix_hgpr", "ovrs_nmix_lwpr", "ovrs_nmix_prpr", "acml_vol")


async def fetch_index_daily(
    client, code: str, start: str, end: str, *, max_pages: int = 8, budget_seconds: float = 15
) -> UsFetchResult:
    result = UsFetchResult()
    cursor = end
    deadline = time.monotonic() + budget_seconds
    seen = {}
    for _ in range(max_pages):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            body = await asyncio.wait_for(client.get_global_index_daily_page(code, start, cursor), remaining)
            if body.get("rt_cd") != "0" or not isinstance(body.get("output2"), list):
                raise ValueError("invalid KIS daily envelope")
            # The provider may pad a successful response with blank sentinel rows.
            if any(not isinstance(r, dict) for r in body["output2"]):
                raise ValueError("invalid KIS daily row")
            for row in body["output2"]:
                if (
                    row
                    and row.get("stck_bsop_date") in (None, "", "00000000")
                    and any(v not in (None, "", "0", "0.00", "0.0000", "00000000") for v in row.values())
                ):
                    raise ValueError("missing KIS trading date")
            rows = [r for r in body["output2"] if r.get("stck_bsop_date") not in (None, "", "00000000")]
            bars = [parse_bar(r, fields=_FIELDS) for r in rows]
            if any(not start <= b.trading_date <= cursor for b in bars):
                raise ValueError("KIS daily cursor did not advance / out-of-range row")
            if not bars:
                result.completed.append(UsDateRange(start=start, end=cursor))
                cursor = shift(start, -1)
                break
            oldest = min(b.trading_date for b in bars)
            for bar in bars:
                seen.setdefault(bar.trading_date, bar)
            result.completed.append(UsDateRange(start=oldest, end=cursor))
            cursor = shift(oldest, -1)
            if cursor < start:
                break
        except (
            KisApiError,
            KisAuthError,
            KisRateLimitError,
            KisTransportError,
            httpx.HTTPError,
            TimeoutError,
            ValueError,
            KeyError,
            TypeError,
        ) as exc:
            result.messages.append(f"KIS daily page incomplete: {type(exc).__name__}")
            break
    result.bars = sorted(seen.values(), key=lambda b: b.trading_date)
    result.truncated = cursor >= start
    return result
