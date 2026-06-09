"""dynamic-N 프리미티브 + start/refresh/watchdog (스펙 §5)."""
import asyncio
from pathlib import Path

import pytest

import hoga.live.kis_runtime as kis_runtime
import hoga.live.lifecycle as lifecycle


@pytest.fixture(autouse=True)
def _reset():
    lifecycle.reset_for_tests()
    yield
    lifecycle.reset_for_tests()


class _FakeKis:
    """get_approval_key만 쓰는 _build_conn용 가짜 KIS client."""
    def __init__(self, account_id: int) -> None:
        self._creds = type("C", (), {"app_key": f"k{account_id}"})()
        self.aclose_calls = 0

    async def get_approval_key(self) -> str:
        return "APPROVAL"

    async def aclose(self) -> None:
        self.aclose_calls += 1


@pytest.mark.asyncio
async def test_build_conn_creates_tasks_and_teardown_keeps_client(tmp_path, monkeypatch):
    # _build_conn은 account의 KisClient를 ensure_kis_client_for_account로 얻는다.
    fake = _FakeKis(1)
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: fake,
    )
    # WS가 실제 네트워크를 치지 않도록 게이트를 닫아 run()이 sleep하게 한다.
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

    conn = lifecycle._build_conn(1, ["005930"], tmp_path)
    assert conn.account_id == 1
    assert conn.codes == ("005930",)
    assert not conn.ws_task.done() and not conn.flush_task.done()

    await lifecycle._teardown_conn(conn)
    assert conn.ws_task.done() and conn.flush_task.done()
    # R1: teardown는 KisClient를 닫지 않는다.
    assert fake.aclose_calls == 0


@pytest.mark.asyncio
async def test_teardown_conn_idempotent(tmp_path, monkeypatch):
    fake = _FakeKis(0)
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: fake,
    )
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    conn = lifecycle._build_conn(0, ["005930"], tmp_path)
    await lifecycle._teardown_conn(conn)
    await lifecycle._teardown_conn(conn)  # 두 번째도 무해(done task cancel = no-op)
