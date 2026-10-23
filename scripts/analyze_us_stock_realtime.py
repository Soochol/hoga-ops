"""Offline analysis of public FE observations versus native REST bars."""
from __future__ import annotations

import argparse
import gzip
import json
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path


def price(value):
    return abs(Decimal(str(value).replace(",", "")))


def patch_bar(base, observed, *, newer):
    """Design prototype: REST owns open/volume; only newer observations overlay."""
    if not newer:
        return dict(base)
    return {**base, "high": max(base["high"], observed["high"]),
            "low": min(base["low"], observed["low"]), "close": observed["close"]}


def aggregate(prices):
    return {"open": prices[0], "high": max(prices), "low": min(prices), "close": prices[-1]}


def native_grid_phases(reads):
    result = {}
    for period in ["1", "3", "5", "10", "15", "30", "60"]:
        bars = [b for r in reads if r["symbol"] == "AAPL" and r["period"] == period for b in r["rows"]]
        phases = Counter((int(b["cntr_tm"][8:10]) * 60 + int(b["cntr_tm"][10:12])) % int(period) for b in bars)
        result[period] = {"sampled_rows_including_repeats": len(bars), "phase_counts": dict(phases)}
    return result


def analyze(report):
    reads = report["rest"]
    events = sorted([r for label, state in report["ws"].items() if label.startswith("us")
                     for r in state["records"]], key=lambda r: r["received_at_utc"])
    grouped = defaultdict(list)
    per_minute = defaultdict(list)
    per_received_second = {}
    for row in events:
        grouped[(row["exchange"], row["item"])].append(row)
        v = row["values"]
        key = (row["exchange"], row["item"], v["22"], v["51020"])
        per_minute[key].append(price(v["10"]))
        per_received_second[(key, row["received_at_utc"][:19])] = price(v["10"])
    sampled = defaultdict(list)
    for (key, _second), value in per_received_second.items():
        sampled[key].append(value)
    result = {"events": len(events), "subjects": {}, "rest_reads": len(reads),
              "rest_successes": sum(r.get("return_code") == 0 for r in reads),
              "rest_errors": [{k: v for k, v in r.items() if k != "rows"}
                              for r in reads if r.get("return_code") != 0],
              "socket_states": {k: {f: v for f, v in state.items() if f != "records"}
                                for k, state in report["ws"].items()}}
    result["last_only_sampling"] = {
        "observed_subject_minutes": len(per_minute),
        "minutes_with_lost_extreme": sum(max(values) != max(sampled[key]) or min(values) != min(sampled[key])
                                         for key, values in per_minute.items()),
    }
    result["native_grid_phases"] = native_grid_phases(reads)
    representative = next(r for r in reads if r["symbol"] == "AAPL" and r["period"] == "1")["rows"]
    full_bytes = len(json.dumps({"candles": representative * 8}, separators=(",", ":")).encode())
    patch_bytes = len(json.dumps({"key": "us-stock:NASDAQ:AAPL", "generation": 1, "sequence": 100,
                                  "minute": representative[0], "daily": {
                                      "open": "349.11", "high": "351.73", "low": "346.43", "close": "348.045"}},
                                 separators=(",", ":")).encode())
    result["representative_payload_bytes"] = {
        "uncompressed_800_rows_repeated_from_first_100": full_bytes,
        "one_minute_and_one_day_patch": patch_bytes,
        "full_over_patch_ratio": round(full_bytes / patch_bytes, 2),
        "not_a_network_or_frontend_performance_benchmark": True,
    }
    result["rest_latency_ms"] = {"median": statistics.median(r["elapsed_ms"] for r in reads),
                                  "max": max(r["elapsed_ms"] for r in reads)}
    for (ex, symbol), rows in grouped.items():
        native = [r for r in reads if r["exchange"] == ex and r["symbol"] == symbol and r.get("return_code") == 0]
        final = next((r for r in reversed(native) if r["period"] == "1"), None)
        bars = {b["cntr_tm"]: b for b in final["rows"]} if final else {}
        eligible_minutes = defaultdict(list)
        seconds = defaultdict(list)
        invalid_ohlc = 0
        for r in rows:
            v = r["values"]
            if final and r["received_at_utc"] < final["started_at_utc"]:
                eligible_minutes[v.get("22", "") + v.get("51020", "")].append(price(v["10"]))
            seconds[r["received_at_utc"][:19]].append(r)
            try:
                op, hi, lo, cl = (price(v[f]) for f in ["16", "17", "18", "10"])
                invalid_ohlc += not (0 < lo <= min(op, cl) <= max(op, cl) <= hi)
            except (KeyError, ValueError):
                invalid_ohlc += 1
        comparisons = []
        for stamp, values in eligible_minutes.items():
            b = bars.get(stamp)
            if not b:
                comparisons.append({"stamp": stamp, "rest_bar": False})
                continue
            comparisons.append({"stamp": stamp, "rest_bar": True,
                                "closed_at_final_snapshot": stamp < final["rows"][0]["cntr_tm"],
                                "observations": len(values),
                                "all_prices_inside_rest_range": price(b["low_pric"]) <= min(values)
                                and max(values) <= price(b["high_pric"]),
                                "observed_high": str(max(values)), "observed_low": str(min(values)),
                                "rest_high": b["high_pric"], "rest_low": b["low_pric"]})
        daily = []
        for r in native:
            if r["period"] != "D" or not r["rows"]:
                continue
            # Compare snapshots close in receipt time. No latency claim follows.
            t = datetime.fromisoformat(r["started_at_utc"])
            nearby = min(rows, key=lambda w: abs((datetime.fromisoformat(w["received_at_utc"]) - t).total_seconds()))
            distance = abs((datetime.fromisoformat(nearby["received_at_utc"]) - t).total_seconds())
            b, v = r["rows"][0], nearby["values"]
            daily.append({"rest_started_at_utc": r["started_at_utc"], "rest_date": b["dt"],
                          "ws_date": v.get("22"), "distance_seconds": round(distance, 3),
                          "rest_ohlc": {k: b[k] for k in ["open_pric", "high_pric", "low_pric", "cur_prc"]},
                          "ws_ohlc": {k: v.get(k) for k in ["16", "17", "18", "10"]},
                          "same_day_and_ohl": b["dt"] == v.get("22") and all(
                              price(b[a]) == price(v[f]) for a, f in
                              [("open_pric", "16"), ("high_pric", "17"), ("low_pric", "18")])})
        result["subjects"][f"{ex}:{symbol}"] = {
            "records": len(rows), "distinct_prices": len({r["values"]["10"] for r in rows}),
            "first_at": rows[0]["received_at_utc"], "last_at": rows[-1]["received_at_utc"],
            "time_seconds_suffixes": dict(Counter(r["values"].get("51020", "")[-2:] for r in rows)),
            "session_types": dict(Counter(r["values"].get("290", "") for r in rows)),
            "invalid_daily_ohlc": invalid_ohlc, "minute_comparisons": comparisons,
            "daily_comparisons": daily,
            "seconds_with_prices_lost_by_last_only": sum(
                max(price(r["values"]["10"]) for r in chunk) != price(chunk[-1]["values"]["10"])
                or min(price(r["values"]["10"]) for r in chunk) != price(chunk[-1]["values"]["10"])
                for chunk in seconds.values()),
        }
    return result


def load_report(path):
    if path.suffix == ".gz":
        return json.loads(gzip.decompress(path.read_bytes()))
    return json.loads(path.read_text())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = analyze(load_report(args.input))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"events": result["events"], "rest_successes": result["rest_successes"],
                      "subjects": {k: v["records"] for k, v in result["subjects"].items()}}, ensure_ascii=False))
