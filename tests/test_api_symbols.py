"""hoga/api/symbols.py — pykrx cache + 3-tier policy + breakdown."""

from __future__ import annotations

import asyncio
import json

import pytest

from hoga.api import symbols


@pytest.fixture(autouse=True)
def _reset():
    symbols.reset_state_for_tests()
    yield
    symbols.reset_state_for_tests()


def _stub_pykrx(monkeypatch, kospi=None, kosdaq=None, *, raise_exc=None):
    """Patch pykrx fetch with an in-memory list (bypasses the DataFrame layer).

    Also sets KRX_ID/KRX_PW so the new krx_creds_present() pre-check passes
    (unless the test is explicitly testing the missing-credentials path).
    """
    kospi = kospi if kospi is not None else [("005930", "삼성전자")]
    kosdaq = kosdaq if kosdaq is not None else [("035720", "카카오")]
    monkeypatch.setenv("KRX_ID", "stub_id")
    monkeypatch.setenv("KRX_PW", "stub_pw")
    if raise_exc is not None:
        async def _raise():
            raise raise_exc
        monkeypatch.setattr(symbols, "_fetch_from_pykrx", _raise)
        return

    async def _fetch():
        return [
            symbols.SymbolHit(
                code=c,
                name=n,
                market="KOSPI",
                captured_count=0,
                captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
            )
            for c, n in kospi
        ] + [
            symbols.SymbolHit(
                code=c,
                name=n,
                market="KOSDAQ",
                captured_count=0,
                captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
            )
            for c, n in kosdaq
        ]

    monkeypatch.setattr(symbols, "_fetch_from_pykrx", _fetch)


@pytest.mark.asyncio
async def test_initial_status_is_loading_then_fresh(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch)
    path = tmp_path / "sm.json"
    resp = await symbols.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "fresh"
    assert len(resp.symbols) == 2
    assert resp.fetched_at_ms is not None


@pytest.mark.asyncio
async def test_concurrent_gets_dedupe_to_one_fetch(monkeypatch, tmp_path):
    """N concurrent refresh calls trigger exactly one underlying fetch."""
    monkeypatch.setenv("KRX_ID", "stub_id")
    monkeypatch.setenv("KRX_PW", "stub_pw")
    counter = {"n": 0}
    sem = asyncio.Event()

    async def _slow_fetch():
        counter["n"] += 1
        await sem.wait()
        return []

    monkeypatch.setattr(symbols, "_fetch_from_pykrx", _slow_fetch)
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
async def test_pykrx_failure_returns_unavailable_when_no_cache(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, raise_exc=RuntimeError("krx down"))
    path = tmp_path / "sm.json"
    resp = await symbols.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.symbols == []


def test_search_filters_by_name(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, kospi=[("005930", "삼성전자"), ("000660", "SK하이닉스")])
    path = tmp_path / "sm.json"
    asyncio.run(symbols.refresh(path=path, data_dir=tmp_path))
    hits = symbols.search("삼성", limit=5)
    assert [h.code for h in hits] == ["005930"]


def test_search_filters_by_code_prefix(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, kospi=[("005930", "삼성전자"), ("005935", "삼성전자우")])
    path = tmp_path / "sm.json"
    asyncio.run(symbols.refresh(path=path, data_dir=tmp_path))
    hits = symbols.search("00593", limit=5)
    assert sorted(h.code for h in hits) == ["005930", "005935"]


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

    breakdowns = symbols._build_all_captured_breakdowns(tmp_path)
    assert breakdowns["005930"] == {"complete": 1, "source_partial": 1, "client_incomplete": 1}


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
async def test_get_all_unavailable_when_creds_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    """No creds → pre-check sets reason; pykrx is NOT called."""
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    # Prevent load_env from loading real .env credentials during the test.
    monkeypatch.setattr(symbols_module, "load_env", lambda *, override: None)

    call_log: list[str] = []
    async def _spy() -> list:
        call_log.append("pykrx-called")
        return []
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _spy)

    path = tmp_path / "sm.json"
    resp = await symbols_module.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING
    assert call_log == [], "pykrx should not be called when creds are missing"


@pytest.mark.asyncio
async def test_get_all_empty_creds_treated_as_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    monkeypatch.setenv("KRX_ID", "")
    monkeypatch.setenv("KRX_PW", "")
    # Prevent load_env from overwriting empty env vars with real .env credentials.
    monkeypatch.setattr(symbols_module, "load_env", lambda *, override: None)

    async def _spy() -> list:
        return []
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _spy)

    path = tmp_path / "sm.json"
    resp = await symbols_module.refresh(path=path, data_dir=tmp_path)
    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING


