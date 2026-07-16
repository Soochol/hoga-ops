"""KiwoomSessionManager 단위 — partition/build/update/teardown (fake conn 주입)."""
import asyncio

from hoga.live.kiwoom_session import KiwoomSessionManager, _KiwoomConn


class _FakeClient:
    def __init__(self, codes=()):
        self.connected = True
        self.updated: list[list[str]] = []
        self._codes = list(codes)
        self.kicked_by_peer = False
        self.last_tick_ms = None

    @property
    def sub_expected(self):
        return len(self._codes)

    @property
    def sub_acked(self):
        return len(self._codes)

    async def update_codes(self, codes):
        self.updated.append(list(codes))
        self._codes = list(codes)


class _FakeStream:
    def __init__(self):
        self.active: set[str] | None = None

    def set_active_codes(self, codes):
        self.active = set(codes)


def _fake_manager():
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
            client=_FakeClient(codes),
            ws_task=asyncio.create_task(_idle()),
            flush_task=asyncio.create_task(_idle()),
            codes=tuple(codes),
        )

    mgr = KiwoomSessionManager(
        buffer=object(), data_dir=object(), date_fn=lambda: "20260716",
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


async def test_sync_rebuilds_dead_conn():
    """리뷰 Major: 죽은 conn(ws_task 종료/킥)을 sync가 teardown 후 재빌드."""
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
    # 다음 sync가 죽은 conn을 재빌드.
    await mgr.sync(("A", "B"), n_accounts=1)
    assert len(built) == 2  # 재빌드됨
    assert not mgr._conns[0].ws_task.done()
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
