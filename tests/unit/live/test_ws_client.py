import asyncio
import json

import pytest

import hoga.live.ws_client as ws_client_mod
from hoga.live.ws_client import KisWsClient, build_request


def test_build_request_shape():
    msg = json.loads(build_request("APPR", "1", "H0STASP0", "005930"))
    assert msg == {
        "header": {"approval_key": "APPR", "custtype": "P",
                   "tr_type": "1", "content-type": "utf-8"},
        "body": {"input": {"tr_id": "H0STASP0", "tr_key": "005930"}},
    }


async def _fake_approval() -> str:
    return "APPR"


class FakeWs:
    """recv 스크립트 재생 + send 기록. 스크립트 소진 시 ConnectionClosed 흉내."""

    def __init__(self, script: list[str]):
        self._script = list(script)
        self.sent: list[str] = []

    async def recv(self) -> str:
        if not self._script:
            raise ConnectionError("closed")
        await asyncio.sleep(0)
        return self._script.pop(0)

    async def send(self, data: str) -> None:
        self.sent.append(data)


async def test_recv_loop_dispatches_ticks_and_echoes_pingpong():
    asp = "0|H0STASP0|001|" + "^".join(
        ["005930", "093015", "0"] + ["1"] * 56
    )
    ping = '{"header":{"tr_id":"PINGPONG","datetime":"x"}}'
    fake = FakeWs([ping, asp])
    got: list = []

    async def on_tick(tick):
        got.append(tick)

    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=on_tick, date_fn=lambda: "20260605"
    )
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)          # 스크립트 소진 → closed
    assert any("PINGPONG" in s for s in fake.sent)  # echo
    assert len(got) == 1 and got[0].code == "005930"


async def test_subscribe_sends_three_trs_per_code():
    fake = FakeWs([])
    client = KisWsClient(approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605")
    await client._send_subscriptions(fake, "APPR", ["005930", "000660"], tr_type="1")
    assert len(fake.sent) == 6                  # 2종목 × 3TR
    trs = {json.loads(s)["body"]["input"]["tr_id"] for s in fake.sent}
    assert trs == {"H0STASP0", "H0STCNT0", "H0STMBC0"}


class _FakeConnectCM:
    """websockets.connect 대체 — __aenter__가 FakeWs를 반환하는 async CM."""

    def __init__(self, ws: FakeWs):
        self._ws = ws

    async def __aenter__(self) -> FakeWs:
        return self._ws

    async def __aexit__(self, *exc: object) -> bool:
        return False


async def test_run_reconnects_and_resubscribes_after_failure(monkeypatch):
    # 2회차 connect만 성공(FakeWs) — 1회차/3회차+는 예외 → fake.sent는 정확히
    # 6에서 안정되어 cancel 시점과 무관하게 단언이 결정적이다(spec §10).
    fake = FakeWs([])  # recv 즉시 ConnectionError → 두 번째 연결도 곧 종료
    calls = {"n": 0}

    def fake_connect(url, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            return _FakeConnectCM(fake)
        raise ConnectionError("refused")

    monkeypatch.setattr(ws_client_mod.websockets, "connect", fake_connect)
    monkeypatch.setattr(ws_client_mod, "_BACKOFF_S", (0,))

    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    task = asyncio.create_task(client.run(["005930", "000660"]))
    for _ in range(100):
        if len(fake.sent) >= 6:
            break
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert calls["n"] >= 2  # 1회차 실패 후 백오프 → 재연결
    # 재연결 성공 시 전 종목 × 3TR 재구독 (tr_type="1")
    sent = {
        (json.loads(s)["body"]["input"]["tr_id"], json.loads(s)["body"]["input"]["tr_key"])
        for s in fake.sent
    }
    assert sent == {
        (tr, code)
        for tr in ("H0STASP0", "H0STCNT0", "H0STMBC0")
        for code in ("005930", "000660")
    }
    assert all(json.loads(s)["header"]["tr_type"] == "1" for s in fake.sent)


async def test_run_does_not_connect_while_gate_closed(monkeypatch):
    calls = {"n": 0}

    def fake_connect(url, **kwargs):
        calls["n"] += 1
        raise AssertionError("must not connect while gate closed")

    monkeypatch.setattr(ws_client_mod.websockets, "connect", fake_connect)
    client = KisWsClient(
        approval_key_fn=_fake_approval,
        on_tick=None,
        date_fn=lambda: "20260605",
        gate_fn=lambda: False,
    )
    task = asyncio.create_task(client.run(["005930"]))
    await asyncio.sleep(0.01)
    assert calls["n"] == 0
    assert client.connected is False
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
