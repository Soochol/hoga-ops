"""Aggregate Phase 1 matrix results into a decision table.

For each (rate_s, step_ms) cell, averages across 3 start_labels:
  pages_per_90s, cap_hit_rate, http_ms_p95, body_len_p50, outcome_count

Outputs a markdown table sorted by pages_per_90s descending, filtered
to outcome=="ok" only. The top safe cell is the adoption candidate.
"""

from __future__ import annotations

import json
from pathlib import Path
from collections import defaultdict

IN = Path("docs/superpowers/measurements/2026-05-23-throughput/matrix-results.json")


def main() -> None:
    results = json.loads(IN.read_text())
    by_cell: dict[tuple, list[dict]] = defaultdict(list)
    for r in results:
        by_cell[(r["rate_s"], r["step_ms"])].append(r)
    rows = []
    for (rate, step), runs in by_cell.items():
        ok_runs = [r for r in runs if r["outcome"] == "ok"]
        if not ok_runs:
            continue
        avg_pages = sum(r.get("pages", 0) for r in ok_runs) / len(ok_runs)
        avg_caphit = sum(r.get("cap_hit_rate", 0) for r in ok_runs) / len(ok_runs)
        avg_p95 = sum(r.get("http_ms_p95", 0) for r in ok_runs) / len(ok_runs)
        avg_body = sum(r.get("body_len_p50", 0) for r in ok_runs) / len(ok_runs)
        rows.append({
            "rate_s": rate, "step_ms": step,
            "avg_pages_per_90s": round(avg_pages, 1),
            "avg_cap_hit_rate": round(avg_caphit, 3),
            "avg_http_ms_p95": round(avg_p95, 1),
            "avg_body_len_p50": round(avg_body, 0),
            "safe_runs": len(ok_runs),
            "total_runs": len(runs),
        })
    rows.sort(key=lambda r: r["avg_pages_per_90s"], reverse=True)
    print("| rate | step | pages/90s | cap_hit | http_p95 | body_p50 | safe |")
    print("|---|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['rate_s']} | {r['step_ms']} | {r['avg_pages_per_90s']} | {r['avg_cap_hit_rate']} | {r['avg_http_ms_p95']} | {r['avg_body_len_p50']} | {r['safe_runs']}/{r['total_runs']} |")


if __name__ == "__main__":
    main()
