from __future__ import annotations

import json

from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import load_live_settings, save_live_settings, update_live_settings


def test_live_settings_default_has_bypass_false(tmp_path):
    settings = load_live_settings(tmp_path)

    assert settings.storage_policy == "ws_plus_rest"
    assert settings.program_trade_storage_enabled is False
    assert settings.kis_rest_bypass_enabled is False
    # ADR-0097 도입 동작(무조건 히트맵 합류) 보존을 위해 기본 True.
    assert settings.heatmap_capture_enabled is True


def test_update_live_settings_toggles_heatmap_capture_and_preserves_others(tmp_path):
    save_live_settings(
        tmp_path,
        LiveSettingsResponse(
            storage_policy="rest_only",
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=True,
        ),
    )

    updated = update_live_settings(tmp_path, heatmap_capture_enabled=False)

    assert updated.heatmap_capture_enabled is False
    # 다른 필드는 omit되었으므로 보존.
    assert updated.storage_policy == "rest_only"
    assert updated.program_trade_storage_enabled is True
    assert updated.kis_rest_bypass_enabled is True
    on_disk = json.loads((tmp_path / "live_settings.json").read_text(encoding="utf-8"))
    assert on_disk["heatmap_capture_enabled"] is False

    # 재-토글로 다시 켜진다(멱등 아님 — 명시적 True 반영).
    re_enabled = update_live_settings(tmp_path, heatmap_capture_enabled=True)
    assert re_enabled.heatmap_capture_enabled is True


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


def test_kiwoom_enabled_defaults_false_and_toggles(tmp_path):
    # 기본 off — 킬스위치 안전값(ADR-0116).
    assert load_live_settings(tmp_path).kiwoom_enabled is False

    updated = update_live_settings(tmp_path, kiwoom_enabled=True)
    assert updated.kiwoom_enabled is True
    assert load_live_settings(tmp_path).kiwoom_enabled is True

    # 다른 필드 patch가 kiwoom_enabled를 보존.
    other = update_live_settings(tmp_path, heatmap_capture_enabled=False)
    assert other.kiwoom_enabled is True

    off = update_live_settings(tmp_path, kiwoom_enabled=False)
    assert off.kiwoom_enabled is False


def test_kiwoom_enabled_backcompat_missing_field_defaults_false(tmp_path):
    # 구 설정 파일(kiwoom_enabled 필드 없음) → 기본 False로 로드(마이그레이션 불필요).
    save_path = tmp_path / "live_settings.json"
    save_path.write_text(json.dumps({"storage_policy": "ws_plus_rest"}))
    assert load_live_settings(tmp_path).kiwoom_enabled is False
