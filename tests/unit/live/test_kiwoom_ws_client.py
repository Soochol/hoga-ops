"""kiwoom_ws_client 단위 테스트 — 단일 recv 루프 + Future ACK 라우팅.

리뷰 C1 회귀 방어: FakeWs가 websockets처럼 **동시 recv를 ConcurrencyError로 거부**한다.
따라서 update_codes가 recv 루프와 동시에 recv를 걸면 테스트가 실패 — 옛 설계(_read_until
recv)를 재도입하면 즉시 잡힌다. 서버형 FakeWs는 REG/REMOVE/LOGIN 송신에 ACK를 자동 응답한다.
"""
import asyncio
import json

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


class FakeConcurrencyError(Exception):
    """websockets 16 ConcurrencyError 모의 — 동시 recv 금지."""


class FakeClosed(Exception):
    def __init__(self, code=1006, reason=""):
        super().__init__(f"closed {code} {reason}")
        self.code = code
        self.reason = reason


class FakeServer:
    """서버형 fake WS. 단일 recv 강제(동시 recv→FakeConcurrencyError). REG/REMOVE/LOGIN
    송신에 ACK 자동 응답(reg_rc_seq로 REG rc 스크립트). push로 REAL/PING/종료 주입."""

    def __init__(self, *, login_rc=0, reg_rc_seq=None):
        self._in: asyncio.Queue = asyncio.Queue()
        self.sent: list[str] = []
        self._recv_active = False
        self._login_rc = login_rc
        self._reg_rc = list(reg_rc_seq or [])
        self._reg_i = 0

    async def recv(self):
        if self._recv_active:
            raise FakeConcurrencyError("two coroutines called recv concurrently")
        self._recv_active = True
        try:
            item = await self._in.get()
            if isinstance(item, Exception):
                raise item
            return item
        finally:
            self._recv_active = False

    async def send(self, raw):
        self.sent.append(raw if isinstance(raw, str) else raw.decode())
        msg = json.loads(self.sent[-1])
        trnm = msg.get("trnm")
        if trnm == "LOGIN":
            self._in.put_nowait(json.dumps({"trnm": "LOGIN", "return_code": self._login_rc}))
        elif trnm in ("REG", "REMOVE"):
            rc = self._reg_rc[self._reg_i] if self._reg_i < len(self._reg_rc) else 0
            self._reg_i += 1
            self._in.put_nowait(json.dumps({"trnm": trnm, "return_code": rc, "return_msg": ""}))
        # PING 등은 무응답(테스트가 직접 push)

    def push(self, item):
        self._in.put_nowait(item)

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


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    monkeypatch.setattr(M, "_REG_PACING_S", 0.0)


async def _run_briefly(client, codes, *, hold=0.05):
    """run()을 태스크로 띄워 연결·초기 등록까지 진행시킨 뒤 반환. 호출자가 cancel."""
    task = asyncio.create_task(client.run(codes))
    for _ in range(50):
        await asyncio.sleep(0)
        if client.connected:
            break
    await asyncio.sleep(hold)
    return task


async def _cancel(task):
    task.cancel()
    with pytest.raises((asyncio.CancelledError, FakeClosed, FakeConcurrencyError)):
        await task


async def test_login_register_and_real_dispatch():
    ticks = []

    async def collect(t):
        ticks.append(t)

    ws = FakeServer()
    client = _client(ws, on_tick=collect)
    task = await _run_briefly(client, ["005930"])
    ws.push(json.dumps(REAL_0D))
    await asyncio.sleep(0.02)
    assert client.connected
    assert json.loads(ws.sent[0])["trnm"] == "LOGIN"
    assert json.loads(ws.sent[1])["trnm"] == "REG"
    assert client.sub_acked == 1
    assert len(ticks) == 1 and ticks[0].kind is SnapshotKind.OB
    await _cancel(task)


async def test_update_codes_while_draining_no_concurrency():
    """리뷰 C1 회귀: recv 루프가 도는 중 update_codes 호출 — 동시 recv 없이 성립.
    FakeServer가 동시 recv를 FakeConcurrencyError로 거부하므로, 옛 _read_until 설계면 실패."""
    ws = FakeServer()
    client = _client(ws)
    task = await _run_briefly(client, ["005930"])
    # 드레인 중(recv 루프 활성) 코드 변경 → REG/REMOVE 송신 + ACK Future 대기.
    await client.update_codes(["005930", "000660"])  # add 000660
    await asyncio.sleep(0.01)
    assert client.sub_acked == 2
    assert set(client.expected_codes) == {"005930", "000660"}
    # ConcurrencyError가 안 났음(났으면 run 태스크가 죽어 connected=False).
    assert client.connected
    await _cancel(task)


async def test_rejected_batch_not_acked_and_in_missing():
    """리뷰 회귀(Major): rc=거부 배치는 _acked에 안 들어가고 sub_missing에 남는다."""
    ws = FakeServer(reg_rc_seq=[9999])  # 첫 REG가 알 수 없는 거부
    client = _client(ws)
    task = await _run_briefly(client, ["005930"])
    assert client.sub_acked == 0
    assert client.sub_missing() == ["005930"]
    assert ws.sent and json.loads(ws.sent[-1])["trnm"] == "REG"
    await _cancel(task)


async def test_slot_cap_stops_registration():
    codes = [f"{i:06d}" for i in range(60)]  # 2배치
    ws = FakeServer(reg_rc_seq=[0, 105118])  # 1배치 OK, 2배치 슬롯상한
    client = _client(ws)
    task = await _run_briefly(client, codes)
    assert client.sub_acked == 50
    assert client.sub_missing() == sorted(codes[50:])
    await _cancel(task)


