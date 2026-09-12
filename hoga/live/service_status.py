"""Provider connectivity and sourced maintenance notices, independent of market hours."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, model_validator

from hoga.util.atomic_write import atomic_write_json

_log = logging.getLogger(__name__)
FRESH_MS = 120_000


class MaintenanceNotice(BaseModel):
    id: str
    starts_at_ms: int
    ends_at_ms: int
    reason: str
    source: str

    @model_validator(mode="after")
    def check_window(self):
        if self.ends_at_ms <= self.starts_at_ms:
            raise ValueError("maintenance end must follow start")
        return self


DEFAULT_NOTICE = MaintenanceNotice(
    id="kiwoom-20260912", starts_at_ms=1789169400000, ends_at_ms=1789210800000,
    reason="KRX 애프터마켓 이행 관련 시스템 작업",
    source="사용자 제공 키움 공지 · 홈페이지/HTS/MTS 전체 서비스 중단",
)


class ProviderStatus(BaseModel):
    observed_at_ms: int
    connection: Literal["unconfigured", "connecting", "unavailable", "partial", "connected"]
    connected_accounts: int
    configured_accounts: int
    last_received_at_ms: int | None = None
    notice: MaintenanceNotice | None = None
    notice_phase: Literal["scheduled", "active", "overdue"] | None = None
    notice_config_error: bool = False


def _load_notice(data_dir: Path | None) -> tuple[MaintenanceNotice | None, bool]:
    if data_dir is None or not (data_dir / "kiwoom-maintenance.json").exists():
        return DEFAULT_NOTICE, False
    try:
        raw = json.loads((data_dir / "kiwoom-maintenance.json").read_text())
        return (MaintenanceNotice.model_validate(raw) if raw is not None else None), False
    except (OSError, ValueError):
        _log.warning("Cannot read kiwoom maintenance notice")
        return None, True


def provider_status(data_dir: Path | None, session: dict | None, now_ms: int) -> ProviderStatus:
    """Only current per-account control responses establish WS recovery, never REST health."""
    k = session or {}
    configured = k.get("accounts_configured", 0) if k.get("enabled") else 0
    connected = k.get("connected_accounts", 0)
    accounts = k.get("accounts", [])
    fresh = [a for a in accounts if a.get("connected") and
             a.get("last_recv_ms") is not None and 0 <= now_ms - a["last_recv_ms"] <= FRESH_MS]
    if not configured:
        connection = "unconfigured"
    elif connected == 0:
        failed = any(a.get("last_error_type") or a.get("last_close_code") for a in accounts)
        connection = "unavailable" if failed else "connecting"
    elif connected < configured or len(fresh) != configured:
        connection = "partial"
    else:
        connection = "connected"
    result = ProviderStatus(
        observed_at_ms=now_ms, connection=connection, connected_accounts=connected,
        configured_accounts=configured, last_received_at_ms=k.get("last_recv_ms"),
    )
    if not configured:
        return result
    notice, result.notice_config_error = _load_notice(data_dir)
    if notice is None:
        return result
    marker = data_dir / "kiwoom-maintenance-recovered.json" if data_dir else None
    recovered = False
    try:
        if marker and marker.exists():
            recovered = json.loads(marker.read_text()).get("id") == notice.id
    except (OSError, ValueError, AttributeError):
        _log.warning("Cannot read kiwoom maintenance recovery")
    if recovered:
        return result
    if now_ms >= notice.ends_at_ms and connection == "connected" and all(
        a["last_recv_ms"] >= notice.ends_at_ms for a in fresh
    ):
        if marker:
            try:
                atomic_write_json(marker, {"id": notice.id, "ws_recovered_at_ms": now_ms})
            except OSError:
                _log.warning("Cannot save kiwoom maintenance recovery")
        return result
    result.notice = notice
    result.notice_phase = "scheduled" if now_ms < notice.starts_at_ms else (
        "active" if now_ms < notice.ends_at_ms else "overdue"
    )
    return result
