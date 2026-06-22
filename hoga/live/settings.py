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
    storage_policy: LiveStoragePolicy,
) -> LiveSettings:
    settings = LiveSettings(storage_policy=storage_policy)
    save_live_settings(data_dir, settings)
    return settings