@pytest.mark.asyncio
async def test_get_all_fetch_failed_when_creds_set_but_pykrx_raises(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    async def _raise() -> list:
        raise RuntimeError("pykrx exploded")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _raise)

    path = tmp_path / "sm.json"
    resp = await symbols_module.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.reason == UpstreamCode.KRX_FETCH_FAILED


@pytest.mark.asyncio
async def test_get_all_reason_cleared_on_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    from hoga.api.models import SymbolHit

    async def _ok() -> list[SymbolHit]:
        return [SymbolHit(code="005930", name="삼성전자", market="KOSPI",
                          captured_count=0,
                          captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0})]
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)

    path = tmp_path / "sm.json"
    resp = await symbols_module.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "fresh"
    assert resp.reason is None
    assert len(resp.symbols) == 1


@pytest.mark.asyncio
async def test_refresh_calls_load_env_with_override_true(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    """Calling refresh() invokes load_env(override=True) under the lock."""
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    calls: list[bool] = []
    def _spy(*, override: bool) -> None:
        calls.append(override)
        return None
    monkeypatch.setattr(symbols_module, "load_env", _spy)

    async def _ok() -> list:
        return []
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)

    path = tmp_path / "sm.json"
    await symbols_module.refresh(path=path, data_dir=tmp_path)
    assert calls == [True], "refresh should call load_env(override=True) exactly once"


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
        captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0},
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
        json.dumps({"schema_version": 1, "fetched_at_ms": 1}),
        encoding="utf-8",
    )
    assert symbols_module._load_from_disk(path) is None


def test_load_malformed_entry_returns_none(tmp_path):
    path = tmp_path / "bad-entry.json"
    path.write_text(
        json.dumps({
            "schema_version": 1,
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
    hit.captured_breakdown = {"complete": 99, "source_partial": 0, "client_incomplete": 0}
    symbols_module._write_to_disk(path, [hit], fetched_at_ms=1)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert "captured_count" not in payload["entries"][0]
    assert "captured_breakdown" not in payload["entries"][0]
    assert set(payload["entries"][0].keys()) == {"code", "name", "market"}


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
            "schema_version": 1,
            "fetched_at_ms": 1747900000000,
            "source": "pykrx",
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
        raise AssertionError("get_all() must not trigger pykrx fetch")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _boom)


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
            "schema_version": 1,
            "fetched_at_ms": 99,
            "source": "pykrx",
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
# T8 — refresh(*, path, data_dir): sole pykrx entry point, disk write, dedupe
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_happy_path(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    monkeypatch.setenv("KRX_ID", "x")
    monkeypatch.setenv("KRX_PW", "y")

    async def _fake_fetch():
        return [_make_hit("005930", "삼성전자")]

    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _fake_fetch)
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert path.exists(), "disk file must be written on success"
    assert len(resp.symbols) == 1
    assert resp.status == "fresh"
    assert resp.reason is None
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert len(payload["entries"]) == 1


@pytest.mark.asyncio
async def test_refresh_missing_creds(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    # Prevent load_env from loading real .env credentials during the test.
    monkeypatch.setattr(symbols_module, "load_env", lambda *, override: None)

    async def _must_not_call():
        raise AssertionError("pykrx must not be called when creds missing")

    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _must_not_call)
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING
    assert resp.status == "unavailable"
    assert not path.exists(), "no disk write when creds missing"


@pytest.mark.asyncio
async def test_refresh_pykrx_failure_preserves_disk(tmp_path, monkeypatch):
    symbols_module.reset_state_for_tests()
    monkeypatch.setenv("KRX_ID", "x")
    monkeypatch.setenv("KRX_PW", "y")
    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    async def _ok():
        return [_make_hit("005930", "삼성전자")]
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)
    await symbols_module.refresh(path=path, data_dir=data_dir)
    original_content = path.read_text(encoding="utf-8")

    async def _boom():
        raise RuntimeError("KRX down")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _boom)
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.reason == UpstreamCode.KRX_FETCH_FAILED
    assert resp.status == "stale", "cache populated → state is stale, not unavailable"
    assert path.read_text(encoding="utf-8") == original_content


@pytest.mark.asyncio
async def test_refresh_concurrent_dedupe(tmp_path, monkeypatch):
    """Two simultaneous refresh calls collapse to one pykrx fetch."""
    import asyncio as _asyncio

    symbols_module.reset_state_for_tests()
    monkeypatch.setenv("KRX_ID", "x")
    monkeypatch.setenv("KRX_PW", "y")
    call_count = 0

    async def _slow():
        nonlocal call_count
        call_count += 1
        await _asyncio.sleep(0.05)
        return [_make_hit("005930", "삼성전자")]

    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _slow)
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

    app = create_app(data_dir)
    with TestClient(app) as client:
        resp = client.get("/api/symbols/info")

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 0
    assert body["status"] == "unavailable"
    assert body["fetched_at_ms"] is None
    assert body["reason"] == "symbol_master_not_initialized"
