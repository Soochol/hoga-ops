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
        """해당 달의 거래일 캐시를 **평일**로 채운다(KIS 없이).

        범위 캡처 enqueue 는 `trading_days_in_range` 로 거래일 목록을 확정하는데, 이
        경로에는 폴백이 없어 KIS 자격증명이 없으면 503
        (`KIS_CREDENTIALS_MISSING`)으로 즉시 실패한다 — CI 에는 자격증명이 없으므로
        `range-capture` · `cookie-pause` 가 통과할 수 없었다(실측: UI 에 "범위 캡처 시작
        실패 — KIS 자격증명 미설정"). 자격증명이 **있는** 로컬은 더 나쁘다: 반복 실행이
        KIS 토큰 발급 쿨다운(분당 1회)에 걸려 같은 스펙이 201/503 을 오간다.

        `trading_days_in_range` 의 docstring 이 지정한 확장점(`_month_cache` 선주입)을
        그대로 쓴다. 업스트림 클라이언트를 `FakeHogaplayClient` 로 갈아끼우는 기존 테스트
        모드 설계와 같은 결이다 — 라우터 자체가 프로덕션에 마운트되지 않는다.

        휴장일은 무시된다(평일이면 전부 거래일). e2e 결정성을 위해 의도한 것이며, 진짜
        휴장일 판정은 `kis_holidays` 단위 테스트가 덮는다.
        """
        from hoga.api import calendar as _calendar  # noqa: PLC0415 — 테스트 전용 지연 import

        last = calendar_mod.monthrange(year, month)[1]
        weekdays = {
            f"{year:04d}{month:02d}{day:02d}"
            for day in range(1, last + 1)
            if dt.date(year, month, day).weekday() < 5  # noqa: PLR2004 — 5=토
        }
        with _calendar._trading_days_lock:
            _calendar._month_cache[(year, month)] = weekdays
            _calendar._failure_cache.pop((year, month), None)
        return {"ok": True, "year": year, "month": month, "trading_days": len(weekdays)}

    return router
