"""sync_storage_runtime — 관심종목=KIS WS, 히트맵=키움 WS(ADR-0116).

KIS REST 30s 캡처(rest30)·storage_policy는 제거됨(2026-07-17 정책: 호가는 api로
받지 않는다 — 폴백 없음). 이 스위트는 키움 라우팅과 프로그램매매 사이드카
게이트(bypass만)를 검증한다.
"""
from __future__ import annotations

from dataclasses import dataclass

import pytest

from hoga.api.models import (
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolder,
)
from hoga.api.watchlist import save_document
from hoga.live.settings import LiveSettings, save_live_settings
from hoga.live.storage_runtime import sync_storage_runtime


class FakeProgramTradeCollector:
    created = []

    def __init__(self, **kwargs):
        self.started = False
        self.stopped = False
        FakeProgramTradeCollector.created.append(self)

    def start(self) -> None:
        self.started = True
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


@dataclass
class FakeStorageState:
    program_trade_collector: FakeProgramTradeCollector | None = None
    kiwoom_session: object | None = None  # ADR-0116 — Protocol 필드(off일 땐 None)


def _seed_watchlist(tmp_path):
    save_document(
        tmp_path,
        WatchlistDocument(
            folders=[
                WatchlistFolder(
                    id="f_0000000a",
                    name="스윙",
                    order=0,
                    member_codes=["005930", "000660", "035420"],
                    capture_enabled=True,
                ),
            ],
            entries=[
                WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
                WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
                WatchlistEntry(code="035420", name="NAVER", registered_at_kst_date="20260601"),
            ],
        ),
    )


class Hit:
    def __init__(self, code: str) -> None:
        self.code = code


def _patch_common(monkeypatch):
    FakeProgramTradeCollector.created.clear()
    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [Hit("005930"), Hit("000660"), Hit("035420")],
    )
    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_from_env",
        lambda data_dir: object(),
    )
    monkeypatch.setattr(
        "hoga.live.program_trade_collector.ProgramTradeCollector",
        FakeProgramTradeCollector,
    )


def _seed_heatmap(tmp_path, codes: list[tuple[str, str]]):
    from hoga.api.heatmap import save_document as save_heatmap_document
    from hoga.api.models import HeatmapDocument, HeatmapEntry

    save_heatmap_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder(id="f_00000aaa", name="히트맵", order=0)],
            entries=[
                HeatmapEntry(code=code, name=name, folder_id="f_00000aaa")
                for code, name in codes
            ],
        ),
    )


@pytest.mark.asyncio
async def test_storage_runtime_ws_targets_from_watchlist(tmp_path, monkeypatch) -> None:
    """기본 경로: 관심종목이 슬롯 내면 전부 KIS WS 타깃, 키움 off면 kiwoom_targets=()."""
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    save_live_settings(tmp_path, LiveSettings())
    state = FakeStorageState()

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.ws_targets == ("005930", "000660", "035420")
    assert snapshot.kiwoom_targets == ()


@pytest.mark.asyncio
async def test_storage_runtime_ws_targets_clamped_to_account_slots(
    tmp_path, monkeypatch,
) -> None:
    """슬롯(per_account_max×n) 초과 관심종목은 WS 타깃에서 잘린다 — REST 스필오버 없음."""
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    monkeypatch.setattr("hoga.live.coverage._PER_ACCOUNT_MAX", 1)
    save_live_settings(tmp_path, LiveSettings())
    state = FakeStorageState()

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert snapshot.ws_targets == ("005930",)
    # 초과분(000660, 035420)은 어디에도 안 담긴다(계좌 추가로 대응).
    assert snapshot.kiwoom_targets == ()


class FakeKiwoomSession:
    def __init__(self):
        self.synced: list[tuple[tuple[str, ...], int]] = []
        self.stopped = 0
        self._codes: tuple[str, ...] = ()

    async def sync(self, kiwoom_targets, *, n_accounts):
        self.synced.append((tuple(kiwoom_targets), n_accounts))
        self._codes = tuple(kiwoom_targets)

    def active_codes(self):
        return list(self._codes)

    def status(self):
        return {"enabled": True, "subscribed_count": len(self._codes)}

    async def stop(self):
        self.stopped += 1
        self._codes = ()


@pytest.mark.asyncio
async def test_storage_runtime_kiwoom_enabled_routes_heatmap_to_kiwoom(
    tmp_path, monkeypatch,
) -> None:
    """kiwoom_enabled=True 칼 컷오버(ADR-0118 PR-E): 관심종목+히트맵 union이 kiwoom_session.
    sync로 간다. 히트맵의 관심종목 중복은 dedup, 미지 종목은 드롭. KIS ws_targets는 빈 튜플."""
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    _seed_heatmap(tmp_path, [
        ("000660", "SK하이닉스"),  # watchlist dup → dedup
        ("005380", "현대차"),      # heatmap-only → 키움
        ("999999", "유령"),        # unknown → dropped
    ])
    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _q, limit=10_000: [Hit("005930"), Hit("000660"), Hit("035420"), Hit("005380")],
    )
    monkeypatch.setattr("hoga.live.kiwoom_runtime.configured_account_ids", lambda _d: [0, 1])
    save_live_settings(tmp_path, LiveSettings(kiwoom_enabled=True))

    kiwoom = FakeKiwoomSession()
    state = FakeStorageState(kiwoom_session=kiwoom)

    snapshot = await sync_storage_runtime(
        tmp_path, state=state, buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717", now_ms_fn=lambda: 0, n_configured=1,
    )

    assert snapshot.ws_targets == ()                       # 관심종목 키움 이관(컷오버)
    assert snapshot.kiwoom_targets == ("005930", "000660", "035420", "005380")  # 관심+히트맵
    # n_accounts=키움 앱키 수(2). 저장셋 전체가 sync로.
    assert kiwoom.synced == [(("005930", "000660", "035420", "005380"), 2)]


