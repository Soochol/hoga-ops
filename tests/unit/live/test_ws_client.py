import asyncio
import json

import pytest

import hoga.live.ws_client as ws_client_mod
from hoga.live.ws_client import DuplicateAppKeyInUse, KisWsClient, build_request


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


async def test_recv_loop_decodes_bytes_data_frames():
    """ship 리뷰: websockets는 BINARY 프레임을 bytes로 전달한다 — str 가정이면
    raw[0]이 int라 데이터 분기가 절대 매칭 안 되고 json.loads 실패 → 무로그
    드롭(침묵 캡처 정지, last_recv_ms는 갱신돼 watchdog도 못 본다). 녹화
    스크립트(record_kis_ws_frames.py:53)와 동일하게 디코드해 방어한다."""
    asp = "0|H0STASP0|001|" + "^".join(["005930", "093015", "0"] + ["1"] * 56)
    fake = FakeWs([asp.encode("utf-8")])  # bytes 프레임
    got: list = []

    async def on_tick(tick):
        got.append(tick)

    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=on_tick, date_fn=lambda: "20260605"
    )
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)
    assert len(got) == 1 and got[0].code == "005930"


async def test_recv_loop_stamps_last_recv_ms_on_control_frames():
    """리뷰 Important 1 — PINGPONG(비데이터)만 수신해도 last_recv_ms가 찍힌다.

    watchdog liveness의 유일한 신호가 이 스탬프다: 깨지면(영구 None) grace
    경과 후 매 패스 stale → 장중 재시작 폭풍. 데이터 프레임이 없으므로
    last_tick_ms는 None 유지(의미 분리: tick=데이터 전용, recv=모든 프레임).
    """
    ping = '{"header":{"tr_id":"PINGPONG","datetime":"x"}}'
    fake = FakeWs([ping])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    assert client.last_recv_ms is None
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)
    assert client.last_recv_ms is not None   # PINGPONG도 liveness
    assert client.last_tick_ms is None       # 데이터 프레임은 없었다


async def test_recv_loop_counts_subscription_acks():
    """spec 2026-06-08 §2.1: control 프레임의 body.rt_cd로 구독 확인을 센다 —
    rt_cd=='0'은 sub_acked, 그 외는 sub_rejected(+WARNING). watchdog/pill의
    헬스 술어가 '기대 ACK의 부재'로 구독 거부를 감지하는 입력."""
    ok = '{"header":{"tr_id":"H0STASP0","tr_key":"005930"},"body":{"rt_cd":"0","msg_cd":"OPSP0000","msg1":"SUBSCRIBE SUCCESS"}}'
    ok2 = '{"header":{"tr_id":"H0STCNT0","tr_key":"005930"},"body":{"rt_cd":"0","msg_cd":"OPSP0000"}}'
    reject = '{"header":{"tr_id":"H0STASP0","tr_key":"005930"},"body":{"rt_cd":"1","msg_cd":"OPSP0002","msg1":"ALREADY IN SUBSCRIBE"}}'
    fake = FakeWs([ok, ok2, reject])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)
    assert client.sub_acked == 2
    assert client.sub_rejected == 1


async def test_recv_loop_raises_duplicate_appkey_on_ops8996():
    msg = '{"header":{"tr_id":null},"body":{"rt_cd":"9","msg_cd":"OPSP8996","msg1":"ALREADY IN USE appkey"}}'
    fake = FakeWs([msg])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )

    with pytest.raises(DuplicateAppKeyInUse):
        await client._recv_loop(fake)

    assert client.sub_rejected == 1


async def test_run_duplicate_appkey_uses_long_backoff_without_fast_reconnect(monkeypatch):
    msg = '{"header":{"tr_id":null},"body":{"rt_cd":"9","msg_cd":"OPSP8996","msg1":"ALREADY IN USE appkey"}}'
    calls = {"connect": 0}
    sleeps: list[float] = []

    def fake_connect(url, **kwargs):
        calls["connect"] += 1
        return _FakeConnectCM(FakeWs([msg]))

    async def fake_sleep(delay: float) -> None:
        if delay == 0:
            return
        sleeps.append(delay)
        raise asyncio.CancelledError

    monkeypatch.setattr(ws_client_mod.websockets, "connect", fake_connect)
    monkeypatch.setattr(ws_client_mod, "_APPKEY_IN_USE_BACKOFF_S", 123)
    monkeypatch.setattr(ws_client_mod.asyncio, "sleep", fake_sleep)

    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )

    with pytest.raises(asyncio.CancelledError):
        await client.run(["005930"])

    assert calls["connect"] == 1
    assert sleeps == [123]
    assert client.connected is False


async def test_subscription_counters_reset_fields_exist():
    """연결 전 기본값 — sub_expected/acked/rejected는 0에서 시작."""
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    assert client.sub_expected == 0
    assert client.sub_acked == 0
    assert client.sub_rejected == 0


