import asyncio
import json

import pytest

from hoga.live.ws_client import KisWsClient, build_request


def test_build_request_shape():
    msg = json.loads(build_request("APPR", "1", "H0STASP0", "005930"))
    assert msg == {
        "header": {"approval_key": "APPR", "custtype": "P",
                   "tr_type": "1", "content-type": "utf-8"},
        "body": {"input": {"tr_id": "H0STASP0", "tr_key": "005930"}},
    }


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

    client = KisWsClient(approval_key_fn=None, on_tick=on_tick, date_fn=lambda: "20260605")
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)          # 스크립트 소진 → closed
    assert any("PINGPONG" in s for s in fake.sent)  # echo
    assert len(got) == 1 and got[0].code == "005930"


async def test_subscribe_sends_three_trs_per_code():
    fake = FakeWs([])
    client = KisWsClient(approval_key_fn=None, on_tick=None, date_fn=lambda: "20260605")
    await client._send_subscriptions(fake, "APPR", ["005930", "000660"], tr_type="1")
    assert len(fake.sent) == 6                  # 2종목 × 3TR
    trs = {json.loads(s)["body"]["input"]["tr_id"] for s in fake.sent}
    assert trs == {"H0STASP0", "H0STCNT0", "H0STMBC0"}
