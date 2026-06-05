"""hoga/api/symbols.py — KIS .mst cache + 3-tier policy + breakdown."""

from __future__ import annotations

import asyncio
import json

import pytest

from hoga.api import symbols
from hoga.api.kis_master import MasterRow


@pytest.fixture(autouse=True)
def _reset():
    symbols.reset_state_for_tests()
    yield
    symbols.reset_state_for_tests()


def _stub_fetch(monkeypatch, kospi=None, kosdaq=None, *, raise_exc=None):
    """Patch _fetch_symbol_master with an in-memory list.

    No credentials required — the new path is static (SPEC §7).
    """
    kospi = kospi if kospi is not None else [("005930", "삼성전자")]
    kosdaq = kosdaq if kosdaq is not None else [("035720", "카카오")]
    if raise_exc is not None:
        async def _raise():
            raise raise_exc
        monkeypatch.setattr(symbols, "_fetch_symbol_master", _raise)
        return

    async def _fetch():
        return [
            symbols.SymbolHit(
                code=c,
                name=n,
                market="KOSPI",
                captured_count=0,
                captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
            )
            for c, n in kospi
        ] + [
            symbols.SymbolHit(
                code=c,
                name=n,
                market="KOSDAQ",
                captured_count=0,
                captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
            )
            for c, n in kosdaq
        ]

    monkeypatch.setattr(symbols, "_fetch_symbol_master", _fetch)


@pytest.mark.asyncio
async def test_initial_status_is_loading_then_fresh(monkeypatch, tmp_path):
    _stub_fetch(monkeypatch)
    path = tmp_path / "sm.json"
    resp = await symbols.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "fresh"
    assert len(resp.symbols) == 2
    assert resp.fetched_at_ms is not None


@pytest.mark.asyncio
async def test_concurrent_gets_dedupe_to_one_fetch(monkeypatch, tmp_path):
    """N concurrent refresh calls trigger exactly one underlying fetch."""
    counter = {"n": 0}
    sem = asyncio.Event()

    async def _slow_fetch():
        counter["n"] += 1
        await sem.wait()
        return []

    monkeypatch.setattr(symbols, "_fetch_symbol_master", _slow_fetch)
    path = tmp_path / "sm.json"

    t1 = asyncio.create_task(symbols.refresh(path=path, data_dir=tmp_path))
    t2 = asyncio.create_task(symbols.refresh(path=path, data_dir=tmp_path))
    t3 = asyncio.create_task(symbols.refresh(path=path, data_dir=tmp_path))
    await asyncio.sleep(0.05)
    assert counter["n"] == 1
    sem.set()
    await asyncio.gather(t1, t2, t3)
    assert counter["n"] == 1


@pytest.mark.asyncio
async def test_kis_master_failure_returns_unavailable_when_no_cache(monkeypatch, tmp_path):
    from hoga.api.kis_master import KisMasterFetchError
    _stub_fetch(monkeypatch, raise_exc=KisMasterFetchError("mst down"))
    path = tmp_path / "sm.json"
    resp = await symbols.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.symbols == []


def test_search_filters_by_name(monkeypatch, tmp_path):
    _stub_fetch(monkeypatch, kospi=[("005930", "삼성전자"), ("000660", "SK하이닉스")])
    path = tmp_path / "sm.json"
    asyncio.run(symbols.refresh(path=path, data_dir=tmp_path))
    hits = symbols.search("삼성", limit=5)
    assert [h.code for h in hits] == ["005930"]


def test_search_filters_by_code_prefix(monkeypatch, tmp_path):
    _stub_fetch(monkeypatch, kospi=[("005930", "삼성전자"), ("005935", "삼성전자우")])
    path = tmp_path / "sm.json"
    asyncio.run(symbols.refresh(path=path, data_dir=tmp_path))
    hits = symbols.search("00593", limit=5)
    assert sorted(h.code for h in hits) == ["005930", "005935"]


