"""KiwoomSessionManager 단위 — partition/build/update/teardown + 워치독(venue 스왑·
dead 재빌드·warmup 술어·재구독). fake conn 주입 + 시각 주입(결정성)."""
import asyncio
import logging
import threading
import time
from datetime import datetime

import pytest

from hoga.live.coverage import KIWOOM_SECTOR_RESERVE
from hoga.live.kiwoom_session import KiwoomSessionManager, _KiwoomConn
from hoga.util.timeenc import KST


@pytest.fixture(autouse=True)
def _pin_master(krx_only_master):
    """이 모듈의 주제는 venue 파생이 아니다 — 마스터를 KRX 전용으로 고정한다."""


def _ms(hour: int, minute: int) -> int:
    # 2026-05-27 = 화요일(거래일). 순수 시각만 venue/warmup 파생에 쓰인다.
    return int(datetime(2026, 5, 27, hour, minute, 0, tzinfo=KST).timestamp() * 1000)


def test_display_reassignment_builds_master_once_and_refreshes_next_pass(monkeypatch):
    from unittest.mock import Mock

    from hoga.live import kiwoom_session as session

    manager = object.__new__(KiwoomSessionManager)
    manager._nxt_map_fn = lambda: session._nxt_map()
    manager._storage_members = {f"{i:06}" for i in range(315)}
    manager._storage_registration_keys = set()
    manager._display = {
        (code, venue): session._DisplayEntry(refs={"view"}, owner=1)
        for code in manager._storage_members for venue in ("KRX", "NXT", "UN")
    }
    manager._conns = {1: object()}
    master = Mock(return_value=dict.fromkeys(manager._storage_members, True))
    monkeypatch.setattr(session, "_nxt_map", master)
    manager._reassign_display()
    assert master.call_count == 1
    assert ("000000", "NXT") in manager._storage_registration_keys
    assert all(entry.owner is None for entry in manager._display.values())
    # A new master must affect the very next pass; no permanent stale cache.
    master.return_value = dict.fromkeys(manager._storage_members, False)
    monkeypatch.setattr(manager, "_pick_account", lambda: 1)
    manager._reassign_display()
    assert master.call_count == 2
    assert ("000000", "NXT") not in manager._storage_registration_keys
    assert manager._display[("000000", "KRX")].owner is None
    assert manager._display[("000000", "NXT")].owner == 1


_KRX_MS = _ms(10, 0)       # 정규장 → target_ws_venue=KRX (wire=bare)
_NXT_MS = _ms(15, 31)      # drain 마진 후 → NXT (wire=_NX)
_WARMUP_MS = _ms(8, 55)    # 08:50–09:00 워밍 창 → KRX, in_krx_warmup_window=True


class _FakeClient:
    def __init__(self, codes=(), *, persist_missing=False):
        self.connected = True
        self.updated: list[list[str]] = []
        self._codes = list(codes)  # wire 코드(venue 적용본)
        self.kicked_by_peer = False
        self.last_tick_ms = None
        self.last_recv_ms = None  # PING 포함 전 수신 — 좀비 진단 표면(status)
        self.resubscribed = 0
        self._missing: set[str] = set()
        self._persist_missing = persist_missing

    @property
    def expected_codes(self):
        return set(self._codes)

    @property
    def sub_expected(self):
        return len(self._codes)

    @property
    def sub_acked(self):
        return len([c for c in self._codes if c not in self._missing])

    def sub_missing(self):
        return sorted(c for c in self._codes if c in self._missing)

    async def update_codes(self, codes):
        self.updated.append(list(codes))
        self._codes = list(codes)
        self._missing &= set(self._codes)  # 스왑 시 구 wire missing 자연 소멸

    async def resubscribe_missing(self):
        n = len(self.sub_missing())
        self.resubscribed += 1
        if not self._persist_missing:
            self._missing.clear()  # 재구독 성공 모의
        return n


