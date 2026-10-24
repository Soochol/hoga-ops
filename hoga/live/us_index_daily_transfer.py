"""Stateless daily-history validation; does not change fetching or cache ownership."""

from __future__ import annotations

import hashlib
import json

from hoga.live.us_daily_candles import UsDailyBar


def daily_history_transfer(
    index_id: str, start: str, end: str, bars: list[UsDailyBar], known_revision: str | None,
) -> tuple[list[UsDailyBar], str, bool]:
    """Keep the latest row mutable; validate every other row on every request.

    A rollover, correction, partial-history fill or changed range invalidates the
    prefix and sends the full window. Old clients never opt in to a tail response.
    """
    body = [index_id, start, end, [bar.model_dump(mode="json") for bar in bars[:-1]]]
    revision = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    unchanged = known_revision == revision
    return bars[-1:] if unchanged else bars, revision, unchanged


def us_index_candle_transfer(
    index_id: str, start: str, end: str, timeframe: str, bars: list[UsDailyBar], known_revision: str | None,
) -> dict:
    fields = {}
    if timeframe == "D":
        bars, revision, unchanged = daily_history_transfer(index_id, start, end, bars, known_revision)
        fields = {"daily_history_revision": revision, "daily_history_unchanged": unchanged}
    return {**fields, "candles": [bar.model_dump() for bar in bars]}
