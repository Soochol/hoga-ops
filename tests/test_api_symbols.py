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
    _stub_pykrx(monkeypatch, raise_exc=symbols.KrxFetchFailed("krx down"))
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
async def test_get_all_unavailable_when_creds_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    """_fetch_from_pykrx raising KrxCredentialsMissing surfaces as the matching reason."""
    async def _raise_missing() -> list:
        raise symbols_module.KrxCredentialsMissing()
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _raise_missing)

    path = tmp_path / "sm.json"
    resp = await symbols_module.refresh(path=path, data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING


@pytest.mark.asyncio
async def test_get_all_fetch_failed_when_creds_set_but_pykrx_raises(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    async def _raise() -> list:
        raise symbols_module.KrxFetchFailed("pykrx exploded")
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


def test_ensure_krx_credentials_calls_load_env_override_true(
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    """_ensure_krx_credentials hot-reloads .env (override wins over shell env)."""
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    calls: list[bool] = []
    def _spy(*, override: bool) -> None:
        calls.append(override)
        return None
    monkeypatch.setattr(symbols_module, "load_env", _spy)

    symbols_module._ensure_krx_credentials()
    assert calls == [True]


def test_ensure_krx_credentials_raises_when_missing(
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    """Missing KRX_ID/KRX_PW → KrxCredentialsMissing before any pykrx call."""
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    monkeypatch.setattr(symbols_module, "load_env", lambda *, override: None)

    with pytest.raises(symbols_module.KrxCredentialsMissing):
        symbols_module._ensure_krx_credentials()


def test_ensure_krx_credentials_empty_strings_treated_as_missing(
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    """Empty-string KRX_ID/KRX_PW are treated as missing (not as valid creds)."""
    monkeypatch.setenv("KRX_ID", "")
    monkeypatch.setenv("KRX_PW", "")
    monkeypatch.setattr(symbols_module, "load_env", lambda *, override: None)

    with pytest.raises(symbols_module.KrxCredentialsMissing):
        symbols_module._ensure_krx_credentials()


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
    """KrxCredentialsMissing → reason + no disk write."""
    symbols_module.reset_state_for_tests()

    async def _raise_missing():
        raise symbols_module.KrxCredentialsMissing()

    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _raise_missing)
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
        raise symbols_module.KrxFetchFailed("KRX down")
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
async def test_refresh_invokes_ensure_credentials_in_production_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end: refresh() must call load_env(override=True) via _ensure_krx_credentials.

    Uses the missing-creds short-circuit so we don't have to mock pykrx. The
    refresh-level tests elsewhere all stub _fetch_from_pykrx, which would
    silently pass even if a future change removed the _ensure_krx_credentials()
    call from the real implementation. This test catches that.
    """
    symbols_module.reset_state_for_tests()
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    calls: list[bool] = []
    def _spy_load_env(*, override: bool) -> None:
        calls.append(override)
    monkeypatch.setattr(symbols_module, "load_env", _spy_load_env)

    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert calls == [True], "refresh() must call load_env(override=True) via the real fetch path"
    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING


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
    monkeypatch.setenv("KRX_ID", "x")
    monkeypatch.setenv("KRX_PW", "y")

    async def _ok():
        return [_make_hit("005930", "삼성전자")]
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)

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
async def test_refresh_skips_loading_state_when_creds_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """B4 regression: a missing-creds refresh must NOT flip _state to loading()
    on its way to stale/unavailable. The previous flow set loading() inside
    the coordinator's task factory before the credentials check ran, so a
    concurrent GET /api/symbols/all could briefly observe status='loading'
    and flash a spinner before the refresh task's typed handler reset it.

    Spy SymbolCacheState.loading: if it's called during refresh(), the
    transient flash is back.
    """
    symbols_module.reset_state_for_tests()
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    monkeypatch.setattr(symbols_module, "load_env", lambda *, override: None)

    loading_calls = []
    original_loading = symbols_module.SymbolCacheState.loading

    def _spy_loading():
        loading_calls.append(True)
        return original_loading()

    monkeypatch.setattr(symbols_module.SymbolCacheState, "loading", _spy_loading)

    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING
    assert loading_calls == [], (
        "refresh() must short-circuit before flipping _state to loading() "
        "when credentials are missing — otherwise a concurrent GET observes a "
        "transient 'loading' status"
    )


@pytest.mark.asyncio
async def test_refresh_short_circuits_before_pykrx_import_when_creds_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The credentials pre-check must run BEFORE the pykrx import in _fetch_from_pykrx.

    Replaces sys.modules['pykrx.stock'] with a sentinel that raises on any
    attribute access; missing-creds short-circuit must prevent any access.
    """
    import sys
    symbols_module.reset_state_for_tests()
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    monkeypatch.setattr(symbols_module, "load_env", lambda *, override: None)

    class _ForbiddenStock:
        def __getattr__(self, name):
            raise AssertionError(f"pykrx.stock.{name} accessed despite missing creds")

    fake_pykrx = type(sys)("pykrx")
    fake_pykrx.stock = _ForbiddenStock()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pykrx", fake_pykrx)
    monkeypatch.setitem(sys.modules, "pykrx.stock", _ForbiddenStock())

    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING


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
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    call_count = 0
    async def _fetch():
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.01)
        return [_make_hit(f"{call_count:06d}", f"name{call_count}")]

    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _fetch)
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
    ImportError from a broken pykrx (or OSError from _build_all_captured_breakdowns)
    would escape _do_refresh and strand _state at loading() forever.
    """
    symbols_module.reset_state_for_tests()

    async def _explode():
        raise ImportError("pykrx broken")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _explode)

    path = tmp_path / "sm.json"
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    resp = await symbols_module.refresh(path=path, data_dir=data_dir)

    assert resp.status != "loading", "broad except must surface a terminal state"
    assert resp.status in ("stale", "unavailable")
    assert resp.reason == UpstreamCode.KRX_FETCH_FAILED
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
