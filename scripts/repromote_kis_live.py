"""One-shot: delete kis_live/ parquet dirs and re-promote from preserved JSONL.

Use after deploying the ADR-0049 encoding fix (hoga/live/promote.py) to
restore historical dates that the today_promoter won't touch (it only
handles today).

DO NOT run for today — today_promoter is actively writing today's
kis_live dir via atomic_write_parquet (tempfile + rename). This script's
shutil.rmtree can interleave with the promoter's mkdir/rename and
produce a transient FileNotFoundError or partial dir. For today, use:
    rm -rf data/parquet/{today}/*/kis_live
and let the next 5-min today_promoter cycle rebuild from scratch.

Usage:
    uv run python scripts/repromote_kis_live.py --date 20260527
    uv run python scripts/repromote_kis_live.py --date 20260527 --code 005930

JSONL source resolution (in order):
    1. <data_dir>/live/{date}/{code}.jsonl              (not yet archived)
    2. <data_dir>/live/_archive/{date}/{code}.jsonl     (Daily Promotion 이후)
"""
from __future__ import annotations

import argparse
import asyncio
import shutil
from pathlib import Path

from hoga.config import resolve_data_dir
from hoga.live.promote import promote_one


def _resolve_jsonl(data_dir: Path, date: str, code: str) -> Path | None:
    """Find the JSONL for (date, code), preferring the live dir over archive."""
    live = data_dir / "live" / date / f"{code}.jsonl"
    if live.exists():
        return live
    archive = data_dir / "live" / "_archive" / date / f"{code}.jsonl"
    if archive.exists():
        return archive
    return None


async def repromote(data_dir: Path, *, date: str, code: str | None) -> None:
    """Re-promote (date, code) — or every code with a JSONL on that date.

    Steps per code:
      1. Resolve JSONL via _resolve_jsonl (live > archive).
      2. Delete existing kis_live parquet dir (this bypasses promote_one's
         meta.json idempotency guard — intentional, per ADR-0049 spec).
      3. Call promote_one which re-encodes ts_ms per the new contract.

    Per-code errors are caught + logged; the loop continues so a single
    bad JSONL doesn't leave the batch half-recovered. Exits non-zero if
    any code failed.
    """
    parquet_root = data_dir / "parquet"
    live_dir = data_dir / "live" / date
    archive_dir = data_dir / "live" / "_archive" / date

    if code is not None:
        codes = [code]
    else:
        seen: set[str] = set()
        for d in (live_dir, archive_dir):
            if d.exists():
                for p in d.glob("*.jsonl"):
                    seen.add(p.stem)
        codes = sorted(seen)

    if not codes:
        print(f"no JSONL found for date={date} (live or archive)")
        return

    total = len(codes)
    recovered = 0
    skipped = 0
    failures: list[tuple[str, str]] = []

    for idx, c in enumerate(codes, start=1):
        prefix = f"[{idx}/{total}]"
        jsonl = _resolve_jsonl(data_dir, date, c)
        if jsonl is None:
            print(f"{prefix} skip {c}: no JSONL")
            skipped += 1
            continue
        target = parquet_root / date / c / "kis_live"
        try:
            if target.exists():
                print(f"{prefix} delete {target}")
                shutil.rmtree(target)
            print(f"{prefix} promote {date}/{c} from {jsonl}")
            await promote_one(jsonl, parquet_root, code=c, date=date)
            recovered += 1
        except Exception as e:  # noqa: BLE001 — one bad JSONL must not abort batch
            print(f"{prefix} FAILED {c}: {type(e).__name__}: {e}")
            failures.append((c, f"{type(e).__name__}: {e}"))

    print(
        f"\nrecovered={recovered} skipped={skipped} failed={len(failures)} "
        f"total={total}"
    )
    if failures:
        print("failures:")
        for c, msg in failures:
            print(f"  {c}: {msg}")
        raise SystemExit(1)


def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="YYYYMMDD")
    parser.add_argument(
        "--code",
        help="6-digit Code; if omitted, all codes with JSONL on that date",
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help="Override data dir (default: resolve_data_dir())",
    )
    args = parser.parse_args()
    data_dir = Path(args.data_dir) if args.data_dir else resolve_data_dir()
    asyncio.run(repromote(data_dir, date=args.date, code=args.code))


if __name__ == "__main__":
    _main()
