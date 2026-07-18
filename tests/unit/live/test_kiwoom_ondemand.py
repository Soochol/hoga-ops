"""키움 온디맨드 표시셋 — 매니저 참조 카운트 장부(ADR-0118 PR-C, #685).

KiwoomOnDemandSession(별도 세션) 삭제 후, 온디맨드 표시 구독은 KiwoomSessionManager의
장부로 통합됐다: (code,venue)→참조 집합, 전역 1회 등록, 유예 해제, 만석 차단, on_tick
연결별 라우팅(저장멤버→stream / 그외→buffer). 시각·슬롯상한 주입으로 결정론화."""
import asyncio
from datetime import datetime

from hoga.live.kis_client import KIS_KST
from hoga.live.kiwoom_session import KiwoomSessionManager, _KiwoomConn
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick


def _ms(hour: int, minute: int) -> int:
    return int(datetime(2026, 5, 27, hour, minute, 0, tzinfo=KIS_KST).timestamp() * 1000)


_KRX_MS = _ms(10, 0)  # 정규장 → target_ws_venue=KRX (wire=bare)


class _FakeClient:
    def __init__(self, codes=()):
        self.connected = True
        self._codes = list(codes)
        self.updated: list[list[str]] = []
        self.kicked_by_peer = False
        self.last_tick_ms = None

    @property
    def expected_codes(self):
        return set(self._codes)

    @property
    def sub_expected(self):
        return len(self._codes)

    @property
    def sub_acked(self):
        return len(self._codes)

    def sub_missing(self):
        return []

    async def update_codes(self, codes):
        self.updated.append(list(codes))
        self._codes = list(codes)

    async def resubscribe_missing(self):
        return 0


class _FakeStream:
    def __init__(self):
        self.active: set[str] | None = None
        self.ticks: list = []

    def set_active_codes(self, codes):
        self.active = set(codes)

    async def on_tick(self, tick):
        self.ticks.append(tick)


class _FakeBuffer:
    def __init__(self):
        self.published: list[tuple[str, list]] = []

    async def publish(self, code, snapshots, *, now_ms=None):
        self.published.append((code, list(snapshots)))


def _mgr(*, per_account_max=200, buffer=None):
    async def _idle():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            raise

    def build(account_id, codes):
        return _KiwoomConn(
            account_id=account_id,
            stream=_FakeStream(),
            client=_FakeClient(codes),
            ws_task=asyncio.create_task(_idle()),
            flush_task=asyncio.create_task(_idle()),
            codes=tuple(codes),
        )

    return KiwoomSessionManager(
        buffer=buffer or _FakeBuffer(),
        data_dir=object(),
        date_fn=lambda: "20260716",
        now_fn=lambda: _KRX_MS,
        per_account_max=per_account_max,
        _build_conn=build,
    )


def _wire(mgr, account_id=0):
    return set(mgr._conns[account_id].client.expected_codes)


# ── 표시 구독: 슬롯 추가·전역 1회 등록 ──────────────────────────────────────

async def test_view_subscribe_display_only_adds_slot():
    mgr = _mgr()
    await mgr.sync(("A", "B"), n_accounts=1)
    accepted = await mgr.on_view_subscribe("Z", {"KRX"}, ref="tab1")  # Z는 저장셋 밖
    assert accepted is True
    assert "Z" in _wire(mgr)          # 표시 슬롯으로 구독됨
    assert {"A", "B"} <= _wire(mgr)   # 저장셋 유지
    await mgr.stop()


async def test_two_tabs_same_code_one_registration_and_survives_one_close():
    """회귀 가드(현행 버그): 두 탭이 같은 (code,venue)를 봐도 1등록, 한 탭 닫아도 유지."""
    mgr = _mgr()
    await mgr.sync(("A",), n_accounts=1)
    await mgr.on_view_subscribe("Z", {"KRX"}, ref="tab1")
    await mgr.on_view_subscribe("Z", {"KRX"}, ref="tab2")
    client = mgr._conns[0].client
    assert list(_wire(mgr)).count("Z") == 1  # 집합이라 1등록
    n_updates = len(client.updated)
    # 한 탭 닫음 → tab2 남아 유지.
    await mgr.on_view_unsubscribe("Z", {"KRX"}, ref="tab1")
    assert "Z" in _wire(mgr)
    assert len(client.updated) == n_updates  # 변경 없음(재구독 안 함)
    await mgr.stop()


