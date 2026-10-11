"""요청 기반 뉴스 조회. 창 간 공유·60초 캐시, 거래 데이터 수집과 분리한다."""
from __future__ import annotations

import asyncio
import html
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import StockNewsItem, StockNewsResponse
from hoga.live.kis_client import KisApiError, KisAuthError, KisClient, KisRateLimitError
from hoga.live.kis_runtime import ensure_kis_client_for_account
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
_CODE_LENGTH = 6
_CACHE_TTL_S = 60
_CACHE_CAPACITY = 128
_DATE_LENGTH = 8
_TIME_LENGTH = 6


def normalize_news(rows: list[dict[str, Any]], date: str | None) -> list[StockNewsItem]:
    items: dict[str, StockNewsItem] = {}
    for row in rows[:40]:
        serial = str(row.get("cntt_usiq_srno") or "").strip()
        title = html.unescape(str(row.get("hts_pbnt_titl_cntt") or "")).strip()
        if not serial or not title:
            raise ValueError("news row missing identity/title")
        raw_date = str(row.get("data_dt") or "")
        if date and raw_date != date:
            continue  # 기준일 이전 기사가 섞여도 선택일 기사로 오인하지 않는다.
        try:
            raw_time = str(row.get("data_tm") or "")
            if len(raw_date) != _DATE_LENGTH or len(raw_time) != _TIME_LENGTH:
                raise ValueError("invalid news timestamp")
            published = datetime.strptime(raw_date + raw_time, "%Y%m%d%H%M%S")
            published_ms = int(published.replace(tzinfo=KST).timestamp() * 1000)
        except ValueError:
            published_ms = None
        provider = str(row.get("news_ofer_entp_code") or "").strip()
        identity = f"{provider}:{serial}"
        codes = list(dict.fromkeys(
            code for i in range(1, 11)
            if len(code := str(row.get(f"iscd{i}") or "").strip()) == _CODE_LENGTH and code.isdigit()
        ))
        items[identity] = StockNewsItem(
            id=identity, title=title, source=str(row.get("dorg") or "").strip() or "출처 미상",
            published_at_ms=published_ms, related_codes=codes,
        )
    return sorted(items.values(), key=lambda item: item.published_at_ms or 0, reverse=True)


class StockNewsService:
    def __init__(self, client_factory: Callable[[], KisClient | None]) -> None:
        self.client_factory = client_factory
        self.cache: OrderedDict[tuple[str, str | None], tuple[float, StockNewsResponse]] = OrderedDict()
        self.pending: dict[tuple[str, str | None], asyncio.Task[StockNewsResponse]] = {}

    async def get(self, code: str, date: str | None) -> StockNewsResponse:
        key = (code, date)
        cached = self.cache.get(key)
        if cached and time.monotonic() - cached[0] < _CACHE_TTL_S:
            self.cache.move_to_end(key)
            return cached[1]
        task = self.pending.get(key)
        if task is None:
            task = asyncio.create_task(self._load(key, cached[1] if cached else None))
            self.pending[key] = task
        return await asyncio.shield(task)

    async def _load(self, key: tuple[str, str | None], previous: StockNewsResponse | None) -> StockNewsResponse:
        code, date = key
        try:
            client = self.client_factory()
            if client is None:
                response = StockNewsResponse(code=code, date=date, status="unconfigured")
            else:
                rows = await client.fetch_stock_news(code, date)
                response = StockNewsResponse(
                    code=code, date=date, status="ok", items=normalize_news(rows, date),
                    fetched_at_ms=int(time.time() * 1000),
                )
        except (KisApiError, KisAuthError, KisRateLimitError, httpx.HTTPError, ValueError, OSError):
            # 벤더 예외 문자열/HTTP 헤더는 응답·로그에 노출하지 않는다.
            log.warning("stock news unavailable code=%s date=%s", code, date)
            response = StockNewsResponse(
                code=code, date=date, status="error",
                items=previous.items if previous else [],
                fetched_at_ms=previous.fetched_at_ms if previous else None,
            )
        finally:
            self.pending.pop(key, None)
        self.cache[key] = (time.monotonic(), response)
        self.cache.move_to_end(key)
        while len(self.cache) > _CACHE_CAPACITY:
            self.cache.popitem(last=False)
        return response


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/news", tags=["news"])
    service = StockNewsService(lambda: ensure_kis_client_for_account(0, data_dir))

    @router.get("/stock", response_model=StockNewsResponse)
    async def get_stock_news(
        code: str = Query(pattern=r"^\d{6}$"),
        date: str | None = Query(default=None, pattern=r"^\d{8}$"),
    ) -> StockNewsResponse:
        if date:
            try:
                selected = datetime.strptime(date, "%Y%m%d").date()
            except ValueError as exc:
                raise HTTPException(422, "유효한 날짜를 선택해주세요") from exc
            if selected > datetime.now(KST).date():
                raise HTTPException(422, "미래 날짜는 조회할 수 없습니다")
        return await service.get(code, date)

    return router
