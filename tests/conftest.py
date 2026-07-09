from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


@pytest.fixture(autouse=True)
def _reset_queue_ownership() -> None:
    """ADR-0094: restore the owned-by-default state before each test.

    The app lifespan teardown calls ``release_queue_ownership()`` which sets
    ``_queue_owned = False`` (the lock is gone). Tests that exercise
    ``_finalize_item``/``_persist_queue_locked`` by writing ``_data_dir``
    directly — without calling ``reset_state_for_tests()`` — would then see a
    leaked False and silently no-op their persistence. Resetting to the owned
    default here closes that cross-test leak; ownership tests set the state
    they need inside the test body, after this fixture runs.
    """
    from hoga.api import captures

    captures._queue_owned = True


@pytest.fixture(autouse=True)
def _no_real_mst_downloads(monkeypatch: pytest.MonkeyPatch) -> None:
    """Suite-wide network guard for the Symbol Master boot auto-refresh.

    app.py's lifespan schedules a REAL .mst download whenever
    symbols.needs_boot_refresh() is true — which it is for every
    TestClient(create_app(...)) on a machine/CI without the machine-global
    symbol-master.json (resolve_symbol_master_path deliberately ignores
    HOGA_DATA_DIR, so tmp_path can't sandbox it). Without this guard, dozens
    of lifespan-running tests each fired two HTTPS downloads, could overwrite
    the developer's real symbol-master.json, and hung teardown up to 60s on
    the non-cancellable urllib thread.

    Failing fast at download_master keeps the whole refresh path (status
    transitions, error mapping) intact; tests that exercise refresh success
    stub higher-level seams (symbols.refresh / _fetch_symbol_master) and are
    unaffected.
    """
    from hoga.api import kis_master

    def _blocked(market: str) -> bytes:
        raise kis_master.KisMasterFetchError(
            f"{market} .mst download blocked in tests (autouse guard)"
        )

    monkeypatch.setattr(kis_master, "download_master", _blocked)


@pytest.fixture(autouse=True)
def _no_env_reload_on_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep creds isolation honest: the user-retry path (kis_holidays →
    kis_runtime, reload_env=True) re-reads the repo's REAL .env on a creds
    miss. In tests that would silently restore KIS_APP_KEY/SECRET that a test
    delenv'ed — and background paths (poller gate) reach it too. No-op the
    dedicated hook; tests exercising the reload behavior re-patch it."""
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "_reload_env_for_retry", lambda: None)


@pytest.fixture(autouse=True)
def _fresh_today_ttl(monkeypatch):
    """ADR-0090 TodayTtlCache 테스트 간 격리 — 전역 인스턴스를 매 테스트 교체."""
    import hoga.api.bundle as bundle_mod
    from hoga.api.today_ttl_cache import TodayTtlCache

    fresh = TodayTtlCache()
    monkeypatch.setattr("hoga.api.today_ttl_cache.TODAY_TTL", fresh)
    # bundle이 `from ... import TODAY_TTL`로 바인딩하므로 그 참조도 갈아끼운다.
    if hasattr(bundle_mod, "TODAY_TTL"):
        monkeypatch.setattr(bundle_mod, "TODAY_TTL", fresh)


@pytest.fixture
def tmp_data_dir(tmp_path: Path) -> Path:
    """A fresh per-test data directory."""
    d = tmp_path / "data"
    d.mkdir()
    return d


@pytest.fixture(scope="module")
def app_client(tmp_path_factory: pytest.TempPathFactory) -> TestClient:
    """Module-scoped TestClient backed by the tiny_tsv fixture for 003490/20260519.

    Module scope amortises the parse_stock_date cost across the file. The test
    suite is read-only (HTTP GETs against pre-parsed parquet); no test mutates
    the data dir, so sharing the app + parsed parquet across the file is safe.
    """
    tmp_path = tmp_path_factory.mktemp("api")
    raw = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw / name)
    parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    app = create_app(data_dir=tmp_path / "data")
    return TestClient(app)
