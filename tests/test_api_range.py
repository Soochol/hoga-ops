"""Route tests for GET /api/range (ADR-0013)."""
from __future__ import annotations

import json
from unittest.mock import patch

from fastapi.testclient import TestClient


def _build_range_bundle_stub(
    *,
    code,
    from_date,
    to_date,
    bucket_ms,
    source_pref="hogaplay",
    broker_late_entries_enabled=True,
    broker_late_entry_start_hhmm=None,
    volume_distribution_bins=None,
    volume_distribution_price_min=None,
    volume_distribution_price_max=None,
    trade_volume_poc_bins=None,
    mode="full",
):
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


def test_range_accepts_broker_late_entry_threshold_and_returns_field(
    app_client: TestClient,
) -> None:
    r = app_client.get(
        "/api/range?code=003490&from=20260519&to=20260519"
        "&bucket_ms=60000&broker_late_entry_start_hhmm=930"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "broker_late_entries" in body
    assert isinstance(body["broker_late_entries"], list)
    for event in body["broker_late_entries"]:
        assert set(event) == {"t_ms", "broker", "side", "net"}
        assert event["side"] in ("buy", "sell")
        assert event["t_ms"] >= 1_577_836_800_000


def test_range_defaults_broker_late_entry_threshold_to_930(
    app_client: TestClient,
) -> None:
    from hoga.api.models import BrokerLateEntryEvent

    def _stub(engine, **kw):
        broker_late_entries = []
        if kw["broker_late_entry_start_hhmm"] == 930:
            broker_late_entries = [
                BrokerLateEntryEvent(
                    t_ms=1_746_885_600_000,
                    broker="NH투자증권",
                    side="buy",
                    net=42,
                )
            ]
        return _build_range_bundle_stub(**kw).model_copy(
            update={"broker_late_entries": broker_late_entries}
        )

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get(
            "/api/range?code=003490&from=20260519&to=20260519&bucket_ms=60000"
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["broker_late_entries"] == [
        {
            "t_ms": 1_746_885_600_000,
            "broker": "NH투자증권",
            "side": "buy",
            "net": 42,
        }
    ]


def test_range_can_disable_broker_late_entries(
    app_client: TestClient,
) -> None:
    captured: list[bool] = []

    def _stub(engine, **kw):
        captured.append(kw["broker_late_entries_enabled"])
        return _build_range_bundle_stub(**kw)

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get(
            "/api/range?code=003490&from=20260519&to=20260519"
            "&bucket_ms=60000&broker_late_entries_enabled=false"
        )

    assert r.status_code == 200, r.text
    assert captured == [False]


def test_range_rejects_invalid_broker_late_entry_threshold(
    app_client: TestClient,
) -> None:
    r = app_client.get(
        "/api/range?code=003490&from=20260519&to=20260519"
        "&bucket_ms=60000&broker_late_entry_start_hhmm=800"
    )
    assert r.status_code == 400
    assert "broker_late_entry_start_hhmm" in r.text


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
        patch("hoga.api.bundle.build_trade_volume_poc_slice", return_value=None),
        patch("hoga.api.bundle.build_broker_late_entries_slice", return_value=[]),
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

    def _stub(
        engine,
        *,
        code,
        from_date,
        to_date,
        bucket_ms,
        source_pref="hogaplay",
        broker_late_entries_enabled=True,
        broker_late_entry_start_hhmm=None,
        volume_distribution_bins=None,
        volume_distribution_price_min=None,
        volume_distribution_price_max=None,
        trade_volume_poc_bins=None,
        mode="full",
    ):
        captured.append(source_pref)
        return _build_range_bundle_stub(
            code=code,
            from_date=from_date,
            to_date=to_date,
            bucket_ms=bucket_ms,
            source_pref=source_pref,
            volume_distribution_bins=volume_distribution_bins,
            volume_distribution_price_min=volume_distribution_price_min,
            volume_distribution_price_max=volume_distribution_price_max,
            trade_volume_poc_bins=trade_volume_poc_bins,
            mode=mode,
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

    def _stub(
        engine,
        *,
        code,
        from_date,
        to_date,
        bucket_ms,
        source_pref="hogaplay",
        broker_late_entries_enabled=True,
        broker_late_entry_start_hhmm=None,
        volume_distribution_bins=None,
        volume_distribution_price_min=None,
        volume_distribution_price_max=None,
        trade_volume_poc_bins=None,
        mode="full",
    ):
        captured.append(source_pref)
        return _build_range_bundle_stub(
            code=code,
            from_date=from_date,
            to_date=to_date,
            bucket_ms=bucket_ms,
            source_pref=source_pref,
            volume_distribution_bins=volume_distribution_bins,
            volume_distribution_price_min=volume_distribution_price_min,
            volume_distribution_price_max=volume_distribution_price_max,
            trade_volume_poc_bins=trade_volume_poc_bins,
            mode=mode,
        )

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000"
        )
    assert r.status_code == 200, r.text
    assert captured == ["hogaplay"]


def test_api_range_omits_volume_distribution_by_default(app_client: TestClient) -> None:
    captured: list[int | None] = []

    def _stub(engine, **kw):
        captured.append(kw.get("volume_distribution_bins"))
        return _build_range_bundle_stub(**kw)

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get("/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000")

    assert r.status_code == 200, r.text
    assert captured == [None]
    assert r.json()["volume_distributions"] == []


def test_api_range_threads_volume_distribution_bins(app_client: TestClient) -> None:
    captured: list[int | None] = []

    def _stub(engine, **kw):
        captured.append(kw.get("volume_distribution_bins"))
        return _build_range_bundle_stub(**kw)

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512"
            "&bucket_ms=60000&volume_distribution_bins=10"
        )

    assert r.status_code == 200, r.text
    assert captured == [10]


def test_api_range_threads_volume_distribution_price_range(app_client: TestClient) -> None:
    captured: list[tuple[int | None, int | None]] = []

    def _stub(engine, **kw):
        captured.append((
            kw.get("volume_distribution_price_min"),
            kw.get("volume_distribution_price_max"),
        ))
        return _build_range_bundle_stub(**kw)

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512"
            "&bucket_ms=60000&volume_distribution_price_min=69900"
            "&volume_distribution_price_max=70100"
        )

    assert r.status_code == 200, r.text
    assert captured == [(69900, 70100)]


