"""Boundary validation: Code and Stock-Date must match their canonical regex
before they reach any filesystem join or DuckDB query.

CONTEXT.md defines:
- **Code**: a 6-digit KRX ticker, e.g. ``005930``
- **Stock-Date**: ``(Code, YYYYMMDD)`` pair

The route layer enforces these via ``pattern=r"^\\d{6}$"`` and ``r"^\\d{8}$"``.
This test pins that enforcement so a future refactor can't accidentally drop
the regex constraint and re-expose the path-traversal hazard adversarial
review caught (e.g. ``date=".."`` flowing into ``data_dir/parquet/{date}/{code}``).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.mark.parametrize(
    "endpoint",
    [
        "/api/meta",
        "/api/orderbook?t=0",
        "/api/trades?t=0",
        "/api/candles",
        "/api/brokers?t=0",
        "/api/session",
    ],
)
@pytest.mark.parametrize(
    ("code", "date"),
    [
        ("..", "20260519"),
        ("abc", "20260519"),
        ("00349", "20260519"),
        ("0034900", "20260519"),
        ("003490", ".."),
        ("003490", "2026-05-19"),
        ("003490", "20260519x"),
        ("003490", "../etc"),
    ],
)
def test_routes_reject_non_canonical_code_or_date(
    app_client: TestClient, endpoint: str, code: str, date: str
) -> None:
    sep = "&" if "?" in endpoint else "?"
    r = app_client.get(f"{endpoint}{sep}code={code}&date={date}")
    assert r.status_code == 422, (
        f"expected 422 for code={code!r} date={date!r} on {endpoint}; "
        f"got {r.status_code}: {r.text}"
    )
