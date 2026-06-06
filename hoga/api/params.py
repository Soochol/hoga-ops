"""Annotated query-parameter types for FastAPI route handlers.

Validates **Code** (KRX ticker) and **Stock-Date** (YYYYMMDD) at the boundary
so these strings can never reach filesystem joins or DuckDB queries as
arbitrary values. CONTEXT.md defines the canonical shapes; this is the
machine-readable enforcement.

CODE_PATTERN is the single source for the ticker grammar, shared by every
validator (models, routes, live api). KRX short codes are 6 alphanumeric chars
(the newer ticker scheme adds letters — e.g. 0000H0 ETF, 0001A0 KOSDAQ stock);
ETNs use 'Q' + 6 digits (7 chars, e.g. Q500093). Anything else is rejected.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Query

CODE_PATTERN = r"^(?:[0-9A-Z]{6}|Q[0-9]{6})$"

Code = Annotated[str, Query(..., pattern=CODE_PATTERN)]
StockDate = Annotated[str, Query(..., pattern=r"^\d{8}$")]
