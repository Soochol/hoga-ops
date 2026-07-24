from __future__ import annotations

import argparse
import json
from collections import defaultdict
from collections.abc import Callable
from contextlib import ExitStack
from functools import wraps
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

from hoga.api import bundle as bundle_mod
from hoga.api.queries import QueryEngine

if __package__:
    from tools.range_measurement_policy import (
        TRADING_CALENDAR_POLICY,
        fixture_only_trading_calendar,
    )
    from tools.range_request_manifest import (
        LoadedRequestManifest,
        RangeRequestManifest,
        load_request_manifest,
    )
else:
    from range_measurement_policy import (  # type: ignore[import-not-found]
        TRADING_CALENDAR_POLICY,
        fixture_only_trading_calendar,
    )
    from range_request_manifest import (  # type: ignore[import-not-found]
        LoadedRequestManifest,
        RangeRequestManifest,
        load_request_manifest,
    )

PROFILED_FUNCTIONS: tuple[str, ...] = (
    "build_program_trade_series",
    "build_candles_slice",
    "build_quote_ratio_slice",
    "build_fill_strength_slice",
    "build_ask_bid_peak_slices",
    "build_trade_volume_poc_slice",
    "build_broker_late_entries_slice",
    "build_volume_distribution_slice",
    "build_depth_heatmap_slice",
    "build_depth_delta_slice",
)

SUPPORTED_MODES: tuple[str, ...] = ("hoga", "sidecar", "candles")


def profile_range_case(
    engine: QueryEngine,
    *,
    label: str,
    request_manifest: RangeRequestManifest,
    code: str,
    from_date: str,
    to_date: str,
    manifest_source_name: str | None = None,
) -> dict[str, object]:
    """Profile one ``build_range_bundle`` request without leaking wrappers."""
    request_kwargs = request_manifest.request_kwargs(
        code=code,
        from_date=from_date,
        to_date=to_date,
    )
    rows: list[tuple[str, float]] = []
    with ExitStack() as stack:
        stack.enter_context(fixture_only_trading_calendar())
        for name in PROFILED_FUNCTIONS:
            original: Callable[..., object] = getattr(bundle_mod, name)

            @wraps(original)
            def wrapped(
                *args: object,
                __name: str = name,
                __original: Callable[..., object] = original,
                **kwargs: object,
            ) -> object:
                started = perf_counter()
                try:
                    return __original(*args, **kwargs)
                finally:
                    rows.append((__name, (perf_counter() - started) * 1000))

            stack.enter_context(patch.object(bundle_mod, name, wrapped))

        started = perf_counter()
        result = bundle_mod.build_range_bundle(engine, **request_kwargs)
        total_ms = (perf_counter() - started) * 1000

    totals: defaultdict[str, float] = defaultdict(float)
    calls: defaultdict[str, int] = defaultdict(int)
    for name, elapsed_ms in rows:
        totals[name] += elapsed_ms
        calls[name] += 1

    return {
        "label": label,
        "configuration_name": request_manifest.name,
        "request_manifest_name": manifest_source_name
        or f"{request_manifest.name}.json",
        "request_manifest_sha256": request_manifest.sha256(),
        "request_manifest": request_manifest.normalized(),
        "trading_calendar_policy": TRADING_CALENDAR_POLICY,
        "total_ms": round(total_ms, 3),
        "result_counts": {
            "segments": len(result.segments),
            "candles": len(result.candles),
            "quote_ratio": len(result.quote_ratio.points),
            "fill_strength": len(result.fill_strength.points),
            "ask_peaks": len(result.ask_peaks),
            "bid_peaks": len(result.bid_peaks),
            "depth_heatmap": len(result.depth_heatmap),
            "depth_delta": len(result.depth_delta),
        },
        "functions": {
            name: {"total_ms": round(totals[name], 3), "calls": calls[name]}
            for name in sorted(totals)
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Profile current-head range bundle calls against isolated development data."
    )
    parser.add_argument("--data-dir", type=Path, required=True, metavar="PATH")
    parser.add_argument("--code", required=True)
    parser.add_argument("--from", dest="from_date", required=True, metavar="YYYYMMDD")
    parser.add_argument("--to", dest="to_date", required=True, metavar="YYYYMMDD")
    parser.add_argument(
        "--request-manifest",
        type=Path,
        required=True,
        metavar="JSON",
    )
    parser.add_argument("--repeat", type=int, default=1, metavar="INT")
    parser.add_argument("--label-prefix", default="range", metavar="TEXT")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if not args.data_dir.is_dir():
        parser.error(f"--data-dir must be an existing directory: {args.data_dir}")
    if args.repeat <= 0:
        parser.error("--repeat must be a positive integer")
    try:
        loaded: LoadedRequestManifest = load_request_manifest(args.request_manifest)
    except ValueError as exc:
        parser.error(str(exc))

    for repeat_index in range(1, args.repeat + 1):
        engine = QueryEngine(args.data_dir)
        try:
            result = profile_range_case(
                engine,
                label=f"{args.label_prefix}:{loaded.manifest.name}:{repeat_index}",
                request_manifest=loaded.manifest,
                code=args.code,
                from_date=args.from_date,
                to_date=args.to_date,
                manifest_source_name=loaded.source_name,
            )
        finally:
            engine.close()
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
