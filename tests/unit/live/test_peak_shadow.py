"""Shadow comparison on real LiveStream callbacks, seed replay and writer output."""
from __future__ import annotations

import json
import random
import weakref
from datetime import datetime

import pytest

from hoga.live.ask_peak_state import Peak
from hoga.live.buffer import LiveBuffer
from hoga.live.peak_changes import PeakChanges, PeakReplica, prepare, wire_roundtrip
from hoga.live.peak_shadow import PeakShadow
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream, build_today_peak_seed
from hoga.live.ticks import WsTick
from hoga.live.writer import LiveWriter
from hoga.util.timeenc import KST

STAMP = int(datetime(2026, 10, 23, 10, tzinfo=KST).timestamp() * 1000)


def book(index=0, *, venue="KRX", code="005930", stamp=None):
    return WsTick(code, stamp or STAMP + index * 1000, SnapshotKind.OB,
                  {"asks": [{"price": 100 + i, "qty": 1000 + i + index} for i in range(10)],
                   "bids": [{"price": 99 - i, "qty": 1000 + i + index} for i in range(10)]}, venue)


def trade(index, *, venue="KRX", code="005930", stamp=None):
    t_ms = stamp or STAMP + index * 1000
    return WsTick(code, t_ms, SnapshotKind.TRADE,
                  {"trades": [{"price": 90 + index % 22, "qty": 1, "side": 1, "t_ms": t_ms}],
                   "cum_volume": index + 1}, venue)


def stream(root, *, shadow=None, date_fn=lambda: "20261023"):
    owner = LiveStream(buffer=LiveBuffer(max_total_entries=1, max_total_bytes=1), writer=LiveWriter(root),
                       date_fn=date_fn, phase_fn=lambda: "regular", signal_monitor_fn=lambda: None,
                       peak_shadow=shadow)
    owner._open_venues = frozenset({"KRX", "NXT", "UN"})
    return owner


def compare_all(shadow, *, wire=True):
    for _ in range(len(shadow.entries)):
        shadow.check_one(wire=wire)
    assert not shadow.disabled, shadow.summary()


@pytest.mark.parametrize("seed", [7, 83, 101])
async def test_real_tick_path_matches_legacy_snapshots_and_durable_output(tmp_path, seed):
    rng = random.Random(seed)
    shadow = PeakShadow(max_sides=16, max_check_ms=float("inf"))
    candidate, reference = stream(tmp_path / "new", shadow=shadow), stream(tmp_path / "old")
    for index in range(140):
        venue = rng.choice(["KRX", "NXT", "UN"])
        make = book if rng.randrange(3) else trade
        tick = make(index, venue=venue, stamp=STAMP + rng.randrange(130) * 1000)
        await candidate.on_tick(tick)
        await reference.on_tick(tick)
        compare_all(shadow)
        for market in ("KRX", "NXT", "UN"):
            assert candidate.ask_peak_snapshot("005930", market) == reference.ask_peak_snapshot("005930", market)
            assert candidate.bid_peak_snapshot("005930", market) == reference.bid_peak_snapshot("005930", market)
    for owner in (reference, candidate):
        await owner.flush_once(now_ms=STAMP + 300_000)
    for path in (tmp_path / "old").rglob("*.jsonl"):
        assert path.read_bytes() == (tmp_path / "new" / path.relative_to(tmp_path / "old")).read_bytes()
    assert shadow.metrics["matched"] > 500
    assert shadow.metrics["delta"] > 0


async def test_unchanged_book_does_not_advance_revision(tmp_path):
    shadow = PeakShadow(max_check_ms=float("inf"))
    owner = stream(tmp_path, shadow=shadow)
    await owner.on_tick(book())
    compare_all(shadow)
    versions = [entry.native().changes.revision for entry in shadow.entries.values()]
    await owner.on_tick(book(stamp=STAMP + 1))
    assert versions == [entry.native().changes.revision for entry in shadow.entries.values()]
    compare_all(shadow)


async def test_seed_install_merge_and_duplicate_replay_remain_exact(tmp_path):
    source = stream(tmp_path / "source")
    for index in range(20):
        await source.on_tick(book(index, stamp=STAMP + index * 60_000))
        await source.on_tick(trade(index, stamp=STAMP + index * 60_000 + 500))
        await source.flush_once(now_ms=STAMP + index * 60_000 + 10_000)
    seed = build_today_peak_seed(code="005930", venue="KRX", date="20261023", live_root=tmp_path / "source")
    assert seed is not None
    shadow = PeakShadow(max_check_ms=float("inf"))
    candidate = stream(tmp_path / "candidate", shadow=shadow)
    assert candidate.install_today_peak_seed(code="005930", venue="KRX", seed=seed) == "installed"
    compare_all(shadow)
    await candidate.on_tick(book(100, stamp=STAMP + 25 * 60_000))
    compare_all(shadow)
    candidate.install_today_peak_seed(code="005930", venue="KRX", seed=seed)
    compare_all(shadow)
    assert candidate.ask_peak_snapshot("005930", "KRX")["coverage"] == "full"


