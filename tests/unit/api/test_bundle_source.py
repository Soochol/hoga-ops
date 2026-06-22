"""Stage 6B — build_range_bundle source_pref + fallback (ADR-0039)."""
import json
from pathlib import Path

import pytest

# We don't import build_range_bundle yet — we test the signature exists.


def test_resolve_source_prefers_explicit(tmp_path: Path) -> None:
    """Verify the _resolve_source helper returns the preferred source when present."""
    from hoga.api.bundle import _resolve_source
    from hoga.api.queries import QueryEngine

    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    (sd_dir / "hogaplay").mkdir(parents=True)
    (sd_dir / "hogaplay" / "meta.json").write_text(json.dumps({
        "collection_complete": True, "is_partial": False,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
    }))
    (sd_dir / "kis_live").mkdir()
    (sd_dir / "kis_live" / "meta.json").write_text(json.dumps({
        "source": "kis_live",
    }))

    engine = QueryEngine(tmp_path)
    try:
        assert _resolve_source(engine, "20260527", "005930", "hogaplay") == "hogaplay"
        assert _resolve_source(engine, "20260527", "005930", "kis_live") == "kis_live"
    finally:
        engine.close()


def test_resolve_source_fallback(tmp_path: Path) -> None:
    """When preferred source is absent, fall back to any other available."""
    from hoga.api.bundle import _resolve_source
    from hoga.api.queries import QueryEngine

    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    (sd_dir / "kis_live").mkdir(parents=True)
    (sd_dir / "kis_live" / "meta.json").write_text(json.dumps({"source": "kis_live"}))

    engine = QueryEngine(tmp_path)
    try:
        # Prefer hogaplay but it's not present → fallback to kis_live
        assert _resolve_source(engine, "20260527", "005930", "hogaplay") == "kis_live"
    finally:
        engine.close()


def test_resolve_source_prefers_kis_api_when_policy_requests_it(tmp_path: Path) -> None:
    from hoga.api.bundle import _resolve_source
    from hoga.api.queries import QueryEngine

    sd_dir = tmp_path / "parquet" / "20260622" / "005930"
    for source in ("hogaplay", "kis_live", "kis_api"):
        (sd_dir / source).mkdir(parents=True, exist_ok=True)
        (sd_dir / source / "meta.json").write_text(json.dumps({
            "collection_complete": True,
            "is_partial": False,
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
        }))

    engine = QueryEngine(tmp_path)
    try:
        assert _resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"
    finally:
        engine.close()


def test_list_stock_dates_in_range_finds_any_source(tmp_path: Path) -> None:
    """list_stock_dates_in_range matches any source for backward compat."""
    from hoga.api.queries import QueryEngine

    # hogaplay layout
    (tmp_path / "parquet" / "20260520" / "005930" / "hogaplay").mkdir(parents=True)
    (tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": False,
                    "regular_session_open_ms": 90000000,
                    "regular_session_close_ms": 153000000})
    )
    # kis_live layout
    (tmp_path / "parquet" / "20260521" / "005930" / "kis_live").mkdir(parents=True)
    (tmp_path / "parquet" / "20260521" / "005930" / "kis_live" / "meta.json").write_text(
        json.dumps({"source": "kis_live"})
    )

    engine = QueryEngine(tmp_path)
    try:
        dates = engine.list_stock_dates_in_range(
            code="005930", from_date="20260101", to_date="20261231",
        )
        assert dates == ["20260520", "20260521"]
    finally:
        engine.close()
