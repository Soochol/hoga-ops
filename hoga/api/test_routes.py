"""Dev-only test routes - gated behind HOGA_ENABLE_TEST_ENDPOINTS=1.

These endpoints exist solely to bootstrap E2E test data. They are NEVER
included in the app when the env var is unset, so production builds cannot
expose them.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from hoga.parser import parse_stock_date

# Reject any non-canonical Code / Stock-Date BEFORE it reaches `dest = data_dir /
# "raw" / date / code`, which would otherwise allow filesystem path traversal
# (e.g. date="..") when this dev-only router is enabled.
_CODE_PATTERN = r"^\d{6}$"
_DATE_PATTERN = r"^\d{8}$"


def build_test_router(data_dir: Path) -> APIRouter:
    """Construct the dev-only test router bound to the given data_dir.

    Fixture source path is resolved relative to the repo root (the parent of
    ``hoga/``). If the fixtures directory doesn't exist (e.g. installed wheel
    without test data), the endpoint returns 503.
    """
    router = APIRouter(prefix="/api/test", tags=["test"])

    # Find repo root by walking up from this file until we hit tests/fixtures.
    here = Path(__file__).resolve()
    fixtures_root: Path | None = None
    for parent in [here.parent, *here.parents]:
        candidate = parent / "tests" / "fixtures" / "tiny_tsv_multi"
        if candidate.is_dir():
            fixtures_root = candidate
            break

    @router.post("/add-stockdate")
    def add_stockdate(
        code: str = Query(..., pattern=_CODE_PATTERN),
        date: str = Query(..., pattern=_DATE_PATTERN),
    ) -> dict:
        if fixtures_root is None:
            raise HTTPException(
                status_code=503,
                detail="tiny_tsv_multi fixtures not available in this install",
            )
        src = fixtures_root / code
        if not src.is_dir():
            raise HTTPException(
                status_code=404,
                detail=f"no fixture for code={code}",
            )
        dest = data_dir / "raw" / date / code
        dest.mkdir(parents=True, exist_ok=True)
        for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
            src_file = src / name
            if not src_file.exists():
                raise HTTPException(
                    status_code=500,
                    detail=f"fixture {code}/{name} missing",
                )
            shutil.copy(src_file, dest / name)
        # Parse -> parquet (this triggers the watchdog observer)
        parse_stock_date(code=code, date=date, data_dir=data_dir)
        return {"ok": True, "code": code, "date": date}

    return router
