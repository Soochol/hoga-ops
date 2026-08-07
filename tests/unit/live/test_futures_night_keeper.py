"""야간 keeper — 화면 수요와 무관하게 야간 WS 를 유지한다 (ADR-0141 후속).

**왜 필요한가.** 야간 봉은 WS 로만 오고 소급 조회 경로가 0이다. 수집을 화면 폴링에
묶어두면 그림이 시장이 아니라 **"누가 언제 봤는가"** 를 기록한다 — 2026-08-07 실측:
18:00 개장인데 관측 시작이 19:10, 정확히 사람이 페이지를 연 시각이었다.

**주 회귀 가드 셋.**

① **싱글턴.** 라우트 홀더와 keeper 가 각자 런타임을 만들면 한 프로세스 안에 야간 WS
   가 두 벌 생기고 벤더가 한쪽을 끊는다. 증상이 "틱이 가끔 끊긴다" 라서 원인에
   도달하기 어렵다 — `KisFuturesNightWs` docstring 이 싱글턴을 전제로 못박은 이유다.

② **세션 밖에서는 닫는다.** 05:00 이 지나도 붙들고 있으면 슬롯을 하루 종일 쥔다.
   유휴 정지(`_IDLE_STOP_S`)는 지우지 않았고, keeper 가 야간에만 그걸 무의미하게 한다.

③ **REST 를 태우지 않는다.** 야간 REST 는 주간 마감본에 동결돼 있어서, keeper 가
   `snapshot()` 을 부르면 아무도 안 보는 밤에 60초마다 무의미한 TR 을 태운다.
"""
import asyncio
from pathlib import Path

import pytest

from hoga.api.kis_futures_master import FuturesMasterRow
from hoga.live import futures_runtime as fr

MASTER = [
    FuturesMasterRow("A01609", "F 202609", "kospi200", "202609", "2001", "KOSPI200"),
    FuturesMasterRow("A06609", "코스닥150F 202609", "kosdaq150", "202609", "3003", "KSQ150"),
]


class _FakeWs:
    def __init__(self) -> None:
        self.running_codes: tuple[str, ...] | None = None
        self.closed = False

    async def ensure_running(self, codes, *, session_day=None):
        self.running_codes = codes
        self.session_day = session_day

    async def aclose(self):
        self.closed = True

    def latest(self, code):
        return None


class _ExplodingClient:
    """REST 를 부르면 터진다 — keeper 가 시세 TR 을 태우지 않는지 재는 장치."""

    async def fetch_futures_quotes(self, rows, *, foreground=False):
        raise AssertionError("keeper 는 REST 시세를 부르면 안 된다 (야간 REST 는 주간 마감본)")


@pytest.fixture
def runtime(monkeypatch):
    rt = fr.FuturesQuotesRuntime(lambda: _ExplodingClient())
    rt._master = MASTER
    rt._master_at = float("inf")  # TTL 만료 방지 — 다운로드로 새지 않게
    monkeypatch.setattr(fr.time, "monotonic", lambda: 0.0)
    monkeypatch.setattr(fr, "spark_date", lambda _t: "20260806")
    return rt


@pytest.fixture(autouse=True)
def _clean_singleton():
    """싱글턴은 프로세스 전역이라 테스트가 서로를 오염시킨다."""
    fr.reset_runtime_for_tests()
    yield
    fr.reset_runtime_for_tests()


# ── ① 싱글턴 ────────────────────────────────────────────────────────────────


def test_ensure_runtime_returns_the_same_instance(tmp_path):
    assert fr.ensure_runtime(tmp_path) is fr.ensure_runtime(tmp_path)


def test_route_holder_shares_the_keeper_runtime(tmp_path):
    """라우트와 keeper 가 **같은** 런타임을 써야 한다.

    각자 만들면 야간 WS 가 한 프로세스에 두 벌이 되고 벤더가 한쪽을 끊는다.
    """
    from hoga.api.market_routes import _FuturesRuntimeHolder

    holder = _FuturesRuntimeHolder(tmp_path)
    assert holder._ensure() is fr.ensure_runtime(tmp_path)


# ── ② 세션 게이트 ───────────────────────────────────────────────────────────


async def test_opens_stream_during_night(runtime, monkeypatch):
    monkeypatch.setattr(fr, "futures_session", lambda _t: "night")
    ws = _FakeWs()
    runtime._ws = ws

    assert await runtime.ensure_night_stream() is True
    # 라인업 근월물 전부를 구독한다 — 마스터에서 뽑은 단축코드여야 한다(`101W09` 아님).
    assert ws.running_codes == ("A01609", "A06609")
    assert ws.closed is False


@pytest.mark.parametrize("session", ["day", "closed"])
async def test_closes_stream_outside_night(runtime, monkeypatch, session):
    """세션 밖에서는 슬롯을 반납한다 — 주간 REST 는 이미 실시간이라 틱이 필요 없다."""
    monkeypatch.setattr(fr, "futures_session", lambda _t: session)
    ws = _FakeWs()
    runtime._ws = ws

    assert await runtime.ensure_night_stream() is False
    assert ws.closed is True


