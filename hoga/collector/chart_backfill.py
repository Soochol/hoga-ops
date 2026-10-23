"""Add missing earlier chart.php candles without re-parsing orderflow."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from hoga.api.invariants import StockDateArtifacts, check_series
from hoga.tables import candles
from hoga.util.atomic_write import atomic_write_json, atomic_write_text
from hoga.util.timeenc import KST

_DAY_MS = 86_400_000


@dataclass(frozen=True)
class ChartRepairResult:
    added: int
    before_count: int
    after_count: int
    first_ms: int | None


def _rows(body: str) -> dict[int, tuple[candles.Candle, str]]:
    rows: dict[int, tuple[candles.Candle, str]] = {}
    for line in body.splitlines():
        if not line.strip():
            continue
        candle = candles.parse_row(line)
        if not 0 <= candle.ts_ms < _DAY_MS:
            raise ValueError(f"candle timestamp outside the requested day: {candle.ts_ms}")
        if candle.ts_ms in rows and rows[candle.ts_ms][0] != candle:
            raise ValueError(f"conflicting chart rows at {candle.ts_ms}")
        rows[candle.ts_ms] = candle, line
    return rows


def _digest(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def repair_chart(
    data_dir: Path, *, code: str, date: str, chart_body: str, backup_dir: Path,
) -> ChartRepairResult:
    """Prepend older candles, preserving every existing candle and capture bit.

    Requires existing hogaplay metadata: candle-only data must not masquerade
    as a new Full Capture. Back up all three changed files before publishing;
    reject concurrent changes and roll back if any publication fails. Touching
    meta last invalidates the running app's mtime-based inventory cache.
    """
    source = data_dir / "parquet" / date / code / "hogaplay"
    raw_path = data_dir / "raw" / date / code / "chart.tsv"
    parquet_path = source / "candles.parquet"
    meta_path = source / "meta.json"
    paths = [raw_path, parquet_path, meta_path]
    before = {path: _digest(path) for path in paths}
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    existing = candles.read_parquet(parquet_path)
    oldest = min((c.ts_ms for c in existing), default=None)
    fetched = _rows(chart_body)
    added = [c for ts, (c, _) in fetched.items() if oldest is None or ts < oldest]
    if not added:
        return ChartRepairResult(0, len(existing), len(existing), oldest)
    merged = sorted(existing + added, key=lambda c: c.ts_ms)
    violations = check_series(StockDateArtifacts(meta=meta, candles=merged))
    if violations:
        raise ValueError(f"repaired candle invariants failed: {violations}")

    # Raw may have been pruned while Parquet survives. Use freshly fetched
    # rows only when they reproduce the existing candle exactly; never invent
    # lost TSV fields or overwrite a historical OHLCV with a changed response.
    original_raw = _rows(raw_path.read_text(encoding="utf-8")) if raw_path.exists() else {}
    raw_rows = {c.ts_ms: fetched[c.ts_ms][1] for c in added}
    for candle in existing:
        row = original_raw.get(candle.ts_ms) or fetched.get(candle.ts_ms)
        if row is None or row[0] != candle:
            raise ValueError(f"cannot reproduce existing candle from raw at {candle.ts_ms}")
        raw_rows[candle.ts_ms] = row[1]
    body = "".join(raw_rows[ts] + "\n" for ts in sorted(raw_rows, reverse=True))
    # Only candle invariants were re-evaluated; retain every other archived
    # violation, and do not increment capture counters or change completeness.
    archived = meta.get("invariant_violations") or []
    retained = [v for v in archived if v.get("invariant_id") != "series.candles_ts_monotonic"]
    if retained:
        meta["invariant_violations"] = retained
    else:
        meta.pop("invariant_violations", None)
    meta["chart_history_backfill"] = {
        "at_kst": datetime.now(KST).isoformat(),
        "added_candles": len(added),
        "previous_first_ms": oldest,
        "first_ms": merged[0].ts_ms,
    }

    _publish_repair(paths, before, backup_dir / date / code, body, merged, meta)
    return ChartRepairResult(len(added), len(existing), len(merged), merged[0].ts_ms)


def _publish_repair(
    paths: list[Path], before: dict[Path, str | None], backup: Path,
    body: str, merged: list[candles.Candle], meta: dict,
) -> None:
    raw_path, parquet_path, meta_path = paths
    backup.mkdir(parents=True, exist_ok=False)
    for path in paths:
        if before[path] is not None:
            shutil.copy2(path, backup / path.name)
    atomic_write_json(backup / "manifest.json", {
        str(path): before[path] for path in paths
    })
    if any(_digest(path) != before[path] for path in paths):
        raise RuntimeError(f"capture changed during chart repair: {meta_path}")
    try:
        atomic_write_text(raw_path, body)
        candles.write_parquet(merged, parquet_path)
        atomic_write_json(meta_path, meta)
    except Exception:
        for path in paths:
            if before[path] is None:
                path.unlink(missing_ok=True)
            else:
                _restore_file(backup / path.name, path)
        raise


def _restore_file(backup: Path, target: Path) -> None:
    fd, name = tempfile.mkstemp(dir=target.parent, prefix=target.name + ".rollback-")
    os.close(fd)
    staged = Path(name)
    try:
        shutil.copy2(backup, staged)
        os.replace(staged, target)
    finally:
        staged.unlink(missing_ok=True)
