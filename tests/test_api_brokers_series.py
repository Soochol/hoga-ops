"""Route tests for GET /api/brokers/series (ADR-0023, day-anchored 거래원 card)."""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_brokers_series_happy_path_returns_per_broker_trajectories(
    app_client: TestClient,
) -> None:
    """Tiny fixture (003490/20260519) has at least one broker snapshot —
    the response shape is well-formed and ordering invariant holds."""
    r = app_client.get("/api/brokers/series?code=003490&date=20260519")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["date"] == "20260519"
    assert isinstance(body["brokers"], list)
    # At most 10 entries.
    assert len(body["brokers"]) <= 10
    if body["brokers"]:
        first = body["brokers"][0]
        for key in ("broker", "final_net", "dominant_side", "points"):
            assert key in first
        assert first["dominant_side"] in ("buy", "sell")
        # Sorted by abs(final_net) desc.
        nets = [abs(e["final_net"]) for e in body["brokers"]]
        assert nets == sorted(nets, reverse=True)
        # Points are ts ascending and carry Unix-ms (per ADR-0003: ts >= 2020).
        for p in first["points"]:
            assert p["ts_ms"] >= 1_577_836_800_000  # 2020-01-01 UTC
        ts_list = [p["ts_ms"] for p in first["points"]]
        assert ts_list == sorted(ts_list)


def test_brokers_series_returns_empty_response_for_unknown_stock_date(
    app_client: TestClient,
) -> None:
    """ADR-0044 graceful-empty: an unknown (code, date) returns 200 with
    brokers=[] instead of 404. Matches the empty-bundle semantics adopted
    for /api/range and removes the console-noise pathway the frontend's
    useSpot.catch logged on every hover over an uncaptured candle.
    """
    r = app_client.get("/api/brokers/series?code=999999&date=20990101")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["date"] == "20990101"
    assert body["brokers"] == []
    assert body["source"] == "hogaplay"
