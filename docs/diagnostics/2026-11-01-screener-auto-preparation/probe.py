"""Offline design experiment: real governor/store, synthetic transport and corpus.

Run from the repository root with:
  uv run --extra dev python docs/diagnostics/2026-11-01-screener-auto-preparation/probe.py
No runtime environment, credentials, server or production writer is used.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import polars as pl

from hoga.api import screener_series_store as store, symbols, trading_days
from hoga.api.screener_store import _DAILY_PL_SCHEMA
from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

OUT = Path(__file__).resolve().parent
NOW = dt.datetime(2026, 11, 1, 18, tzinfo=KST)
ANCHOR = NOW.date().isoformat()
BACKGROUND_LIMIT = 4
BARS = 700
WEEKDAYS = 5
VOLUME = 100
NEW_BASIS_BARS = 2


async def transport_case(concurrency, latency, *, accounts=4, pages=2, count=24):
    scheduler = KiwoomCapacityScheduler()
    scheduler.set_clients([object() for _ in range(accounts)])
    sem = asyncio.Semaphore(concurrency)
    calls = active = peak = 0

    async def fake(_):
        nonlocal calls, active, peak
        calls += 1
        active += 1
        peak = max(active, peak)
        await asyncio.sleep(latency)
        active -= 1
        return 1

    async def one(code):
        async with sem:
            for page in range(pages):
                await scheduler.submit(key=(code, page), api_id="ka10081", priority="background", call=fake)

    started = time.perf_counter()
    try:
        await asyncio.gather(*(one(code) for code in range(count)))
        elapsed = time.perf_counter() - started
    finally:
        await scheduler.aclose()
    assert calls == count * pages
    assert peak <= BACKGROUND_LIMIT
    return dict(concurrency=concurrency, accounts=accounts, pages_per_code=pages,
                synthetic_latency_ms=latency * 1000, codes=count, calls=calls,
                elapsed_ms=round(elapsed * 1000, 2), peak_transport_calls=peak)


async def dedup_case(canonical, independent=False):
    scheduler = KiwoomCapacityScheduler(rate_per_sec=10000)
    scheduler.set_clients([object() for _ in range(4)])
    calls = 0

    async def fake(_):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.005)
        return {"observed_at": NOW.isoformat()}

    async def consumer(name, code):
        for page in range(2):
            # Independent confirmation rounds MUST NOT share an observation.
            epoch = name if independent else "same-observation"
            key = (("ka10081", code, "KRX", ANCHOR, page, epoch)
                   if canonical else (name, code, ANCHOR, page, epoch))
            await scheduler.submit(key=key, api_id="ka10081", priority="background", call=fake)

    try:
        await asyncio.gather(*(consumer(name, code) for name in ("update", "search") for code in range(12)))
    finally:
        await scheduler.aclose()
    expected = 24 if canonical and not independent else 48
    assert calls == expected, (calls, expected)
    return dict(canonical=canonical, independent_confirmation=independent, logical_calls=48,
                transport_calls=calls)


def seed(root, codes, days):
    sdir = root / "screener"
    sdir.mkdir(parents=True)
    rows = [dict(code=code, date=day, open=100., high=110., low=90., close=105., volume=100)
            for code in codes for day in days]
    frame = pl.DataFrame(rows, schema=_DAILY_PL_SCHEMA)
    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet"):
        frame.write_parquet(sdir / name)
    # Production-size roster makes repeated roster publication visible.
    roster = [f"{i:06d}" for i in range(4412)]
    pl.DataFrame(dict(code=roster, name=roster, market=["KOSPI"] * len(roster),
                      is_etf=[False] * len(roster), is_halted=[False] * len(roster))).write_parquet(
                          sdir / "stocks.parquet")
    pl.DataFrame(dict(code=codes, seg_start=[days[0]] * len(codes), factor=[1.] * len(codes))).write_parquet(
        sdir / "factors.parquet")
    store.ensure_baseline(root)


def observations(root, codes, days):
    captured = []

    def capture(_root, section, code, value, **_kwargs):
        assert section == "observations"
        captured.append((code, value))
        return "captured"

    # Reuse production input validation/value construction; only intercept publication.
    with patch.object(store, "_publish", capture):
        for code in codes:
            rows = [dict(date=day.isoformat(), code=code, open=100., high=110., low=90.,
                         close=105., volume=100, complete=True) for day in days]
            store.publish_pair(root, code, rows, rows, adjusted_as_of=ANCHOR,
                               price_events=[], observed_at=NOW.isoformat())
    return captured


def publish_batch(root, incoming):
    """Experimental single-writer publication, intentionally outside product code.

    Same object format/merge/atomic pointer as _publish, one roster/manifest per batch.
    This is a design probe, not a complete cancellation/restart implementation.
    """
    baseline = store.ensure_baseline(root)
    base = store.root(root)
    with store._series_write_lock(root / "screener"):
        old = store.load_snapshot(root)
        manifest = old[1] if old else dict(schema_version=1, baseline=baseline,
                                         observations={}, quantity={}, adjusted_as_of=None)
        updated = dict(manifest["observations"])
        for code, incoming_value in incoming:
            value = incoming_value
            if code in updated:
                previous = store.read_object(root, updated[code])
                if previous["adjusted_as_of"] > value["adjusted_as_of"]:
                    raise ValueError("backward adjusted basis")
                candidate = store._write_object(base, value)
                value = {**store._merge_observations(previous, value), "candidate_observation": candidate}
            updated[code] = store._write_object(base, value)
        etfs = symbols.all_etf_etn_codes()
        roster = pl.read_parquet(root / "screener/stocks.parquet")
        if etfs is not None:
            roster = roster.with_columns(pl.col("code").is_in(etfs).alias("is_etf"))
        manifest = {**manifest, "observations": updated, "parent": old[0] if old else None,
                    "adjusted_as_of": max([manifest["adjusted_as_of"] or ANCHOR] +
                                          [v["adjusted_as_of"] for _, v in incoming]),
                    "calendar": sorted(trading_days.trading_days(root)),
                    "etf_classification": "master" if etfs is not None else "legacy_roster",
                    "roster": store._write_object(base, roster.to_dicts())}
        identity = store._write_object(base, manifest)
        atomic_write_json(base / "current.json", {"id": identity})
        store._sync_dir(base)


def semantic_snapshot(root):
    _, manifest = store.load_snapshot(root)
    return {k: v for k, v in manifest.items() if k != "parent"}


def storage_integrity(tmp, inputs, days, reference):
    # Failure before the current pointer switch must preserve the old readable snapshot.
    root = Path(tmp) / "r2-b24"
    before = (store.root(root) / "current.json").read_bytes()
    real_write = atomic_write_json

    def fail_pointer(path, value):
        if path.name == "current.json":
            raise OSError("injected pointer failure")
        real_write(path, value)

    with patch.dict(publish_batch.__globals__, atomic_write_json=fail_pointer):
        try:
            publish_batch(root, inputs[:8])
        except OSError:
            pass
        else:
            raise AssertionError("fault was not injected")
    assert (store.root(root) / "current.json").read_bytes() == before
    assert semantic_snapshot(root) == reference

    # Same-basis conflicting originals remain isolated; new adjusted bases do not mix.
    serial, batched = Path(tmp) / "r2-b1", Path(tmp) / "r2-b24"
    code, old_value = inputs[0]
    changed = json.loads(json.dumps(old_value))
    changed["unadjusted"][0]["volume"] += 1
    store._publish(serial, "observations", code, changed, anchor=ANCHOR)
    publish_batch(batched, [(code, changed)])
    assert semantic_snapshot(serial) == semantic_snapshot(batched)
    manifest = store.load_snapshot(batched)[1]
    observation = store.read_object(batched, manifest["observations"][code])
    assert days[0].isoformat() in observation["conflicts"]
    assert observation["unadjusted"][0]["volume"] == VOLUME
    next_basis = json.loads(json.dumps(changed))
    next_basis["adjusted_as_of"] = "2026-11-02"
    next_basis["observed_at"] = "2026-11-02T18:00:00+09:00"
    next_basis["adjusted"] = next_basis["adjusted"][-NEW_BASIS_BARS:]
    store._publish(serial, "observations", code, next_basis, anchor="2026-11-02")
    publish_batch(batched, [(code, next_basis)])
    assert semantic_snapshot(serial) == semantic_snapshot(batched)
    manifest = store.load_snapshot(batched)[1]
    observation = store.read_object(batched, manifest["observations"][code])
    assert len(observation["adjusted"]) == NEW_BASIS_BARS


def storage_cases():
    days = []
    day = dt.date(2026, 10, 30)
    while len(days) < BARS:
        if day.weekday() < WEEKDAYS:
            days.append(day)
        day -= dt.timedelta(days=1)
    days.sort()
    codes = [f"{i:06d}" for i in range(48)]
    calendar = [d.strftime("%Y%m%d") for d in days]
    results, reference = [], None
    with patch.object(trading_days, "trading_days", lambda _: calendar), \
            patch.object(symbols, "all_etf_etn_codes", lambda: None), tempfile.TemporaryDirectory() as tmp:
        for repeat in range(3):
            for batch_size in (1, 8, 24):
                root = Path(tmp) / f"r{repeat}-b{batch_size}"
                seed(root, codes, days)
                inputs = observations(root, codes, days)
                legacy_before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in (root / "screener").glob("*.parquet")}
                started = time.perf_counter()
                if batch_size == 1:
                    for code, value in inputs:
                        store._publish(root, "observations", code, value, anchor=ANCHOR)
                else:
                    for first in range(0, len(inputs), batch_size):
                        publish_batch(root, inputs[first:first + batch_size])
                elapsed = (time.perf_counter() - started) * 1000
                result = semantic_snapshot(root)
                reference = result if reference is None else reference
                assert result == reference, "batching changed semantic snapshot"
                assert legacy_before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                         for p in (root / "screener").glob("*.parquet")}
                results.append(dict(repeat=repeat, batch_size=batch_size, codes=len(codes), bars_per_code=700,
                                    roster_codes=4412, elapsed_ms=round(elapsed, 2),
                                    publications=(len(codes) + batch_size - 1) // batch_size))
                print(json.dumps({"storage": results[-1]}), flush=True)

        storage_integrity(tmp, inputs, days, reference)
    return results


async def main():
    result = {"head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
              "scope": "offline synthetic transport; real production governor/store; no vendor speed claim",
              "transport": [], "dedup": []}
    for latency in (.08, .20):
        for concurrency in (1, 3, 4, 6):
            runs = [await transport_case(concurrency, latency) for _ in range(3)]
            result["transport"].append({**runs[0], "runs_ms": [r["elapsed_ms"] for r in runs],
                                        "median_ms": statistics.median(r["elapsed_ms"] for r in runs)})
            print(json.dumps({"transport": result["transport"][-1]}), flush=True)
    for concurrency in (1, 4):
        run = await transport_case(concurrency, .08, accounts=1, count=12)
        result["transport"].append(run)
        print(json.dumps({"transport": run}), flush=True)
    for canonical, independent in ((False, False), (True, False), (True, True)):
        result["dedup"].append(await dedup_case(canonical, independent))
    result["storage"] = await asyncio.to_thread(storage_cases)
    result["assertions"] = {"semantic_snapshot_equal": True, "legacy_files_unchanged": True,
                             "pointer_failure_preserves_snapshot": True,
                             "original_conflict_preserved": True,
                             "adjustment_basis_not_mixed": True,
                             "independent_confirmation_not_deduped": True}
    (OUT / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print("All probe assertions passed; results.json written.", flush=True)


async def raw_update_matrix():
    results = []
    for latency in (.08, .20):
        for concurrency in (3, 4):
            runs = [await transport_case(concurrency, latency, accounts=6, pages=1, count=48) for _ in range(3)]
            result = {**runs[0], "runs_ms": [r["elapsed_ms"] for r in runs],
                      "median_ms": statistics.median(r["elapsed_ms"] for r in runs)}
            results.append(result)
            print(json.dumps(result), flush=True)
    (OUT / "raw-update-results.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    if "--raw-update" in sys.argv:
        asyncio.run(raw_update_matrix())
    elif "--storage-only" in sys.argv:
        storage_cases()
    else:
        asyncio.run(main())