class _FakeStream:
    def __init__(self):
        self.active: set[str] | None = None

    def set_active_codes(self, codes):
        self.active = set(codes)


def _fake_manager(now_fn=None, *, persist_missing=False, gate_fn=None, monotonic_fn=time.monotonic):
    built: list[tuple[int, tuple[str, ...]]] = []

    async def _idle():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            raise

    def build(account_id, codes):
        built.append((account_id, tuple(codes)))
        return _KiwoomConn(
            account_id=account_id,
            stream=_FakeStream(),
            client=_FakeClient(codes, persist_missing=persist_missing),
            ws_task=asyncio.create_task(_idle()),
            flush_task=asyncio.create_task(_idle()),
            codes=tuple(codes),
        )

    mgr = KiwoomSessionManager(
        buffer=object(), data_dir=object(), date_fn=lambda: "20260716",
        now_fn=now_fn or (lambda: _KRX_MS),
        gate_fn=gate_fn, monotonic_fn=monotonic_fn,
        _build_conn=build,
    )
    return mgr, built


async def test_sync_partitions_across_accounts():
    mgr, built = _fake_manager()
    codes = tuple(f"{i:06d}" for i in range(250))
    await mgr.sync(codes, n_accounts=4)
    assert sorted(a for a, _ in built) == [0, 1, 2, 3]
    assert max(len(c.codes) for c in mgr._conns.values()) < 100
    assert set(mgr.active_codes()) == set(codes)
    assert mgr.connected_accounts == 4
    await mgr.stop()


async def test_slow_account_recovery_does_not_block_other_view_subscriptions():
    mgr, _ = _fake_manager()
    await mgr.sync(("A",), n_accounts=2)
    slow = mgr._conns[0].client
    slow._missing = {"A"}
    entered, release = asyncio.Event(), asyncio.Event()

    async def recover():
        entered.set()
        await release.wait()
        slow._missing.clear()
        return 1

    slow.resubscribe_missing = recover
    recovery = asyncio.create_task(mgr.watchdog_pass(_KRX_MS))
    await entered.wait()
    # Force the new display onto the healthy account; test isolation, not allocation.
    mgr._pick_account = lambda: 1
    view = asyncio.create_task(mgr.on_view_subscribe("Z", {"KRX"}, ref="tab"))
    try:
        for _ in range(30):
            await asyncio.sleep(0)
        assert view.done(), "view admission waits behind another account's REG"
        assert view.result()
        assert "Z" in mgr._conns[1].client.expected_codes
    finally:
        release.set()
        await asyncio.gather(recovery, view)
        await mgr.stop()


async def test_inflight_subscription_updates_converge_to_latest_desired_set():
    mgr, _ = _fake_manager()
    await mgr.sync(("A",), n_accounts=1)
    client = mgr._conns[0].client
    entered, release = asyncio.Event(), asyncio.Event()
    original_update = client.update_codes
    calls = []

    async def update(codes):
        calls.append(codes)
        if len(calls) == 1:
            entered.set()
            await release.wait()
        await original_update(codes)

    client.update_codes = update
    await mgr.sync(("A", "B"), n_accounts=1)
    await entered.wait()
    await mgr.sync(("A", "C"), n_accounts=1)
    await mgr.sync(("A", "D"), n_accounts=1)
    release.set()
    for _ in range(30):
        await asyncio.sleep(0)
        if not mgr._subscription_tasks:
            break
    assert calls == [["A", "B"], ["A", "D"]]
    assert client.expected_codes == {"A", "D"}
    await mgr.stop()


async def test_stop_cancels_inflight_subscription_work():
    mgr, _ = _fake_manager()
    await mgr.sync(("A",), n_accounts=1)
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def update(_codes):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    mgr._conns[0].client.update_codes = update
    await mgr.sync(("A", "B"), n_accounts=1)
    await entered.wait()
    await mgr.stop()
    assert cancelled.is_set()
    assert not mgr._subscription_tasks
    assert not mgr._pending_subscriptions