def test_search_name_is_case_insensitive(monkeypatch, tmp_path):
    """영문 종목명은 입력 케이스와 무관하게 매칭된다 (한글은 영향 없음)."""
    _stub_fetch(
        monkeypatch,
        kospi=[("058850", "KTcs"), ("010950", "S-Oil"), ("001040", "CJ")],
        kosdaq=[],
    )
    path = tmp_path / "sm.json"
    asyncio.run(symbols.refresh(path=path, data_dir=tmp_path))
    # 소문자 쿼리 → 혼합 케이스 종목명 매칭
    assert [h.code for h in symbols.search("ktcs", limit=5)] == ["058850"]
    # 대문자 쿼리 → 혼합 케이스 종목명 매칭
    assert [h.code for h in symbols.search("S-OIL", limit=5)] == ["010950"]
    # 소문자 쿼리 → 대문자 종목명 매칭
    assert [h.code for h in symbols.search("cj", limit=5)] == ["001040"]


def test_search_name_case_insensitive_ordering(monkeypatch, tmp_path):
    """대소문자 무시 시에도 접두사 우선 + 이름 길이순 정렬이 유지된다."""
    _stub_fetch(
        monkeypatch,
        kospi=[("000120", "CJ대한통운"), ("001040", "CJ")],
        kosdaq=[],
    )
    path = tmp_path / "sm.json"
    asyncio.run(symbols.refresh(path=path, data_dir=tmp_path))
    # 'cj' → 둘 다 접두사 매칭 → 이름 길이순: 'CJ'(2자) 먼저
    assert [h.code for h in symbols.search("cj", limit=5)] == ["001040", "000120"]


def test_captured_breakdown_classifies_states(monkeypatch, tmp_path):
    """Setup a parquet dir per code with meta files representing each state."""
    (tmp_path / "parquet" / "20260518" / "005930").mkdir(parents=True)
    (tmp_path / "parquet" / "20260518" / "005930" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": False})
    )  # complete
    (tmp_path / "parquet" / "20260519" / "005930").mkdir(parents=True)
    (tmp_path / "parquet" / "20260519" / "005930" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": True})
    )  # source_partial
    (tmp_path / "raw" / "20260520" / "005930").mkdir(parents=True)
    (tmp_path / "raw" / "20260520" / "005930" / "first_0001.tsv").write_text("")  # client_incomplete
    (tmp_path / "parquet" / "20260521" / "005930").mkdir(parents=True)
    (tmp_path / "parquet" / "20260521" / "005930" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": False, "regular_session_close_ms": 0})
    )  # invalid (close_ms=0 trips error-severity invariant per ADR-0020)

    breakdowns = symbols._build_all_captured_breakdowns(tmp_path)
    assert breakdowns["005930"] == {
        "complete": 1, "source_partial": 1, "client_incomplete": 1, "invalid": 1,
    }


def test_symbols_all_response_accepts_reason() -> None:
    """SymbolsAllResponse.reason is optional and accepts UpstreamCode values."""
    from hoga.api.error_codes import UpstreamCode
    from hoga.api.models import SymbolsAllResponse

    resp = SymbolsAllResponse(symbols=[], status="unavailable", fetched_at_ms=None,
                              reason=UpstreamCode.KRX_CREDENTIALS_MISSING)
    assert resp.reason == "krx_credentials_missing"

    # Default is None for backward compat.
    resp_default = SymbolsAllResponse(symbols=[], status="fresh", fetched_at_ms=123)
    assert resp_default.reason is None


def test_calendar_response_accepts_reason() -> None:
    """CalendarResponse.reason is optional and accepts UpstreamCode values."""
    from hoga.api.error_codes import UpstreamCode
    from hoga.api.models import CalendarResponse

    resp = CalendarResponse(cells=[], as_of_ms=123,
                            reason=UpstreamCode.KRX_FETCH_FAILED)
    assert resp.reason == "krx_fetch_failed"

    resp_default = CalendarResponse(cells=[], as_of_ms=123)
    assert resp_default.reason is None


import pytest
from pathlib import Path

from hoga.api import symbols as symbols_module
from hoga.api.error_codes import UpstreamCode


@pytest.fixture(autouse=False)
def _reset_symbols_state():
    """Each test starts with a clean module state."""
    symbols_module.reset_state_for_tests()
    yield
    symbols_module.reset_state_for_tests()


