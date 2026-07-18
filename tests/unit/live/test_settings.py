from __future__ import annotations

import json

from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import load_live_settings, save_live_settings, update_live_settings


def test_live_settings_defaults(tmp_path):
    settings = load_live_settings(tmp_path)

    assert settings.program_trade_storage_enabled is False
    assert settings.kis_rest_bypass_enabled is False
    assert settings.screener_depth_autocollect is False
    # ADR-0118: 키움이 실시간 유일 소스라 기본 True(실제 활성화는 자격증명 게이트).
    assert settings.kiwoom_enabled is True


def test_update_live_settings_partial_patch_preserves_omitted_fields(tmp_path):
    save_live_settings(
        tmp_path,
        LiveSettingsResponse(
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=False,
        ),
    )

    updated = update_live_settings(tmp_path, kis_rest_bypass_enabled=True)

    assert updated.program_trade_storage_enabled is True
    assert updated.kis_rest_bypass_enabled is True
    on_disk = json.loads((tmp_path / "live_settings.json").read_text(encoding="utf-8"))
    assert on_disk["kis_rest_bypass_enabled"] is True


def test_update_live_settings_program_trade_is_independent_toggle(tmp_path):
    """storage_policy 제거(2026-07-17) 후 program_trade는 독립 토글 — ws_only 강제
    off 규칙 같은 결합이 없다."""
    updated = update_live_settings(tmp_path, program_trade_storage_enabled=True)
    assert updated.program_trade_storage_enabled is True

    # 다른 필드 patch가 값을 보존.
    other = update_live_settings(tmp_path, kis_rest_bypass_enabled=True)
    assert other.program_trade_storage_enabled is True

    off = update_live_settings(tmp_path, program_trade_storage_enabled=False)
    assert off.program_trade_storage_enabled is False


def test_corrupt_settings_falls_back_to_bypass_false(tmp_path):
    (tmp_path / "live_settings.json").write_text("{broken", encoding="utf-8")

    settings = load_live_settings(tmp_path)

    assert settings.kis_rest_bypass_enabled is False
    assert list(tmp_path.glob("live_settings.json.corrupt-*"))


def test_kiwoom_enabled_defaults_true_and_toggles(tmp_path):
    # 기본 on — 키움이 실시간 유일 소스(ADR-0118). 실제 활성화는 자격증명 게이트.
    assert load_live_settings(tmp_path).kiwoom_enabled is True

    # 명시적 off 토글이 영속되는지(운영자가 끌 수 있어야 함).
    off = update_live_settings(tmp_path, kiwoom_enabled=False)
    assert off.kiwoom_enabled is False
    assert load_live_settings(tmp_path).kiwoom_enabled is False

    # 다른 필드 patch가 off 값을 보존.
    other = update_live_settings(tmp_path, program_trade_storage_enabled=True)
    assert other.kiwoom_enabled is False

    back_on = update_live_settings(tmp_path, kiwoom_enabled=True)
    assert back_on.kiwoom_enabled is True


def test_kiwoom_enabled_backcompat_missing_field_defaults_true(tmp_path):
    # 구 설정 파일(kiwoom_enabled 필드 없음) → 기본 True로 로드(ADR-0118, 마이그레이션
    # 불필요). 자격증명 게이트가 있어 키 없는 구 배포는 여전히 휴면.
    save_path = tmp_path / "live_settings.json"
    save_path.write_text(json.dumps({"program_trade_storage_enabled": False}))
    assert load_live_settings(tmp_path).kiwoom_enabled is True


def test_legacy_storage_policy_keys_are_ignored_on_load(tmp_path):
    """회귀 가드(2026-07-17): rest30 시절 live_settings.json에 남은
    storage_policy·heatmap_capture_enabled 키가 로드를 깨지 않는다(pydantic extra
    ignore). 다른 필드 값은 정상 반영, corrupt 백업도 안 생긴다."""
    save_path = tmp_path / "live_settings.json"
    save_path.write_text(json.dumps({
        "schema_version": 1,
        "storage_policy": "ws_plus_rest",
        "heatmap_capture_enabled": True,
        "program_trade_storage_enabled": True,
        "kis_rest_bypass_enabled": False,
        "kiwoom_enabled": True,
    }))

    settings = load_live_settings(tmp_path)

    assert settings.program_trade_storage_enabled is True
    assert settings.kiwoom_enabled is True
    assert not hasattr(settings, "storage_policy")
    assert not hasattr(settings, "heatmap_capture_enabled")
    assert not list(tmp_path.glob("live_settings.json.corrupt-*"))

    # 후속 patch 저장은 레거시 키를 다시 쓰지 않는다.
    update_live_settings(tmp_path, kis_rest_bypass_enabled=True)
    on_disk = json.loads(save_path.read_text(encoding="utf-8"))
    assert "storage_policy" not in on_disk
    assert "heatmap_capture_enabled" not in on_disk
