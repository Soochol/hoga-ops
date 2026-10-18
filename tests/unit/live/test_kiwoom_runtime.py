"""kiwoom_runtime env 발견 + kiwoom_token_provider 만료 파싱 단위 테스트."""
from datetime import datetime
from pathlib import Path

from hoga.live import kiwoom_runtime as R
from hoga.live.kiwoom_token_provider import KIWOOM_KST, KiwoomTokenProvider


def test_account_env_naming():
    assert R._account_env(0) == ("KIWOOM_APP_KEY", "KIWOOM_APP_SECRET")
    # account_id=1 → '사람이 세는 2번째 키' (KIS 관례 복제).
    assert R._account_env(1) == ("KIWOOM_APP_KEY_2", "KIWOOM_APP_SECRET_2")
    assert R._account_env(3) == ("KIWOOM_APP_KEY_4", "KIWOOM_APP_SECRET_4")


def test_configured_account_ids_contiguous(monkeypatch, tmp_path):
    for k in ["KIWOOM_APP_KEY", "KIWOOM_APP_SECRET", "KIWOOM_APP_KEY_2",
              "KIWOOM_APP_SECRET_2", "KIWOOM_APP_KEY_3", "KIWOOM_APP_SECRET_3"]:
        monkeypatch.delenv(k, raising=False)
    # 아무것도 없으면 [] (오프라인).
    assert R.configured_account_ids(tmp_path) == []
    # 0만 → [0].
    monkeypatch.setenv("KIWOOM_APP_KEY", "k0")
    monkeypatch.setenv("KIWOOM_APP_SECRET", "s0")
    assert R.configured_account_ids(tmp_path) == [0]
    # 0,1 → [0,1].
    monkeypatch.setenv("KIWOOM_APP_KEY_2", "k1")
    monkeypatch.setenv("KIWOOM_APP_SECRET_2", "s1")
    assert R.configured_account_ids(tmp_path) == [0, 1]
    # 3(account_id=2)이 비면 정지 — skip 없음(1 다음 2 없으면 [0,1]).
    monkeypatch.setenv("KIWOOM_APP_KEY_4", "k3")
    monkeypatch.setenv("KIWOOM_APP_SECRET_4", "s3")
    assert R.configured_account_ids(tmp_path) == [0, 1]


def test_token_cache_path_backcompat():
    d = Path("/data")
    assert R._token_cache_path(d, 0).name == "kiwoom-token.json"
    assert R._token_cache_path(d, 1).name == "kiwoom-token-1.json"


def test_parse_expiry_expires_dt():
    exp = KiwoomTokenProvider._parse_expiry({"expires_dt": "20260717133549"})
    assert exp == datetime(2026, 7, 17, 13, 35, 49, tzinfo=KIWOOM_KST)


def test_parse_expiry_falls_back_to_expires_in():
    exp = KiwoomTokenProvider._parse_expiry({"expires_in": 3600})
    now = datetime.now(KIWOOM_KST)
    assert 3500 < (exp - now).total_seconds() < 3700


def test_mock_credentials_never_fall_back_to_real(monkeypatch, tmp_path):
    monkeypatch.setenv("KIWOOM_APP_KEY", "fake-real")
    monkeypatch.setenv("KIWOOM_APP_SECRET", "fake-secret")
    monkeypatch.delenv("KIWOOM_MOCK_APP_KEY", raising=False)
    monkeypatch.delenv("KIWOOM_MOCK_APP_SECRET", raising=False)
    assert R.configured_account_ids(tmp_path, environment="mock") == []
    assert R.ensure_token_provider_for_account(0, tmp_path, environment="mock") is None
    assert R._token_cache_path(tmp_path, 0, "mock").name == "kiwoom-mock-token.json"
    monkeypatch.setenv("KIWOOM_MOCK_APP_KEY", "fake-mock")
    monkeypatch.setenv("KIWOOM_MOCK_APP_SECRET", "fake-mock-secret")
    assert R.configured_account_ids(tmp_path, environment="mock") == [0]
    assert R._resolve_env_creds(0, "mock").environment == "mock"


def test_token_cache_environment_isolation_and_legacy_real_cache(tmp_path):
    import json
    from datetime import timedelta

    import httpx

    from hoga.live.kiwoom_token_provider import KiwoomCredentials

    path = tmp_path / "cache.json"
    transport = httpx.MockTransport(lambda request: (_ for _ in ()).throw(AssertionError("no network expected")))
    real = KiwoomTokenProvider(KiwoomCredentials("same-fake-key", "fake-secret"), path, _transport=transport)
    mock = KiwoomTokenProvider(KiwoomCredentials("same-fake-key", "fake-secret", "mock"), path, _transport=transport)
    try:
        expiry = datetime.now(KIWOOM_KST) + timedelta(days=1)
        real._write_cache("fake-real-token", expiry)
        assert real._read_cache()[0] == "fake-real-token"
        assert mock._read_cache() is None
        cached = json.loads(path.read_text())
        cached.pop("environment")
        path.write_text(json.dumps(cached))
        assert real._read_cache()[0] == "fake-real-token"
        assert mock._read_cache() is None
        mock._write_cache("fake-mock-token", expiry)
        assert real._read_cache() is None
        assert mock._read_cache()[0] == "fake-mock-token"
    finally:
        real.close()
        mock.close()
