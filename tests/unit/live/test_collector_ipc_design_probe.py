"""Protocol correctness experiments; these prototypes do not replace production IPC."""
from __future__ import annotations

import asyncio
import copy
import json
import random

import pytest

from scripts.probe_collector_ipc_design import (
    FRAME_BUDGET,
    NativeJournal,
    Producer,
    Replica,
    assemble_transaction,
    blocked_peak_lane_probe,
    mutate,
    native_states,
    snapshots,
    transaction_frames,
)


def deliver(producer, replica, current):
    for encoded in producer.frames(current):
        assert len(encoded) - 4 <= FRAME_BUDGET
        replica.apply(json.loads(encoded[4:]))
    assert replica.snapshot() == current


@pytest.mark.parametrize("mode", ["key_snapshot", "minute_patch"])
def test_real_snapshot_roundtrip_updates_and_coalesced_pending_states(mode):
    states = native_states(4, 30)
    producer, replica = Producer(mode), Replica()
    current = snapshots(states)
    deliver(producer, replica, current)
    for turn in range(1, 20):
        mutate(states, turn % 4 + 1, turn)
        pending = snapshots(states)
        producer.observe(pending)
        replica.heartbeat(producer.source_revisions)
        # Changes may be replaced in the pending slot before any patch is sent.
        if turn % 3 == 0:
            deliver(producer, replica, pending)
    deliver(producer, replica, pending)


@pytest.mark.parametrize("mode", ["key_snapshot", "minute_patch"])
def test_late_corrections_minute_insert_delete_rank_replace_side_reset_and_day_rollover(mode):
    producer, replica = Producer(mode), Replica()
    current = snapshots(native_states(2, 20))
    deliver(producer, replica, current)
    current = copy.deepcopy(current)
    side = current["000000:KRX"]["ask"]
    side["traded_bar_peaks"][1]["qty"] += 1000  # Correction to an earlier minute.
    side["all_bar_peaks"].pop(4)
    side["unreached_bar_peaks"].append({"price": 101_000, "qty": 999,
                                        "t_ms": side["unreached_bar_peaks"][-1]["t_ms"] + 60_000})
    side["all_peaks"] = [{"price": 101_000, "qty": 999, "t_ms": 1234}]
    side["new_optional_field"] = True
    side.pop("day_extreme")
    deliver(producer, replica, current)
    current = copy.deepcopy(current)
    current["000001:KRX"]["bid"] = None
    deliver(producer, replica, current)
    current = copy.deepcopy(current)
    current["000000:KRX"]["ask"]["date"] = "20261026"
    current["000000:KRX"]["ask"]["all_bar_peaks"] = []
    deliver(producer, replica, current)
    current = {"000000:KRX": current["000000:KRX"]}
    deliver(producer, replica, current)
    deliver(producer, replica, {})


def test_patch_gap_invalidates_only_affected_key_and_scoped_full_recovers():
    producer, replica = Producer(), Replica()
    current = snapshots(native_states(2, 20))
    deliver(producer, replica, current)
    key = "000000:KRX"
    changed = copy.deepcopy(current[key])
    changed["ask"]["all_bar_peaks"][-1]["qty"] += 1
    dropped = producer.prepare(key, changed)
    producer.commit(dropped, changed)  # Deliberate transport-loss injection.
    newer = copy.deepcopy(changed)
    newer["ask"]["all_bar_peaks"][-1]["qty"] += 1
    next_frame = producer.prepare(key, newer)
    assert not replica.apply(next_frame)
    assert replica.needs_resync == {key}
    assert key not in replica.snapshot()
    assert replica.snapshot()["000001:KRX"] == current["000001:KRX"]
    full = {**next_frame, "full": True, "value": newer}
    assert replica.apply(full)
    assert not replica.needs_resync
    assert replica.snapshot()[key] == newer
    assert not replica.apply(dropped)  # A delayed older delta cannot rewind it.