async def test_rate_limit_retries_then_succeeds(monkeypatch):
    real_sleep = M.asyncio.sleep

    async def fast_sleep(_):
        await real_sleep(0)

    monkeypatch.setattr(M.asyncio, "sleep", fast_sleep)
    ws = FakeServer(reg_rc_seq=[105110, 0])  # 유량 초과 후 성공
    client = _client(ws)
    task = asyncio.create_task(client.run(["005930"]))
    # 유량 재시도(REG 2회)가 완료될 때까지 결정론적으로 대기.
    for _ in range(500):
        await real_sleep(0)
        if client.sub_acked == 1:
            break
    assert client.sub_acked == 1
    assert sum(1 for s in ws.sent if json.loads(s)["trnm"] == "REG") == 2
    await _cancel(task)


async def test_ping_echoed():
    ws = FakeServer()
    client = _client(ws)
    task = await _run_briefly(client, ["005930"])
    ws.push(json.dumps({"trnm": "PING", "x": 1}))
    await asyncio.sleep(0.02)
    assert any(json.loads(s).get("trnm") == "PING" for s in ws.sent)
    await _cancel(task)


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


async def test_kick_counter_resets_after_healthy_session(monkeypatch):
    """리뷰 회귀(Major): 연결 성공(LOGIN)이 킥 카운터를 리셋 — 건강한 세션 사이의
    간헐 킥이 누적돼 영구 정지하지 않는다. 킥으로 끝나는 정상 세션을 반복해도
    max_consecutive_kicks에 도달하지 않아야 한다."""
    monkeypatch.setattr(M, "_BACKOFF_S", (0,) * 7)
    sessions = {"n": 0}

    async def token_fn():
        return "tok"

    def connect_factory():
        async def connect(url):
            sessions["n"] += 1
            if sessions["n"] > 4:
                # 5번째부터는 연결 자체 실패(테스트 종료 유도) — 그 전 4세션은 킥.
                raise asyncio.CancelledError
            return FakeServer()  # 정상 연결 → LOGIN 성공 → 이후 킥 주입
        return connect

    client = KiwoomWsClient(
        token_fn=token_fn, on_tick=None, date_fn=lambda: DATE,
        _connect=connect_factory(), max_consecutive_kicks=3,
    )

    # run을 태스크로 돌리되, 매 세션 연결 후 킥을 주입한다.
    task = asyncio.create_task(client.run(["005930"]))
    for _ in range(4):
        for _ in range(200):
            await asyncio.sleep(0)
            if client.connected:
                break
        # 연결·LOGIN 성공 상태 → 카운터 리셋됐어야. 킥으로 세션 종료.
        assert client._consecutive_kicks == 0
        # 현재 세션의 소켓에 킥 주입.
        for conn_ws in [client._ws]:
            if conn_ws is not None:
                conn_ws.push(FakeClosed(1000, "Bye"))
        for _ in range(200):
            await asyncio.sleep(0)
            if not client.connected:
                break
    with pytest.raises(asyncio.CancelledError):
        await task
    # 4번 킥당했지만 매번 healthy 세션이라 리셋 → 영구정지 안 함.
    assert client.kicked_by_peer is False


async def test_login_failure_invalidates_token():
    """리뷰 Major: LOGIN rc!=0(토큰 거부) 시 invalidate_fn 호출 — 다음 재연결이 신선
    토큰을 받게 해 stale 토큰 24h 루프를 막는다."""
    invalidated = []
    ws = FakeServer(login_rc=1)  # LOGIN 거부
    client = _client(ws, invalidate_fn=lambda: invalidated.append(True))
    with pytest.raises(RuntimeError):
        await client._session_once()
    assert invalidated == [True]


async def test_resubscribe_missing_reregs_unacked():
    """워치독 표적 복구(PR-B ④, KIS resubscribe_missing 미러): 초기 REG 거부로
    미확인 남은 종목만 재 REG해 acked로 수렴시킨다."""
    ws = FakeServer(reg_rc_seq=[9999, 0])  # 초기 REG 거부 → 재구독 REG 성공
    client = _client(ws)
    task = await _run_briefly(client, ["005930"])
    assert client.sub_missing() == ["005930"]  # 초기 등록 실패로 미확인
    reg_before = sum(1 for s in ws.sent if json.loads(s)["trnm"] == "REG")

    count = await client.resubscribe_missing()
    await asyncio.sleep(0.01)
    assert count == 1
    assert client.sub_missing() == []       # 재구독으로 수렴
    assert client.sub_acked == 1
    reg_after = sum(1 for s in ws.sent if json.loads(s)["trnm"] == "REG")
    assert reg_after == reg_before + 1      # 미확인 1건만 재 REG
    await _cancel(task)


async def test_resubscribe_missing_noop_when_all_acked():
    """전부 acked면 재구독은 no-op(0) — 불필요한 REG 트래픽 없음."""
    ws = FakeServer()  # 모든 REG rc=0
    client = _client(ws)
    task = await _run_briefly(client, ["005930"])
    assert client.sub_missing() == []
    assert await client.resubscribe_missing() == 0
    await _cancel(task)


async def test_resubscribe_missing_disconnected_is_noop():
    """미연결이면 재구독은 0 — _ws None 가드."""
    ws = FakeServer()
    client = _client(ws)
    # run 안 함 → 미연결(_ws None). sub_missing 있어도 재구독 no-op.
    client._codes = ["005930"]
    assert await client.resubscribe_missing() == 0
