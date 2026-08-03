"""Dev-only test routes - gated behind HOGA_ENABLE_TEST_ENDPOINTS=1.

These endpoints exist solely to bootstrap E2E test data. They are NEVER
included in the app when the env var is unset, so production builds cannot
expose them.
"""

from __future__ import annotations

import calendar as calendar_mod
import datetime as dt
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hoga.api.captures_fake import configure_fake_to_raise_on
from hoga.api.params import Code, StockDate
from hoga.parser import parse_stock_date


class CookieExpireAt(BaseModel):
    index: int


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
    def add_stockdate(code: Code, date: StockDate) -> dict:
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

    @router.post("/cookie_expire_at")
    def cookie_expire_at(req: CookieExpireAt) -> dict:
        """Configure FakeHogaplayClient to raise CookieExpiredError on the Nth
        global fetch_first call. Pass index <= 0 to disable.
        """
        configure_fake_to_raise_on(req.index)
        return {"ok": True}

    @router.post("/seed-trading-days")
    def seed_trading_days(year: int, month: int) -> dict:
        """해당 달의 **평일 전부**를 거래일로 만든다(벤더 없이).

        범위 캡처 enqueue 는 `trading_days_in_range` 로 거래일 목록을 확정하는데,
        e2e 러너에는 그 달이 달력 커버리지 밖일 수 있다(정적 시드는 커밋 시점까지만
        덮는다). 그러면 근사 경고가 붙거나 날짜 집합이 실행 시점에 따라 달라져
        **개수 단언이 흔들린다.**

        PR-H(#1044) 이전에는 `_calendar._month_cache` 를 선주입했다. 그 캐시는
        사라졌고, 지금의 확장점은 **data_dir 오버레이**다 —
        `trading_days.append_overlay` 가 공개 API 이고 프로덕션 갱신 경로가 쓰는
        것과 같은 자리다. 오버레이는 합집합이라 시드가 휴장으로 아는 날짜도
        거래일로 덮어쓴다(그게 이 라우트의 원래 계약이다).

        휴장일은 무시된다(평일이면 전부 거래일). e2e 결정성을 위해 의도한 것이며,
        진짜 휴장일 판정은 `tests/api/test_trading_days_source.py` 가 덮는다.
        """
        from hoga.api import (  # noqa: PLC0415 — 테스트 전용 지연 import(프로덕션 미마운트)
            calendar as _calendar,
            trading_days as _trading_days,
        )

        last = calendar_mod.monthrange(year, month)[1]
        weekdays = sorted(
            f"{year:04d}{month:02d}{day:02d}"
            for day in range(1, last + 1)
            if dt.date(year, month, day).weekday() < 5  # noqa: PLR2004 — 5=토
        )
        _trading_days.append_overlay(data_dir, weekdays)
        # 세션 판정 캐시(ADR-0064)까지 비운다 — 오늘에 대한 옛 False 가 남아 있으면
        # 새로 심은 거래일이 반영되지 않는다.
        _calendar.reset_cache_for_tests()
        _calendar.set_data_dir(data_dir)
        return {"ok": True, "year": year, "month": month, "trading_days": len(weekdays)}

    return router