async def test_status_separates_ownership_from_ack_coverage():
    mgr, _ = _fake_manager()
    await mgr.sync(("A", "B"), n_accounts=1)
    mgr._conns[0].client._missing = {"B"}
    status = mgr.status()
    assert status["subscribed_codes"] == ["A", "B"]
    assert status["ready_codes"] == ["A"]
    assert status["ready_registrations"] == ["A"]
    assert status["registration_incomplete"]
    assert not status["accounts"][0]["registration_ready"]
    await mgr.stop()


async def test_sync_over_capacity_drops_and_warns():
    mgr, _ = _fake_manager()
    codes = tuple(f"{i:06d}" for i in range(850))  # 800 상한 초과(4×200)
    await mgr.sync(codes, n_accounts=4)
    # 4계정 × 200 = 800만 담김.
    # 마지막 계정은 업종 예약(66)만큼 저장셋을 덜 담는다 — 800 이 아니라 734.
    assert len(mgr.active_codes()) == 800 - KIWOOM_SECTOR_RESERVE
    await mgr.stop()


async def test_sync_updates_codes_without_rebuild():
    mgr, built = _fake_manager()
    await mgr.sync(("A", "B"), n_accounts=1)
    assert len(built) == 1
    conn = mgr._conns[0]
    client = conn.client
    await mgr.sync(("A", "B", "C"), n_accounts=1)  # 코드 변경 → update_codes(재빌드 아님)
    assert len(built) == 1  # 재빌드 안 함
    assert client.updated == [["A", "B", "C"]]
    assert set(mgr.active_codes()) == {"A", "B", "C"}
    await mgr.stop()


async def test_sync_empty_targets_tears_down():
    mgr, _ = _fake_manager()
    await mgr.sync(("A",), n_accounts=1)
    assert mgr._conns
    await mgr.sync((), n_accounts=1)  # 빈 타깃 → 전체 teardown(휴면)
    assert not mgr._conns
    assert mgr.active_codes() == []


async def test_sync_shrinking_accounts_tears_down_extra():
    mgr, _ = _fake_manager()
    await mgr.sync(tuple(f"{i:06d}" for i in range(250)), n_accounts=4)  # 계정 0,1
    assert set(mgr._conns) == {0, 1, 2, 3}
    # Leave only account 0's codes; the empty sector carrier stays alive.
    kept = mgr._conns[0].codes
    await mgr.sync(kept, n_accounts=4)
    assert set(mgr._conns) == {0, 3}
    assert set(mgr.active_codes()) == set(kept)


async def test_status_snapshot_shape():
    mgr, _ = _fake_manager()
    await mgr.sync(tuple(f"{i:06d}" for i in range(250)), n_accounts=4)  # 계정 0,1
    st = mgr.status()
    assert st["enabled"] is True
    assert st["accounts_configured"] == 4
    assert st["connected_accounts"] == 4  # FakeClient.connected=True
    assert st["subscribed_count"] == 250
    assert set(st["subscribed_codes"]) == set(f"{i:06d}" for i in range(250))
    assert [a["account_id"] for a in st["accounts"]] == [0, 1, 2, 3]
    assert sum(a["sub_expected"] for a in st["accounts"]) == 250
    assert st["accounts"][-1]["sub_expected"] <= 200 - KIWOOM_SECTOR_RESERVE
    await mgr.stop()


async def test_status_empty_when_idle():
    mgr, _ = _fake_manager()
    st = mgr.status()
    assert st["connected_accounts"] == 0
    assert st["subscribed_count"] == 0
    assert st["accounts"] == []