async def test_skips_without_credentials(monkeypatch):
    """무자격은 정상 경로다(ADR-0134) — 크래시가 아니라 미기동이 옳다."""
    monkeypatch.setattr(fr, "futures_session", lambda _t: "night")
    rt = fr.FuturesQuotesRuntime(lambda: None)
    ws = _FakeWs()
    rt._ws = ws

    assert await rt.ensure_night_stream() is False
    # 마스터도 안 받는다 — 자격이 없으면 어차피 구독을 못 연다.
    assert ws.running_codes is None


# ── ③ keeper 루프 ───────────────────────────────────────────────────────────


class _RecordingRuntime:
    def __init__(self, *, boom: bool = False) -> None:
        self.calls = 0
        self._boom = boom

    async def ensure_night_stream(self) -> bool:
        self.calls += 1
        if self._boom:
            raise RuntimeError("벤더 장애")
        return True


def _sleep_stub(stop_after: int):
    """N 번째 잠에서 루프를 끊는다. **벽시계를 기다리지 않는다**(#977)."""
    state = {"n": 0}

    async def fake_sleep(_s):
        state["n"] += 1
        if state["n"] >= stop_after:
            raise asyncio.CancelledError

    return fake_sleep


async def test_keeper_ticks_every_interval(monkeypatch, tmp_path):
    rt = _RecordingRuntime()
    monkeypatch.setattr(fr, "ensure_runtime", lambda _d: rt)

    with pytest.raises(asyncio.CancelledError):
        await fr.run_night_keeper(tmp_path, sleep=_sleep_stub(3))

    assert rt.calls == 3


async def test_keeper_survives_vendor_failure(monkeypatch, tmp_path):
    """**퍼페추얼 루프다** — 예외로 조용히 끝나면 그날 밤 봉이 통째로 빈다(ADR-0064)."""
    rt = _RecordingRuntime(boom=True)
    monkeypatch.setattr(fr, "ensure_runtime", lambda _d: rt)

    with pytest.raises(asyncio.CancelledError):
        await fr.run_night_keeper(tmp_path, sleep=_sleep_stub(3))

    assert rt.calls == 3  # 예외가 나도 계속 두드린다


async def test_keeper_stops_on_cancel(monkeypatch, tmp_path):
    """취소는 삼키지 않는다 — 삼키면 프로세스가 안 내려간다."""

    class _Cancelling:
        async def ensure_night_stream(self):
            raise asyncio.CancelledError

    monkeypatch.setattr(fr, "ensure_runtime", lambda _d: _Cancelling())

    with pytest.raises(asyncio.CancelledError):
        await fr.run_night_keeper(tmp_path, sleep=_sleep_stub(99))


# ── opt-in 플래그 ───────────────────────────────────────────────────────────


def test_keeper_is_opt_in_by_default(monkeypatch):
    """기본 꺼짐이 **안전 기본값**이다.

    워크트리·e2e 백엔드는 `.env` 를 메인에서 상속한다(ADR-0134). 지금까지는 야간 WS
    가 화면 수요에 묶여 있어 그 프로세스들이 슬롯을 안 열었다 — lazy 가 우연히 사고를
    막고 있었다. 무조건 기동으로 바꾸면 키를 상속한 모든 프로세스가 매일 밤 사용자
    dev 서버와 킥 전쟁을 벌인다(#1088 유형 · 증상이 조용하다).
    """
    monkeypatch.delenv("HOGA_NIGHT_FUTURES_KEEPER", raising=False)
    assert fr.night_keeper_enabled_from_env() is False


@pytest.mark.parametrize("value", ["1", "yes", "True", "TRUE", ""])
def test_keeper_flag_only_accepts_exact_true(monkeypatch, value):
    """`HOGA_STARTUP_CATCHUP_ENABLED` 와 같은 판정 — 오타로 켜지면 안 된다."""
    monkeypatch.setenv("HOGA_NIGHT_FUTURES_KEEPER", value)
    assert fr.night_keeper_enabled_from_env() is False


def test_keeper_flag_on(monkeypatch):
    monkeypatch.setenv("HOGA_NIGHT_FUTURES_KEEPER", "true")
    assert fr.night_keeper_enabled_from_env() is True


# ── 종료 정리 ───────────────────────────────────────────────────────────────


async def test_aclose_runtime_closes_night_ws(tmp_path):
    """keeper 는 야간 내내 소켓을 연다 — 종료 때 우리가 닫아야 한다.

    lazy 시절엔 10분 유휴 정지가 이걸 대충 가려줬다. 상시 유지로 바꾼 이상 그 안전망은
    없다: 안 닫고 내려가면 재시작 직후 옛 소켓이 새 프로세스와 슬롯을 다툰다.
    """
    rt = fr.ensure_runtime(tmp_path)
    ws = _FakeWs()
    rt._ws = ws

    await fr.aclose_runtime()
    assert ws.closed is True


async def test_aclose_runtime_without_runtime_is_harmless():
    """주간에만 돈 프로세스는 런타임을 만든 적이 없다 — 종료가 거기서 터지면 안 된다."""
    await fr.aclose_runtime()


def test_is_available_follows_kis_credentials(monkeypatch, tmp_path: Path):
    """무자격이면 스케줄러가 태스크를 아예 안 만든다 — health 에 거짓 행을 남기지 않는다."""
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda _d: [])
    assert fr.is_available(tmp_path) is False

    monkeypatch.setattr(kis_runtime, "configured_account_ids", lambda _d: [0])
    assert fr.is_available(tmp_path) is True