async def test_missing_marker_is_detected_even_if_no_delta_was_emitted(tmp_path):
    shadow = PeakShadow(max_check_ms=float("inf"))
    owner = stream(tmp_path, shadow=shadow)
    await owner.on_tick(book())
    compare_all(shadow)
    native = owner._ask_peak_by_code[("005930", "KRX")]
    minute = min(native.all_bar_max)
    native.all_bar_max[minute] = Peak(100, 99999, STAMP)  # Deliberately omit invalidation.
    shadow.check_one()
    assert shadow.disabled and shadow.metrics["mismatches"] == 1
    assert shadow.first_failure["fields"] == ["all_bar_peaks"]
    assert not shadow.entries and native.changes is None
    await owner.on_tick(book(2))
    await owner.flush_once(now_ms=STAMP + 10_000)
    assert owner.storage_error is None


async def test_diagnostic_exception_does_not_escape_or_break_storage(tmp_path, monkeypatch):
    from hoga.live import peak_shadow as module
    shadow = PeakShadow()
    owner = stream(tmp_path, shadow=shadow)
    await owner.on_tick(book())
    monkeypatch.setattr(module, "prepare", lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("fault")))
    shadow.check_one()
    assert shadow.disabled and shadow.metrics["errors"] == 1
    assert all(state.changes is None for state in owner._ask_peak_by_code.values())
    await owner.on_tick(trade(1))
    await owner.flush_once(now_ms=STAMP + 10_000)
    assert list(tmp_path.rglob("*.jsonl"))


async def test_bookkeeping_exception_is_also_isolated(tmp_path, monkeypatch):
    shadow = PeakShadow()
    owner = stream(tmp_path, shadow=shadow)
    await owner.on_tick(book())
    monkeypatch.setattr(shadow, "points", lambda: (_ for _ in ()).throw(RuntimeError("fault")))
    shadow.check_one()
    assert shadow.disabled and shadow.metrics["errors"] == 1 and not shadow.entries
    await owner.on_tick(book(1))