@pytest.mark.asyncio
async def test_get_all_fetch_failed_when_kis_master_raises(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    from hoga.api.kis_master import KisMasterFetchError

    async def _raise() -> list:
        raise KisMasterFetchError("mst download failed")
    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _raise)

    path = tmp_path / "sm.json"
    resp = await symbols_module.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.reason == UpstreamCode.KIS_MASTER_FETCH_FAILED


@pytest.mark.asyncio
async def test_get_all_reason_cleared_on_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    from hoga.api.models import SymbolHit

    async def _ok() -> list[SymbolHit]:
        return [SymbolHit(code="005930", name="삼성전자", market="KOSPI",
                          captured_count=0,
                          captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0})]
    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _ok)

    path = tmp_path / "sm.json"
    resp = await symbols_module.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "fresh"
    assert resp.reason is None
    assert len(resp.symbols) == 1


@pytest.mark.asyncio
async def test_spec7_no_creds_refresh_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    """SPEC §7: symbol refresh works without KRX_ID/KRX_PW — .mst is static/no-auth."""
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    # Patch the sync _fetch_mst (called in executor) to return rows without network.
    fake_rows = [MasterRow(code="005930", name="삼성전자", market="KOSPI", security_type="stock")]
    monkeypatch.setattr(symbols_module, "_fetch_mst", lambda: fake_rows)

    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.status == "fresh", "refresh must succeed without any KRX credentials"
    assert len(resp.symbols) == 1
    assert resp.symbols[0].code == "005930"


def test_reset_state_for_tests_clears_reason() -> None:
    """Reset returns the state to unavailable(SYMBOL_MASTER_NOT_INITIALIZED).

    T7: reset now mirrors the module-level default — boot must populate via
    load_disk_state(); if it hasn't run, state is unavailable, not loading.
    """
    symbols_module._state = SymbolCacheState.stale(reason=UpstreamCode.KRX_FETCH_FAILED)
    symbols_module.reset_state_for_tests()
    assert symbols_module._state.status == "unavailable"
    assert symbols_module._state.reason == UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED


from hoga.api.symbols import SymbolCacheState


def test_symbol_cache_state_factories_enforce_invariants() -> None:
    """Spec §5.3 2-axis matrix is enforced by classmethod factories.

    The factories are the only sanctioned way to construct a SymbolCacheState
    in production code. Direct dataclass construction is technically allowed
    but bypasses the invariant guidance — a code-review concern, not a type
    error.
    """
    # Loading and fresh carry no reason.
    assert SymbolCacheState.loading().status == "loading"
    assert SymbolCacheState.loading().reason is None
    assert SymbolCacheState.fresh().status == "fresh"
    assert SymbolCacheState.fresh().reason is None

    # Stale and unavailable require a reason.
    stale = SymbolCacheState.stale(reason=UpstreamCode.KRX_FETCH_FAILED)
    assert stale.status == "stale"
    assert stale.reason == UpstreamCode.KRX_FETCH_FAILED

    unavailable = SymbolCacheState.unavailable(reason=UpstreamCode.KRX_CREDENTIALS_MISSING)
    assert unavailable.status == "unavailable"
    assert unavailable.reason == UpstreamCode.KRX_CREDENTIALS_MISSING

    # Frozen — immutable after construction.
    with pytest.raises(Exception):  # dataclasses.FrozenInstanceError
        stale.reason = None  # type: ignore[misc]


def test_symbol_cache_state_stale_requires_keyword_reason() -> None:
    """The factory rejects positional/missing reason — invariant aid."""
    with pytest.raises(TypeError):
        SymbolCacheState.stale()  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        SymbolCacheState.unavailable()  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# T4 — disk I/O helpers: _load_from_disk / _write_to_disk / SCHEMA_VERSION
# ---------------------------------------------------------------------------

import json
import os
from pathlib import Path

from hoga.api import symbols as symbols_module
from hoga.api.models import SymbolHit


def _make_hit(code: str, name: str, market: str = "KOSPI") -> SymbolHit:
    return SymbolHit(
        code=code,
        name=name,
        market=market,  # type: ignore[arg-type]
        captured_count=0,
        captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
    )


