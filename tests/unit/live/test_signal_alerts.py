from multiprocessing import get_context
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


def _append_worker(data_dir: str, code: str, ready, out_queue) -> None:
    from pathlib import Path

    from hoga.live.signal_alerts import append_signal_alert

    ready.wait()
    result = append_signal_alert(Path(data_dir), event(0, code))
    out_queue.put((result.seq, result.id))


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

    def append(code: str) -> tuple[int, str]:
        start.wait()
        result = append_signal_alert(tmp_path, event(0, code))
        return result.seq, result.id

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = sorted(pool.map(append, ["005930", "000660"]))

    assert [seq for seq, _id in results] == [1, 2]
    assert all(
        _id == f"20260701:{_id.split(':')[1]}:sell_total_renewal:{seq}:ws"
        for seq, _id in results
    )
    assert [r.seq for r in read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")] == [2, 1]


def test_append_signal_alert_rewrites_id_to_assigned_seq(tmp_path: Path) -> None:
    result = append_signal_alert(tmp_path, event(99))

    assert result.seq == 1
    assert result.id == "20260701:005930:sell_total_renewal:1:ws"
    rows = read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")
    assert [row.id for row in rows] == ["20260701:005930:sell_total_renewal:1:ws"]


def test_append_signal_alert_is_safe_across_processes(tmp_path: Path) -> None:
    ctx = get_context("spawn")
    ready = ctx.Barrier(2)
    out_queue = ctx.Queue()

    procs = [
        ctx.Process(target=_append_worker, args=(str(tmp_path), code, ready, out_queue))
        for code in ("005930", "000660")
    ]
    for proc in procs:
        proc.start()
    try:
        results = [out_queue.get(timeout=5) for _ in procs]
    finally:
        for proc in procs:
            proc.join(timeout=5)

    assert sorted(seq for seq, _ in results) == [1, 2]
    rows = read_signal_alerts(tmp_path, "20260701", limit=10, scope="all")
    assert sorted(row.seq for row in rows) == [1, 2]
    assert all(
        row.id == f"20260701:{row.code}:sell_total_renewal:{row.seq}:ws"
        for row in rows
    )


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
