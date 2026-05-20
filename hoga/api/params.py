"""Annotated query-parameter types for FastAPI route handlers.

Validates **Code** (6-digit KRX ticker) and **Stock-Date** (YYYYMMDD) at the
boundary so these strings can never reach filesystem joins or DuckDB queries
as arbitrary values. CONTEXT.md defines the canonical shapes; this is the
machine-readable enforcement.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Query

Code = Annotated[str, Query(..., pattern=r"^\d{6}$")]
StockDate = Annotated[str, Query(..., pattern=r"^\d{8}$")]