async def test_capture_streams_excludes_dead_conns():
    """PR-D: 거래원 합성 틱 브로드캐스트 대상 = 살아있는 conn의 stream(죽은 conn 제외 —
    active_codes 규율과 동일, 유령 저장 방지)."""
    mgr, _ = _fake_manager()
    await mgr.sync(tuple(f"{i:06d}" for i in range(250)), n_accounts=4)  # 계정 0,1
    assert mgr.capture_streams()[:2] == [mgr._conns[0].stream, mgr._conns[1].stream]
    mgr._conns[1].client.kicked_by_peer = True  # 계정 1 킥 정지
    assert mgr._conns[1].stream not in mgr.capture_streams()  # 1 제외
    await mgr.stop()


async def test_watchdog_rebuilds_dead_conn():
    """PR-B ①: 죽은 conn(ws_task 종료/킥) 재빌드가 sync→워치독으로 승격됐다.
    저장셋 멤버십(bare)은 재빌드에도 보존된다."""
    mgr, built = _fake_manager()
    await mgr.sync(("A", "B"), n_accounts=1)
    assert len(built) == 1
    # 계정 0의 ws_task를 죽인다(킥 정지 모의).
    conn = mgr._conns[0]
    conn.ws_task.cancel()
    try:  # noqa: SIM105 — teardown/idempotent close — 예외 무시가 의도
        await conn.ws_task
    except asyncio.CancelledError:
        pass
    assert conn.ws_task.done()
    # sync는 더는 재빌드하지 않는다(멤버십만) — 죽은 conn 유지.
    await mgr.sync(("A", "B"), n_accounts=1)
    assert len(built) == 1
    # 워치독 패스가 죽은 conn을 재빌드(멤버십 보존).
    await mgr.watchdog_pass(_KRX_MS)
    assert len(built) == 2
    assert not mgr._conns[0].ws_task.done()
    assert mgr._conns[0].codes == ("A", "B")  # bare 멤버십 보존
    await mgr.stop()





async def test_watchdog_resubscribes_missing():
    """PR-B ④: 미확인(sub_missing) 종목을 워치독이 표적 재구독으로 수렴시킨다."""
    mgr, _ = _fake_manager()
    await mgr.sync(("005930", "000660"), n_accounts=1)
    client = mgr._conns[0].client
    client._missing = {"000660"}  # 초기 등록 유실 모의
    await mgr.watchdog_pass(_KRX_MS)
    assert client.resubscribed >= 1
    assert client.sub_missing() == []  # 기본 fake는 재구독으로 수렴
    await mgr.stop()




async def test_active_codes_excludes_kicked_account():
    """리뷰 Major: 킥 정지된 계정의 종목은 active_codes/subscribed_codes에서 제외
    (죽은 계정 종목이 realtime● 오표시 방지)."""
    mgr, _ = _fake_manager()
    await mgr.sync(tuple(f"{i:06d}" for i in range(250)), n_accounts=4)  # 계정 0,1
    # 계정 1을 킥 정지 상태로.
    mgr._conns[1].client.kicked_by_peer = True
    codes = mgr.active_codes()
    expected = set().union(*(set(c.codes) for i, c in mgr._conns.items() if i != 1))
    assert set(codes) == expected
    assert mgr.status()["subscribed_count"] == len(expected)
    await mgr.stop()


