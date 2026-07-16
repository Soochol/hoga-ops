"""kiwoom_ws_client 단위 테스트 — fake websocket으로 세션 골격 검증.

LOGIN→배치 REG→REAL 디스패치, 유량 rc 재시도, 슬롯 상한 중단, 킥 정지.
실 소켓/네트워크 없이 스크립트된 수신 큐로 프로토콜을 재현한다.
"""
import json
from collections import deque

import pytest

from hoga.live import kiwoom_ws_client as M
from hoga.live.kiwoom_ws_client import KiwoomWsClient
from hoga.live.snapshot import SnapshotKind

DATE = "20260716"

REAL_0D = {
    "trnm": "REAL",
    "data": [{
        "type": "0D", "item": "005930",
        "values": {
            "21": "135622",
            **{str(f): "+6500" for f in range(41, 51)},
            **{str(f): "+6490" for f in range(51, 61)},
            **{str(f): "10" for f in range(61, 81)},
            "121": "100", "125": "200",
        },
    }],
}


class FakeClosed(Exception):
    def __init__(self, code=1006, reason=""):
        super().__init__(f"closed {code} {reason}")
        self.code = code
        self.reason = reason


class FakeWs:
    """스크립트된 수신 큐. Exception 원소는 recv에서 raise(연결 종료 모의)."""

    def __init__(self, incoming):
        self._q = deque(incoming)
        self.sent: list[str] = []

    async def send(self, raw):
        self.sent.append(raw)

    async def recv(self):
        if not self._q:
            raise FakeClosed(1006, "queue empty")
        item = self._q.popleft()
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self):
        pass


def _client(ws, on_tick=None, **kw):
    async def token_fn():
        return "tok"

    async def connect(url):
        return ws

    return KiwoomWsClient(
        token_fn=token_fn, on_tick=on_tick, date_fn=lambda: DATE,
        _connect=connect, **kw,
    )


def _ack(trnm, rc=0, msg=""):
    return json.dumps({"trnm": trnm, "return_code": rc, "return_msg": msg})


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    monkeypatch.setattr(M, "_REG_PACING_S", 0.0)


async def test_login_register_and_real_dispatch():
    ticks = []

    async def collect(t):
        ticks.append(t)

    ws = FakeWs([
        _ack("LOGIN"),
        _ack("REG"),
        json.dumps(REAL_0D),
        FakeClosed(1006, "end"),
    ])
    client = _client(ws, on_tick=collect)
    client._codes = ["005930"]
    with pytest.raises(FakeClosed):
        await client._session_once()
    # LOGIN + REG 송신됨.
    assert json.loads(ws.sent[0])["trnm"] == "LOGIN"
    assert json.loads(ws.sent[1])["trnm"] == "REG"
    # REAL이 파싱되어 on_tick 도달.
    assert len(ticks) == 1
    assert ticks[0].kind is SnapshotKind.OB
    assert ticks[0].code == "005930"


async def test_slot_cap_stops_registration():
    # 첫 배치 OK, 둘째 배치 슬롯상한(105118) → 중단. codes 2배치(60종목).
    codes = [f"{i:06d}" for i in range(60)]
    ws = FakeWs([_ack("LOGIN"), _ack("REG"), _ack("REG", rc=105118, msg="200 초과"),
                 FakeClosed()])
    client = _client(ws)
    client._codes = codes
    with pytest.raises(FakeClosed):
        await client._session_once()
    # 첫 배치(50)만 acked, 둘째(10)는 상한으로 제외.
    assert client.sub_acked == 50
    assert client.sub_missing() == sorted(codes[50:])


async def test_rate_limit_retries_then_succeeds(monkeypatch):
    ws = FakeWs([
        _ack("LOGIN"),
        _ack("REG", rc=105110, msg="유량"),  # 1차 유량 초과
        _ack("REG"),                          # 재시도 성공
        FakeClosed(),
    ])
    client = _client(ws, max_consecutive_kicks=5)
    client._codes = ["005930"]
    # 유량 백오프(1s)를 즉시로 — asyncio.sleep 패치(monkeypatch 자동 복원).
    real_sleep = M.asyncio.sleep

    async def fast_sleep(_):
        await real_sleep(0)

    monkeypatch.setattr(M.asyncio, "sleep", fast_sleep)
    with pytest.raises(FakeClosed):
        await client._session_once()
    assert client.sub_acked == 1
    # REG가 2번 송신됨(유량 재시도).
    assert sum(1 for s in ws.sent if json.loads(s)["trnm"] == "REG") == 2


async def test_ping_echoed():
    ws = FakeWs([_ack("LOGIN"), _ack("REG"), json.dumps({"trnm": "PING"}), FakeClosed()])
    client = _client(ws)
    client._codes = ["005930"]
    with pytest.raises(FakeClosed):
        await client._session_once()
    # PING 원문이 그대로 echo 송신됨.
    assert any(json.loads(s).get("trnm") == "PING" for s in ws.sent)


async def test_kick_detection():
    assert KiwoomWsClient._is_kick(FakeClosed(1000, "Bye")) is True
    assert KiwoomWsClient._is_kick(FakeClosed(1006, "abnormal")) is False
    assert KiwoomWsClient._is_kick(FakeClosed(1000, "normal")) is False


async def test_run_stops_after_consecutive_kicks(monkeypatch):
    monkeypatch.setattr(M, "_BACKOFF_S", (0, 0, 0, 0, 0, 0, 0))

    async def kick_connect(url):
        raise FakeClosed(1000, "Bye")

    async def token_fn():
        return "tok"

    client = KiwoomWsClient(
        token_fn=token_fn, on_tick=None, date_fn=lambda: DATE,
        _connect=kick_connect, max_consecutive_kicks=3,
    )
    await client.run(["005930"])  # 3회 킥 후 kicked_by_peer로 정지(무한루프 아님)
    assert client.kicked_by_peer is True


async def test_update_codes_diffs(monkeypatch):
    ws = FakeWs([_ack("REMOVE"), _ack("REG")])
    client = _client(ws)
    client._codes = ["A", "B", "C"]
    client._acked = {"A", "B", "C"}
    client._ws = ws
    await client.update_codes(["B", "C", "D"])  # remove A, add D
    assert client._codes == ["B", "C", "D"]
    assert "A" not in client._acked
    assert "D" in client._acked
