"""Shared fixtures for tests/unit/api endpoint tests.

Follows the same pattern as tests/unit/api/test_bundle_source_aware.py
(_write_meta, _write_snapshots, _snap helpers).
"""
from __future__ import annotations

import json
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app


# ---------------------------------------------------------------------------
# Helpers (mirrors test_bundle_source_aware.py)
# ---------------------------------------------------------------------------

def _write_meta(path: Path, **kwargs) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    default = {
        "source": "hogaplay",
        "code": "005930",
        "date": "20260528",
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
        "collection_complete": True,
        "is_partial": False,
    }
    default.update(kwargs)
    path.write_text(json.dumps(default, indent=2))


def _snap(t_hhmmssms: int) -> dict:
    """Build a snapshot row matching snapshots.parquet schema."""
    base: dict = {"ts_ms": t_hhmmssms, "seq": 0}
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, 11):
            base[f"{prefix}{i}"] = 0
    base["bid_q1"] = 100
    base["ask_q1"] = 100
    base.update({"tot_ask": 100, "tot_ask_d": 0, "tot_bid": 100, "tot_bid_d": 0})
    return base


def _write_snapshots(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


# ---------------------------------------------------------------------------
# seed_orderbook fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def seed_orderbook(tmp_path: Path):
    """Factory fixture: returns a callable (date, code, *, with_kis_live) -> TestClient.

    Seeds a minimal hogaplay (and optionally kis_live) source dir under
    tmp_path/data/parquet/{date}/{code}/{source}/ so that the /api/orderbook
    route can resolve the source and read snapshots.parquet without a 404.
    """
    def _factory(
        date: str,
        code: str,
        *,
        with_kis_live: bool,
    ) -> TestClient:
        # HHMMSSmmm encoding: 100000000 = 10:00:00.000 KST
        row = _snap(100000000)

        # Seed hogaplay
        hp_dir = tmp_path / "data" / "parquet" / date / code / "hogaplay"
        _write_meta(hp_dir / "meta.json", source="hogaplay", code=code, date=date)
        _write_snapshots(hp_dir / "snapshots.parquet", [row])

        if with_kis_live:
            kl_dir = tmp_path / "data" / "parquet" / date / code / "kis_live"
            _write_meta(kl_dir / "meta.json", source="kis_live", code=code, date=date)
            _write_snapshots(kl_dir / "snapshots.parquet", [row])

        app = create_app(data_dir=tmp_path / "data")
        return TestClient(app)

    return _factory