def test_late_full_seed_reply_cannot_rewind_newer_patch():
    producer, replica = Producer(), Replica()
    current = snapshots(native_states(1, 3))
    key = next(iter(current))
    old_reply = producer.prepare(key, current[key])
    replica.apply(json.loads(json.dumps(old_reply)))
    producer.commit(old_reply, current[key])
    newer = copy.deepcopy(current)
    newer[key]["bid"]["traded_bar_peaks"][0]["qty"] += 1000
    deliver(producer, replica, newer)
    assert not replica.apply(old_reply)
    assert replica.snapshot() == newer


def test_source_revision_manifest_marks_stale_peak_data_while_heartbeat_is_alive():
    producer, replica = Producer(), Replica()
    current = snapshots(native_states(2, 3))
    deliver(producer, replica, current)
    changed = copy.deepcopy(current)
    changed["000000:KRX"]["ask"]["all_bar_peaks"][0]["qty"] += 1
    producer.observe(changed)  # Producer sees changes even while the peak sender is blocked.
    replica.heartbeat(producer.source_revisions)
    assert "000000:KRX" not in replica.snapshot()
    assert "000001:KRX" in replica.snapshot()
    deliver(producer, replica, changed)


def test_change_then_revert_still_advances_revision_and_restores_data_readiness():
    producer, replica = Producer(), Replica()
    current = snapshots(native_states(1, 3))
    deliver(producer, replica, current)
    newer = copy.deepcopy(current)
    key = next(iter(current))
    newer[key]["ask"]["day_extreme"] += 1
    producer.observe(newer)
    producer.observe(current)
    replica.heartbeat(producer.source_revisions)
    assert key not in replica.snapshot()
    deliver(producer, replica, current)
    assert replica.revisions[key] == 3


@pytest.mark.parametrize("change", [{"epoch": "retired"}, {"desired_version": 2}])
def test_epoch_and_configuration_mismatch_cannot_mutate_replica(change):
    producer, replica = Producer(), Replica()
    current = snapshots(native_states(1, 3))
    frame = producer.prepare("000000:KRX", current["000000:KRX"])
    with pytest.raises(ValueError, match="old epoch/version"):
        replica.apply({**frame, **change})
    assert replica.snapshot() == {}
    # A replacement owner starts with a complete snapshot in its own namespace.
    replacement, restarted = Producer(epoch="new", version=2), Replica(epoch="new", version=2)
    deliver(replacement, restarted, current)


@pytest.mark.parametrize("seed", [7, 41, 83, 101])
def test_randomized_sparse_edits_and_pending_overwrites_reconstruct_exactly(seed):
    rng = random.Random(seed)
    producer, replica = Producer(), Replica()
    current = snapshots(native_states(5, 12))
    deliver(producer, replica, current)
    for _ in range(60):
        current = copy.deepcopy(current)
        key = rng.choice(sorted(current))
        side = current[key][rng.choice(["ask", "bid"])]
        field = rng.choice(["traded_bar_peaks", "all_bar_peaks", "unreached_bar_peaks"])
        rng.choice(side[field])["qty"] += rng.randrange(1, 1000)
        producer.observe(current)
        replica.heartbeat(producer.source_revisions)
        if rng.randrange(4) == 0:
            deliver(producer, replica, current)
    deliver(producer, replica, current)


async def test_real_socket_backpressure_does_not_block_separate_heartbeat_lane():
    result = await blocked_peak_lane_probe()
    assert result["peak_drain_blocked"] and result["peak_drain_still_blocked"]
    assert result["heartbeats_received_while_blocked"] == 20


def initialize_journal(states):
    journal, replica = NativeJournal(states), Replica()
    for encoded in journal.initial_frames(snapshots(states)):
        replica.apply(json.loads(encoded[4:]))
    assert replica.snapshot() == snapshots(states)
    return journal, replica


def deliver_journal(journal, replica):
    replica.heartbeat(journal.source_revisions)
    for encoded in journal.frames():
        assert len(encoded) - 4 <= FRAME_BUDGET
        replica.apply(json.loads(encoded[4:]))