async def test_watchdog_reconcile_is_time_invariant():
    """시분할 폐지(ADR-0140 §2): 시각이 바뀌어도 파생 집합이 **안 바뀐다**.

    여기 있던 `test_watchdog_swaps_to_nxt_venue` · `..._swaps_back_to_krx...` ·
    `..._kick_during_swap...` 셋을 대체한다. 그 셋은 08:50/15:31 경계에서 구독이 통째로
    갈아 끼워지는 것을 검증했는데, 갈아 끼울 것 자체가 사라졌다. 남은 위험은 반대쪽이다 —
    **어딘가 시각 의존이 남아 조용히 재구독을 유발하는 것**이라 그걸 못박는다.
    """
    now = {"ms": _KRX_MS}
    mgr, _ = _fake_manager(now_fn=lambda: now["ms"])
    await mgr.sync(("005930", "000660"), n_accounts=1)
    client = mgr._conns[0].client
    assert client.expected_codes == {"005930", "000660"}
    n_updates = len(client.updated)

    for ms in (_NXT_MS, _WARMUP_MS, _KRX_MS):  # 옛 스왑 경계를 전부 넘나든다
        now["ms"] = ms
        await mgr.watchdog_pass(ms)
        assert client.expected_codes == {"005930", "000660"}
    assert len(client.updated) == n_updates  # 재구독 0 — no-op 이어야 한다
    assert set(mgr.active_codes()) == {"005930", "000660"}
    await mgr.stop()


async def test_watchdog_respects_kick_cooldown_before_rebuilding():
    now = [_KRX_MS]
    mgr, built = _fake_manager(now_fn=lambda: now[0])
    await mgr.sync(("005930",), n_accounts=1)
    mgr._conns[0].client.kicked_by_peer = True
    mgr._conns[0].client._consecutive_kicks = 5
    for _ in range(3):
        await mgr.watchdog_pass(now[0])
    assert len(built) == 1
    assert mgr.status()["accounts"][0]["cooldown_until_ms"] == now[0] + 60_000
    now[0] += 60_000
    await mgr.watchdog_pass(now[0])
    assert len(built) == 2
    assert not mgr._conns[0].client.kicked_by_peer
    assert mgr._conns[0].client._consecutive_kicks == 5
    assert mgr._conns[0].client.expected_codes == {"005930"}
    await mgr.stop()


async def test_watchdog_registration_incomplete_sets_flag_and_warns(caplog):
    """등록 미완은 **상시** 감시한다(ADR-0140 §2 — 08:50–09:00 창 특례 폐지).

    옛 판은 워밍 창 밖이면 플래그를 그냥 내렸다. 그 창은 KRX venue 스왑이 개장 직전에
    일어난다는 사실에서 나온 것이라 스왑과 함께 근거를 잃었고, NXT·UN 은 08:00–20:00
    내내 열려 있어 등록 미완의 대가를 아무 때나 치른다."""
    mgr, _ = _fake_manager(now_fn=lambda: _NXT_MS, persist_missing=True)
    await mgr.sync(("005930", "000660"), n_accounts=1)
    mgr._conns[0].client._missing = {"000660"}  # 재구독해도 안 풀리는 미확인
    with caplog.at_level("WARNING"):
        await mgr.watchdog_pass(_NXT_MS)  # ← 옛 워밍 창 **밖** 시각
    assert mgr.status()["registration_incomplete"] is True
    assert any("registration_incomplete" in r.getMessage() for r in caplog.records)
    await mgr.stop()


async def test_watchdog_registration_complete_clears_flag():
    """등록 완결(미확인 0)이면 플래그가 서지 않는다 — 시각 무관."""
    mgr, _ = _fake_manager(now_fn=lambda: _NXT_MS)
    await mgr.sync(("005930",), n_accounts=1)
    await mgr.watchdog_pass(_NXT_MS)
    assert mgr.status()["registration_incomplete"] is False
    await mgr.stop()


async def test_closed_gate_keeps_736_registrations_without_retry_or_warning(caplog):
    mgr, _ = _fake_manager(gate_fn=lambda: False, persist_missing=True)
    assert mgr.status()["connection_allowed"] is None
    try:
        await mgr.sync(tuple(f"{i:06d}" for i in range(736)), n_accounts=6)
        for conn in mgr._conns.values():
            conn.client.connected = False
            conn.client._missing = conn.client.expected_codes
        for _ in range(3):
            await mgr.watchdog_pass(_KRX_MS)
        status = mgr.status()
        assert sum(a["sub_expected"] for a in status["accounts"]) == 736
        assert sum(a["sub_acked"] for a in status["accounts"]) == 0
        assert status["connected_accounts"] == 0
        assert status["connection_allowed"] is False
        assert status["connection_gate_observed_ms"] == _KRX_MS
        assert not status["registration_incomplete"]
        assert not status["ready_codes"]
        assert not any(a["registration_ready"] for a in status["accounts"])
        assert all(c.client.resubscribed == 0 for c in mgr._conns.values())
        assert not mgr._subscription_tasks
        assert not any("registration_incomplete" in r.message for r in caplog.records)
    finally:
        await mgr.stop()


