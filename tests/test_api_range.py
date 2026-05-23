"""Route tests for GET /api/range (ADR-0013)."""
from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient


def _build_range_bundle_stub(*, code, from_date, to_date, bucket_ms):
    """Return a minimal valid RangeBundle for happy-path tests."""
    from hoga.api.models import (
        FillStrength,
        QuoteRatio,
        RangeBundle,
        RangeSegment,
        VolumeProfile,
    )

    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        segments=[
            RangeSegment(date=from_date, session_open_ms=1, session_close_ms=2),
        ],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=[]),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=[]),
        volume_profile_range=VolumeProfile(
            bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[],
        ),
        volume_profile_by_day=[
            VolumeProfile(
                bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[],
            ),
        ],
    )


def test_api_range_happy_path(app_client: TestClient) -> None:
    with patch(
        "hoga.api.routes.build_range_bundle",
        side_effect=lambda engine, **kw: _build_range_bundle_stub(**kw),
    ):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000"
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == "005930"
    assert body["bucket_ms"] == 60_000
    assert len(body["segments"]) == 1
    assert "candles" in body
    assert "volume_profile_range" in body
    assert "volume_profile_by_day" in body


def test_api_range_400_on_invalid_bucket_ms(app_client: TestClient) -> None:
    # validate_bucket_ms raises ValueError → 400 BEFORE calling build_range_bundle.
    r = app_client.get(
        "/api/range?code=005930&from=20260512&to=20260512&bucket_ms=42000"
    )
    assert r.status_code == 400


def test_api_range_400_on_from_gt_to(app_client: TestClient) -> None:
    # build_range_bundle raises HTTPException(400) for from > to.
    r = app_client.get(
        "/api/range?code=005930&from=20260520&to=20260512&bucket_ms=60000"
    )
    assert r.status_code == 400


def test_api_range_400_on_range_over_30_days(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/range?code=005930&from=20260101&to=20260201&bucket_ms=60000"
    )
    assert r.status_code == 400


def test_api_range_404_on_empty_inventory(app_client: TestClient) -> None:
    # Patch engine inventory lookup to return empty → build_range_bundle raises 404.
    with patch(
        "hoga.api.queries.QueryEngine.list_stock_dates_in_range",
        return_value=[],
    ):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000"
        )
    assert r.status_code == 404
