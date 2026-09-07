"""Derive coarse heatmaps from complete minute points without scanning snapshots."""

from __future__ import annotations

from itertools import groupby

from hoga.api.models import DepthHeatmapPoint
from hoga.util.timeenc import ms_from_midnight_to_unix_ms

ONE_MINUTE_MS = 60_000


def _maximum_key(point: DepthHeatmapPoint) -> tuple[int, tuple[int, ...]]:
    # Exact field order of snapshots.query_bucketed_depth_heatmap's struct_body:
    # ask_p1, ask_q1, bid_p1, bid_q1, then level 2, ..., level 10.
    levels = tuple(value for ask, bid in zip(point.asks_max, point.bids_max, strict=True) for value in (*ask, *bid))
    total = sum(qty for _price, qty in point.asks_max) + sum(qty for _price, qty in point.bids_max)
    return total, levels


def _price_max(points: list[DepthHeatmapPoint], side: str) -> list[list[int]]:
    quantities: dict[int, int] = {}
    for point in points:
        levels = point.asks_price_max if side == "ask" else point.bids_price_max
        for price, qty in levels:
            quantities[price] = max(quantities.get(price, 0), qty)
    return [[price, quantities[price]] for price in sorted(quantities, reverse=side == "bid")]


def reaggregate_depth_heatmap(
    points: list[DepthHeatmapPoint],
    *,
    date: str,
    bucket_ms: int,
) -> list[DepthHeatmapPoint]:
    """Sorted complete 1m points → N-minute points, aligned to KST midnight.

    Equal maximum totals use the lexicographically greatest level tuple, just
    like the direct SQL. No timestamp metadata or additional wire fields needed.
    Input points and their nested arrays are immutable cache values.
    """
    if bucket_ms <= 0 or bucket_ms % ONE_MINUTE_MS:
        raise ValueError("bucket_ms must be a positive multiple of one minute")
    if bucket_ms == ONE_MINUTE_MS:
        return points
    midnight = ms_from_midnight_to_unix_ms(date, 0)
    out = []
    for bucket, group in groupby(points, key=lambda p: (p.t_ms - midnight) // bucket_ms):
        rows = list(group)
        maximum = max(rows, key=_maximum_key)
        out.append(
            rows[-1].model_copy(
                update={
                    "t_ms": midnight + bucket * bucket_ms,
                    "asks_max": maximum.asks_max,
                    "bids_max": maximum.bids_max,
                    "asks_price_max": _price_max(rows, "ask"),
                    "bids_price_max": _price_max(rows, "bid"),
                }
            )
        )
    return out
