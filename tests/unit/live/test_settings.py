from __future__ import annotations

import json

from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import load_live_settings, save_live_settings, update_live_settings


def test_live_settings_default_has_bypass_false(tmp_path):
    settings = load_live_settings(tmp_path)

    assert settings.storage_policy == "ws_plus_rest"
    assert settings.program_trade_storage_enabled is False
    assert settings.kis_rest_bypass_enabled is False


def test_update_live_settings_partial_patch_preserves_omitted_fields(tmp_path):
    save_live_settings(
        tmp_path,
        LiveSettingsResponse(
            storage_policy="rest_only",
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=False,
        ),
    )

    updated = update_live_settings(tmp_path, kis_rest_bypass_enabled=True)

    assert updated.storage_policy == "rest_only"
    assert updated.program_trade_storage_enabled is True
    assert updated.kis_rest_bypass_enabled is True
    on_disk = json.loads((tmp_path / "live_settings.json").read_text(encoding="utf-8"))
    assert on_disk["kis_rest_bypass_enabled"] is True


def test_ws_only_still_disables_program_trade_without_changing_bypass(tmp_path):
    save_live_settings(
        tmp_path,
        LiveSettingsResponse(
            storage_policy="rest_only",
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=True,
        ),
    )

    updated = update_live_settings(tmp_path, storage_policy="ws_only")

    assert updated.storage_policy == "ws_only"
    assert updated.program_trade_storage_enabled is False
    assert updated.kis_rest_bypass_enabled is True


def test_corrupt_settings_falls_back_to_bypass_false(tmp_path):
    (tmp_path / "live_settings.json").write_text("{broken", encoding="utf-8")

    settings = load_live_settings(tmp_path)

    assert settings.kis_rest_bypass_enabled is False
    assert list(tmp_path.glob("live_settings.json.corrupt-*"))
