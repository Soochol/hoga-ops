import json


def test_load_missing_live_settings_defaults_ws_plus_rest(tmp_path):
    from hoga.live.settings import load_live_settings

    settings = load_live_settings(tmp_path)

    assert settings.schema_version == 1
    assert settings.storage_policy == "ws_plus_rest"


def test_save_and_reload_live_settings(tmp_path):
    from hoga.live.settings import LiveSettings, load_live_settings, save_live_settings

    save_live_settings(tmp_path, LiveSettings(storage_policy="rest_only"))

    assert load_live_settings(tmp_path).storage_policy == "rest_only"
    raw = json.loads((tmp_path / "live_settings.json").read_text())
    assert raw == {"schema_version": 1, "storage_policy": "rest_only"}


def test_invalid_live_settings_file_falls_back_to_default(tmp_path):
    from hoga.live.settings import load_live_settings

    (tmp_path / "live_settings.json").write_text(
        '{"schema_version": 1, "storage_policy": "bad"}'
    )

    assert load_live_settings(tmp_path).storage_policy == "ws_plus_rest"
    assert list(tmp_path.glob("live_settings.json.corrupt-*"))
