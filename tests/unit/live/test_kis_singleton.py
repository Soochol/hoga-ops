from pathlib import Path

from hoga.live import lifecycle
from hoga.live.kis_client import KisCredentials


def test_ensure_returns_same_instance(tmp_path: Path):
    lifecycle.reset_for_tests()
    creds = KisCredentials(app_key="k", app_secret="s")
    a = lifecycle.ensure_kis_client(tmp_path / "t.json", creds)
    b = lifecycle.ensure_kis_client(tmp_path / "t.json", creds)
    assert a is b  # 단일 인스턴스(단일 토큰버킷)
