from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Query

from hoga.api.models import (
    SignalAlertClearResponse,
    SignalAlertRecentResponse,
    SignalAlertScope,
    SignalAlertSettings,
    SignalAlertSettingsUpdate,
)
from hoga.live.signal_alerts import (
    clear_today_inbox,
    load_signal_alert_settings,
    recent_response,
    update_signal_alert_settings,
)

_KST = timezone(timedelta(hours=9))


def _today() -> str:
    return datetime.now(_KST).strftime("%Y%m%d")


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/signal-alerts", tags=["signal-alerts"])

    @router.get("/settings", response_model=SignalAlertSettings)
    async def get_settings() -> SignalAlertSettings:
        return load_signal_alert_settings(data_dir)

    @router.patch("/settings", response_model=SignalAlertSettings)
    async def patch_settings(req: SignalAlertSettingsUpdate) -> SignalAlertSettings:
        return update_signal_alert_settings(data_dir, req)

    @router.get("/recent", response_model=SignalAlertRecentResponse)
    async def get_recent(
        date: str | None = Query(None, pattern=r"^\d{8}$"),
        limit: int = Query(100, ge=1, le=500),
        scope: SignalAlertScope = "inbox",
    ) -> SignalAlertRecentResponse:
        return recent_response(data_dir, date or _today(), limit=limit, scope=scope)

    @router.post("/clear-today", response_model=SignalAlertClearResponse)
    async def clear_today(
        date: str | None = Query(None, pattern=r"^\d{8}$"),
    ) -> SignalAlertClearResponse:
        return clear_today_inbox(data_dir, date or _today())

    return router
