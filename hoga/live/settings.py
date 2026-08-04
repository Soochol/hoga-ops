"""Backend-persisted /live write-policy settings."""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api.models import LiveSettingsResponse
from hoga.util.atomic_write import atomic_write_json

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
    rest_bypass_enabled: bool | None = None,
    screener_depth_autocollect: bool | None = None,
) -> LiveSettings:
    previous = load_live_settings(data_dir)
    settings = LiveSettings(
        rest_bypass_enabled=(
            previous.rest_bypass_enabled
            if rest_bypass_enabled is None
            else bool(rest_bypass_enabled)
        ),
        screener_depth_autocollect=(
            previous.screener_depth_autocollect
            if screener_depth_autocollect is None
            else bool(screener_depth_autocollect)
        ),
    )
    save_live_settings(data_dir, settings)
    return settings


def rest_bypass_enabled(data_dir: Path) -> bool:
    """REST 우회 토글이 켜져 있나.

    2026-08-04까지 `live_settings.rest_bypass_enabled` 였다(PR-J·#1046). 그 모듈은
    KIS 계정 라우팅 seam 이었는데 **프로덕션에서 살아남은 심볼이 이것 하나뿐**이라
    (나머지는 테스트만 붙잡고 있었다) 설정을 읽는 함수를 설정 모듈로 되돌린다.

    벤더와 무관한 정책 스위치다 — 우회하면 업스트림을 아예 만지지 않고 캐시만
    서빙한다. 어느 브로커냐는 이 판단에 들어오지 않는다.
    """
    return load_live_settings(data_dir).rest_bypass_enabled
