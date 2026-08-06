"""Tests for BrokerSeriesResponse model and /api/brokers/series endpoint
(source_pref thread-through per ADR-0044 / ADR-0039)."""
from __future__ import annotations

import pytest

from hoga.api.models import BrokerSeriesResponse


def test_brokers_response_has_source_field() -> None:
    resp = BrokerSeriesResponse(date="20260528", brokers=[], source="hogaplay")
    assert resp.source == "hogaplay"
    assert BrokerSeriesResponse(date="20260528", brokers=[], source="kis_api").source == "kis_api"
    # Type narrowed to SourceName Literal — wrong values rejected by Pydantic
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        BrokerSeriesResponse(date="20260528", brokers=[], source="invalid")  # type: ignore[arg-type]


def test_brokers_source_pref_prefers_kiwoom_live(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kiwoom_live=True)
    r = client.get("/api/brokers/series", params={"venue": "KRX", 
        "code": "005930", "date": "20260528", "source_pref": "kiwoom_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "kiwoom_live"


def test_brokers_source_pref_falls_back_to_hogaplay(seed_brokers):
    # Only hogaplay seeded — kiwoom_live missing.
    client = seed_brokers(date="20260528", code="005930", with_kiwoom_live=False)
    r = client.get("/api/brokers/series", params={"venue": "KRX", 
        "code": "005930", "date": "20260528", "source_pref": "kiwoom_live",
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"  # fallback (ADR-0039)


def test_brokers_source_pref_default_is_hogaplay(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kiwoom_live=False)
    r = client.get("/api/brokers/series", params={"venue": "KRX", 
        "code": "005930", "date": "20260528",
        # no source_pref → default "hogaplay"
    })
    assert r.status_code == 200
    assert r.json()["source"] == "hogaplay"


def test_brokers_unknown_source_pref_is_accepted(seed_brokers):
    client = seed_brokers(date="20260528", code="005930", with_kiwoom_live=False)
    r = client.get("/api/brokers/series", params={"venue": "KRX", 
        "code": "005930", "date": "20260528", "source_pref": "garbage",
    })
    # 소스 선호 옵션 폐지(2026-08-07) — 정책 문자열은 무시된다. 구 URL·저장된
    # 설정이 도착해도 422 로 화면을 깨지 않고 단일 사다리로 조용히 수렴한다.
    assert r.status_code == 200
