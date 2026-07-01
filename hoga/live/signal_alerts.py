from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    SignalAlertClearResponse,
    SignalAlertEvent,
    SignalAlertRecentResponse,
    SignalAlertScope,
    SignalAlertSettings,
    SignalAlertSettingsUpdate,
)

_lock = threading.RLock()


class _InboxState(BaseModel):
    schema_version: int = 1
    cleared_through_seq_by_date: dict[str, int] = Field(default_factory=dict)


def _settings_path(data_dir: Path) -> Path:
    return data_dir / "signal_alert_settings.json"


def _alerts_dir(data_dir: Path) -> Path:
    return data_dir / "signal_alerts"


def _ledger_path(data_dir: Path, date: str) -> Path:
    return _alerts_dir(data_dir) / f"{_validate_date(date)}.jsonl"


def _inbox_state_path(data_dir: Path) -> Path:
    return data_dir / "signal_alert_inbox_state.json"


def _validate_date(date: str) -> str:
    normalized = datetime.strptime(date, "%Y%m%d").strftime("%Y%m%d")
    if normalized != date:
        raise ValueError("date must be YYYYMMDD")
    return normalized


def _next_seq_unlocked(data_dir: Path, date: str) -> int:
    path = _ledger_path(data_dir, date)
    if not path.exists():
        return 1
    seq = 0
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            if not raw.strip():
                continue
            try:
                seq = max(seq, int(json.loads(raw).get("seq", 0)))
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
    return seq + 1


def load_signal_alert_settings(data_dir: Path) -> SignalAlertSettings:
    path = _settings_path(data_dir)
    if not path.exists():
        return SignalAlertSettings()
    try:
        return SignalAlertSettings.model_validate(
            json.loads(path.read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ValidationError, TypeError):
        return SignalAlertSettings()


def update_signal_alert_settings(
    data_dir: Path, patch: SignalAlertSettingsUpdate
) -> SignalAlertSettings:
    settings = SignalAlertSettings(sell_total_renewal=patch.sell_total_renewal)
    with _lock:
        atomic_write_json(_settings_path(data_dir), settings.model_dump(mode="json"))
    return settings


def _load_inbox_state(data_dir: Path) -> _InboxState:
    path = _inbox_state_path(data_dir)
    if not path.exists():
        return _InboxState()
    try:
        return _InboxState.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValidationError, TypeError):
        return _InboxState()


def _save_inbox_state(data_dir: Path, state: _InboxState) -> None:
    atomic_write_json(_inbox_state_path(data_dir), state.model_dump(mode="json"))


def _read_all(data_dir: Path, date: str) -> list[SignalAlertEvent]:
    path = _ledger_path(data_dir, date)
    if not path.exists():
        return []
    rows: list[SignalAlertEvent] = []
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            if not raw.strip():
                continue
            try:
                rows.append(SignalAlertEvent.model_validate_json(raw))
            except ValidationError:
                continue
    rows.sort(key=lambda e: (e.seq, e.t_ms), reverse=True)
    return rows


def assign_next_seq(data_dir: Path, event: SignalAlertEvent) -> SignalAlertEvent:
    with _lock:
        seq = _next_seq_unlocked(data_dir, _validate_date(event.date))
    return event.model_copy(update={"seq": seq})


def append_signal_alert(data_dir: Path, event: SignalAlertEvent) -> SignalAlertEvent:
    with _lock:
        event = assign_next_seq(data_dir, event)
        path = _ledger_path(data_dir, _validate_date(event.date))
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(event.model_dump_json() + "\n")
        return event


def read_signal_alerts(
    data_dir: Path,
    date: str,
    *,
    limit: int,
    scope: SignalAlertScope,
) -> list[SignalAlertEvent]:
    with _lock:
        date = _validate_date(date)
        cleared = 0
        if scope == "inbox":
            cleared = _load_inbox_state(data_dir).cleared_through_seq_by_date.get(date, 0)
        rows = [event for event in _read_all(data_dir, date) if event.seq > cleared]
        return rows[:limit]


def recent_response(
    data_dir: Path,
    date: str,
    *,
    limit: int,
    scope: SignalAlertScope,
) -> SignalAlertRecentResponse:
    with _lock:
        date = _validate_date(date)
        cleared = _load_inbox_state(data_dir).cleared_through_seq_by_date.get(date, 0)
        return SignalAlertRecentResponse(
            date=date,
            scope=scope,
            cleared_through_seq=cleared,
            alerts=read_signal_alerts(data_dir, date, limit=limit, scope=scope),
        )


def clear_today_inbox(data_dir: Path, today: str) -> SignalAlertClearResponse:
    with _lock:
        today = _validate_date(today)
        state = _load_inbox_state(data_dir)
        latest = max((event.seq for event in _read_all(data_dir, today)), default=0)
        state.cleared_through_seq_by_date[today] = latest
        _save_inbox_state(data_dir, state)
        return SignalAlertClearResponse(date=today, cleared_through_seq=latest)
