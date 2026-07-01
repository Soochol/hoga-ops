from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from hoga.api.models import SignalAlertEvent, SignalAlertSettingsUpdate
from hoga.live.signal_alerts import (
    append_signal_alert,
    clear_today_inbox,
    load_signal_alert_settings,
    read_signal_alerts,
    update_signal_alert_settings,
)


def event(seq: int, code: str = "005930") -> SignalAlertEvent:
    return SignalAlertEvent(
        type="signal_alert",
        id=f"20260701:{code}:sell_total_renewal:{seq}:ws",
        signal="sell_total_renewal",
        seq=seq,
        code=code,
        name="삼성전자",
        t_ms=1_779_851_250_000 + seq,
        date="20260701",
        source="ws",
        value=1_240_000 + seq,
        baseline=1_200_000,
        ratio_pct=103.3,
        use_intra_minute_max=True,
    )


def test_settings_defaults_and_patch_round_trip(tmp_path: Path) -> None:
    assert load_signal_alert_settings(tmp_path).sell_total_renewal.threshold_pct == 100

    updated = update_signal_alert_settings(
        tmp_path,
        SignalAlertSettingsUpdate(
            sell_total_renewal={
                "enabled": False,
                "start_hhmm": 1030,
                "threshold_pct": 95,
                "use_intra_minute_max": False,
            },
        ),
    )

    assert updated.sell_total_renewal.enabled is False
    assert updated.sell_total_renewal.start_hhmm == 1030
    assert updated.sell_total_renewal.threshold_pct == 95
    assert updated.sell_total_renewal.use_intra_minute_max is False
    assert load_signal_alert_settings(tmp_path) == updated


def test_alerts_are_date_partitioned_and_read_newest_first(tmp_path: Path) -> None:
    append_signal_alert(tmp_path, event(1, "005930"))
    append_signal_alert(tmp_path, event(2, "000660"))
    append_signal_alert(tmp_path, event(1, "035420").model_copy(update={"date": "20260702"}))

    rows = read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")

    assert [r.seq for r in rows] == [2, 1]
    assert [r.code for r in rows] == ["000660", "005930"]


def test_append_signal_alert_allocates_increasing_seq_atomically(tmp_path: Path) -> None:
    start = Barrier(2)

    def append(code: str) -> int:
        start.wait()
        return append_signal_alert(tmp_path, event(0, code)).seq

    with ThreadPoolExecutor(max_workers=2) as pool:
        seqs = sorted(pool.map(append, ["005930", "000660"]))

    assert seqs == [1, 2]
    assert [r.seq for r in read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")] == [2, 1]


def test_invalid_date_is_rejected_before_ledger_path_build(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        append_signal_alert(tmp_path, event(1).model_copy(update={"date": "../20260701"}))


def test_clear_today_hides_inbox_without_truncating_ledger(tmp_path: Path) -> None:
    append_signal_alert(tmp_path, event(1))
    append_signal_alert(tmp_path, event(2))

    cleared = clear_today_inbox(tmp_path, "20260701")

    assert cleared.date == "20260701"
    assert cleared.cleared_through_seq == 2
    assert read_signal_alerts(tmp_path, "20260701", limit=10, scope="inbox") == []
    assert [r.seq for r in read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")] == [2, 1]

    append_signal_alert(tmp_path, event(3))
    assert [r.seq for r in read_signal_alerts(tmp_path, "20260701", limit=10, scope="inbox")] == [3]
