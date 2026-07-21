"""KiwoomSessionManager 단위 — partition/build/update/teardown + 워치독(venue 스왑·
dead 재빌드·warmup 술어·재구독). fake conn 주입 + 시각 주입(결정성)."""
import asyncio
from datetime import datetime

from hoga.live.kis_client import KIS_KST
from hoga.live.kiwoom_session import KiwoomSessionManager, _KiwoomConn


def _ms(hour: int, minute: int) -> int:
    # 2026-05-27 = 화요일(거래일). 순수 시각만 venue/warmup 파생에 쓰인다.
    return int(datetime(2026, 5, 27, hour, minute, 0, tzinfo=KIS_KST).timestamp() * 1000)


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


def _fake_manager(now_fn=None, *, persist_missing=False):
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
        _build_conn=build,
    )
    return mgr, built


async def test_sync_partitions_across_accounts():
    mgr, built = _fake_manager()
    codes = tuple(f"{i:06d}" for i in range(250))  # 200 + 50 → 2계정
    await mgr.sync(codes, n_accounts=4)
    # 계정 0=200, 1=50, 2·3=빈파티션 → conn 미생성.
    assert sorted(a for a, _ in built) == [0, 1]
    assert set(mgr.active_codes()) == set(codes)
    assert mgr.connected_accounts == 2
    await mgr.stop()


async def test_sync_over_capacity_drops_and_warns():
    mgr, _ = _fake_manager()
    codes = tuple(f"{i:06d}" for i in range(850))  # 800 상한 초과(4×200)
    await mgr.sync(codes, n_accounts=4)
    # 4계정 × 200 = 800만 담김.
    assert len(mgr.active_codes()) == 800
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
    assert set(mgr._conns) == {0, 1}
    await mgr.sync(tuple(f"{i:06d}" for i in range(100)), n_accounts=4)  # 계정 0만
    assert set(mgr._conns) == {0}


async def test_status_snapshot_shape():
    mgr, _ = _fake_manager()
    await mgr.sync(tuple(f"{i:06d}" for i in range(250)), n_accounts=4)  # 계정 0,1
    st = mgr.status()
    assert st["enabled"] is True
    assert st["accounts_configured"] == 2
    assert st["connected_accounts"] == 2  # FakeClient.connected=True
    assert st["subscribed_count"] == 250
    assert set(st["subscribed_codes"]) == set(f"{i:06d}" for i in range(250))
    assert [a["account_id"] for a in st["accounts"]] == [0, 1]
    assert st["accounts"][0]["sub_expected"] == 200
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
    assert mgr.capture_streams() == [mgr._conns[0].stream, mgr._conns[1].stream]
    mgr._conns[1].client.kicked_by_peer = True  # 계정 1 킥 정지
    assert mgr.capture_streams() == [mgr._conns[0].stream]  # 1 제외
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
    try:
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


async def test_watchdog_swaps_to_nxt_venue():
    """PR-B ②: NXT 창으로 시각이 넘어가면 워치독이 구독 코드를 _NX 접미로 스왑한다
    (기대 등록 = 저장셋 × venue). bare 멤버십은 불변(active_codes 무영향)."""
    now = {"ms": _KRX_MS}
    mgr, _ = _fake_manager(now_fn=lambda: now["ms"])
    await mgr.sync(("005930", "000660"), n_accounts=1)
    client = mgr._conns[0].client
    assert client.expected_codes == {"005930", "000660"}  # KRX 창: wire=bare
    # 15:31 이후 → NXT 창. 워치독이 스왑.
    now["ms"] = _NXT_MS
    await mgr.watchdog_pass(now["ms"])
    assert client.expected_codes == {"005930_NX", "000660_NX"}
    # 멤버십(bare)은 불변 → active_codes/저장셋 무영향.
    assert set(mgr.active_codes()) == {"005930", "000660"}
    await mgr.stop()