async def test_closed_gate_with_real_clients_never_connects_or_requests_tokens(caplog):
    from unittest.mock import AsyncMock

    from hoga.live.kiwoom_ws_client import KiwoomWsClient

    mgr, _ = _fake_manager(gate_fn=lambda: False)
    connect, token = AsyncMock(), AsyncMock()
    try:
        await mgr.sync(tuple(f"{i:06d}" for i in range(736)), n_accounts=6)
        loop = asyncio.get_running_loop()
        observed = [asyncio.Event() for _ in mgr._conns]
        for account, conn in mgr._conns.items():
            conn.ws_task.cancel()
            await asyncio.gather(conn.ws_task, return_exceptions=True)

            def gate(event=observed[account]):
                loop.call_soon_threadsafe(event.set)
                return False

            conn.client = KiwoomWsClient(
                token_fn=token, on_tick=AsyncMock(), date_fn=lambda: "20261003",
                gate_fn=gate, _connect=connect,
            )
            conn.ws_task = asyncio.create_task(conn.client.run(list(conn.codes)))
        async with asyncio.timeout(5):
            await asyncio.gather(*(event.wait() for event in observed))
        for _ in range(3):
            await mgr.watchdog_pass(_KRX_MS)
        connect.assert_not_awaited()
        token.assert_not_awaited()
        assert sum(len(c.client.sub_missing()) for c in mgr._conns.values()) == 736
        assert all(c.client.connection_generation == 0 for c in mgr._conns.values())
        assert not mgr.status()["registration_incomplete"]
        assert not mgr._subscription_tasks
        assert not any("registration_incomplete" in r.message for r in caplog.records)
    finally:
        await mgr.stop()


async def test_gate_reopens_with_latest_membership_and_display_refs():
    allowed, now = [False], [_KRX_MS]
    mgr, _ = _fake_manager(gate_fn=lambda: allowed[0], now_fn=lambda: now[0])
    try:
        await mgr.sync(("A",), n_accounts=1)
        await mgr.on_view_subscribe("Z", {"KRX"}, ref="kept")
        await mgr.on_view_subscribe("Y", {"KRX"}, ref="released")
        await mgr.on_view_unsubscribe("Y", {"KRX"}, ref="released")
        now[0] += 60_001
        await mgr.sync(("B",), n_accounts=1)
        await mgr.watchdog_pass(now[0])
        client = mgr._conns[0].client
        client.connected = False
        client._missing = client.expected_codes
        assert ("Y", "KRX") not in mgr._display
        assert mgr._display[("Z", "KRX")].refs == {"kept"}
        allowed[0] = True
        await mgr.watchdog_pass(now[0])
        assert mgr.status()["registration_incomplete"]
        assert client.resubscribed == 0  # the WS loop owns initial connection
        client.connected = True
        client._missing = client.expected_codes
        await mgr.watchdog_pass(now[0])
        assert client.expected_codes == {"B", "Z"}
        assert not client.sub_missing()
        assert mgr.status()["ready_codes"] == ["B"]
    finally:
        await mgr.stop()