async def test_covered_by_storage_no_extra_registration():
    """저장셋 코드를 현재 창 venue로 열람 = 이미 실시간 → 추가 등록 없음(부족분만)."""
    mgr = _mgr()
    await mgr.sync(("A", "B"), n_accounts=1)
    client = mgr._conns[0].client
    n_updates = len(client.updated)
    accepted = await mgr.on_view_subscribe("A", {"KRX"}, ref="tab1")  # A는 저장셋(KRX)
    assert accepted is True
    assert len(client.updated) == n_updates  # 이미 구독 중 → update 없음
    assert _wire(mgr) == {"A", "B"}
    await mgr.stop()


# ── 유예 해제 ────────────────────────────────────────────────────────────

async def test_release_after_grace_only():
    """마지막 탭 닫음 → 참조 0. 유예 전엔 유지, 유예 후 sweep에서 해제."""
    now = {"ms": _KRX_MS}
    mgr = _mgr()
    mgr._now_fn = lambda: now["ms"]
    await mgr.sync(("A",), n_accounts=1)
    await mgr.on_view_subscribe("Z", {"KRX"}, ref="tab1")
    assert "Z" in _wire(mgr)
    await mgr.on_view_unsubscribe("Z", {"KRX"}, ref="tab1")  # 참조 0 → 유예 시작
    # 유예 전(즉시 sweep) → 아직 유지.
    await mgr.watchdog_pass(now["ms"])
    assert "Z" in _wire(mgr)
    # 유예 경과 후 sweep → 해제.
    now["ms"] += 61_000  # 61s
    await mgr.watchdog_pass(now["ms"])
    assert "Z" not in _wire(mgr)
    await mgr.stop()


async def test_resubscribe_within_grace_cancels_release():
    """유예 중 재구독하면 해제 취소(참조 복귀)."""
    now = {"ms": _KRX_MS}
    mgr = _mgr()
    mgr._now_fn = lambda: now["ms"]
    await mgr.sync(("A",), n_accounts=1)
    await mgr.on_view_subscribe("Z", {"KRX"}, ref="tab1")
    await mgr.on_view_unsubscribe("Z", {"KRX"}, ref="tab1")  # 유예 시작
    await mgr.on_view_subscribe("Z", {"KRX"}, ref="tab2")    # 재구독 → 취소
    now["ms"] += 61_000
    await mgr.watchdog_pass(now["ms"])
    assert "Z" in _wire(mgr)  # 해제 안 됨
    await mgr.stop()


# ── 만석 차단 ────────────────────────────────────────────────────────────

async def test_full_house_rejects_and_warns(caplog):
    """전 연결 슬롯 만석이면 신규 표시 구독 거부(False) + 경고 로그(ws.py가 만석 이벤트)."""
    mgr = _mgr(per_account_max=2)
    await mgr.sync(("A", "B"), n_accounts=1)  # 저장 2 = 슬롯 만석(max=2)
    with caplog.at_level("WARNING"):
        accepted = await mgr.on_view_subscribe("Z", {"KRX"}, ref="tab1")
    assert accepted is False
    assert any("on_demand_full_house" in r.getMessage() for r in caplog.records)
    assert "Z" not in _wire(mgr)
    await mgr.stop()


async def test_display_fills_remaining_slot_then_full():
    """저장 1 + max 3 → 표시 2개까지 수용, 3번째 만석(거부)."""
    mgr = _mgr(per_account_max=3)
    await mgr.sync(("A",), n_accounts=1)  # 저장 1, 잔여 2
    assert await mgr.on_view_subscribe("Y", {"KRX"}, ref="t") is True
    assert await mgr.on_view_subscribe("Z", {"KRX"}, ref="t") is True
    assert await mgr.on_view_subscribe("W", {"KRX"}, ref="t") is False  # 만석
    assert {"A", "Y", "Z"} == _wire(mgr)
    await mgr.stop()


