from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.models import SignalAlertEvent
from hoga.live.signal_alerts import append_signal_alert


def make_client(tmp_path: Path) -> TestClient:
    app = create_app(data_dir=tmp_path)
    return TestClient(app)


def test_signal_alert_settings_round_trip(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    assert (
        client.get("/api/signal-alerts/settings").json()["sell_total_renewal"][
            "threshold_pct"
        ]
        == 100
    )

    response = client.patch(
        "/api/signal-alerts/settings",
        json={
            "sell_total_renewal": {
                "enabled": False,
                "start_hhmm": 1030,
                "threshold_pct": 95,
                "use_intra_minute_max": False,
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["sell_total_renewal"]["enabled"] is False
    assert client.get("/api/signal-alerts/settings").json()["sell_total_renewal"] == {
        "enabled": False,
        "start_hhmm": 1030,
        "threshold_pct": 95,
        "use_intra_minute_max": False,
    }


def test_recent_inbox_and_clear_preserve_ledger(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    for seq in [1, 2]:
        append_signal_alert(
            tmp_path,
            SignalAlertEvent(
                type="signal_alert",
                id=f"20260701:005930:sell_total_renewal:{seq}:ws",
                signal="sell_total_renewal",
                seq=seq,
                code="005930",
                name="삼성전자",
                t_ms=1_779_851_250_000 + seq,
                date="20260701",
                source="ws",
                value=1_000 + seq,
                baseline=1_000,
                ratio_pct=100.0,
                use_intra_minute_max=True,
            ),
        )

    before = client.get("/api/signal-alerts/recent?date=20260701&scope=inbox").json()
    assert [row["seq"] for row in before["alerts"]] == [2, 1]
    assert before["cleared_through_seq"] == 0

    cleared = client.post("/api/signal-alerts/clear-today?date=20260701")
    assert cleared.status_code == 200
    assert cleared.json()["cleared_through_seq"] == 2

    inbox_after = client.get("/api/signal-alerts/recent?date=20260701&scope=inbox").json()
    assert inbox_after["alerts"] == []
    assert inbox_after["cleared_through_seq"] == 2

    all_after = client.get("/api/signal-alerts/recent?date=20260701&scope=all").json()
    assert [row["seq"] for row in all_after["alerts"]] == [2, 1]
    assert all_after["cleared_through_seq"] == 2
