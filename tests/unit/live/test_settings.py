from __future__ import annotations

import json

from hoga.api.models import LiveSettingsResponse
from hoga.live.settings import load_live_settings, save_live_settings, update_live_settings


def test_live_settings_defaults(tmp_path):
    settings = load_live_settings(tmp_path)

    assert settings.kis_rest_bypass_enabled is False
    assert settings.screener_depth_autocollect is False
    # kiwoom_enabled 활성화 스위치는 폐지됨(ADR-0118) — 필드 자체가 없다.
    assert not hasattr(settings, "kiwoom_enabled")
    # program_trade_storage_enabled 도 폐지(2026-07-21) — 프로그램 순매수는 항시 저장.
    assert not hasattr(settings, "program_trade_storage_enabled")


def test_update_live_settings_partial_patch_preserves_omitted_fields(tmp_path):
    save_live_settings(
        tmp_path,
        LiveSettingsResponse(
            screener_depth_autocollect=True,
            kis_rest_bypass_enabled=False,
        ),
    )

    updated = update_live_settings(tmp_path, kis_rest_bypass_enabled=True)

    assert updated.screener_depth_autocollect is True
    assert updated.kis_rest_bypass_enabled is True
    on_disk = json.loads((tmp_path / "live_settings.json").read_text(encoding="utf-8"))
    assert on_disk["kis_rest_bypass_enabled"] is True


def test_corrupt_settings_falls_back_to_bypass_false(tmp_path):
    (tmp_path / "live_settings.json").write_text("{broken", encoding="utf-8")

    settings = load_live_settings(tmp_path)

    assert settings.kis_rest_bypass_enabled is False
    assert list(tmp_path.glob("live_settings.json.corrupt-*"))


def test_kiwoom_enabled_field_removed_and_legacy_key_ignored(tmp_path):
    """활성화 스위치 폐지(ADR-0118) — 필드 자체가 없다. 실시간은 키움 WS 유일 소스라
    '쓸지 말지'가 선택지가 아니고, 활성화는 자격증명(앱키) 존재만으로 게이트된다.
    옛 live_settings.json에 남은 kiwoom_enabled 키(True/False 무관)는 pydantic
    extra-ignore로 무시된다 — 마이그레이션·크래시 없이 로드는 정상."""
    assert not hasattr(load_live_settings(tmp_path), "kiwoom_enabled")

    save_path = tmp_path / "live_settings.json"
    save_path.write_text(json.dumps({
        "screener_depth_autocollect": True,
        "kiwoom_enabled": False,  # 옛 킬스위치 값 — 이제 무시됨
    }))
    settings = load_live_settings(tmp_path)
    assert settings.screener_depth_autocollect is True
    assert not hasattr(settings, "kiwoom_enabled")


def test_legacy_storage_policy_keys_are_ignored_on_load(tmp_path):
    """회귀 가드(2026-07-17): rest30 시절 live_settings.json에 남은
    storage_policy·heatmap_capture_enabled 키가 로드를 깨지 않는다(pydantic extra
    ignore). 다른 필드 값은 정상 반영, corrupt 백업도 안 생긴다.

    2026-07-21 추가: program_trade_storage_enabled 도 폐지되어 같은 취급을 받는다 —
    실사용 디스크에 True 로 남아 있는 상태에서 업그레이드해도 로드가 정상이어야 한다."""
    save_path = tmp_path / "live_settings.json"
    save_path.write_text(json.dumps({
        "schema_version": 1,
        "storage_policy": "ws_plus_rest",
        "heatmap_capture_enabled": True,
        "program_trade_storage_enabled": True,
        "kis_rest_bypass_enabled": False,
        "screener_depth_autocollect": True,
        "kiwoom_enabled": True,
    }))

    settings = load_live_settings(tmp_path)

    assert settings.screener_depth_autocollect is True
    # kiwoom_enabled·program_trade_storage_enabled도 이제 폐지된 레거시 키 —
    # extra-ignore로 무시된다.
    assert not hasattr(settings, "kiwoom_enabled")
    assert not hasattr(settings, "program_trade_storage_enabled")
    assert not hasattr(settings, "storage_policy")
    assert not hasattr(settings, "heatmap_capture_enabled")
    assert not list(tmp_path.glob("live_settings.json.corrupt-*"))

    # 후속 patch 저장은 레거시 키를 다시 쓰지 않는다.
    update_live_settings(tmp_path, kis_rest_bypass_enabled=True)
    on_disk = json.loads(save_path.read_text(encoding="utf-8"))
    assert "storage_policy" not in on_disk
    assert "heatmap_capture_enabled" not in on_disk
    assert "program_trade_storage_enabled" not in on_disk
