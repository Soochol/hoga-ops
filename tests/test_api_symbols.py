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
    """Patch pykrx fetch with an in-memory list (bypasses the DataFrame layer)."""
    kospi = kospi if kospi is not None else [("005930", "삼성전자")]
    kosdaq = kosdaq if kosdaq is not None else [("035720", "카카오")]
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

    breakdown = symbols._count_captured_states(tmp_path, "005930")
    assert breakdown == {"complete": 1, "source_partial": 1, "client_incomplete": 1}
