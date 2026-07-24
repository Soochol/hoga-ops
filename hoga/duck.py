"""Central DuckDB connection factory.

Every in-process DuckDB connection must come from here so that a single
runaway query can never take the whole server down: the default
``memory_limit`` for an in-memory DuckDB is 80% of physical RAM and its
default ``temp_directory`` is ``<cwd>/.tmp`` — both caused the 2026-07-05
356GB spill / repeated uvicorn OOM kills.
"""
from __future__ import annotations

import os
from pathlib import Path

import duckdb

from hoga.config import resolve_data_dir

DEFAULT_MEMORY_LIMIT = "8.0 GiB"
DEFAULT_MAX_TEMP_SIZE = "50.0 GiB"


def connect_bounded(
    *,
    memory_limit: str | None = None,
    temp_directory: Path | None = None,
    max_temp_directory_size: str | None = None,
) -> duckdb.DuckDBPyConnection:
    limit = memory_limit or os.environ.get("HOGA_DUCKDB_MEMORY_LIMIT", DEFAULT_MEMORY_LIMIT)
    tmp = (
        resolve_data_dir() / "duckdb-tmp"
        if temp_directory is None
        else temp_directory
    )
    tmp.mkdir(parents=True, exist_ok=True)
    max_tmp = max_temp_directory_size or os.environ.get(
        "HOGA_DUCKDB_MAX_TEMP_SIZE", DEFAULT_MAX_TEMP_SIZE
    )
    return duckdb.connect(
        database=":memory:",
        read_only=False,
        config={
            "memory_limit": limit,
            "temp_directory": str(tmp),
            "max_temp_directory_size": max_tmp,
        },
    )
