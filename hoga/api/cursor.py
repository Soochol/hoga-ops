"""API-boundary helper for translating a **Cursor** (Unix-ms point on the
API contract per ADR 0003) into the native HHMMSSmmm encoding the table
modules store on Parquet.

This module sits at the route-handler seam. It's separate from
``hoga.api.timeenc`` so the latter stays a pure encoding module without
FastAPI as a dependency: ``timeenc`` is unit-testable in isolation, and
``cursor`` only exists where HTTP semantics belong.
"""

from __future__ import annotations

from fastapi import HTTPException

from hoga.api.timeenc import unix_ms_to_hhmmssms


def cursor_to_native(date: str, unix_ms: int) -> int:
    """Translate a Unix-ms request cursor to the HHMMSSmmm encoding the
    trades/snapshots/brokers tables expect.

    Out-of-day cursors — for example, ``date=20260519`` with a cursor that
    falls on 2026-05-20 — produce HTTPException(400) instead of leaking
    the underlying ``ValueError`` from :func:`unix_ms_to_hhmmssms` as a
    500. This is the route layer's contract: client errors are 4xx.
    """
    try:
        return unix_ms_to_hhmmssms(date, unix_ms)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
