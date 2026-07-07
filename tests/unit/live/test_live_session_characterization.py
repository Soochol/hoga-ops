"""C3 characterization — Live Session 상태기계의 *공개-seam* 동작 잠금(2026-06-10).

C3는 lifecycle.py의 WS 연결집합 상태기계(streams + start/refresh/restart/stop +
degraded + status)를 신규 `live_session.LiveSession` 객체로 strangler 추출한다.
그 추출이 load-bearing(장중 캡처 핵심)이라, Beck의 "make the change easy" 원칙대로
**동작을 먼저 잠근다**.

핵심 규율(이 파일의 존재 이유): 기존 test_lifecycle*.py는 `_state.streams[k].ws_task`
같은 *내부*를 찌른다 — 그 내부가 LiveSession으로 이동하면 테스트도 함께 수정되어
"코드를 옮겼더니 통과"가 되고 회귀 신호가 사라진다. 이 파일은 오직 **공개 seam**
(start_live_stream / refresh_live_stream / stop_live_stream / get_status /
_ws_watchdog_check)의 **관측 가능한 출력**(LiveStatus 필드)만 assert한다. 따라서
streams가 어디로 옮겨가든 byte-identical로 살아남아 추출 단계마다 진짜 회귀를 잡는다.

네트워크 0 기법: WS 게이트(should_run_now)를 닫아 KisWsClient.run이 approval-key
fetch 대신 sleep하게 한다. 게이트가 닫혀 conn의 ws는 connected=False로 머문다 —
이는 'market open' 패치 시 degraded 집계를 *내부 ws 주입 없이* 공개-seam으로
특성화하는 데 쓰인다.
"""
import json
from pathlib import Path

import pytest

from hoga.api import symbols
from hoga.live import kis_runtime, lifecycle, session_gate


# Singleton reset is provided by tests/unit/live/conftest.py (_reset_live_singletons).


class _FakeKis:
    """get_approval_key만 쓰는 _build_conn용 가짜 KIS client(R1: 닫혀도 무해)."""

    def __init__(self, account_id: int = 0) -> None:
        self.account_id = account_id

    async def get_approval_key(self) -> str:
        return "APPROVAL"

    async def aclose(self) -> None:
        pass


def _write_watchlist(tmp_path: Path, codes: list[str]) -> None:
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": c, "name": c,
             "registered_at_kst_date": "20260101", "last_success_date": None}
            for c in codes
        ],
    }))


def _wire(monkeypatch, tmp_path, *, n: int, codes: list[str]) -> None:
    """N계좌 환경 + 가짜 client + 닫힌 게이트 + 무필터 + watchlist 작성.

    공개 seam만 관측하므로 어떤 _state 내부도 건드리지 않는다. n∈{1,2}.
    """
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)  # 게이트 닫힘→무네트워크
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])     # cold cache→무필터
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    if n >= 2:
        monkeypatch.setenv("KIS_APP_KEY_2", "k1")
        monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    else:
        monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
        monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: _FakeKis(account_id),
    )
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_from_env", lambda data_dir: _FakeKis(0),
    )
    _write_watchlist(tmp_path, codes)


def _codes(n: int) -> list[str]:
    return [f"{i:06d}" for i in range(n)]


# ── start: Live Set 산출 + N계좌 분배(공개 관측 = live_set + running) ─────────────

@pytest.mark.asyncio
async def test_start_n1_truncates_live_set_to_per_account_max_and_runs(tmp_path, monkeypatch):
    """N=1, 초과 종목 → Live Set은 표시순서 상위 _PER_ACCOUNT_MAX로 절단, 수집 활성."""
    m = lifecycle._PER_ACCOUNT_MAX
    _wire(monkeypatch, tmp_path, n=1, codes=_codes(2 * m))   # 상한의 2배 입력 → 절단 검증
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True
    st = lifecycle.get_status()
    assert st.running is True
    assert st.live_set == _codes(m)         # 상위 m 절단(_PER_ACCOUNT_MAX * n_configured, n=1)
    assert st.watchlist_count == m
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_start_n2_keeps_full_double_live_set(tmp_path, monkeypatch):
    """N=2, 2*_PER_ACCOUNT_MAX 종목 → Live Set 전부 수집(동적 상한 m*2)."""
    m = lifecycle._PER_ACCOUNT_MAX
    full = 2 * m
    _wire(monkeypatch, tmp_path, n=2, codes=_codes(full))
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True
    st = lifecycle.get_status()
    assert st.running is True
    assert st.live_set == _codes(full)
    assert st.watchlist_count == full
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_start_no_creds_stays_offline(tmp_path, monkeypatch):
    """KIS creds 없으면 start는 False·offline(가드 승계)."""
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)
    _write_watchlist(tmp_path, _codes(5))
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is False
    st = lifecycle.get_status()
    assert st.running is False
    assert st.capture_reason == "offline"
    assert st.live_set == []