def test_native_journal_coalesces_updates_without_rebuilding_any_day_snapshot(monkeypatch):
    states = native_states(6, 390)
    journal, replica = initialize_journal(states)
    for turn in range(20):
        journal.record(mutate(states, turn % 6 + 1, turn))
    expected = snapshots(states)
    # Dirty extraction may call the real scalar/rank logic, with empty minute
    # maps. Reject accidental full-day snapshot enumeration during an update.
    from hoga.live.ask_peak_state import TodayAskPeakState, TodayBidPeakState
    original = TodayAskPeakState.snapshot

    def meta_only(self):
        assert not self.traded_bar_max and not self.all_bar_max and not self.unreached_bar_max
        assert not self.all_record
        return original(self)

    with monkeypatch.context() as patch:
        patch.setattr(TodayAskPeakState, "snapshot", meta_only)
        patch.setattr(TodayBidPeakState, "snapshot", meta_only)
        deliver_journal(journal, replica)
    assert replica.snapshot() == expected
    assert journal.pending == {}


def test_journal_update_during_drain_cannot_clear_a_newer_dirty_minute():
    states = native_states(1, 10)
    journal, replica = initialize_journal(states)
    key = next(iter(states))
    journal.record(mutate(states, 1, 1))
    inflight = journal.prepare(key)
    journal.record(mutate(states, 1, 2))
    replica.apply(json.loads(json.dumps(inflight)))
    journal.commit(inflight)
    assert journal.pending and journal.source_revisions[key] > journal.sent[key]
    deliver_journal(journal, replica)
    assert replica.snapshot() == snapshots(states)


def test_journal_past_minute_delete_insert_seed_reset_empty_side_and_key_removal():
    from hoga.live.ask_peak_state import Peak, TodayBidPeakState
    states = native_states(2, 20)
    journal, replica = initialize_journal(states)
    key = next(iter(states))
    native = states[key]["ask"]
    minute = min(native.all_bar_max)
    native.all_bar_max.pop(minute)
    native.traded_bar_max[minute].qty += 1000
    newer = max(native.unreached_bar_max) + 1
    native.unreached_bar_max[newer] = Peak(101_000, 900, newer * 60_000 + 100)
    journal.record({key: {"ask": {"all_bar_peaks": {minute}, "traded_bar_peaks": {minute},
                                  "unreached_bar_peaks": {newer}}}})
    deliver_journal(journal, replica)
    assert replica.snapshot() == snapshots(states)
    states[key]["bid"] = TodayBidPeakState()
    journal.record({key: {"bid": {}}})
    deliver_journal(journal, replica)
    assert replica.snapshot() == snapshots(states)
    states[key]["bid"] = native_states(1, 6)[key]["bid"]
    journal.record({key: {"bid": {}}})
    deliver_journal(journal, replica)
    assert replica.snapshot() == snapshots(states)
    states[key] = native_states(1, 5)[key]  # Seed/owner replacement invalidates old maps.
    journal.record({key: {}}, full=True)
    deliver_journal(journal, replica)
    assert replica.snapshot() == snapshots(states)
    states.pop(key)
    journal.record({key: {}})
    deliver_journal(journal, replica)
    assert replica.snapshot() == snapshots(states)


def test_journal_day_rollover_during_inflight_patch_requires_full_next_snapshot():
    states = native_states(1, 10)
    journal, replica = initialize_journal(states)
    key = next(iter(states))
    journal.record(mutate(states, 1, 1))
    inflight = journal.prepare(key)
    journal.date = "20261026"
    states[key] = native_states(1, 2)[key]
    journal.record({key: {"ask": {}, "bid": {}}})
    replica.apply(json.loads(json.dumps(inflight)))
    journal.commit(inflight)
    assert journal.prepare(key)["full"]
    deliver_journal(journal, replica)
    expected = snapshots(states)
    for side in expected[key].values():
        side["date"] = journal.date
    assert replica.snapshot() == expected


