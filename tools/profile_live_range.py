from __future__ import annotations

from collections import defaultdict
from functools import wraps
from time import perf_counter

from hoga.api import bundle as bundle_mod
from hoga.api.queries import QueryEngine
from hoga.config import resolve_data_dir


FUNCTIONS = [
    "build_program_trade_series",
    "build_candles_slice",
    "build_quote_ratio_slice",
    "build_fill_strength_slice",
    "build_volume_profile_slice",
    "build_ask_peak_slice",
    "build_bid_peak_slice",
    "build_ask_bid_peak_slices",
    "build_trade_volume_poc_slice",
    "build_broker_late_entries_slice",
    "build_volume_distribution_slice",
    "build_volume_profile_range",
]


def main() -> None:
    rows: list[tuple[str, float]] = []

    def record(name: str, elapsed: float) -> None:
        rows.append((name, elapsed))

    for name in FUNCTIONS:
        original = getattr(bundle_mod, name)

        @wraps(original)
        def wrapped(*args, __name=name, __original=original, **kwargs):
            t0 = perf_counter()
            try:
                return __original(*args, **kwargs)
            finally:
                record(__name, perf_counter() - t0)

        setattr(bundle_mod, name, wrapped)

    original_list_stock_dates = QueryEngine.list_stock_dates

    def list_stock_dates_wrapped(self: QueryEngine):
        t0 = perf_counter()
        try:
            return original_list_stock_dates(self)
        finally:
            record("QueryEngine.list_stock_dates", perf_counter() - t0)

    QueryEngine.list_stock_dates = list_stock_dates_wrapped

    cases = [
        ("hoga-1m", dict(mode="hoga")),
        ("sidecar-1m", dict(mode="sidecar", broker_late_entries_enabled=True, trade_volume_poc_bins=10)),
        ("full-1m", dict(mode="full", broker_late_entries_enabled=True, trade_volume_poc_bins=10)),
    ]

    for label, extra in cases:
        engine = QueryEngine(resolve_data_dir())
        rows.clear()
        kwargs = dict(
            code="000660",
            from_date="20260619",
            to_date="20260626",
            bucket_ms=60_000,
            source_pref="hogaplay_first",
        )
        kwargs.update(extra)
        t0 = perf_counter()
        result = bundle_mod.build_range_bundle(engine, **kwargs)
        total = perf_counter() - t0
        by_name: defaultdict[str, float] = defaultdict(float)
        counts: defaultdict[str, int] = defaultdict(int)
        for name, elapsed in rows:
            by_name[name] += elapsed
            counts[name] += 1

        print(
            f"CASE {label} total={total:.3f}s "
            f"qr={len(result.quote_ratio.points)} "
            f"fs={len(result.fill_strength.points)} "
            f"ask={len(result.ask_peaks)} "
            f"bid={len(result.bid_peaks)} "
            f"brokers={len(result.broker_late_entries)} "
            f"poc={len(result.trade_volume_pocs)} "
            f"program={len(result.program_trade.points)}"
        )
        for name, elapsed in sorted(by_name.items(), key=lambda item: -item[1])[:12]:
            print(f"  {name:38s} {elapsed:.3f}s calls={counts[name]}")


if __name__ == "__main__":
    main()
