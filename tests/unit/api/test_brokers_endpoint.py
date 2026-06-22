"""Tests for BrokerSeriesResponse model and /api/brokers/series endpoint
(source_pref thread-through per ADR-0044 / ADR-0039)."""
from __future__ import annotations

import pytest
from hoga.api.models import BrokerSeriesResponse
from hoga.api.sources import SourceName


def test_brokers_response_has_source_field() -> None:
    resp = BrokerSeriesResponse(date="20260528", brokers=[], source="hogaplay")
    assert resp.source == "hogaplay"
    assert BrokerSeriesResponse(date="20260528", brokers=[], source="kis_api").source == "kis_api"
    # Type narrowed to SourceName Literal — wrong values rejected by Pydantic
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        BrokerSeriesResponse(date="20260528", brokers=[], source="invalid")  # type: ignore[arg-type]


def test_brokers_source_pref_prefers_kis_live(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kis_live=True)
    r = client.get("/api/brokers/series", params={
        "code": "005930", "date": "20260528", "source_pref": "kis_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "kis_live"


def test_brokers_source_pref_falls_back_to_hogaplay(seed_brokers):
    # Only hogaplay seeded — kis_live missing.
    client = seed_brokers(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/brokers/series", params={
        "code": "005930", "date": "20260528", "source_pref": "kis_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"  # fallback (ADR-0039)


def test_brokers_source_pref_default_is_hogaplay(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/brokers/series", params={
        "code": "005930", "date": "20260528",
        # no source_pref → default "hogaplay"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_brokers_source_pref_invalid_returns_422(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kis_live=False)
    r = client.get("/api/brokers/series", params={
        "code": "005930", "date": "20260528", "source_pref": "garbage",
    })
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_source_pref"
