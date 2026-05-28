"""Tests for TradesResponse model and /api/trades endpoint
(source_pref thread-through per ADR-0044 / ADR-0039)."""
from __future__ import annotations

import pytest
from hoga.api.models import TradesResponse
from hoga.api.sources import SourceName


def test_trades_response_has_source_field() -> None:
    resp = TradesResponse(trades=[], source="hogaplay")
    assert resp.source == "hogaplay"
    # Type narrowed to SourceName Literal — wrong values rejected by Pydantic
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        TradesResponse(trades=[], source="invalid")  # type: ignore[arg-type]


def test_trades_source_pref_prefers_kis_live(seed_trades):
    client = seed_trades(date="20260528", code="005930", with_kis_live=True)
    r = client.get("/api/trades", params={
        "code": "005930", "date": "20260528", "t": 1779930000000, "limit": 20,
        "source_pref": "kis_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "kis_live"


def test_trades_source_pref_falls_back_to_hogaplay(seed_trades):
    # Only hogaplay seeded — kis_live missing.
    client = seed_trades(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/trades", params={
        "code": "005930", "date": "20260528", "t": 1779930000000, "limit": 20,
        "source_pref": "kis_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"  # fallback (ADR-0039)


def test_trades_source_pref_default_is_hogaplay(seed_trades):
    client = seed_trades(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/trades", params={
        "code": "005930", "date": "20260528", "t": 1779930000000, "limit": 20,
        # no source_pref → default "hogaplay"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_trades_source_pref_invalid_returns_422(seed_trades):
    client = seed_trades(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/trades", params={
        "code": "005930", "date": "20260528", "t": 1779930000000, "limit": 20,
        "source_pref": "garbage",
    })
    assert r.status_code == 422