async def test_registration_warning_is_aggregated_and_uses_monotonic_time(caplog):
    clock = [0.0]
    mgr, _ = _fake_manager(persist_missing=True, monotonic_fn=lambda: clock[0])
    try:
        await mgr.sync(tuple(f"{i:06d}" for i in range(30)), n_accounts=6)
        for conn in mgr._conns.values():
            conn.client._missing = conn.client.expected_codes
        with caplog.at_level(logging.INFO):
            await mgr.watchdog_pass(_KRX_MS)
            await asyncio.sleep(0)  # all account completion checks stay silent
            assert len([r for r in caplog.records if "registration_incomplete" in r.message]) == 1
            assert all(c.client.resubscribed == 1 for c in mgr._conns.values())
            clock[0] = 59.0
            mgr._conns[0].client._missing.clear()  # changed counts do not bypass the limit
            await mgr.watchdog_pass(_KRX_MS + 900_000)  # wall clock is irrelevant
            assert len([r for r in caplog.records if "registration_incomplete" in r.message]) == 1
            clock[0] = 60.0
            await mgr.watchdog_pass(_KRX_MS)
            warnings = [r for r in caplog.records if "registration_incomplete" in r.message]
            assert len(warnings) == 2
            assert "accounts=[1, 2, 3, 4, 5]" in warnings[-1].message
            for conn in mgr._conns.values():
                conn.client._missing.clear()
            await mgr.watchdog_pass(_KRX_MS)
            await mgr.watchdog_pass(_KRX_MS)
            assert len([r for r in caplog.records if "registration_recovered" in r.message]) == 1
            mgr._conns[0].client._missing = mgr._conns[0].client.expected_codes
            await mgr.watchdog_pass(_KRX_MS)
            assert len([r for r in caplog.records if "registration_incomplete" in r.message]) == 3
    finally:
        await mgr.stop()


async def test_closing_gate_resets_warning_episode_without_false_recovery(caplog):
    allowed = [True]
    mgr, _ = _fake_manager(gate_fn=lambda: allowed[0], persist_missing=True, monotonic_fn=lambda: 0.0)
    try:
        await mgr.sync(("A",), n_accounts=1)
        client = mgr._conns[0].client
        client._missing = {"A"}
        with caplog.at_level(logging.INFO):
            await mgr.watchdog_pass(_KRX_MS)
            allowed[0] = False
            await mgr.watchdog_pass(_KRX_MS)
            assert not mgr.status()["registration_incomplete"]
            assert client.resubscribed == 1
            allowed[0] = True
            await mgr.watchdog_pass(_KRX_MS)
            assert len([r for r in caplog.records if "registration_incomplete" in r.message]) == 2
            assert not any("registration_recovered" in r.message for r in caplog.records)
    finally:
        await mgr.stop()


async def test_healthy_and_disconnected_accounts_do_not_schedule_retry(caplog):
    mgr, _ = _fake_manager(persist_missing=True)
    try:
        await mgr.sync(("A", "B", "C"), n_accounts=3)
        mgr._conns[1].client.connected = False
        mgr._conns[1].client._missing = mgr._conns[1].client.expected_codes
        mgr._conns[2].client._missing = mgr._conns[2].client.expected_codes
        await mgr.watchdog_pass(_KRX_MS)
        assert [mgr._conns[i].client.resubscribed for i in range(3)] == [0, 0, 1]
        assert mgr.status()["registration_incomplete"]
        assert "disconnected=[1]" in caplog.records[-1].message
    finally:
        await mgr.stop()


async def test_queued_retry_checks_gate_again_after_update():
    allowed = [True]
    mgr, _ = _fake_manager(gate_fn=lambda: allowed[0], persist_missing=True)
    try:
        await mgr.sync(("A",), n_accounts=1)
        conn = mgr._conns[0]
        entered, release = asyncio.Event(), asyncio.Event()
        original = conn.client.update_codes

        async def update(codes):
            entered.set()
            await release.wait()
            await original(codes)

        conn.client.update_codes = update
        mgr._schedule_subscription(conn, ["A", "Z"], retry=True)
        await entered.wait()
        allowed[0] = False
        await mgr._refresh_connection_gate()
        release.set()
        await mgr._subscription_tasks[0]
        assert conn.client.expected_codes == {"A", "Z"}
        assert conn.client.resubscribed == 0
    finally:
        await mgr.stop()


