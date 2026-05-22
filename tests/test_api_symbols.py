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
    resp = await symbols.get_all(data_dir=tmp_path)
    assert resp.status == "fresh"
    assert len(resp.symbols) == 2
    assert resp.fetched_at_ms is not None


@pytest.mark.asyncio
async def test_concurrent_gets_dedupe_to_one_fetch(monkeypatch, tmp_path):
    """N concurrent GETs trigger exactly one underlying fetch."""
    monkeypatch.setenv("KRX_ID", "stub_id")
    monkeypatch.setenv("KRX_PW", "stub_pw")
    counter = {"n": 0}
    sem = asyncio.Event()

    async def _slow_fetch():
        counter["n"] += 1
        await sem.wait()
        return []

    monkeypatch.setattr(symbols, "_fetch_from_pykrx", _slow_fetch)

    t1 = asyncio.create_task(symbols.get_all(data_dir=tmp_path))
    t2 = asyncio.create_task(symbols.get_all(data_dir=tmp_path))
    t3 = asyncio.create_task(symbols.get_all(data_dir=tmp_path))
    await asyncio.sleep(0.05)
    assert counter["n"] == 1
    sem.set()
    await asyncio.gather(t1, t2, t3)
    assert counter["n"] == 1


@pytest.mark.asyncio
async def test_pykrx_failure_returns_unavailable_when_no_cache(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, raise_exc=RuntimeError("krx down"))
    resp = await symbols.get_all(data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.symbols == []


@pytest.mark.asyncio
async def test_pykrx_failure_returns_stale_with_prior_cache(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch)
    first = await symbols.get_all(data_dir=tmp_path)
    assert first.status == "fresh"
    # Now simulate a fetch failure on refresh.
    _stub_pykrx(monkeypatch, raise_exc=RuntimeError("krx down"))
    symbols.invalidate_cache_for_tests()  # mark stale
    second = await symbols.get_all(data_dir=tmp_path)
    assert second.status == "stale"
    assert len(second.symbols) == 2


def test_search_filters_by_name(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, kospi=[("005930", "삼성전자"), ("000660", "SK하이닉스")])
    asyncio.run(symbols.get_all(data_dir=tmp_path))
    hits = symbols.search("삼성", limit=5)
    assert [h.code for h in hits] == ["005930"]


def test_search_filters_by_code_prefix(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, kospi=[("005930", "삼성전자"), ("005935", "삼성전자우")])
    asyncio.run(symbols.get_all(data_dir=tmp_path))
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

    call_log: list[str] = []
    async def _spy() -> list:
        call_log.append("pykrx-called")
        return []
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _spy)

    resp = await symbols_module.get_all(data_dir=tmp_path)
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

    async def _spy() -> list:
        return []
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _spy)

    resp = await symbols_module.get_all(data_dir=tmp_path)
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

    resp = await symbols_module.get_all(data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.reason == UpstreamCode.KRX_FETCH_FAILED


@pytest.mark.asyncio
async def test_get_all_stale_path_carries_reason(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_symbols_state: None,
) -> None:
    """Spec §5.3 2-axis matrix — status='stale' + reason='krx_fetch_failed'.

    Scenario: a prior successful fetch warmed the cache. A subsequent refresh
    fails. The endpoint should serve the stale cache AND surface reason.
    """
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    from hoga.api.models import SymbolHit

    # First call: succeed, prime the cache.
    async def _ok() -> list[SymbolHit]:
        return [SymbolHit(code="005930", name="삼성전자", market="KOSPI",
                          captured_count=0,
                          captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0})]
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _ok)
    resp1 = await symbols_module.get_all(data_dir=tmp_path)
    assert resp1.status == "fresh"
    assert len(resp1.symbols) == 1

    # Force cache to look stale, then make pykrx fail.
    symbols_module.invalidate_cache_for_tests()
    async def _raise() -> list[SymbolHit]:
        raise RuntimeError("pykrx exploded mid-session")
    monkeypatch.setattr(symbols_module, "_fetch_from_pykrx", _raise)

    resp2 = await symbols_module.get_all(data_dir=tmp_path)
    assert resp2.status == "stale", "cache exists → status should downgrade to stale, not unavailable"
    assert resp2.reason == UpstreamCode.KRX_FETCH_FAILED
    assert len(resp2.symbols) == 1, "stale cache should still be served"


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

    resp = await symbols_module.get_all(data_dir=tmp_path)
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

    await symbols_module.refresh(data_dir=tmp_path)
    assert calls == [True], "refresh should call load_env(override=True) exactly once"


def test_reset_state_for_tests_clears_reason() -> None:
    """Reset returns the state to loading()."""
    symbols_module._state = SymbolCacheState.stale(reason=UpstreamCode.KRX_FETCH_FAILED)
    symbols_module.reset_state_for_tests()
    assert symbols_module._state.reason is None
    assert symbols_module._state.status == "loading"


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