@pytest.mark.asyncio
async def test_storage_runtime_kiwoom_disabled_stops_existing_session(
    tmp_path, monkeypatch,
) -> None:
    """kiwoom_enabled=False인데 세션이 살아있으면 stop(휴면 전환). 히트맵은 미수집."""
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    _seed_heatmap(tmp_path, [("005380", "현대차")])
    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _q, limit=10_000: [Hit("005930"), Hit("000660"), Hit("035420"), Hit("005380")],
    )
    save_live_settings(tmp_path, LiveSettings())  # kiwoom off

    kiwoom = FakeKiwoomSession()
    state = FakeStorageState(kiwoom_session=kiwoom)

    snapshot = await sync_storage_runtime(
        tmp_path, state=state, buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717", now_ms_fn=lambda: 0, n_configured=1,
    )
    assert kiwoom.stopped == 1
    assert kiwoom.synced == []
    # off면 히트맵은 어디에도 안 담긴다(REST 폴백 없음).
    assert snapshot.kiwoom_targets == ()


@pytest.mark.asyncio
async def test_storage_runtime_kiwoom_enabled_but_no_accounts_collects_nothing(
    tmp_path, monkeypatch,
) -> None:
    """kiwoom_enabled=True인데 키움 앱키 0개(capacity=0)면 히트맵은 미수집 —
    KIS REST 폴백은 존재하지 않는다(2026-07-17 정책). 세션 sync도 없음."""
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    _seed_heatmap(tmp_path, [("005380", "현대차")])
    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _q, limit=10_000: [Hit("005930"), Hit("000660"), Hit("035420"), Hit("005380")],
    )
    monkeypatch.setattr("hoga.live.kiwoom_runtime.configured_account_ids", lambda _d: [])
    save_live_settings(tmp_path, LiveSettings(kiwoom_enabled=True))

    kiwoom = FakeKiwoomSession()
    state = FakeStorageState(kiwoom_session=kiwoom)

    snapshot = await sync_storage_runtime(
        tmp_path, state=state, buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717", now_ms_fn=lambda: 0, n_configured=1,
    )
    assert snapshot.kiwoom_targets == ()
    assert kiwoom.synced == []


@pytest.mark.asyncio
async def test_storage_runtime_kiwoom_sync_failure_is_isolated(
    tmp_path, monkeypatch,
) -> None:
    """키움 sync 예외가 sync_storage_runtime을 뚫고 나가면 KIS 경로(호출자 후속)가
    죽는다 — 격리 확인(리뷰 Major)."""
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    _seed_heatmap(tmp_path, [("005380", "현대차")])
    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _q, limit=10_000: [Hit("005930"), Hit("000660"), Hit("035420"), Hit("005380")],
    )
    monkeypatch.setattr("hoga.live.kiwoom_runtime.configured_account_ids", lambda _d: [0])
    save_live_settings(tmp_path, LiveSettings(kiwoom_enabled=True))

    class ExplodingKiwoom(FakeKiwoomSession):
        async def sync(self, kiwoom_targets, *, n_accounts):
            raise RuntimeError("simulated kiwoom failure")

    state = FakeStorageState(kiwoom_session=ExplodingKiwoom())

    snapshot = await sync_storage_runtime(
        tmp_path, state=state, buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717", now_ms_fn=lambda: 0, n_configured=1,
    )
    # 예외가 삼켜지고 스냅샷은 정상 반환(계획값 유지 — 컷오버: 저장셋=kiwoom, ws 빈값).
    assert snapshot.ws_targets == ()
    assert snapshot.kiwoom_targets == ("005930", "000660", "035420", "005380")


@pytest.mark.asyncio
async def test_storage_runtime_starts_program_trade_collector_when_enabled(
    tmp_path, monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    save_live_settings(tmp_path, LiveSettings(program_trade_storage_enabled=True))
    state = FakeStorageState()

    await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert state.program_trade_collector is FakeProgramTradeCollector.created[0]
    assert state.program_trade_collector.started is True


@pytest.mark.asyncio
async def test_storage_runtime_stops_program_trade_collector_when_disabled(
    tmp_path, monkeypatch,
) -> None:
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    existing = FakeProgramTradeCollector()
    save_live_settings(tmp_path, LiveSettings(program_trade_storage_enabled=False))
    state = FakeStorageState(program_trade_collector=existing)

    await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert existing.stopped is True


@pytest.mark.asyncio
async def test_storage_runtime_bypass_stops_program_trade_collector(
    tmp_path, monkeypatch,
) -> None:
    """kis_rest_bypass는 KIS REST 전면 우회 토글 — 프로그램매매 사이드카(REST 기반)도
    함께 끈다. program_trade_storage_enabled=True여도 bypass가 이긴다."""
    _patch_common(monkeypatch)
    _seed_watchlist(tmp_path)
    existing = FakeProgramTradeCollector()
    save_live_settings(
        tmp_path,
        LiveSettings(
            program_trade_storage_enabled=True,
            kis_rest_bypass_enabled=True,
        ),
    )
    state = FakeStorageState(program_trade_collector=existing)

    snapshot = await sync_storage_runtime(
        tmp_path,
        state=state,
        buffer=object(),  # type: ignore[arg-type]
        date_fn=lambda: "20260717",
        now_ms_fn=lambda: 0,
        n_configured=1,
    )

    assert existing.stopped is True
    # bypass는 WS 타깃 계획엔 영향 없다.
    assert snapshot.ws_targets == ("005930", "000660", "035420")