async def test_closed_gate_defers_dead_connection_rebuild_until_open():
    allowed = [False]
    mgr, built = _fake_manager(gate_fn=lambda: allowed[0])
    try:
        await mgr.sync(("A",), n_accounts=1)
        mgr._conns[0].ws_task.cancel()
        await asyncio.gather(mgr._conns[0].ws_task, return_exceptions=True)
        await mgr.watchdog_pass(_KRX_MS)
        assert len(built) == 1
        allowed[0] = True
        await mgr.watchdog_pass(_KRX_MS)
        assert len(built) == 2
        assert mgr._conns[0].client.expected_codes == {"A"}
    finally:
        await mgr.stop()


async def test_blocking_gate_does_not_hold_admission_lock_or_block_status():
    entered, release = threading.Event(), threading.Event()

    def gate():
        entered.set()
        assert release.wait(5), "gate test did not release worker thread"
        return False

    mgr, _ = _fake_manager(gate_fn=gate)
    task = asyncio.create_task(mgr.watchdog_pass(_KRX_MS))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        assert not mgr._lock.locked()
        async with mgr._lock:
            assert mgr.status()["connection_allowed"] is None
        assert await mgr.on_view_subscribe("A", {"KRX"}, ref="view") is False
    finally:
        release.set()
        await task
        await mgr.stop()


async def test_gate_failure_invalidates_closed_verdict_and_empty_sync_still_stops():
    failing = [False]

    def gate():
        if failing[0]:
            raise RuntimeError("calendar unavailable")
        return False

    mgr, _ = _fake_manager(gate_fn=gate)
    try:
        await mgr.sync(("A",), n_accounts=1)
        mgr._conns[0].client.connected = False
        failing[0] = True
        with pytest.raises(RuntimeError, match="calendar unavailable"):
            await mgr.watchdog_pass(_KRX_MS)
        status = mgr.status()
        assert status["connection_allowed"] is None
        assert status["connection_gate_observed_ms"] is None
        assert status["registration_incomplete"]
        await mgr.sync((), n_accounts=0)
        assert not mgr._conns
        assert not mgr._registration_incomplete
        assert mgr._last_registration_warning is None
    finally:
        await mgr.stop()


async def test_stop_and_restart_allow_new_warning_without_waiting(caplog):
    mgr, _ = _fake_manager(persist_missing=True, monotonic_fn=lambda: 0.0)
    try:
        for _ in range(2):
            await mgr.sync(("A",), n_accounts=1)
            mgr._conns[0].client._missing = {"A"}
            await mgr.watchdog_pass(_KRX_MS)
            await mgr.stop()
        assert len([r for r in caplog.records if "registration_incomplete" in r.message]) == 2
    finally:
        await mgr.stop()


def test_sector_price_timestamp_ignores_breadth_and_older_price(monkeypatch):
    from hoga.live import kiwoom_session
    from hoga.live.kiwoom_sector_frames import SectorTick

    manager, _ = _fake_manager()
    ticks = iter([
        SectorTick(code='001', kind='0J', hhmmss='100000', value=200),
        SectorTick(code='001', kind='0U', hhmmss='100100', rising=500),
        SectorTick(code='001', kind='0J', hhmmss='095900', value=100),
    ])
    monkeypatch.setattr(kiwoom_session, 'parse_sector_row', lambda row: next(ticks))
    for _ in range(3):
        manager._on_sector_row({}, _ms(10, 2))
    snapshot = manager.sector_snapshot()['001']
    assert snapshot['value'] == 200
    assert snapshot['t_ms'] == _ms(10, 0)
    assert snapshot['rising'] == 500
