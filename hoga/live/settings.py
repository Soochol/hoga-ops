"""Backend-persisted /live write-policy settings."""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import LiveSettingsResponse, LiveStoragePolicy

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
    storage_policy: LiveStoragePolicy | None = None,
    program_trade_storage_enabled: bool | None = None,
    kis_rest_bypass_enabled: bool | None = None,
    heatmap_capture_enabled: bool | None = None,
) -> LiveSettings:
    previous = load_live_settings(data_dir)
    next_storage_policy = storage_policy or previous.storage_policy
    next_program_enabled = (
        previous.program_trade_storage_enabled
        if program_trade_storage_enabled is None
        else program_trade_storage_enabled
    )
    settings = LiveSettings(
        storage_policy=next_storage_policy,
        program_trade_storage_enabled=(
            False if next_storage_policy == "ws_only" else bool(next_program_enabled)
        ),
        kis_rest_bypass_enabled=(
            previous.kis_rest_bypass_enabled
            if kis_rest_bypass_enabled is None
            else bool(kis_rest_bypass_enabled)
        ),
        heatmap_capture_enabled=(
            previous.heatmap_capture_enabled
            if heatmap_capture_enabled is None
            else bool(heatmap_capture_enabled)
        ),
    )
    save_live_settings(data_dir, settings)
    return settings