def test_journal_record_tail_patch_handles_append_and_late_prefix_invalidation():
    from hoga.live.ask_peak_state import Peak
    states = native_states(1, 10)
    key = next(iter(states))
    native = states[key]["ask"]
    # Use the actual monotonic record mutation, including replacement of later
    # records by an earlier, larger peak. Append-only IPC would be incorrect.
    native.all_record = []
    for index in range(10):
        native._offer_all_record(Peak(100_000, 100 + index, 1_000_000 + index * 1000))
    journal, replica = initialize_journal(states)
    native._offer_all_record(Peak(100_000, 1000, 1_005_500))
    journal.record({key: {"ask": {"all_record_peaks": {6}}}})
    deliver_journal(journal, replica)
    assert replica.snapshot() == snapshots(states)
    native._offer_all_record(Peak(100_000, 2000, 1_020_000))
    journal.record({key: {"ask": {"all_record_peaks": {len(native.all_record) - 1}}}})
    deliver_journal(journal, replica)
    assert replica.snapshot() == snapshots(states)


def test_single_key_larger_than_8mib_requires_intra_key_chunking():
    from hoga.live.collector_ipc import MAX_FRAME_BYTES, state_frames
    from scripts.probe_collector_ipc_design import status
    current = snapshots(native_states(1, 1))
    key = next(iter(current))
    # all_record has no cap by domain contract. Repeated values share memory
    # only in this framing test; the JSON byte count is still genuinely >8MiB.
    records = [{"price": 100_000, "qty": 1_000_000, "t_ms": 1_792_713_600_000}] * 180_000
    current[key]["ask"]["all_record_peaks"] = records
    with pytest.raises(ValueError, match="peak exceeds byte limit"):
        list(state_frames(status(current)))
    frame = {"epoch": "experiment", "desired_version": 1, "key": key, "revision": 1,
             "base_revision": 0, "full": True, "removed": False, "value": current[key]}
    parts = list(transaction_frames(frame))
    assert sum(map(len, parts)) > MAX_FRAME_BYTES
    assert max(map(len, parts)) - 4 <= FRAME_BUDGET
    assert assemble_transaction(parts) == frame


@pytest.mark.parametrize("fault", ["missing", "epoch", "version", "revision", "key"])
def test_chunked_transaction_never_commits_truncated_or_mixed_key_history(fault):
    from hoga.live.collector_ipc import encode
    frame = {"epoch": "experiment", "desired_version": 1, "key": "005930:KRX", "revision": 1,
             "value": {"all_record_peaks": [1] * 1000}}
    parts = list(transaction_frames(frame, limit=1000))
    if fault == "missing":
        parts.pop()
    else:
        middle = json.loads(parts[1][4:])
        field = "desired_version" if fault == "version" else fault
        middle[field] = 2 if fault in ("version", "revision") else "other"
        parts[1] = encode(middle)
    with pytest.raises(ValueError, match="incomplete|mixed"):
        assemble_transaction(parts)


@pytest.mark.parametrize("yield_every", [0, 8])
async def test_small_frames_need_explicit_yields_even_when_drain_returns_immediately(yield_every):
    states = native_states(32, 2)
    journal, _ = initialize_journal(states)
    journal.record(mutate(states, 32, 1))
    started = asyncio.Event()
    sent, heartbeat_observed_after = [], []

    async def immediate_drain():
        pass  # StreamWriter.drain need not suspend when the transport is writable.

    async def sender():
        started.set()
        for frame in journal.frames():
            sent.append(len(frame))
            await immediate_drain()
            if yield_every and len(sent) % yield_every == 0:
                await asyncio.sleep(0)

    async def heartbeat():
        await started.wait()
        heartbeat_observed_after.append(len(sent))

    await asyncio.gather(sender(), heartbeat())
    assert heartbeat_observed_after == [8 if yield_every else 32]
