"""partition_live_set — 연속 슬라이스 13/13 (스펙 §5.3, Q4)."""
from hoga.live.lifecycle import _PER_ACCOUNT_MAX, partition_live_set


def _codes(n: int) -> list[str]:
    return [f"{i:06d}" for i in range(n)]


def test_partition_26_into_2_is_13_13():
    parts = partition_live_set(_codes(26), 2)
    assert len(parts) == 2
    assert parts[0] == _codes(26)[:13]
    assert parts[1] == _codes(26)[13:26]


def test_partition_13_into_2_leaves_second_empty():
    parts = partition_live_set(_codes(13), 2)
    assert parts[0] == _codes(13)
    assert parts[1] == []


def test_partition_14_into_2_puts_14th_on_account_1():
    parts = partition_live_set(_codes(14), 2)
    assert len(parts[0]) == 13
    assert parts[1] == ["000013"]  # the 14th code (0-based index 13)


def test_partition_13_into_1():
    parts = partition_live_set(_codes(13), 1)
    assert parts == [_codes(13)]


def test_partition_stable_account_0_unchanged_when_appending_14th():
    # Appending a 14th code must NOT move any of account 0's first 13.
    a = partition_live_set(_codes(13), 2)
    b = partition_live_set(_codes(14), 2)
    assert a[0] == b[0]


def test_per_account_max_is_13():
    assert _PER_ACCOUNT_MAX == 13