def test_disk_round_trip(tmp_path):
    path = tmp_path / "symbol-master.json"
    entries = [_make_hit("005930", "삼성전자"), _make_hit("000660", "SK하이닉스")]
    symbols_module._write_to_disk(path, entries, fetched_at_ms=1747900000000)

    result = symbols_module._load_from_disk(path)
    assert result is not None
    loaded, fetched_at_ms = result
    assert fetched_at_ms == 1747900000000
    assert [(h.code, h.name, h.market) for h in loaded] == [
        ("005930", "삼성전자", "KOSPI"),
        ("000660", "SK하이닉스", "KOSPI"),
    ]


def test_load_missing_file_returns_none(tmp_path):
    assert symbols_module._load_from_disk(tmp_path / "absent.json") is None


def test_load_corrupt_json_returns_none(tmp_path):
    path = tmp_path / "corrupt.json"
    path.write_text("{ this is not valid json", encoding="utf-8")
    assert symbols_module._load_from_disk(path) is None


def test_load_wrong_schema_version_returns_none(tmp_path):
    path = tmp_path / "wrong-version.json"
    path.write_text(
        json.dumps({"schema_version": 999, "fetched_at_ms": 1, "entries": []}),
        encoding="utf-8",
    )
    assert symbols_module._load_from_disk(path) is None


def test_load_missing_entries_array_returns_none(tmp_path):
    path = tmp_path / "no-entries.json"
    path.write_text(
        json.dumps({"schema_version": 2, "fetched_at_ms": 1}),
        encoding="utf-8",
    )
    assert symbols_module._load_from_disk(path) is None


def test_load_malformed_entry_returns_none(tmp_path):
    path = tmp_path / "bad-entry.json"
    path.write_text(
        json.dumps({
            "schema_version": 2,
            "fetched_at_ms": 1,
            "entries": [{"code": "005930"}],  # missing name and market
        }),
        encoding="utf-8",
    )
    assert symbols_module._load_from_disk(path) is None


def test_write_strips_captured_breakdown(tmp_path):
    path = tmp_path / "sm.json"
    hit = _make_hit("005930", "삼성전자")
    hit.captured_count = 99
    hit.captured_breakdown = {"complete": 99, "source_partial": 0, "client_incomplete": 0, "invalid": 0}
    symbols_module._write_to_disk(path, [hit], fetched_at_ms=1)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert "captured_count" not in payload["entries"][0]
    assert "captured_breakdown" not in payload["entries"][0]
    assert set(payload["entries"][0].keys()) == {"code", "name", "market", "security_type"}


def test_write_creates_parent_dir(tmp_path):
    path = tmp_path / "nested" / "deeper" / "sm.json"
    symbols_module._write_to_disk(path, [_make_hit("005930", "삼성전자")], fetched_at_ms=1)
    assert path.exists()


def test_atomic_write_rollback_on_replace_failure(tmp_path, monkeypatch):
    path = tmp_path / "sm.json"
    symbols_module._write_to_disk(path, [_make_hit("005930", "기존")], fetched_at_ms=1)
    original_content = path.read_text(encoding="utf-8")

    def fail_replace(_src, _dst):
        raise OSError("simulated replace failure")

    monkeypatch.setattr("os.replace", fail_replace)
    try:
        symbols_module._write_to_disk(path, [_make_hit("000660", "신규")], fetched_at_ms=2)
    except OSError:
        pass

    assert path.read_text(encoding="utf-8") == original_content


# ---------------------------------------------------------------------------
# T6 — load_disk_state boot entry point
# ---------------------------------------------------------------------------


def test_load_disk_state_no_file(tmp_path):
    symbols_module.reset_state_for_tests()
    path = tmp_path / "absent.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    symbols_module.load_disk_state(path=path, data_dir=data_dir)

    assert symbols_module._cache == []
    assert symbols_module._fetched_at_ms is None
    assert symbols_module._state.status == "unavailable"
    assert symbols_module._state.reason == UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED


def test_load_disk_state_corrupt_file(tmp_path):
    symbols_module.reset_state_for_tests()
    path = tmp_path / "corrupt.json"
    path.write_text("not json", encoding="utf-8")
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    symbols_module.load_disk_state(path=path, data_dir=data_dir)

    assert symbols_module._state.status == "unavailable"
    assert symbols_module._state.reason == UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED


