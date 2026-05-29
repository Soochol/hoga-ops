"""Atomic JSON write helper. Extracted per ADR-0015 footer + ADR-0019.

Used by:
- hoga/api/symbols.py (Symbol Master disk cache)
- hoga/api/captures_persistence.py (Capture Queue manifest)
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, payload: Any, *, indent: int = 2) -> None:
    """Write ``payload`` as JSON to ``path`` atomically.

    Pattern: tempfile in target's parent dir → flush + fsync → os.replace.
    The parent dir is created if missing. Korean text is preserved
    (ensure_ascii=False).

    Raises:
        OSError: if disk write fails. Callers decide whether to propagate.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=indent)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def atomic_write_parquet_table(path: Path, table: Any) -> None:
    """Write a pyarrow ``Table`` to ``path`` atomically (tempfile + os.replace).

    Schema-strict counterpart of :func:`atomic_write_parquet` — caller has
    already constructed a ``pa.Table`` with the canonical ``PARQUET_SCHEMA``,
    so this just owns the durability/atomicity. Use from
    ``hoga.tables.*.write_parquet`` so today_promoter's overwrite during a
    polling cycle never leaves a partial file visible to readers.

    The parent dir is created if missing.

    Raises:
        OSError: if disk write fails. On failure the target is unchanged
            (the tempfile may linger; callers can ignore).
    """
    import pyarrow.parquet as pq  # local import — heavy

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        pq.write_table(table, tmp_path)
        os.replace(tmp_path, path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def atomic_write_parquet(path: Path, records: list[dict[str, Any]]) -> None:
    """Write ``records`` as Parquet to ``path`` atomically.

    Empty ``records`` → unlink existing file. polars handles empty
    DataFrame poorly, and downstream DuckDB read_parquet errors on
    zero-row files in some configurations — so we represent "no data"
    as "no file" (callers must handle FileNotFoundError on the read
    side, which the standard try/except FileNotFoundError pattern does).

    Pattern: tempfile in target's parent dir → polars write → os.replace.
    The parent dir is created if missing.

    Raises:
        OSError: if disk write fails. On failure the target is unchanged
            (the tempfile may linger; callers can ignore).
    """
    import polars as pl  # local import — heavy module

    path.parent.mkdir(parents=True, exist_ok=True)

    if not records:
        path.unlink(missing_ok=True)
        return

    with tempfile.NamedTemporaryFile(
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        pl.DataFrame(records).write_parquet(tmp_path)
        os.replace(tmp_path, path)
    except Exception:
        # write_parquet raised — tempfile is partial/empty; clean up.
        tmp_path.unlink(missing_ok=True)
        raise