def test_api_range_rejects_incomplete_volume_distribution_price_range(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/range?code=005930&from=20260512&to=20260512"
        "&bucket_ms=60000&volume_distribution_price_min=69900"
    )
    assert r.status_code == 400


def test_api_range_rejects_reversed_volume_distribution_price_range(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/range?code=005930&from=20260512&to=20260512"
        "&bucket_ms=60000&volume_distribution_price_min=70100"
        "&volume_distribution_price_max=69900"
    )
    assert r.status_code == 400


def test_api_range_threads_trade_volume_poc_bins(app_client: TestClient) -> None:
    captured: list[int | None] = []

    def _stub(engine, **kw):
        captured.append(kw.get("trade_volume_poc_bins"))
        return _build_range_bundle_stub(**kw)

    with patch("hoga.api.routes.build_range_bundle", side_effect=_stub):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512"
            "&bucket_ms=60000&trade_volume_poc_bins=12"
        )

    assert r.status_code == 200, r.text
    assert captured == [12]


def test_api_range_rejects_invalid_volume_distribution_bins(app_client: TestClient) -> None:
    for value in ("4", "31"):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512"
            f"&bucket_ms=60000&volume_distribution_bins={value}"
        )
        assert r.status_code in (400, 422)


def test_api_range_rejects_invalid_trade_volume_poc_bins(app_client: TestClient) -> None:
    for value in ("4", "31"):
        r = app_client.get(
            "/api/range?code=005930&from=20260512&to=20260512"
            f"&bucket_ms=60000&trade_volume_poc_bins={value}"
        )
        assert r.status_code in (400, 422)


# --- Roundtrip: parser write path is visible to /api/range read path ---


