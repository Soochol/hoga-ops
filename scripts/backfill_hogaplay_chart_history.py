"""Repair capped historical chart.tsv/candles.parquet for current Heatmap Codes.

Run with ``uv run python scripts/backfill_hogaplay_chart_history.py --help``.
Dry-run is the default; --apply fetches and prepends missing history with backups.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from collections import Counter
from dataclasses import asdict
from datetime import datetime
from functools import partial
from pathlib import Path

from dotenv import dotenv_values

from hoga.api.heatmap import load_heatmap
from hoga.collector.chart import CHART_PAGE_LIMIT, fetch_full_chart
from hoga.collector.chart_backfill import repair_chart
from hoga.collector.client import CookieExpiredError, HogaplayClient, HogaplayHTTPError
from hoga.collector.orchestrator import THROTTLED_STATUSES, chart_final_time
from hoga.config import resolve_data_dir
from hoga.tables import candles
from hoga.util.atomic_write import atomic_write_json, atomic_write_text
from hoga.util.timeenc import KST


def _protected_files(data_dir: Path, date: str, code: str) -> dict[str, str]:
    source = data_dir / "parquet" / date / code / "hogaplay"
    raw = data_dir / "raw" / date / code
    paths = [p for p in source.glob("*.parquet") if p.name != "candles.parquet"]
    paths.extend(p for p in [raw / "info.tsv", raw / "_progress.json"] if p.exists())
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def _assert_queue_idle(data_dir: Path, dates: list[str]) -> None:
    path = data_dir / ".queue.json"
    if path.exists():
        items = json.loads(path.read_text()).get("items", [])
        if any(item.get("date") in dates for item in items):
            raise RuntimeError("selected dates have pending captures; retry after those finish")


def _plan(data_dir: Path, dates: list[str], subset: str | None) -> list[dict]:
    entries = load_heatmap(data_dir)
    codes = sorted({e.code for e in entries})
    if subset:
        codes = [c for c in codes if c in set(subset.split(","))]
    plans = []
    for date in dates:
        for code in codes:
            source = data_dir / "parquet" / date / code / "hogaplay"
            path = source / "candles.parquet"
            if not (source / "meta.json").exists() or not path.exists():
                status = "no_existing_capture"
            else:
                status = "capped" if len(candles.read_parquet(path)) == CHART_PAGE_LIMIT else "not_capped"
            plans.append({"date": date, "code": code, "status": status})
    return plans


def _repair_one(data_dir: Path, dates: list[str], output: Path, plan: dict, fetch) -> dict:
    date, code = plan["date"], plan["code"]
    result = {**plan}
    try:
        protected = _protected_files(data_dir, date, code)
        body = fetch_full_chart(partial(fetch, code, date), date=date, final_time=chart_final_time(date))
        atomic_write_text(output / "downloads" / date / f"{code}.tsv", body)
        _assert_queue_idle(data_dir, dates)
        if _protected_files(data_dir, date, code) != protected:
            raise RuntimeError("protected capture files changed during fetch")
        repaired = repair_chart(data_dir, code=code, date=date, chart_body=body, backup_dir=output / "files")
        if _protected_files(data_dir, date, code) != protected:
            raise RuntimeError("protected capture files changed during repair")
        result.update(asdict(repaired))
        result["status"] = "repaired" if repaired.added else "unchanged"
        result["protected_sha256"] = protected
    except CookieExpiredError:
        raise
    except HogaplayHTTPError as exc:
        if exc.status_code in THROTTLED_STATUSES:
            raise
        result.update(status="error", error=str(exc))
    except (OSError, ValueError, RuntimeError) as exc:
        result.update(status="error", error=str(exc))
    return result


def _apply(data_dir: Path, dates: list[str], output: Path, plans: list[dict], cookie: str) -> None:
    _assert_queue_idle(data_dir, dates)
    output.mkdir(parents=True, exist_ok=False)
    atomic_write_json(output / "plan.json", plans)
    print("output", output, flush=True)
    results = []
    last_request_at = 0.0
    candidates = [p for p in plans if p["status"] == "capped"]
    with HogaplayClient(cookie=cookie, timeout=30) as client:
        def fetch(code: str, date: str, cursor: int) -> str:
            nonlocal last_request_at
            time.sleep(max(0.0, 0.15 - (time.monotonic() - last_request_at)))
            last_request_at = time.monotonic()
            return client.fetch_chart(code, date, cursor)

        for index, plan in enumerate(candidates, start=1):
            result = _repair_one(data_dir, dates, output, plan, fetch)
            results.append(result)
            atomic_write_json(output / "results.json", results)
            if index % 20 == 0 or index == len(candidates) or result["status"] == "error":
                print(f"{index}/{len(candidates)}", dict(Counter(r["status"] for r in results)),
                      "added", sum(r.get("added", 0) for r in results), flush=True)
    for date in dates:
        subset = [r for r in results if r["date"] == date]
        print(date, dict(Counter(r["status"] for r in subset)),
              "added", sum(r.get("added", 0) for r in subset), flush=True)
    if any(r["status"] == "error" for r in results):
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dates", nargs="+", required=True, help="YYYYMMDD historical dates")
    parser.add_argument("--data-dir", type=Path, default=resolve_data_dir())
    parser.add_argument("--output-dir", type=Path, help="Unique backup/download/report directory")
    parser.add_argument("--env-file", type=Path, help="Read only HOGAPLAY_COOKIE from this file")
    parser.add_argument("--codes", help="Optional comma-separated subset of Heatmap Codes")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    today = datetime.now(KST).strftime("%Y%m%d")
    for date in args.dates:
        datetime.strptime(date, "%Y%m%d")
        if date >= today:
            parser.error("only past dates can be repaired")
    plans = _plan(args.data_dir, args.dates, args.codes)
    print("plan", dict(Counter(p["status"] for p in plans)), flush=True)
    if not args.apply:
        return
    cookie = os.environ.get("HOGAPLAY_COOKIE")
    if not cookie and args.env_file:
        cookie = dotenv_values(args.env_file).get("HOGAPLAY_COOKIE")
    if not cookie:
        parser.error("HOGAPLAY_COOKIE is required for --apply")
    output = args.output_dir or (
        args.data_dir.parent / "backups" / ("chart-history-" + datetime.now(KST).strftime("%Y%m%dT%H%M%S"))
    )
    _apply(args.data_dir, args.dates, output, plans, cookie)


if __name__ == "__main__":
    main()
