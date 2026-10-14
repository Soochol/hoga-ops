"""Report subsequent API demand for warmed Stock-Dates from complete retained logs.

PYTHONPATH=. .venv/bin/python tools/report_prewarm_usage.py --data-dir DATA LOG...
Supply all rotated logs covering the observation window. This measures demand
for matching source/venue/kind, not actual cache hits, saved CPU, or UI visibility.
"""
from __future__ import annotations

import argparse
import bisect
import json
from collections import defaultdict
from pathlib import Path

from hoga.api.prewarm_usage import MARKER


def summarize(events: list[dict], *, data_dir: Path, window_hours: float = 24) -> dict:
    if window_hours <= 0:
        raise ValueError("window_hours must be positive")
    selected = [e for e in events if e.get("v") == 1 and e.get("data_dir") == str(data_dir.absolute())]
    # Duplicated input log paths/lines must not inflate the denominator.
    selected = list({json.dumps(e, sort_keys=True): e for e in selected}.values())
    end = max((e["at_ns"] for e in selected), default=0)
    window = int(window_hours * 3_600_000_000_000)
    demand = defaultdict(list)
    warms = []
    for event in selected:
        for date in event["dates"]:
            key = (event["code"], date["date"], date["source"], event["venue"])
            if event["event"] == "demand":
                for kind in date["kinds"]:
                    demand[(*key, kind)].append(event["at_ns"])
            elif event["event"] == "warm":
                warms.append((key, date["kinds"], event["at_ns"]))
    for times in demand.values():
        times.sort()
    totals = {"warm_builds": 0, "pending": 0, "mature": 0, "demanded": 0, "unobserved": 0}
    by_source = {}
    for key, kinds, at in warms:
        group = by_source.setdefault(key[2], {name: 0 for name in totals})
        # A full observation window is required even for already-demanded builds,
        # so young positives cannot bias the mature cohort's rate upwards.
        mature = at + window <= end
        matched = False
        for kind in kinds:
            times = demand[(*key, kind)]
            i = bisect.bisect_left(times, at)
            matched |= i < len(times) and times[i] <= at + window
        for counts in (totals, group):
            counts["warm_builds"] += 1
            if not mature:
                counts["pending"] += 1
            else:
                counts["mature"] += 1
                counts["demanded" if matched else "unobserved"] += 1
    return {
        "scope": "successful warm builds with subsequent API bundle demand for any warmed kind",
        "window_hours": window_hours, "observed_until_ns": end or None,
        "events": len(selected), "totals": totals, "by_source": by_source,
        "demand_rate": totals["demanded"] / totals["mature"] if totals["mature"] else None,
        "limitations": [
            "Requires complete logs throughout each observation window; rotated-away events bias results.",
            "Demand does not prove a cache hit or that the user viewed the response.",
            "Unobserved means no matching demand in this window, not permanently unused.",
            "A repeated warm build is a separate build; elapsed build time is not CPU or avoidable cost.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--window-hours", type=float, default=24)
    parser.add_argument("logs", type=Path, nargs="+")
    args = parser.parse_args()
    events = []
    invalid = 0
    for path in dict.fromkeys(args.logs):
        with path.open() as handle:
            for line in handle:
                if MARKER not in line:
                    continue
                try:
                    event = json.loads(line.split(MARKER, 1)[1])
                    if event.get("v") == 1:
                        events.append(event)
                except (ValueError, AttributeError):
                    invalid += 1
    result = summarize(events, data_dir=args.data_dir, window_hours=args.window_hours)
    result["invalid_lines"] = invalid
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