def test_capture_worker_wires_one_shared_opt_in_observer(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from hoga.live.collector_worker import CollectorWorker
    options = {}

    def factory(**kwargs):
        options.update(kwargs["stream_options"])
        return SimpleNamespace()

    monkeypatch.setenv("HOGA_PEAK_SHADOW", "1")
    worker = CollectorWorker(tmp_path, "epoch", None, manager_factory=factory)
    assert options["peak_shadow"] is worker.peak_shadow
    assert worker.peak_shadow is not None


async def test_admission_point_and_time_budgets_release_shadow_state(tmp_path):
    shadow = PeakShadow(max_sides=1, max_side_points=1)
    owner = stream(tmp_path, shadow=shadow)
    await owner.on_tick(book())
    assert shadow.metrics["admission_rejected"] == 1
    shadow.check_one()
    assert shadow.metrics["point_budget_rejected"] == 1
    assert not shadow.entries and shadow.points() == 0
    timer = PeakShadow(max_check_ms=-1)
    other = stream(tmp_path / "timed", shadow=timer)
    await other.on_tick(book())
    timer.check_one()
    assert timer.metrics["time_budget_rejected"] == 1


async def test_membership_day_and_weak_owner_cleanup_cannot_accumulate_replicas(tmp_path):
    shadow = PeakShadow(max_check_ms=float("inf"))
    date = ["20261023"]
    owner = stream(tmp_path, shadow=shadow, date_fn=lambda: date[0])
    for index in range(50):
        owner.set_active_codes({"005930"})
        await owner.on_tick(book(index))
        compare_all(shadow)
        assert len(shadow.order) == len(shadow.entries) == 2
        owner.set_active_codes(set())
        assert not shadow.entries and shadow.points() == 0
    owner.set_active_codes({"005930"})
    await owner.on_tick(book())
    old_generations = {entry.replica.generation for entry in shadow.entries.values()}
    date[0] = "20261026"
    await owner.on_tick(book(1))
    compare_all(shadow)
    assert old_generations.isdisjoint({entry.replica.generation for entry in shadow.entries.values()})
    ref = weakref.ref(owner)
    del owner
    assert ref() is None
    shadow.prune()
    assert shadow.summary()["active_sides"] == 0


def test_explicit_opt_in_and_code_filter(monkeypatch, tmp_path):
    monkeypatch.delenv("HOGA_PEAK_SHADOW", raising=False)
    assert PeakShadow.from_env() is None
    monkeypatch.setenv("HOGA_PEAK_SHADOW", "1")
    monkeypatch.setenv("HOGA_PEAK_SHADOW_CODES", "005930")
    shadow = PeakShadow.from_env()
    assert shadow.codes == frozenset({"005930"})


def test_wire_parts_roundtrip_large_record_and_fail_at_staging_budget():
    message = {"generation": "g", "revision": 1, "value": [{"qty": i} for i in range(20_000)]}
    result, _, parts = wire_roundtrip(message)
    assert parts > 1 and result == message
    with pytest.raises(ValueError, match="budget"):
        wire_roundtrip(message, byte_limit=100)


def test_replica_rejects_generation_gap_and_stale_revision():
    replica = PeakReplica("new")
    with pytest.raises(ValueError, match="generation"):
        replica.apply({"generation": "old", "revision": 1})
    with pytest.raises(ValueError, match="base"):
        replica.apply({"generation": "new", "revision": 2, "base": 1, "full": False})
    replica.apply({"generation": "new", "revision": 1, "base": 0, "full": True, "value": None})
    with pytest.raises(ValueError, match="regression"):
        replica.apply({"generation": "new", "revision": 1})


def test_record_splice_and_minutes_coalesce_until_sampling():
    from hoga.live.ask_peak_state import TodayAskPeakState
    native = TodayAskPeakState(changes=PeakChanges())
    replica = PeakReplica("g")
    for index in range(12):
        native.ingest_orderbook(t_ms=STAMP + index * 60_000, asks=[{"price": 100, "qty": index + 1}])
    message = prepare(native, base=0, generation="g", empty=True)
    replica.apply(json.loads(json.dumps(message)))
    native.changes.clear()
    native.ingest_orderbook(t_ms=STAMP + 6 * 60_000 + 500, asks=[{"price": 101, "qty": 99}])
    native.ingest_orderbook(t_ms=STAMP + 13 * 60_000, asks=[{"price": 102, "qty": 100}])
    message = prepare(native, base=replica.revision, generation="g", empty=False)
    assert not message["full"] and message["record"]["start"] == 7
    replica.apply(wire_roundtrip(message)[0])
    assert replica.snapshot() == native.snapshot()


@pytest.mark.parametrize("value", [None, True, False, {}, [], {"한글": 'a"\\\n'},
                                   {"array": [1, -2, None, False, [1.5]], "nested": {"x": 2}}])
def test_iterative_encoder_matches_standard_json_without_recursive_closure_graph(value):
    from hoga.live.peak_changes import json_tokens
    actual = "".join(json_tokens(value))
    assert actual == json.dumps(value, separators=(",", ":"), ensure_ascii=False)


async def test_diagnostic_summary_fault_cannot_terminate_worker_state_sender(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from hoga.live.collector_ipc import LatestStateOutbox, PeakSnapshotDelta
    from hoga.live.collector_worker import CollectorWorker
    shadow = PeakShadow()
    owner = stream(tmp_path, shadow=shadow)
    await owner.on_tick(book())
    worker = object.__new__(CollectorWorker)
    worker.peak_shadow = shadow
    worker.manager = SimpleNamespace(capture_streams=lambda: [owner])
    worker.state_sequence = 30
    worker.state = lambda: {"sequence": 30, "desired_version": 1, "peaks": {}}
    worker.peak_delta, worker.state_outbox = PeakSnapshotDelta(), LatestStateOutbox()
    monkeypatch.setattr(shadow, "summary", lambda: (_ for _ in ()).throw(RuntimeError("summary fault")))
    sender = asyncio.create_task(worker.states())
    try:
        await asyncio.sleep(0)
        assert not sender.done() and worker.state_outbox.frames
        assert worker.peak_shadow is None and not shadow.entries
        assert all(state.changes is None for state in owner._ask_peak_by_code.values())
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)


async def test_replacement_stream_is_sampled_even_before_retired_owner_is_garbage_collected(tmp_path):
    shadow = PeakShadow(max_sides=2, max_check_ms=float("inf"))
    retired = stream(tmp_path / "retired", shadow=shadow)
    await retired.on_tick(book())
    compare_all(shadow)
    generations = {entry.replica.generation for entry in shadow.entries.values()}
    replacement = stream(tmp_path / "replacement", shadow=shadow)
    await replacement.on_tick(book(2))  # Full sample initially rejects these two states.
    shadow.reconcile([replacement])
    compare_all(shadow)
    assert all(entry.owner() is replacement for entry in shadow.entries.values())
    assert generations.isdisjoint({entry.replica.generation for entry in shadow.entries.values()})
    assert all(native.changes is None for native in retired._ask_peak_by_code.values())


async def test_budget_rejected_states_are_not_retried_each_worker_pass(tmp_path):
    shadow = PeakShadow(max_side_points=1)
    owner = stream(tmp_path, shadow=shadow)
    await owner.on_tick(book())
    for _ in range(3):
        shadow.check_one()
    before = shadow.metrics["point_budget_rejected"]
    for _ in range(10):
        shadow.reconcile([owner])
        shadow.check_one()
    assert shadow.metrics["point_budget_rejected"] == before
    assert not shadow.entries and len(shadow.blocked) == 2