async def test_subscribe_sends_two_trs_per_code():
    """ADR-0111: 거래원 TR(H0STMBC0)을 WS에서 제외 — 종목당 호가+체결 2 TR만 구독."""
    fake = FakeWs([])
    client = KisWsClient(approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605")
    await client._send_subscriptions(fake, "APPR", ["005930", "000660"], tr_type="1")
    assert len(fake.sent) == 4                  # 2종목 × 2TR
    trs = {json.loads(s)["body"]["input"]["tr_id"] for s in fake.sent}
    assert trs == {"H0STASP0", "H0STCNT0"}


async def test_ensure_venue_swaps_trs_unregister_before_register():
    """#524 시분할 스왑: KRX→NXT 전환 시 KRX를 먼저 해제(슬롯 비움)하고 NXT를 등록.
    unregister-before-register — 연결당 등록 상한 41 준수(ADR-0101/0111: register-first면
    스왑 찰나 종목당 4 TR로 초과)."""
    fake = FakeWs([])
    client = KisWsClient(approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605")
    client._ws = fake            # 연결 상태 시뮬레이션
    client._approval = "APPR"
    client._codes = ["005930"]
    # 스왑 전 구독 헬스 카운터(초기 연결분) — 스왑이 이를 리셋하지 않아야 한다.
    client.sub_expected, client.sub_acked, client.sub_rejected = 2, 2, 0
    assert client.venue == "KRX"

    await client.ensure_venue("NXT")

    assert client.venue == "NXT"
    frames = [json.loads(s) for s in fake.sent]
    reg = [f for f in frames if f["header"]["tr_type"] == "1"]
    unreg = [f for f in frames if f["header"]["tr_type"] == "2"]
    assert {f["body"]["input"]["tr_id"] for f in reg} == {"H0NXASP0", "H0NXCNT0"}
    # ADR-0111: KRX도 거래원 제외 후 호가+체결 2 TR만(H0STMBC0 없음).
    assert {f["body"]["input"]["tr_id"] for f in unreg} == {"H0STASP0", "H0STCNT0"}
    # unregister-before-register: 첫 해제 프레임이 첫 등록 프레임보다 앞선다(상한 41 준수).
    first_reg = next(i for i, f in enumerate(frames) if f["header"]["tr_type"] == "1")
    first_unreg = next(i for i, f in enumerate(frames) if f["header"]["tr_type"] == "2")
    assert first_unreg < first_reg
    # 카운터 리셋 안 함(update_codes 선례) — 표시 전용 NXT 실패가 watchdog 재시작을
    # 유발하거나 status에 순간 거짓 sub_failed를 노출하지 않게 한다.
    assert (client.sub_expected, client.sub_acked) == (2, 2)


async def test_ensure_venue_noop_when_already_on_target():
    fake = FakeWs([])
    client = KisWsClient(approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605")
    client._ws = fake
    client._approval = "APPR"
    client._codes = ["005930"]
    await client.ensure_venue("KRX")   # 이미 KRX
    assert fake.sent == []             # 재전송 없음


async def test_ensure_venue_while_disconnected_defers_to_next_connect():
    """미연결이면 self._trs만 갱신 — 다음 (재)연결이 새 venue로 초기 구독한다."""
    client = KisWsClient(approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605")
    await client.ensure_venue("NXT")
    assert client.venue == "NXT"


async def test_initial_venue_from_constructor_trs():
    """생성자 trs로 초기 venue 결정(NXT로 시작 가능 — 장전 콜드 스타트)."""
    from hoga.live import ws_fields as F
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605",
        trs=F.TRS_NXT,
    )
    assert client.venue == "NXT"


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
        if len(fake.sent) >= 4:
            break
        await asyncio.sleep(0)
    assert client.sub_expected == 4   # 2종목 × 2TR(ADR-0111) — 연결 시 설정 핀(line 93)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert calls["n"] >= 2  # 1회차 실패 후 백오프 → 재연결
    # 재연결 성공 시 전 종목 × 2TR 재구독 (tr_type="1")
    sent = {
        (json.loads(s)["body"]["input"]["tr_id"], json.loads(s)["body"]["input"]["tr_key"])
        for s in fake.sent
    }
    assert sent == {
        (tr, code)
        for tr in ("H0STASP0", "H0STCNT0")
        for code in ("005930", "000660")
    }
    assert all(json.loads(s)["header"]["tr_type"] == "1" for s in fake.sent)


async def test_reconnect_resets_subscription_counters(monkeypatch):
    """spec §4.1: 재연결 시 sub_acked/rejected가 0으로 리셋된다(연결별 카운트).
    이전 연결의 잔여 카운트가 헬스 술어를 오염시키면 안 된다."""
    fake = FakeWs([])
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
    client.sub_acked = 99      # 이전 연결의 잔여 오염
    client.sub_rejected = 7
    task = asyncio.create_task(client.run(["005930", "000660"]))
    for _ in range(100):
        if len(fake.sent) >= 4:
            break
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert client.sub_acked == 0       # 재연결 시 리셋(line 94)
    assert client.sub_rejected == 0    # (line 95)
    assert client.sub_expected == 4    # 2종목 × 2TR(ADR-0111) — (line 93)


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


async def test_gate_fn_runs_off_event_loop():
    """gate_fn(ws_capture_window)은 콜드/네거티브 캐시에서 동기 KIS HTTP
    (timeout 15s)를 부를 수 있다 — run()은 이벤트 루프에서 직접 부르지 말고
    스레드로 격리해야 한다(구 poller의 to_thread 가드 승계, 리뷰 #2)."""
    import threading

    seen: list[bool] = []

    def gate() -> bool:
        seen.append(threading.current_thread() is threading.main_thread())
        return False

    client = KisWsClient(
        approval_key_fn=_fake_approval,
        on_tick=None,
        date_fn=lambda: "20260605",
        gate_fn=gate,
    )
    task = asyncio.create_task(client.run(["005930"]))
    for _ in range(50):
        await asyncio.sleep(0.01)
        if seen:
            break
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert seen, "게이트가 한 번도 평가되지 않음"
    assert not any(seen), "gate_fn이 이벤트 루프(메인 스레드)에서 실행됨"
