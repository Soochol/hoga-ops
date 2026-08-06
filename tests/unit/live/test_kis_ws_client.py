"""KIS WS 전송 계층 — 프레임 봉투·구독 ACK·PINGPONG·관측성 shape.

**주 회귀 가드는 ADR-0116 규율 3(관측성 shape 통일)이다.** `connected` ·
`last_tick_ms` · `last_recv_ms` · `sub_expected` · `sub_acked` · `sub_missing()` 이
`KiwoomWsClient` 와 같은 이름·같은 뜻이어야 한다. 특히 **`last_tick_ms` 는 데이터
프레임 전용이고 `last_recv_ms` 는 PINGPONG 을 포함**한다 — 이 구분이 없으면 무음이
정상인 표면에서 워치독이 살아있는 세션을 죽은 것으로 본다.

두 번째 가드는 실패 분류다. 자격증명 부재(영구)는 조용히 반환해야 하고, 네트워크
실패(일시)는 백오프를 타야 한다. 한 예외로 뭉치면 폴링 주기마다 헛발질한다.
"""
import asyncio

import pytest

from hoga.live.kis_approval_provider import KisApprovalTransient, KisApprovalUnavailable
from hoga.live.kis_ws_client import KisWsClient

TR = "H0MFCNT0"


class _FakeApproval:
    def __init__(self, key: str = "KEY", raises: Exception | None = None) -> None:
        self._key = key
        self._raises = raises
        self.calls = 0

    def get_key(self) -> str:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return self._key


class _FakeWs:
    """스크립트된 프레임을 순서대로 주고, 소진되면 영원히 매달린다(취소 대기)."""

    def __init__(self, frames: list[str]) -> None:
        self._frames = list(frames)
        self.sent: list[str] = []
        self.closed = False

    async def send(self, data, /) -> None:
        self.sent.append(data if isinstance(data, str) else data.decode())

    async def recv(self):
        if self._frames:
            return self._frames.pop(0)
        await asyncio.Event().wait()  # 취소될 때까지 대기
        raise AssertionError("unreachable")

    async def close(self) -> None:
        self.closed = True


def _client(frames: list[str], approval=None, **kw) -> tuple[KisWsClient, list, _FakeWs]:
    got: list[tuple[str, str]] = []
    ws = _FakeWs(frames)

    async def connect(_url):
        return ws

    client = KisWsClient(
        approval or _FakeApproval(),
        tr_id=TR,
        on_frame=lambda tr, payload: got.append((tr, payload)),
        connect=connect,
        **kw,
    )
    return client, got, ws


async def _run_briefly(client: KisWsClient, codes: tuple[str, ...], *, seconds=0.05) -> None:
    task = asyncio.create_task(client.run(codes))
    await asyncio.sleep(seconds)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ── 프레임 봉투 ────────────────────────────────────────────────────────────

async def test_data_frame_payload_is_handed_to_domain() -> None:
    """전송은 봉투(`0|TR|건수|payload`)만 벗긴다 — `^` 해석은 도메인 몫이다."""
    client, got, _ = _client([f"0|{TR}|001|A01609^235027^1004.95"])
    await _run_briefly(client, ("A01609",))
    assert got == [(TR, "A01609^235027^1004.95")]


async def test_other_tr_frames_are_dropped_by_transport() -> None:
    """다른 TR 은 전송에서 걸러진다 — 도메인이 TR 을 알 필요가 없다."""
    client, got, _ = _client(["0|H0IFCNT0|001|A01609^235027^999", f"0|{TR}|001|ok"])
    await _run_briefly(client, ("A01609",))
    assert got == [(TR, "ok")]


async def test_short_frames_are_dropped() -> None:
    client, got, _ = _client(["0|" + TR, "garbage"])
    await _run_briefly(client, ("A01609",))
    assert got == []


# ── PINGPONG ──────────────────────────────────────────────────────────────

async def test_pingpong_is_echoed_and_not_a_tick() -> None:
    """무음이 정상인 표면이라 PINGPONG 이 유일한 liveness 근거다."""
    ping = '{"header":{"tr_id":"PINGPONG"}}'
    client, got, ws = _client([ping])
    await _run_briefly(client, ("A01609",))

    assert ping in ws.sent  # 그대로 되돌려 보낸다
    assert got == []  # 데이터 프레임이 아니다
    assert client.last_recv_ms is not None  # liveness 는 갱신
    assert client.last_tick_ms is None  # 표시용 틱 시각은 아니다


async def test_last_tick_and_recv_diverge() -> None:
    """`last_tick_ms`(데이터 전용) vs `last_recv_ms`(전부) — 키움과 같은 의미 분리."""
    client, _, _ = _client([f"0|{TR}|001|A01609^1^2", '{"header":{"tr_id":"PINGPONG"}}'])
    await _run_briefly(client, ("A01609",))

    assert client.last_tick_ms is not None
    assert client.last_recv_ms is not None
    assert client.last_recv_ms >= client.last_tick_ms


# ── 구독 ACK / 관측성 shape ────────────────────────────────────────────────

async def test_subscribes_each_code_individually() -> None:
    """KIS 는 (tr_id, tr_key) 개별 구독이다 — 키움 배치 REG 와 골격이 다르다."""
    client, _, ws = _client([], )
    await _run_briefly(client, ("A01609", "A06609"))

    assert len(ws.sent) == 2
    assert all(f'"tr_id": "{TR}"' in m for m in ws.sent)
    assert any('"tr_key": "A01609"' in m for m in ws.sent)
    assert any('"tr_key": "A06609"' in m for m in ws.sent)


async def test_ack_updates_observability_shape() -> None:
    ack = '{"header":{"tr_id":"' + TR + '","tr_key":"A01609"},"body":{"rt_cd":"0"}}'
    client, _, _ = _client([ack])
    await _run_briefly(client, ("A01609", "A06609"))

    assert client.sub_expected == 2
    assert client.sub_acked == 1
    # ACK 는 실효성을 보장하지 않는다 — 상위 워치독이 무틱 종목과 교차해야 한다
    assert client.sub_missing() == ["A06609"]


async def test_connected_flips_and_clears() -> None:
    client, _, ws = _client([])
    task = asyncio.create_task(client.run(("A01609",)))
    await asyncio.sleep(0.05)
    assert client.connected is True
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert client.connected is False
    assert ws.closed is True


# ── 실패 분류 ──────────────────────────────────────────────────────────────

async def test_permanent_failure_returns_quietly() -> None:
    """자격증명 부재는 재시도해도 같다 — 조용히 반환하고 사유만 남긴다.

    여기서 warning 을 쓰거나 재시도하면 30초 폴링에 얹혀 로그 벽이 된다.
    """
    approval = _FakeApproval(raises=KisApprovalUnavailable("KIS 자격증명 없음"))
    client, _, _ = _client([], approval=approval)

    await asyncio.wait_for(client.run(("A01609",)), timeout=1.0)  # 매달리지 않는다

    assert client.unavailable == "KIS 자격증명 없음"
    assert approval.calls == 1  # 재시도하지 않았다
    assert client.connected is False


async def test_transient_failure_retries_with_backoff() -> None:
    """네트워크 실패는 백오프 사다리를 탄다 — 즉시 포기하면 야간이 그날 내내 죽는다."""
    approval = _FakeApproval(raises=KisApprovalTransient("네트워크"))
    client, _, _ = _client([], approval=approval)

    task = asyncio.create_task(client.run(("A01609",)))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert client.unavailable is None  # 영구 실패가 아니다
    assert approval.calls >= 1
