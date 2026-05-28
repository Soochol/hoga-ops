"""Tests for OrderbookResponse model and /api/orderbook endpoint
(source_pref thread-through per ADR-0044 / ADR-0039)."""
from __future__ import annotations

import pytest
from hoga.api.models import OrderbookResponse
from hoga.api.sources import SourceName


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