def test_load_disk_state_valid_file(tmp_path):
    symbols_module.reset_state_for_tests()
    path = tmp_path / "sm.json"
    path.write_text(
        json.dumps({
            "schema_version": 2,
            "fetched_at_ms": 1747900000000,
            "source": "kis_mst",
            "entries": [
                {"code": "005930", "name": "삼성전자", "market": "KOSPI"},
                {"code": "000660", "name": "SK하이닉스", "market": "KOSPI"},
            ],
        }),
        encoding="utf-8",
    )
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    symbols_module.load_disk_state(path=path, data_dir=data_dir)

    assert len(symbols_module._cache) == 2
    assert symbols_module._cache[0].code == "005930"
    assert symbols_module._cache[0].name == "삼성전자"
    assert symbols_module._fetched_at_ms == 1747900000000
    assert symbols_module._state.status == "fresh"
    assert symbols_module._state.reason is None


# ---------------------------------------------------------------------------
# T7 — get_all is a pure memory read (no fetch trigger)
# ---------------------------------------------------------------------------


async def _patch_fetch_to_raise(monkeypatch):
    async def _boom():
        raise AssertionError("get_all() must not trigger .mst fetch")
    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _boom)


@pytest.mark.asyncio
async def test_get_all_does_not_trigger_fetch_when_empty(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    await _patch_fetch_to_raise(monkeypatch)
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    resp = await symbols_module.get_all(data_dir=data_dir)

    assert resp.symbols == []
    assert resp.status == "unavailable"
    assert resp.fetched_at_ms is None


@pytest.mark.asyncio
async def test_get_all_returns_cached_entries(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    await _patch_fetch_to_raise(monkeypatch)
    # Pre-populate state via load_disk_state with a valid file.
    path = tmp_path / "sm.json"
    path.write_text(
        json.dumps({
            "schema_version": 2,
            "fetched_at_ms": 99,
            "source": "kis_mst",
            "entries": [{"code": "005930", "name": "삼성전자", "market": "KOSPI"}],
        }),
        encoding="utf-8",
    )
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    symbols_module.load_disk_state(path=path, data_dir=data_dir)

    resp = await symbols_module.get_all(data_dir=data_dir)

    assert len(resp.symbols) == 1
    assert resp.status == "fresh"
    assert resp.fetched_at_ms == 99


# ---------------------------------------------------------------------------
# T8 — refresh(*, path, data_dir): sole .mst entry point, disk write, dedupe
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_happy_path(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()

    async def _fake_fetch():
        return [_make_hit("005930", "삼성전자")]

    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _fake_fetch)
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert path.exists(), "disk file must be written on success"
    assert len(resp.symbols) == 1
    assert resp.status == "fresh"
    assert resp.reason is None
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 2
    assert len(payload["entries"]) == 1


@pytest.mark.asyncio
async def test_refresh_kis_failure_preserves_disk(tmp_path, monkeypatch):
    from hoga.api.kis_master import KisMasterFetchError

    symbols_module.reset_state_for_tests()
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    async def _ok():
        return [_make_hit("005930", "삼성전자")]
    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _ok)
    await symbols_module.refresh(path=path, data_dir=data_dir)
    original_content = path.read_text(encoding="utf-8")

    async def _boom():
        raise KisMasterFetchError("mst down")
    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _boom)
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.reason == UpstreamCode.KIS_MASTER_FETCH_FAILED
    assert resp.status == "stale", "cache populated → state is stale, not unavailable"
    assert path.read_text(encoding="utf-8") == original_content


@pytest.mark.asyncio
async def test_refresh_concurrent_dedupe(tmp_path, monkeypatch):
    """Two simultaneous refresh calls collapse to one .mst fetch."""
    import asyncio as _asyncio

    symbols_module.reset_state_for_tests()
    call_count = 0

    async def _slow():
        nonlocal call_count
        call_count += 1
        await _asyncio.sleep(0.05)
        return [_make_hit("005930", "삼성전자")]

    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _slow)
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    results = await _asyncio.gather(
        symbols_module.refresh(path=path, data_dir=data_dir),
        symbols_module.refresh(path=path, data_dir=data_dir),
        symbols_module.refresh(path=path, data_dir=data_dir),
    )

    assert call_count == 1, "concurrent refreshes must dedupe to one fetch"
    for r in results:
        assert r.status == "fresh"


