from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


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
