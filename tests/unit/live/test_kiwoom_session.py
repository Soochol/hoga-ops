"""KiwoomSessionManager 단위 — partition/build/update/teardown (fake conn 주입)."""
import asyncio

from hoga.live.kiwoom_session import KiwoomSessionManager, _KiwoomConn


class _FakeClient:
    def __init__(self):
        self.connected = True
        self.updated: list[list[str]] = []

    async def update_codes(self, codes):
        self.updated.append(list(codes))


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
            client=_FakeClient(),
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