def test_parser_output_visible_as_hogaplay_source(app_client: TestClient) -> None:
    """parse_stock_date → /api/range round-trip surfaces the captured day under
    source=hogaplay with non-empty candles.

    Regression: when parser wrote to the flat `{date}/{code}/` path (pre v2
    layout fix), `_resolve_source` ignored it (only scans subdirs). With
    `kis_live` co-existing the resolver fell through to kis_live, whose
    candles.parquet doesn't exist by design → empty chart. This test fails
    if parser ever regresses to the flat layout.

    Setup: the module-scoped `app_client` fixture already runs parse_stock_date
    for 003490/20260519 via tiny_tsv, so this just exercises read-back.
    """
    r = app_client.get(
        "/api/range?code=003490&from=20260519&to=20260519&bucket_ms=60000"
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["segments"]) == 1
    assert body["segments"][0]["date"] == "20260519"
    assert body["segments"][0]["source"] == "hogaplay"
    assert len(body["candles"]) > 0


# --- Unmocked end-to-end value lock for the ADR-0001 extracted slices ---


def test_range_bundle_unmocked_asymmetric_value_mapping(tmp_path) -> None:
    """E2E regression lock (reviewer I-1): drive build_range_bundle against REAL
    parquet — no slice builder mocked — and assert the rewired bundle wrappers
    map the extracted query results to the wire shape correctly.

    Fixtures are deliberately ASYMMETRIC so a field swap is caught instantly:
      * snapshots: bid depth-total != ask depth-total, and two snapshots share
        one bucket with different ts_ms → the LATER one must win (locks the
        ORDER BY ts_ms DESC last-in-bucket selection of quote_ratio).
      * trades: buy_qty (side=+1) != sell_qty (side=-1) (locks fill_strength
        sign mapping). An auction-cross trade (side=0) priced ABOVE the candle
        range makes the trades price-range differ from the candle range, which
        separates the two volume profiles:
          - volume_profile_by_day (slice 4): range from candles MIN(low)/MAX(high)
            = [0, 100] → the above-range trade is filtered out (WHERE price
            BETWEEN 0 AND 100).
          - volume_profile_range (slice 3): range from trades MIN/MAX price
            = [10, 150] → price_max == 150 reflects that trade.
      * candle range 0..100 over 24 bins → FRACTIONAL bin_width 4.1666… The
        wire bin_width truncates to int(4) either way, so the ONLY discriminator
        for the float-vs-int-truncation fix is price_low: a trade at price 30
        lands in bin 7, whose price_low must be int(7 * 4.1666…) == 29 (the
        pre-fix int-truncated path would yield int(7 * 4) == 28).
    """
    from hoga.api.bundle import build_range_bundle
    from hoga.api.queries import QueryEngine
    from hoga.tables.candles import Candle
    from hoga.tables.candles import write_parquet as write_candles
    from hoga.tables.snapshots import Orderbook
    from hoga.tables.snapshots import write_parquet as write_snapshots
    from hoga.tables.trades import Trade
    from hoga.tables.trades import write_parquet as write_trades

    code, date = "003490", "20260519"
    code_dir = tmp_path / "parquet" / date / code / "hogaplay"
    code_dir.mkdir(parents=True)

    def _ob(*, ts_ms: int, seq: int, ask_q: tuple[int, ...], bid_q: tuple[int, ...]) -> Orderbook:
        def _pad(t: tuple[int, ...]) -> tuple[int, ...]:
            return (tuple(t) + (0,) * 10)[:10]
        return Orderbook(
            ts_ms=ts_ms, seq=seq,
            ask_p=tuple(range(1, 11)), ask_q=_pad(ask_q), ask_d=(0,) * 10,
            bid_p=tuple(range(10, 0, -1)), bid_q=_pad(bid_q), bid_d=(0,) * 10,
            tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
        )

    # Two snapshots in the SAME 60s bucket (09:00:00.000 and 09:00:00.500).
    # Earlier ts = decoy (ask 111 / bid 222); later ts = winner (ask 700 / bid 300).
    write_snapshots(
        [
            _ob(ts_ms=90_000_000, seq=1, ask_q=(11, 100), bid_q=(22, 200)),   # decoy
            _ob(ts_ms=90_000_500, seq=2, ask_q=(300, 400), bid_q=(100, 200)),  # winner
        ],
        code_dir / "snapshots.parquet",
    )

    def _trade(*, ts_ms: int, seq: int, price: int, qty: int, side: int) -> Trade:
        return Trade(
            ts_ms=ts_ms, seq=seq, price=price, change_pct=0.0, qty=qty, side=side,
            cum_vol=0, cum_trades=0, low_so_far=0, high_so_far=0, net_pressure=0,
            unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0,
        )

    write_trades(
        [
            _trade(ts_ms=90_000_000, seq=1, price=30, qty=50, side=1),    # buy, bin 7
            _trade(ts_ms=90_000_200, seq=2, price=10, qty=20, side=-1),   # sell, bin 2
            _trade(ts_ms=90_000_300, seq=3, price=150, qty=999, side=0),  # above candle range
        ],
        code_dir / "trades.parquet",
    )

    # Candle price grid: low=0, high=100 (DIFFERENT from trades price range 10..150).
    write_candles(
        [Candle(ts_ms=32_400_000, open_=50, close_=60, high=100, low=0, vol_a=5, vol_b=7)],
        code_dir / "candles.parquet",
    )

    # Healthy COMPLETE meta (not INVALID, not partial) so the segment is included.
    (code_dir / "meta.json").write_text(json.dumps({
        "code": code, "name": "테스트",
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "prev_close": 50, "upper_limit": 200, "lower_limit": 1,
        "today_open": 50, "today_high": 100, "today_low": 0, "today_close": 60,
        "pages_collected": 100, "total_unique_events": 80,
        "parser_version": "test", "collection_complete": True, "is_partial": False,
    }), encoding="utf-8")

    engine = QueryEngine(data_dir=tmp_path)
    try:
        rb = build_range_bundle(
            engine, code=code, from_date=date, to_date=date, bucket_ms=60_000,
        )
    finally:
        engine.close()

    assert len(rb.segments) == 1
    assert rb.excluded_dates == []

    # --- quote_ratio: one bucket, LATER snapshot wins; bid_total != ask_total ---
    assert len(rb.quote_ratio.points) == 1
    pt = rb.quote_ratio.points[0]
    assert pt.ask_total == 700  # 300 + 400 (winner)  — NOT 111 (decoy)
    assert pt.bid_total == 300  # 100 + 200 (winner)  — NOT 222 (decoy)
    assert pt.ask_total != pt.bid_total  # asymmetry: a swap would surface here

    # --- fill_strength: one bucket; buy_qty != sell_qty (side sign mapping) ---
    assert len(rb.fill_strength.points) == 1
    fp = rb.fill_strength.points[0]
    assert fp.buy_qty == 50   # side=+1
    assert fp.sell_qty == 20  # side=-1
    assert fp.buy_qty != fp.sell_qty

    # --- volume_profile_by_day (slice 4): candle range [0,100], fractional width ---
    assert len(rb.volume_profile_by_day) == 1
    by_day = rb.volume_profile_by_day[0]
    assert by_day.bin_count == 24
    assert by_day.price_min == 0
    assert by_day.price_max == 100
    assert by_day.bin_width == 4  # wire = int(4.1666…)
    # The float-vs-int-truncation DISCRIMINATOR: bin 7's price_low must use the
    # raw float (29), not the truncated-int width (would be 28).
    assert by_day.bins[7].price_low == 29
    assert by_day.bins[7].qty == 50   # the price-30 buy trade lands here
    assert by_day.bins[2].qty == 20   # the price-10 sell trade lands here
    # The above-range (price 150) trade is filtered OUT of the candle-bounded
    # profile — its qty must NOT appear in any by_day bin.
    assert sum(b.qty for b in by_day.bins) == 70  # 50 + 20, NOT 70 + 999

    # --- volume_profile_range (slice 3): trades price range [10,150] ---
    vpr = rb.volume_profile_range
    assert vpr.bin_count == 24
    assert vpr.price_min == 10
    assert vpr.price_max == 150  # driven by the price-150 trade, NOT the candle high
    # price 30 -> FLOOR((30-10)/5.8333)=3, price 10 -> bin 0; assert their qty.
    assert vpr.bins[0].qty == 20  # price 10
    assert vpr.bins[3].qty == 50  # price 30
