import asyncio
import json
import time

import pytest

import hoga.live.ws_client as ws_client_mod
from hoga.live import ws_fields as F
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
    """control 프레임 body.rt_cd/msg_cd로 (tr, code) 단위 구독 확인. rt_cd=='0' 또는
    OPSP0002(ALREADY IN SUBSCRIBE = 서버에 이미 구독됨)는 acked로, 그 외 비-0
    (OPSP0008 등)은 sub_rejected로 센다. sub_acked는 기대 키와의 교집합 크기."""
    ok = '{"header":{"tr_id":"H0STASP0","tr_key":"005930"},"body":{"rt_cd":"0","msg_cd":"OPSP0000","msg1":"SUBSCRIBE SUCCESS"}}'
    already = '{"header":{"tr_id":"H0STCNT0","tr_key":"005930"},"body":{"rt_cd":"1","msg_cd":"OPSP0002","msg1":"ALREADY IN SUBSCRIBE"}}'
    reject = '{"header":{"tr_id":"H0STASP0","tr_key":"000660"},"body":{"rt_cd":"1","msg_cd":"OPSP0008","msg1":"MAX SUBSCRIBE OVER"}}'
    fake = FakeWs([ok, already, reject])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._codes = ["005930"]   # 기대 = 005930 × 2TR(ADR-0111)
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)
    assert client.sub_acked == 2      # 2 TR 모두 확인(OPSP0002 포함)
    assert client.sub_rejected == 1   # OPSP0008(실제 거부)


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
    # 초기 KRX 구독분을 acked로 시뮬레이션 — 스왑(해제)이 이를 폐기하는지 검증.
    now0 = int(time.time() * 1000)
    for tr in F.TRS_KRX:
        client._acked_keys.add((tr, "005930"))
        client._sub_sent_ms[(tr, "005930")] = now0
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
    # 스왑 후 기대는 NXT 키. KRX 해제가 구 venue ACK를 폐기해 _acked_keys는 비었고,
    # 갓 등록된 NXT 키는 유예 안이라 missing이 아니다(순간 거짓 sub_failed 없음).
    assert client.expected_keys == {("H0NXASP0", "005930"), ("H0NXCNT0", "005930")}
    assert client._acked_keys == set()
    swap_ms = int(time.time() * 1000)
    assert client.sub_missing(swap_ms) == []
    # 유예 경과 후 NXT ACK가 안 오면 그때 missing으로 잡힌다.
    after = swap_ms + ws_client_mod._SUB_ACK_GRACE_MS + 1000
    assert set(client.sub_missing(after)) == {("H0NXASP0", "005930"), ("H0NXCNT0", "005930")}


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
    """spec §4.1: 재연결 시 구독 확인 상태가 리셋된다(연결별). 이전 연결의 잔여
    ack/송신기록이 헬스 술어를 오염시키면 안 된다 — 새 소켓엔 이전 ACK가 무효."""
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
    # 이전 연결의 잔여 오염(다른 종목의 ack·송신기록·거부 카운트).
    client._acked_keys.add(("H0STASP0", "999999"))
    client._sub_sent_ms[("H0STASP0", "999999")] = 1
    client.sub_rejected = 7
    task = asyncio.create_task(client.run(["005930", "000660"]))
    for _ in range(100):
        if len(fake.sent) >= 4:
            break
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert client._acked_keys == set()   # 재연결 시 ack 리셋(새 소켓, 아직 무-ACK)
    # 송신기록은 리셋 후 초기 구독이 새 4키로 다시 스탬프 — 이전 오염 키는 사라졌다.
    assert ("H0STASP0", "999999") not in client._sub_sent_ms
    assert len(client._sub_sent_ms) == 4
    assert client.sub_rejected == 0
    assert client.sub_expected == 4      # 2종목 × 2TR(ADR-0111)


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


# ── per-key 구독 추적 · 표적 재구독 (2026-07-15 인시던트 근본수정) ────────────────

async def test_sub_missing_ignores_keys_within_ack_grace():
    """갓 (재)송신된 키는 유예(_SUB_ACK_GRACE_MS) 안에는 missing이 아니다 —
    스왑/디프 직후 순간적 거짓 sub_failed 방지."""
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._codes = ["005930"]
    now = 1_000_000
    for tr in F.TRS_KRX:
        client._sub_sent_ms[(tr, "005930")] = now
    assert client.sub_missing(now + 1_000) == []                      # 유예 안
    assert len(client.sub_missing(now + _grace() + 1)) == 2           # 유예 후(2TR)


async def test_sub_missing_excludes_never_sent_keys():
    """송신 기록 없는 기대 키는 missing에서 제외(아직 송신 전 — 판단 불가, 보수적)."""
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._codes = ["005930"]  # 기대는 있으나 _sub_sent_ms 비어있음
    assert client.sub_missing(9_999_999) == []


async def test_ack_key_marks_only_that_code_tr():
    """ACK는 header.tr_key/tr_id 단위로 특정 (tr, code)만 확인 처리한다."""
    ok = '{"header":{"tr_id":"H0STASP0","tr_key":"005930"},"body":{"rt_cd":"0"}}'
    fake = FakeWs([ok])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._codes = ["005930"]
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)
    assert client._acked_keys == {("H0STASP0", "005930")}