# ---------------------------------------------------------------------------
# T10 — GET /api/symbols/info lightweight metadata endpoint
# ---------------------------------------------------------------------------


def test_symbols_info_endpoint_empty(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from hoga.api.app import create_app
    from hoga.api import symbols

    symbols_module.reset_state_for_tests()
    # Isolate disk path so we don't read the real machine-global file.
    # The import is via `from hoga.config import resolve_symbol_master_path`
    # in hoga/api/app.py, so we patch the name in that module's namespace.
    monkeypatch.setattr(
        "hoga.api.app.resolve_symbol_master_path",
        lambda: tmp_path / "symbol-master.json",
    )
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    monkeypatch.setenv("HOGA_DATA_DIR", str(data_dir))
    # §4.4: suppress background auto-fetch so the status stays at "unavailable"
    # for the duration of this endpoint-format test. The auto-fetch behaviour
    # itself is covered by test_boot_autofetch_fires_when_cache_unavailable.
    async def _noop_refresh(**_kwargs):
        pass
    monkeypatch.setattr(symbols, "refresh", _noop_refresh)

    app = create_app(data_dir)
    with TestClient(app) as client:
        resp = client.get("/api/symbols/info")

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 0
    assert body["status"] == "unavailable"
    assert body["fetched_at_ms"] is None
    assert body["reason"] == "symbol_master_not_initialized"


# ---------------------------------------------------------------------------
# T4 §4.4 — boot auto-fetch on empty cache (background, non-blocking)
# ---------------------------------------------------------------------------


def test_boot_autofetch_fires_when_cache_unavailable(tmp_path, monkeypatch):
    """§4.4: when disk file is absent (status=unavailable), lifespan must
    schedule refresh() as a background task — not block startup on it."""
    from fastapi.testclient import TestClient
    from hoga.api.app import create_app
    from hoga.api import symbols

    symbols_module.reset_state_for_tests()

    # Point at a nonexistent disk file → load_disk_state leaves status=unavailable.
    monkeypatch.setattr(
        "hoga.api.app.resolve_symbol_master_path",
        lambda: tmp_path / "symbol-master.json",
    )
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    monkeypatch.setenv("HOGA_DATA_DIR", str(data_dir))

    # Patch refresh with a *sync* recorder that returns a real coroutine so the
    # flag is set when create_task() evaluates its argument — synchronously,
    # before TestClient.__enter__ returns — not when the task body runs.
    called = {"v": False, "path": None}
    async def _noop():
        return None
    def _record(**kwargs):
        called["v"] = True
        called["path"] = kwargs.get("path")
        return _noop()
    monkeypatch.setattr(symbols, "refresh", _record)

    app = create_app(data_dir)
    with TestClient(app):
        # Startup must complete (no blocking await on the task).
        assert called["v"], "refresh must be scheduled when cache is unavailable"


def test_boot_autofetch_skipped_when_cache_fresh(tmp_path, monkeypatch):
    """§4.4: when a valid disk file loads (status=fresh), refresh must NOT be
    scheduled — no redundant network call on a warm boot."""
    from fastapi.testclient import TestClient
    from hoga.api.app import create_app
    from hoga.api import symbols
    import json

    symbols_module.reset_state_for_tests()

    # Write a valid v2 disk file so load_disk_state sets status=fresh.
    sm_path = tmp_path / "symbol-master.json"
    sm_path.write_text(
        json.dumps({
            "schema_version": 2,
            "fetched_at_ms": 1747900000000,
            "source": "kis_mst",
            "entries": [{"code": "005930", "name": "삼성전자", "market": "KOSPI"}],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "hoga.api.app.resolve_symbol_master_path",
        lambda: sm_path,
    )
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    monkeypatch.setenv("HOGA_DATA_DIR", str(data_dir))

    called = {"v": False}
    async def _noop():
        return None
    def _record(**kwargs):
        called["v"] = True
        return _noop()
    monkeypatch.setattr(symbols, "refresh", _record)

    app = create_app(data_dir)
    with TestClient(app):
        assert not called["v"], "refresh must NOT be scheduled when cache is already fresh"


def test_current_status_reflects_state():
    """current_status() returns the current _state.status string."""
    from hoga.api.error_codes import UpstreamCode

    symbols_module.reset_state_for_tests()
    # After reset, state is unavailable.
    assert symbols_module.current_status() == "unavailable"

    # Manually drive state to fresh via _state attribute.
    symbols_module._state = symbols_module.SymbolCacheState.fresh()
    assert symbols_module.current_status() == "fresh"

    symbols_module._state = symbols_module.SymbolCacheState.stale(reason=UpstreamCode.KIS_MASTER_FETCH_FAILED)
    assert symbols_module.current_status() == "stale"

    symbols_module.reset_state_for_tests()  # restore


# ---------------------------------------------------------------------------
# Regression guards — refactor of _RefreshCoordinator + _do_refresh safety net
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_coalesce_cancels_detached_worker_when_awaiter_abandons() -> None:
    """#8: when the (sole) awaiter is cancelled, _RefreshCoordinator must cancel
    AND await the detached worker — not leak it to run on past its awaiters (e.g.
    touching a torn-down KIS client during shutdown). Before the fix the worker
    kept running after the joiner was cancelled."""
    coord: symbols_module._RefreshCoordinator[str] = symbols_module._RefreshCoordinator()
    started = asyncio.Event()
    was_cancelled = {"v": False}
    holder: dict[str, asyncio.Task[str]] = {}

    async def _work() -> str:
        started.set()
        try:
            await asyncio.sleep(30)
            return "done"
        except asyncio.CancelledError:
            was_cancelled["v"] = True
            raise

    def _factory() -> asyncio.Task[str]:
        t = asyncio.create_task(_work())
        holder["t"] = t
        return t

    joiner = asyncio.create_task(coord.coalesce(_factory))
    await started.wait()                      # worker is running
    joiner.cancel()
    with pytest.raises(asyncio.CancelledError):
        await joiner
    # The worker must be finished (cancelled), not orphaned and still running.
    assert holder["t"].done()
    assert was_cancelled["v"] is True


@pytest.mark.asyncio
async def test_refresh_disk_write_oserror_maps_to_warning_not_unexpected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    """B3 regression: an OSError from _write_to_disk (full volume, EACCES,
    detached container volume) must NOT fall through to the broad
    'Symbol refresh failed unexpectedly' ERROR-level stack trace — it's a
    routine operational class. Map to a WARNING with the actual cause and
    surface UpstreamCode.DISK_WRITE_FAILED so operators can distinguish
    "upstream down" from "couldn't write the response".
    """
    import logging
    symbols_module.reset_state_for_tests()

    async def _ok():
        return [_make_hit("005930", "삼성전자")]
    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _ok)

    def _raise_disk_full(*_args, **_kwargs):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(symbols_module, "_write_to_disk", _raise_disk_full)

    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    with caplog.at_level(logging.WARNING, logger=symbols_module.logger.name):
        resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.reason == UpstreamCode.DISK_WRITE_FAILED
    assert resp.status == "unavailable"
    # No ERROR-level "failed unexpectedly" stack trace.
    assert not any(
        r.levelno >= logging.ERROR and "unexpectedly" in r.getMessage()
        for r in caplog.records
    ), "disk OSError should not surface as 'failed unexpectedly'"
    # Warning includes the cause so operators can recognize disk issues.
    assert any(
        r.levelno == logging.WARNING and "disk write failed" in r.getMessage()
        for r in caplog.records
    ), f"expected a 'disk write failed' WARNING; got {[r.getMessage() for r in caplog.records]}"


@pytest.mark.asyncio
async def test_refresh_back_to_back_flights_isolate_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two sequential waves of concurrent refreshes must not contaminate each other.

    Regression guard for the universal-clear race in the old _RefreshCoordinator:
    a lingering wave-1 waiter could clobber wave-2's _inflight slot, causing
    duplicate fetches and/or deadlocked waiters. The new initiator-only-clears
    design plus result-broadcast through the future prevents both.
    """
    symbols_module.reset_state_for_tests()

    call_count = 0
    async def _fetch():
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.01)
        return [_make_hit(f"{call_count:06d}", f"name{call_count}")]

    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _fetch)
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    wave1 = await asyncio.gather(
        symbols_module.refresh(path=path, data_dir=data_dir),
        symbols_module.refresh(path=path, data_dir=data_dir),
        symbols_module.refresh(path=path, data_dir=data_dir),
    )
    assert call_count == 1, "wave 1 must trigger exactly one fetch"
    for r in wave1:
        assert r.status == "fresh"
        assert r.symbols[0].code == "000001"

    wave2 = await asyncio.gather(
        symbols_module.refresh(path=path, data_dir=data_dir),
        symbols_module.refresh(path=path, data_dir=data_dir),
        symbols_module.refresh(path=path, data_dir=data_dir),
    )
    assert call_count == 2, "wave 2 must trigger exactly one new fetch (no clobber, no duplicate)"
    for r in wave2:
        assert r.status == "fresh"
        assert r.symbols[0].code == "000002", "every wave-2 waiter must see the same snapshot"


@pytest.mark.asyncio
async def test_refresh_unhandled_exception_recovers_to_terminal_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ImportError or other unexpected exceptions must NOT leave _state at loading().

    Regression guard for the narrowed-except-clauses bug: pre-fix, an
    ImportError or OSError from _build_all_captured_breakdowns would escape
    _do_refresh and strand _state at loading() forever.
    """
    symbols_module.reset_state_for_tests()

    async def _explode():
        raise ImportError("kis_master broken")
    monkeypatch.setattr(symbols_module, "_fetch_symbol_master", _explode)

    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.status != "loading", "broad except must surface a terminal state"
    assert resp.status in ("stale", "unavailable")
    assert resp.reason == UpstreamCode.KIS_MASTER_FETCH_FAILED
    assert symbols_module._state.status != "loading", \
        "module _state must not be stranded at loading() — /info would otherwise lie"


@pytest.mark.asyncio
async def test_coordinator_recovers_when_task_factory_raises() -> None:
    """task_factory raising must roll back _inflight so future calls aren't deadlocked.

    Regression guard for the deadlock-after-factory-raise bug: pre-fix,
    `self._inflight = loop.create_future()` ran BEFORE `task_factory()`,
    so a raising factory left _inflight pointing at an unresolved Future
    with no callback. Every subsequent refresh() would await it forever.
    """
    from hoga.api.symbols import _RefreshCoordinator

    coord: _RefreshCoordinator[str] = _RefreshCoordinator()

    def _bad_factory() -> asyncio.Task[str]:
        raise RuntimeError("factory failed")

    with pytest.raises(RuntimeError, match="factory failed"):
        await coord.coalesce(_bad_factory)

    assert coord._inflight is None, "must roll back so the next call isn't deadlocked"

    async def _noop() -> str:
        return "ok"

    def _good_factory() -> asyncio.Task[str]:
        return asyncio.create_task(_noop())

    result = await coord.coalesce(_good_factory)
    assert result == "ok"


@pytest.mark.asyncio
async def test_coordinator_propagates_task_exception_to_all_waiters(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the in-flight task raises, every joined waiter must receive the exception.

    Today _do_refresh's broad except prevents this in practice, but the
    coordinator must remain correct for any task that does raise — otherwise
    waiters would hang on an unresolved future.
    """
    from hoga.api.symbols import _RefreshCoordinator

    coord: _RefreshCoordinator[str] = _RefreshCoordinator()
    started = asyncio.Event()
    release = asyncio.Event()

    async def _boom() -> str:
        started.set()
        await release.wait()
        raise ValueError("intentional")

    def _factory() -> asyncio.Task[str]:
        return asyncio.create_task(_boom())

    # Initiator + one joiner.
    t1 = asyncio.create_task(coord.coalesce(_factory))
    await started.wait()
    t2 = asyncio.create_task(coord.coalesce(_factory))
    await asyncio.sleep(0)  # let t2 attach as joiner
    release.set()

    with pytest.raises(ValueError, match="intentional"):
        await t1
    with pytest.raises(ValueError, match="intentional"):
        await t2

    assert coord._inflight is None, "initiator must still clear _inflight on task failure"
