"""Re-aggregate 1-minute hoga-indicator rows up to a coarser minute timeframe.

The /api/range hoga indicators (호가비 quote_ratio, 체결강도 fill_strength) are
cached at 1-minute granularity per (code, date, source) — see
``PastIndicatorsCache``. A request for 3m/5m/10m/15m/30m re-aggregates the cached
1m rows instead of re-reading + re-bucketing the raw snapshots/trades parquet.

Equivalence with a direct ``query_bucketed_ratio(bucket_ms=N)`` /
``query_fill_strength(bucket_ms=N)`` is the cache's whole correctness contract,
proven by tests/unit/api/test_indicator_reaggregate.py against the same parquet:

- **fill_strength** is a pure ``SUM(buy)/SUM(sell)`` GROUP BY bucket — the N-minute
  bucket is the sum of its N constituent 1-minute sums. Trivially associative.

- **quote_ratio** is the depth totals of the bucket's *representative* snapshot:
  the last continuous-trading book at/before the session close (ADR-0062). A
  fully-auction bucket (no continuous member after ``last_continuous_ms``) emits
  ``(0, 0)`` so the closing-auction 3-level book never enters 호가비. Because the
  1m query uses the SAME ``session_close_ms`` threshold, a fully-auction MINUTE is
  exactly the one cached as ``(0, 0)``; and a continuous book always has positive
  depth on at least one side (the deep-level test that makes it continuous implies
  ``bid_total`` or ``ask_total`` > 0), so ``(0, 0)`` ⟺ that minute's rep was the
  excluded auction book. The N-minute representative is therefore the LAST
  non-``(0, 0)`` 1-minute rep in the window — and ``(0, 0)`` itself when every
  minute in the window is fully-auction (matching the direct query's zero bucket).

  Caveat (documented, not reachable on real continuous-session data): if a
  genuinely empty book (both totals 0) appeared *before* the threshold, it would
  be is_pre yet indistinguishable from the auction sentinel. A real orderbook
  during continuous trading always carries depth, so this does not occur; the
  auction-fixture equivalence tests lock the structural cases.
"""
from __future__ import annotations

from hoga.tables.snapshots import QuoteRatioRow
from hoga.tables.trades import FillStrengthRow

# All /api/range minute timeframes are multiples of this; the cache is keyed at it.
ONE_MINUTE_MS = 60_000


def _imb_mag(bid: int, ask: int) -> float:
    """|imbalance| 단조 대용(랭킹용). max(a,b)/min(a,b) (b>0 && a>0), degenerate=1.
    snapshots.query_bucketed_ratio의 SQL mag와 동일 정의 — 큰 mag = 큰 |imbalance|."""
    if bid > 0 and ask > 0:
        return max(ask, bid) / min(ask, bid)
    return 1.0


def reaggregate_ratio(rows_1m: list[QuoteRatioRow], bucket_ms: int) -> list[QuoteRatioRow]:
    """Re-aggregate 1-minute quote_ratio rows to ``bucket_ms`` (a multiple of 1m).

    Per target bucket: the depth totals of the LAST non-``(0, 0)`` 1-minute row,
    falling back to the last row overall (which is ``(0, 0)`` for a fully-auction
    window). ``rows_1m`` must be ascending by ``bucket_intra_ms`` (the query
    contract); the output is ascending too.

    Intra-Bar Max (ADR-0075): ``bid_max`` / ``ask_max`` = the max across the
    constituent 1m rows. ``imb_max_*`` = the (bid,ask) pair of the constituent 1m
    with the largest ``_imb_mag(imb_max_bid, imb_max_ask)`` — direct-query
    equivalence holds because the N-minute |imbalance| extreme is the max over the
    constituent 1-minute extremes.
    """
    last_nonzero: dict[int, tuple[int, int]] = {}
    last_any: dict[int, tuple[int, int]] = {}
    bid_max: dict[int, int] = {}
    ask_max: dict[int, int] = {}
    imb_best: dict[int, tuple[float, int, int]] = {}  # (mag, imb_max_bid, imb_max_ask)
    order: list[int] = []
    for r in rows_1m:
        tb = (r.bucket_intra_ms // bucket_ms) * bucket_ms
        if tb not in last_any:
            order.append(tb)
            bid_max[tb] = 0
            ask_max[tb] = 0
            imb_best[tb] = (0.0, 0, 0)
        last_any[tb] = (r.bid_total, r.ask_total)
        if r.bid_total != 0 or r.ask_total != 0:
            last_nonzero[tb] = (r.bid_total, r.ask_total)
        if r.bid_max > bid_max[tb]:
            bid_max[tb] = r.bid_max
        if r.ask_max > ask_max[tb]:
            ask_max[tb] = r.ask_max
        mag = _imb_mag(r.imb_max_bid, r.imb_max_ask)
        if mag > imb_best[tb][0]:
            imb_best[tb] = (mag, r.imb_max_bid, r.imb_max_ask)
    out: list[QuoteRatioRow] = []
    for tb in order:
        bid, ask = last_nonzero.get(tb, last_any[tb])
        _, imb_b, imb_a = imb_best[tb]
        out.append(QuoteRatioRow(
            bucket_intra_ms=tb, bid_total=bid, ask_total=ask,
            bid_max=bid_max[tb], ask_max=ask_max[tb],
            imb_max_bid=imb_b, imb_max_ask=imb_a,
        ))
    return out


def reaggregate_fill(rows_1m: list[FillStrengthRow], bucket_ms: int) -> list[FillStrengthRow]:
    """Re-aggregate 1-minute fill_strength rows to ``bucket_ms`` (a multiple of 1m).

    Per target bucket: the sum of constituent 1-minute buy/sell quantities — the
    direct ``query_fill_strength`` is itself a SUM GROUP BY, so this is exact.
    ``rows_1m`` ascending by ``bucket_intra_ms``; output ascending.
    """
    buy: dict[int, int] = {}
    sell: dict[int, int] = {}
    order: list[int] = []
    for r in rows_1m:
        tb = (r.bucket_intra_ms // bucket_ms) * bucket_ms
        if tb not in buy:
            order.append(tb)
            buy[tb] = 0
            sell[tb] = 0
        buy[tb] += r.buy_qty
        sell[tb] += r.sell_qty
    return [FillStrengthRow(bucket_intra_ms=tb, buy_qty=buy[tb], sell_qty=sell[tb]) for tb in order]
