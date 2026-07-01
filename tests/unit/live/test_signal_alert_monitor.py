from pathlib import Path

from hoga.api.models import SignalAlertSettingsUpdate, SellTotalRenewalSettings
from hoga.live.signal_alert_monitor import SignalAlertMonitor
from hoga.live.signal_alerts import read_signal_alerts, update_signal_alert_settings


def date_fn(_t_ms: int) -> str:
    return "20260701"


def test_emits_at_default_100_percent_after_start(tmp_path: Path) -> None:
    published: list[dict] = []
    monitor = SignalAlertMonitor(tmp_path, publish=published.append, date_fn=date_fn)
    monitor.set_targets({"005930"})

    assert monitor.ingest_orderbook("005930", "삼성전자", 10_00_00, 1_000, "ws") is None
    assert monitor.ingest_orderbook("005930", "삼성전자", 11_01_00, 999, "ws") is None
    event = monitor.ingest_orderbook("005930", "삼성전자", 11_02_00, 1_000, "ws")

    assert event is not None
    assert event.seq == 1
    assert event.ratio_pct == 100.0
    assert published[0]["type"] == "signal_alert"
    assert read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")[0].seq == 1


def test_custom_95_percent_threshold(tmp_path: Path) -> None:
    update_signal_alert_settings(
        tmp_path,
        SignalAlertSettingsUpdate(
            sell_total_renewal=SellTotalRenewalSettings(
                enabled=True,
                start_hhmm=1100,
                threshold_pct=95,
                use_intra_minute_max=True,
            ),
        ),
    )
    monitor = SignalAlertMonitor(tmp_path, publish=lambda _event: None, date_fn=date_fn)
    monitor.set_targets({"005930"})

    monitor.ingest_orderbook("005930", "삼성전자", 10_00_00, 1_000, "rest")
    event = monitor.ingest_orderbook("005930", "삼성전자", 11_00_30, 950, "rest")

    assert event is not None
    assert event.source == "rest"


def test_ignores_non_targets_and_missing_baseline(tmp_path: Path) -> None:
    monitor = SignalAlertMonitor(tmp_path, publish=lambda _event: None, date_fn=date_fn)
    monitor.set_targets({"005930"})

    assert monitor.ingest_orderbook("000660", "SK하이닉스", 10_00_00, 5_000, "ws") is None
    assert monitor.ingest_orderbook("005930", "삼성전자", 11_00_00, 5_000, "ws") is None


def test_rearm_suppresses_repeated_alerts(tmp_path: Path) -> None:
    monitor = SignalAlertMonitor(tmp_path, publish=lambda _event: None, date_fn=date_fn)
    monitor.set_targets({"005930"})

    monitor.ingest_orderbook("005930", "삼성전자", 10_00_00, 1_000, "ws")
    first = monitor.ingest_orderbook("005930", "삼성전자", 11_00_00, 1_000, "ws")
    duplicate = monitor.ingest_orderbook("005930", "삼성전자", 11_00_10, 1_010, "ws")
    monitor.ingest_orderbook("005930", "삼성전자", 11_01_00, 800, "ws")
    second = monitor.ingest_orderbook("005930", "삼성전자", 11_02_00, 1_000, "ws")

    assert first is not None
    assert duplicate is None
    assert second is not None
