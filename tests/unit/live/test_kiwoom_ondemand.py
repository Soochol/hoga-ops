"""KiwoomOnDemandSession — 표시전용 온디맨드 WS (ADR-0116, PR-4b)."""
import asyncio

from hoga.live.kiwoom_ondemand import KiwoomOnDemandSession
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import WsTick


class _FakeClient:
    def __init__(self, on_tick):
        self.on_tick = on_tick
        self.updated: list[list[str]] = []

    async def update_codes(self, codes):
        self.updated.append(list(codes))

    async def run(self, codes):
        self.updated.append(list(codes))  # 초기 구독 기록
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            raise


class _FakeBuffer:
    def __init__(self):
        self.published: list[tuple[str, list]] = []

    async def publish(self, code, snapshots, *, now_ms=None):
        self.published.append((code, list(snapshots)))


def _session(*, has_appkey=True):
    buf = _FakeBuffer()
    made = {}

    def factory(on_tick):
        if not has_appkey:
            return None
        c = _FakeClient(on_tick)
        made["client"] = c
        return c

    sess = KiwoomOnDemandSession(
        buffer=buf, client_factory=factory, date_fn=lambda: "20260716",
        now_ms_fn=lambda: 1_000_000,
    )
    return sess, buf, made


async def _flush():
    await asyncio.sleep(0)
    await asyncio.sleep(0)


async def test_subscribe_updates_targets():
    sess, _, made = _session()
    sess.start()
    sess.on_subscribe("005930")
    await _flush()
    assert made["client"].updated[-1] == ["005930"]
    assert sess.status()["targets"] == ["005930"]
    await sess.stop()


async def test_excluded_codes_removed_from_targets():
    sess, _, made = _session()
    sess.start()
    sess.on_subscribe("005930")
    sess.set_excluded_codes({"005930"})  # 이미 WS 커버 → 온디맨드 제외
    await _flush()
    assert sess.status()["targets"] == []
    assert made["client"].updated[-1] == []
    await sess.stop()


async def test_unsubscribe_releases_slot():
    sess, _, made = _session()
    sess.start()
    sess.on_subscribe("005930")
    sess.on_unsubscribe("005930")
    await _flush()
    assert sess.status()["targets"] == []
    await sess.stop()


async def test_on_tick_publishes_display_only():
    sess, buf, made = _session()
    sess.start()
    tick = WsTick(
        code="005930", t_ms=123, kind=SnapshotKind.OB,
        payload={"code": "005930", "asks": [], "bids": []}, venue="KRX",
    )
    await made["client"].on_tick(tick)
    # 표시 링에만 publish — phase/venue 실려 프론트 무변경.
    assert len(buf.published) == 1
    code, snaps = buf.published[0]
    assert code == "005930"
    assert snaps[0].payload["venue"] == "KRX"
    assert "phase" in snaps[0].payload
    await sess.stop()


async def test_no_reserved_appkey_is_noop():
    sess, buf, _ = _session(has_appkey=False)
    sess.start()  # 팩토리 None → 클라이언트 없음
    sess.on_subscribe("005930")
    await _flush()
    assert sess.alive is False
    assert sess.status() == {
        "enabled": False, "running": False, "target_count": 1, "targets": ["005930"],
    }
    await sess.stop()
