"""Unix-ms ↔ hogaplay intra-day encodings, per ADR 0003."""
from hoga.api.timeenc import (
    hhmmssms_to_unix_ms,
    ms_from_midnight_to_unix_ms,
    unix_ms_to_hhmmssms,
)


def test_hhmmssms_round_trip_at_open():
    # 2026-05-18 09:00:00.000 KST = 2026-05-18 00:00:00.000 UTC
    unix_ms = hhmmssms_to_unix_ms("20260518", 90000000)
    assert unix_ms == 1779062400000
    assert unix_ms_to_hhmmssms("20260518", unix_ms) == 90000000


def test_hhmmssms_round_trip_at_close():
    unix_ms = hhmmssms_to_unix_ms("20260518", 153000000)
    # 15:30 KST = 06:30 UTC
    assert unix_ms == 1779062400000 + 23400000  # +6h30m
    assert unix_ms_to_hhmmssms("20260518", unix_ms) == 153000000


def test_ms_from_midnight_to_unix_at_open():
    # 09:00 = 32_400_000 ms from midnight (9 hours)
    unix_ms = ms_from_midnight_to_unix_ms("20260518", 32_400_000)
    assert unix_ms == 1779062400000


def test_ms_from_midnight_to_unix_at_premarket():
    # 08:30 = 30_600_000 ms (matches the chart.tsv fixture)
    unix_ms = ms_from_midnight_to_unix_ms("20260518", 30_600_000)
    assert unix_ms == 1779062400000 - 1800000  # 30 min before 09:00 KST
