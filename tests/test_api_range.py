"""Route tests for GET /api/range (ADR-0013)."""
from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient


def _build_range_bundle_stub(*, code, from_date, to_date, bucket_ms, source_pref="hogaplay"):
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


def test_api_range_empty_inventory_returns_empty_bundle(app_client: TestClient) -> None:
    # Spec 2026-05-27 §4.3: empty range returns 200 + empty bundle so /live's
    # lazy-fetch doesn't have to special-case 404 handling. Today's data is
    # fetched separately via SSE.
    with patch(
        "hoga.api.queries.QueryEngine.list_stock_dates_in_range",
        return_value=[],
    ):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000"
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["segments"] == []
    assert body["candles"] == []
    assert body["quote_ratio"]["points"] == []
    assert body["fill_strength"]["points"] == []
    assert body["excluded_dates"] == []
    assert body["code"] == "005930"
    assert body["from_date"] == "20260512"
    assert body["to_date"] == "20260512"
    assert body["bucket_ms"] == 60000


# --- ADR-0020: invariant outcomes surfaced on the wire ---


def _meta(*, open_ms=90_000_000, close_ms=153_000_000,
          complete=True, partial=False, pages=100, events=80) -> dict:
    return {
        "regular_session_open_ms": open_ms,
        "regular_session_close_ms": close_ms,
        "collection_complete": complete,
        "is_partial": partial,
        "pages_collected": pages,
        "total_unique_events": events,
    }


def _stub_slice_builders():
    """Patch every per-Stock-Date builder so the route doesn't touch parquet."""
    from hoga.api.models import FillStrength, QuoteRatio, VolumeProfile
    qr = QuoteRatio(bucket_ms=60_000, points=[])
    fs = FillStrength(bucket_ms=60_000, points=[])
    vp = VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[])
    return [
        patch("hoga.api.bundle.build_candles_slice", return_value=[]),
        patch("hoga.api.bundle.downsample_candles", return_value=[]),
        patch("hoga.api.bundle.build_quote_ratio_slice", return_value=qr),
        patch("hoga.api.bundle.build_fill_strength_slice", return_value=fs),
        patch("hoga.api.bundle.build_volume_profile_slice", return_value=vp),
        patch("hoga.api.bundle.build_volume_profile_range", return_value=vp),
    ]


def test_api_range_surfaces_excluded_dates_on_wire(app_client: TestClient) -> None:
    """E2E: invalid Stock-Date is dropped from segments + listed under
    excluded_dates with its violations (ADR-0020)."""
    import contextlib

    metas = {"20260520": _meta(), "20260518": _meta(close_ms=0), "20260521": _meta()}
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch(
            "hoga.api.queries.QueryEngine.list_stock_dates_in_range",
            return_value=["20260520", "20260518", "20260521"],
        ))
        stack.enter_context(patch(
            "hoga.api.queries.QueryEngine.get_meta",
            side_effect=lambda date, _code, _source="hogaplay": metas[date],
        ))
        for pcm in _stub_slice_builders():
            stack.enter_context(pcm)
        r = app_client.get(
            "/api/range?code=005930&from=20260518&to=20260521&bucket_ms=60000"
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert [s["date"] for s in body["segments"]] == ["20260520", "20260521"]
    assert len(body["excluded_dates"]) == 1
    assert body["excluded_dates"][0]["date"] == "20260518"
    fired_ids = {v["invariant_id"] for v in body["excluded_dates"][0]["violations"]}
    assert "meta.close_after_open" in fired_ids
    assert body["data_warnings"] == []


def test_api_range_surfaces_data_warnings_on_wire(app_client: TestClient) -> None:
    """E2E: included Stock-Date with warn-only violations is kept but surfaced
    in data_warnings (ADR-0020)."""
    import contextlib

    with contextlib.ExitStack() as stack:
        stack.enter_context(patch(
            "hoga.api.queries.QueryEngine.list_stock_dates_in_range",
            return_value=["20260520"],
        ))
        stack.enter_context(patch(
            "hoga.api.queries.QueryEngine.get_meta",
            return_value=_meta(pages=4132, events=1553),  # warn ratio
        ))
        for pcm in _stub_slice_builders():
            stack.enter_context(pcm)
        r = app_client.get(
            "/api/range?code=005930&from=20260520&to=20260520&bucket_ms=60000"
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["segments"]) == 1
    assert body["excluded_dates"] == []
    assert len(body["data_warnings"]) == 1
    fired_ids = {v["invariant_id"] for v in body["data_warnings"][0]["warnings"]}
    assert "collection.unique_events_ratio" in fired_ids


def test_api_range_all_invalid_returns_empty_bundle_with_excluded(app_client: TestClient) -> None:
    """Spec 2026-05-27 §4.3: when every Stock-Date is INVALID, return 200 with
    an empty bundle whose excluded_dates carries the gated dates — the frontend
    renders DataWarning UX from that list."""
    with patch(
        "hoga.api.queries.QueryEngine.list_stock_dates_in_range",
        return_value=["20260518"],
    ), patch(
        "hoga.api.queries.QueryEngine.get_meta",
        return_value=_meta(close_ms=0),
    ):
        r = app_client.get(
            "/api/range?code=003490&from=20260518&to=20260518&bucket_ms=60000"
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["segments"] == []
    assert len(body["excluded_dates"]) == 1
    assert body["excluded_dates"][0]["date"] == "20260518"


def test_api_range_source_pref_threads_through(app_client: TestClient) -> None:
    """source_pref query param is forwarded to build_range_bundle (ADR-0039)."""
    captured: list[str] = []

    def _stub(engine, *, code, from_date, to_date, bucket_ms, source_pref="hogaplay"):
        captured.append(source_pref)
        return _build_range_bundle_stub(
            code=code,
            from_date=from_date,
            to_date=to_date,
            bucket_ms=bucket_ms,
            source_pref=source_pref,
        )

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512"
            "&bucket_ms=60000&source_pref=kis_live"
        )
    assert r.status_code == 200, r.text
    assert captured == ["kis_live"]


def test_api_range_source_pref_defaults_to_hogaplay(app_client: TestClient) -> None:
    """source_pref defaults to 'hogaplay' when not provided (ADR-0039)."""
    captured: list[str] = []

    def _stub(engine, *, code, from_date, to_date, bucket_ms, source_pref="hogaplay"):
        captured.append(source_pref)
        return _build_range_bundle_stub(
            code=code,
            from_date=from_date,
            to_date=to_date,
            bucket_ms=bucket_ms,
            source_pref=source_pref,
        )

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000"
        )
    assert r.status_code == 200, r.text
    assert captured == ["hogaplay"]