async def test_ops0002_already_in_subscribe_counts_as_acked():
    """OPSP0002(ALREADY IN SUBSCRIBE)는 서버에 구독이 살아있다는 뜻 → acked 처리
    (resubscribe_missing 재송신의 정상 수렴 경로)."""
    already = '{"header":{"tr_id":"H0STCNT0","tr_key":"005930"},"body":{"rt_cd":"1","msg_cd":"OPSP0002"}}'
    fake = FakeWs([already])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._codes = ["005930"]
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)
    assert ("H0STCNT0", "005930") in client._acked_keys
    assert client.sub_rejected == 0


async def test_resubscribe_missing_sends_only_missing_keys():
    """표적 재구독은 유예 지난 미확인 키만 재송신하고 송신 시각을 갱신한다."""
    fake = FakeWs([])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._ws = fake
    client._approval = "APPR"
    client._codes = ["005930"]
    now = 1_000_000
    # ASP0만 acked, 나머지(CNT0)는 오래전 송신 후 미확인(유예 경과).
    client._acked_keys.add(("H0STASP0", "005930"))
    for tr in F.TRS_KRX:
        client._sub_sent_ms[(tr, "005930")] = now
    later = now + _grace() + 1
    sent = await client.resubscribe_missing(later)
    assert sent == 1
    trs = {json.loads(s)["body"]["input"]["tr_id"] for s in fake.sent}
    assert trs == {"H0STCNT0"}                       # ASP0(acked)은 제외
    assert all(json.loads(s)["header"]["tr_type"] == "1" for s in fake.sent)
    # 재송신한 키의 송신 시각이 갱신돼 즉시 다시 missing으로 잡히지 않는다.
    assert client.sub_missing(later) == []


async def test_resubscribe_missing_noop_when_disconnected():
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._codes = ["005930"]
    client._sub_sent_ms[("H0STASP0", "005930")] = 1
    assert await client.resubscribe_missing(9_999_999) == 0    # _ws None → no-op


async def test_venue_roundtrip_detects_lost_reregistration():
    """2026-07-15 인시던트 재현: KRX 전량 acked → NXT 스왑 → KRX 복귀 시 재등록
    일부만 ACK되면(나머지 유실) 유예 후 그 키들이 sub_missing으로 잡힌다."""
    fake = FakeWs([])
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._ws = fake
    client._approval = "APPR"
    client._codes = ["005930"]
    # 1) 초기 KRX 3TR 전량 acked
    now = 1_000_000
    for tr in F.TRS_KRX:
        client._acked_keys.add((tr, "005930"))
        client._sub_sent_ms[(tr, "005930")] = now
    # 2) NXT로 스왑(KRX 해제 → NXT 등록)
    await client.ensure_venue("NXT")
    # 3) KRX로 복귀 스왑(NXT 해제 → KRX 재등록)
    await client.ensure_venue("KRX")
    assert client.venue == "KRX"
    # 4) 재등록 ACK 중 ASP0만 도착, CNT0는 유실됐다고 가정(_recv_loop 구동)
    ack = '{"header":{"tr_id":"H0STASP0","tr_key":"005930"},"body":{"rt_cd":"0"}}'
    with pytest.raises(ConnectionError):
        await client._recv_loop(FakeWs([ack]))
    # 5) 유예 경과 후 유실된 2키가 missing으로 노출 → 헬스가 sub_failed로 잡을 수 있다.
    later = int(time.time() * 1000) + _grace() + 1
    assert set(client.sub_missing(later)) == {("H0STCNT0", "005930")}


def _grace() -> int:
    return ws_client_mod._SUB_ACK_GRACE_MS


async def test_midbatch_send_failure_leaves_remaining_keys_visible():
    """PR #622 리뷰 갭: 구독 배치 send가 중간에 실패해도 잔여 키가 선(先)스탬프돼
    있어 유예 후 sub_missing으로 잡힌다(→ resubscribe_missing이 재시도). send 후
    스탬프였다면 미송신 키는 영원히 불가시(재연결까지 캡처 구멍)였다."""

    class FailAfterN:
        """N번째 send까지 성공, 이후 raise."""

        def __init__(self, n: int):
            self._left = n
            self.sent: list[str] = []

        async def send(self, data: str) -> None:
            if self._left <= 0:
                raise ConnectionError("mid-batch drop")
            self._left -= 1
            self.sent.append(data)

    fake = FailAfterN(1)   # 2TR 중 1개만 송신 성공
    client = KisWsClient(
        approval_key_fn=_fake_approval, on_tick=None, date_fn=lambda: "20260605"
    )
    client._codes = ["005930"]
    with pytest.raises(ConnectionError):
        await client._send_subscriptions(fake, "APPR", ["005930"], tr_type="1")
    assert len(fake.sent) == 1
    # 미송신 2번째 키까지 전부 스탬프됨 → 유예 후 2키 모두 missing(ACK가 없으므로).
    assert len(client._sub_sent_ms) == 2
    later = int(time.time() * 1000) + _grace() + 1
    assert len(client.sub_missing(later)) == 2
