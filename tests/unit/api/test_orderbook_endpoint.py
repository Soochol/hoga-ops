"""Tests for OrderbookResponse model and /api/orderbook endpoint
(source_pref thread-through per ADR-0044 / ADR-0039)."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.models import OrderbookResponse


def test_orderbook_response_has_source_field() -> None:
    resp = OrderbookResponse(available_from=None, snapshot=None, source="hogaplay")
    assert resp.source == "hogaplay"
    # Type narrowed to SourceName Literal — wrong values rejected by Pydantic
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        OrderbookResponse(available_from=None, snapshot=None, source="invalid")  # type: ignore[arg-type]


def test_orderbook_source_pref_prefers_kis_live(seed_orderbook):
    # seed_orderbook: project fixture that writes snapshots.parquet under
    # both data/parquet/{date}/{code}/hogaplay/ and .../kis_live/
    client = seed_orderbook(date="20260528", code="005930", with_kis_live=True)
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260528", "t": 1779930000000, "source_pref": "kis_live"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "kis_live"


def test_orderbook_source_pref_falls_back_to_hogaplay(seed_orderbook):
    # Only hogaplay seeded — kis_live missing.
    client = seed_orderbook(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260528", "t": 1779930000000, "source_pref": "kis_live"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"  # fallback (ADR-0039)


def test_orderbook_source_pref_default_is_hogaplay(seed_orderbook):
    client = seed_orderbook(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260528", "t": 1779930000000,
        # no source_pref → default "hogaplay"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_orderbook_source_pref_invalid_returns_422(seed_orderbook):
    client = seed_orderbook(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260528", "t": 1779930000000, "source_pref": "garbage"
    })
    assert r.status_code == 422


def test_orderbook_returns_empty_response_when_source_dir_missing(
    tmp_path: Path,
) -> None:
    """ADR-0044 graceful-empty: hover on a candle whose source parquet dir was
    never captured returns 200 + null snapshot, not 404. Previously the
    handler 404'd, which the frontend's useSpot catch surfaced as console
    noise on every hover (no spot data UI, just log spam). Mirrors the
    empty-bundle semantics /api/range adopted for the same reason.
    """
    client = TestClient(create_app(data_dir=tmp_path / "data"))
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260319", "t": 1779930000000,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["snapshot"] is None
    assert body["available_from"] is None
    assert body["source"] == "hogaplay"


def test_orderbook_returns_empty_response_when_source_dir_missing_kis_live_pref(
    tmp_path: Path,
) -> None:
    """Source preference echoed back even when no data exists — chip should
    show the preferred source so the user understands the empty state isn't
    a fallback. resolve_source returns the pref unchanged when no source
    dir exists on disk (per sources.py:46)."""
    client = TestClient(create_app(data_dir=tmp_path / "data"))
    r = client.get("/api/orderbook", params={
        "code": "005930", "date": "20260319", "t": 1779930000000,
        "source_pref": "kis_live",
    })
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "kis_live"
