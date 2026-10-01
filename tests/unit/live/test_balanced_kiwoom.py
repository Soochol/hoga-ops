"""Balance placement without changing priority admission or live ownership."""
from hoga.live.coverage import (
    KIWOOM_PER_ACCOUNT_MAX,
    KIWOOM_SECTOR_RESERVE,
    partition_balanced_kiwoom,
    partition_kiwoom,
)


def owners(parts):
    return {code: account for account, part in enumerate(parts) for code in part}


def venue_cost(code):
    return 3 if int(code) < 202 else 1


def test_mixed_venues_spread_slots_and_keep_all_codes():
    codes = [f"{i:06}" for i in range(319)]
    weight = venue_cost
    parts = partition_balanced_kiwoom(codes, 5, weight=weight, previous={})
    used = [sum(weight(c) for c in part) for part in parts]
    caps = [KIWOOM_PER_ACCOUNT_MAX] * 4 + [KIWOOM_PER_ACCOUNT_MAX - KIWOOM_SECTOR_RESERVE]
    assert len(owners(parts)) == len(codes)
    assert sum(len(p) for p in parts) == len(codes)  # no duplicate owners
    assert all(u <= cap for u, cap in zip(used, caps, strict=True))
    assert max(used) < KIWOOM_PER_ACCOUNT_MAX
    assert min(used) > 0


def test_existing_owners_survive_reordering_and_new_high_priority_code():
    codes = [f"{i:06}" for i in range(319)]
    weight = venue_cost
    original = partition_balanced_kiwoom(codes, 5, weight=weight, previous={})
    before = owners(original)
    after = owners(partition_balanced_kiwoom(
        ["999999", *reversed(codes)], 5, weight=weight, previous=before,
    ))
    assert {c: after[c] for c in codes} == before
    assert "999999" in after


def test_overflow_admission_keeps_same_priority_prefix():
    codes = [f"{i:06}" for i in range(1000)]
    legacy = owners(partition_kiwoom(codes, 4, weight=lambda c: 3))
    balanced = owners(partition_balanced_kiwoom(codes, 4, weight=lambda c: 3, previous={}))
    assert set(balanced) == set(legacy)


def test_expanded_venue_set_does_not_move_a_live_owner_without_removal():
    codes = ["A", "B"]
    previous = {"A": 0, "B": 0}
    parts = partition_balanced_kiwoom(
        codes, 2, weight=lambda c: KIWOOM_PER_ACCOUNT_MAX, previous=previous,
        last_account_reserve=0,
    )
    assert parts == [["A"], []]
    # Once the old owner no longer has B, next sync can place it on account 1.
    assert partition_balanced_kiwoom(
        codes, 2, weight=lambda c: KIWOOM_PER_ACCOUNT_MAX, previous={"A": 0},
        last_account_reserve=0,
    ) == [["A"], ["B"]]