@pytest.mark.asyncio
async def test_poller_only_when_watchlist_empty_is_idle(tmp_path, monkeypatch):
    """빈 watchlist + creds → poller-only로 서비스 중(idle), WS 연결 0·degraded 없음."""
    _wire(monkeypatch, tmp_path, n=1, codes=[])
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True
    st = lifecycle.get_status()
    assert st.running is True               # poller alive
    assert st.live_set == []                # WS conn 0
    assert st.capture_healthy is True
    assert st.capture_reason == "idle"
    assert st.degraded_accounts == []
    await lifecycle.stop_live_stream()


# ── refresh: _PER_ACCOUNT_MAX-경계 넘는 grow/shrink (공개 관측 = live_set 변화) ────

@pytest.mark.asyncio
async def test_refresh_grows_live_set_across_per_account_boundary(tmp_path, monkeypatch):
    """m종목(1 conn)에서 m+1번째 추가 → Live Set이 m+1로 성장(2nd conn 영역)."""
    m = lifecycle._PER_ACCOUNT_MAX
    _wire(monkeypatch, tmp_path, n=2, codes=_codes(m))
    await lifecycle.start_live_stream(data_dir=tmp_path)
    assert lifecycle.get_status().live_set == _codes(m)

    _write_watchlist(tmp_path, _codes(m + 1))
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    st = lifecycle.get_status()
    assert st.live_set == _codes(m + 1)
    assert st.running is True
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_refresh_shrinks_live_set_across_per_account_boundary(tmp_path, monkeypatch):
    """m+1종목(2 conn)에서 m으로 축소 → Live Set m(2nd conn 영역 비워짐)."""
    m = lifecycle._PER_ACCOUNT_MAX
    _wire(monkeypatch, tmp_path, n=2, codes=_codes(m + 1))
    await lifecycle.start_live_stream(data_dir=tmp_path)
    assert lifecycle.get_status().live_set == _codes(m + 1)

    _write_watchlist(tmp_path, _codes(m))
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    st = lifecycle.get_status()
    assert st.live_set == _codes(m)
    assert st.running is True
    await lifecycle.stop_live_stream()


# ── stop: 완전 정지(공개 관측 = running False) ───────────────────────────────────

@pytest.mark.asyncio
async def test_stop_clears_running_and_live_set(tmp_path, monkeypatch):
    _wire(monkeypatch, tmp_path, n=1, codes=_codes(5))
    await lifecycle.start_live_stream(data_dir=tmp_path)
    assert lifecycle.get_status().running is True
    await lifecycle.stop_live_stream()
    st = lifecycle.get_status()
    assert st.running is False
    assert st.live_set == []
    assert st.capture_reason == "offline"


# ── capture health: market-closed(전역) vs per-account degraded ───────────────────

@pytest.mark.asyncio
async def test_market_closed_is_not_per_account_degraded(tmp_path, monkeypatch):
    """야간/주말(market_closed)은 전역 상태 — conn들이 있어도 per-account degraded로
    잡지 않는다(advisor 버그 회귀 가드: closed 단락이 모든 conn을 degraded로 만들면 안 됨)."""
    _wire(monkeypatch, tmp_path, n=2, codes=_codes(2 * lifecycle._PER_ACCOUNT_MAX))
    await lifecycle.start_live_stream(data_dir=tmp_path)
    monkeypatch.setattr(lifecycle, "_market_clock_closed_for_capture", lambda _n: True)
    st = lifecycle.get_status()
    assert st.capture_reason == "closed"
    assert st.degraded_accounts == []
    assert st.capture_healthy is False
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_market_open_unconnected_conns_are_per_account_degraded(tmp_path, monkeypatch):
    """장중(market open)인데 conn들의 ws가 미연결(게이트 닫힘 → sleep) → 각 account가
    degraded로 집계되고 capture_healthy False. per-account 집계의 공개-seam 잠금."""
    _wire(monkeypatch, tmp_path, n=2, codes=_codes(2 * lifecycle._PER_ACCOUNT_MAX))
    await lifecycle.start_live_stream(data_dir=tmp_path)
    monkeypatch.setattr(lifecycle, "_market_clock_closed_for_capture", lambda _n: False)
    st = lifecycle.get_status()
    assert st.degraded_accounts == [0, 1]   # 두 계좌 모두 미연결 → degraded
    assert st.capture_healthy is False
    assert ":" not in st.capture_reason     # Q10: reason 값 재포맷 금지(prefix 없음)
    await lifecycle.stop_live_stream()


# ── watchdog 진입점: 캡처 윈도 밖이면 no-op(공개 관측 = restart 안 함) ────────────

@pytest.mark.asyncio
async def test_watchdog_noop_outside_capture_window(tmp_path, monkeypatch):
    """캡처 윈도 밖(게이트 닫힘)이면 watchdog는 재시작하지 않고 running 불변."""
    _wire(monkeypatch, tmp_path, n=1, codes=_codes(5))
    await lifecycle.start_live_stream(data_dir=tmp_path)
    assert lifecycle.get_status().running is True
    restarted = await lifecycle._ws_watchdog_check(
        data_dir=tmp_path, now_ms=lifecycle._now_ms(), stale_after_ms=120_000,
    )
    assert restarted is False
    assert lifecycle.get_status().running is True
    await lifecycle.stop_live_stream()