async def test_watchdog_swaps_back_to_krx_and_is_idempotent():
    """스왑 왕복 + 동일 venue 재호출 no-op(파생 집합 재수렴, 불필요한 update 없음)."""
    now = {"ms": _NXT_MS}
    mgr, _ = _fake_manager(now_fn=lambda: now["ms"])
    await mgr.sync(("005930",), n_accounts=1)
    client = mgr._conns[0].client
    # NXT에서 시작(빌드가 venue 적용) — reconcile로 _NX 수렴.
    await mgr.watchdog_pass(now["ms"])
    assert client.expected_codes == {"005930_NX"}
    n_updates = len(client.updated)
    # 같은 venue 재패스 → no-op.
    await mgr.watchdog_pass(now["ms"])
    assert len(client.updated) == n_updates
    # KRX 복귀 스왑.
    now["ms"] = _KRX_MS
    await mgr.watchdog_pass(now["ms"])
    assert client.expected_codes == {"005930"}
    await mgr.stop()


async def test_watchdog_kick_during_swap_rebuilds_and_rederives():
    """PR-B: 스왑 시각에 킥된 conn은 재빌드(멤버십 보존) 후 현재 창 venue로 재파생."""
    now = {"ms": _KRX_MS}
    mgr, built = _fake_manager(now_fn=lambda: now["ms"])
    await mgr.sync(("005930",), n_accounts=1)
    assert len(built) == 1
    mgr._conns[0].client.kicked_by_peer = True  # 킥 정지
    now["ms"] = _NXT_MS  # NXT 창으로 스왑 경계
    await mgr.watchdog_pass(now["ms"])
    assert len(built) == 2  # 재빌드
    assert not mgr._conns[0].client.kicked_by_peer
    # 재빌드 후 NXT venue로 재파생.
    assert mgr._conns[0].client.expected_codes == {"005930_NX"}
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


async def test_watchdog_warmup_incomplete_sets_flag_and_warns(caplog):
    """PR-B ③: 08:50–09:00 워밍 창에 저장셋 등록 미완이면 warmup_incomplete 플래그 +
    경고 로그(유일한 저장 리스크 창). 재구독이 수렴 못 하는 persistent 실패를 모의."""
    mgr, _ = _fake_manager(now_fn=lambda: _WARMUP_MS, persist_missing=True)
    await mgr.sync(("005930", "000660"), n_accounts=1)
    mgr._conns[0].client._missing = {"000660"}  # 재구독해도 안 풀리는 미확인
    with caplog.at_level("WARNING"):
        await mgr.watchdog_pass(_WARMUP_MS)
    assert mgr.status()["warmup_incomplete"] is True
    assert any("warmup_incomplete" in r.getMessage() for r in caplog.records)
    await mgr.stop()


async def test_watchdog_warmup_complete_clears_flag():
    """워밍 창에서 등록 완결(미확인 0)이면 플래그가 서지 않는다."""
    mgr, _ = _fake_manager(now_fn=lambda: _WARMUP_MS)
    await mgr.sync(("005930",), n_accounts=1)  # 미확인 없음
    await mgr.watchdog_pass(_WARMUP_MS)
    assert mgr.status()["warmup_incomplete"] is False
    await mgr.stop()


async def test_active_codes_excludes_kicked_account():
    """리뷰 Major: 킥 정지된 계정의 종목은 active_codes/subscribed_codes에서 제외
    (죽은 계정 종목이 realtime● 오표시 방지)."""
    mgr, _ = _fake_manager()
    await mgr.sync(tuple(f"{i:06d}" for i in range(250)), n_accounts=4)  # 계정 0,1
    # 계정 1을 킥 정지 상태로.
    mgr._conns[1].client.kicked_by_peer = True
    codes = mgr.active_codes()
    # 계정 0(200종목)만, 계정 1(50종목)은 제외.
    assert len(codes) == 200
    assert mgr.status()["subscribed_count"] == 200
    await mgr.stop()
