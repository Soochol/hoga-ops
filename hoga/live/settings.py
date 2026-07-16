"""Backend-persisted /live write-policy settings."""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import LiveSettingsResponse

log = logging.getLogger(__name__)

LiveSettings = LiveSettingsResponse


def _path(data_dir: Path) -> Path:
    return data_dir / "live_settings.json"


def load_live_settings(data_dir: Path) -> LiveSettings:
    path = _path(data_dir)
    if not path.exists():
        return LiveSettings()
    try:
        return LiveSettings.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, ValidationError, TypeError, OSError) as e:
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = path.with_name(f"live_settings.json.corrupt-{stamp}")
        try:
            path.rename(backup)
        except OSError:
            log.exception("could not back up corrupt live_settings.json")
        log.warning("live_settings.json was corrupt (%s); backed up to %s", e, backup)
        return LiveSettings()


def save_live_settings(data_dir: Path, settings: LiveSettings) -> None:
    atomic_write_json(_path(data_dir), settings.model_dump())


def update_live_settings(
    data_dir: Path,
    *,
    program_trade_storage_enabled: bool | None = None,
    kis_rest_bypass_enabled: bool | None = None,
    screener_depth_autocollect: bool | None = None,
    kiwoom_enabled: bool | None = None,
) -> LiveSettings:
    previous = load_live_settings(data_dir)
    settings = LiveSettings(
        program_trade_storage_enabled=(
            previous.program_trade_storage_enabled
            if program_trade_storage_enabled is None
            else bool(program_trade_storage_enabled)
        ),
        kis_rest_bypass_enabled=(
            previous.kis_rest_bypass_enabled
            if kis_rest_bypass_enabled is None
            else bool(kis_rest_bypass_enabled)
        ),
        screener_depth_autocollect=(
            previous.screener_depth_autocollect
            if screener_depth_autocollect is None
            else bool(screener_depth_autocollect)
        ),
        kiwoom_enabled=(
            previous.kiwoom_enabled
            if kiwoom_enabled is None
            else bool(kiwoom_enabled)
        ),
    )
    save_live_settings(data_dir, settings)
    return settings