# ── UN 슬롯 산술(+1/+2) ──────────────────────────────────────────────────

async def test_un_view_storage_code_adds_only_missing_venue():
    """UN(KRX∪NXT) 열람: 저장셋 코드는 (X,KRX) 이미 커버 → (X,NXT)만 +1."""
    mgr = _mgr()
    await mgr.sync(("A",), n_accounts=1)  # A = 저장셋(KRX)
    await mgr.on_view_subscribe("A", {"KRX", "NXT"}, ref="tab1")
    assert _wire(mgr) == {"A", "A_NX"}  # KRX 기존 + NXT만 추가(+1)
    await mgr.stop()


async def test_un_view_nonstorage_code_adds_both_venues():
    """UN 열람: 비저장 코드는 (Y,KRX)+(Y,NXT) 둘 다 → +2."""
    mgr = _mgr()
    await mgr.sync(("A",), n_accounts=1)
    await mgr.on_view_subscribe("Y", {"KRX", "NXT"}, ref="tab1")
    assert {"Y", "Y_NX"} <= _wire(mgr)  # +2
    await mgr.stop()


# ── on_tick 연결별 라우팅 ────────────────────────────────────────────────

async def test_on_tick_routes_storage_to_stream_display_to_buffer():
    """연결별 래퍼: 저장 멤버 틱→stream.on_tick(저장경로), 그외→buffer.publish(표시전용)."""
    buf = _FakeBuffer()
    mgr = _mgr(buffer=buf)
    stream = _FakeStream()
    on_tick = mgr._make_conn_on_tick(stream, {"A"})  # 멤버십 {A}
    await on_tick(WsTick(code="A", t_ms=1, kind=SnapshotKind.OB, payload={"x": 1}, venue="KRX"))
    await on_tick(WsTick(code="Z", t_ms=2, kind=SnapshotKind.OB, payload={"y": 2}, venue="KRX"))
    assert [t.code for t in stream.ticks] == ["A"]        # 저장 멤버만 stream
    assert len(buf.published) == 1 and buf.published[0][0] == "Z"  # 비멤버는 buffer
    snap = buf.published[0][1][0]
    assert snap.payload["venue"] == "KRX" and "phase" in snap.payload  # 구 형태 유지
    await mgr.stop()


async def test_on_tick_foreign_stored_code_routes_to_buffer():
    """리뷰 HIGH 회귀: 라우팅은 **연결별 파티션** 기준(전역 저장셋 아님). 다른 계정 소유
    저장코드를 UN으로 열람해 이 연결에 표시 배정된 경우, 이 연결 stream 파티션엔 없으므로
    stream이 조용히 드롭하면 NXT 오버레이가 유실된다 — buffer로 가야 한다."""
    buf = _FakeBuffer()
    mgr = _mgr(buffer=buf)
    stream = _FakeStream()
    # 이 연결 파티션 = {"B"}. X는 (타 계정) 전역 저장셋일 수 있으나 이 연결엔 없음.
    on_tick = mgr._make_conn_on_tick(stream, {"B"})
    await on_tick(WsTick(code="X", t_ms=1, kind=SnapshotKind.OB, payload={}, venue="NXT"))
    assert stream.ticks == []                       # 이 연결 파티션 아님 → stream 미유입
    assert len(buf.published) == 1 and buf.published[0][0] == "X"  # 표시로 buffer 발행
    await mgr.stop()


# ── kiwoom off / 연결 없음 ───────────────────────────────────────────────

async def test_view_subscribe_no_connections_rejects():
    """연결 없음(kiwoom off) → 표시 구독은 만석과 동일하게 거부(예외 없음)."""
    mgr = _mgr()
    accepted = await mgr.on_view_subscribe("Z", {"KRX"}, ref="tab1")
    assert accepted is False
    await mgr.stop()
