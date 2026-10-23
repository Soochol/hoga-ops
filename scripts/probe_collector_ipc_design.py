"""Offline IPC design experiment; no application startup, credentials or vendor IO.

Run: uv run --extra dev python -m scripts.probe_collector_ipc_design --output PATH
This is a design prototype, deliberately outside the production collector.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import platform
import socket
import statistics
import subprocess
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from hoga.live.ask_peak_state import Peak, TodayAskPeakState, TodayBidPeakState
from hoga.live.collector_ipc import (
    PeakSnapshotDelta,
    encode,
    open_channel,
    read_frame,
    state_frames,
)

MINUTE_FIELDS = ("traded_bar_peaks", "all_bar_peaks", "unreached_bar_peaks")
FRAME_BUDGET = 256 * 1024
STAMP = 1_792_713_600_000
NATIVE_FIELDS = dict(zip(MINUTE_FIELDS, ("traded_bar_max", "all_bar_max", "unreached_bar_max"), strict=True))
RECORD_FIELD = "all_record_peaks"


def normalize(side):
    if side is None:
        return None
    return {"fields": {k: v for k, v in side.items() if k not in MINUTE_FIELDS},
            "minutes": {field: {str(point["t_ms"] // 60_000): point for point in side.get(field, [])}
                        for field in MINUTE_FIELDS}}


def materialize(side):
    if side is None:
        return None
    return {**side["fields"], **{field: sorted(points.values(), key=lambda point: point["t_ms"])
                               for field, points in side["minutes"].items()}}


def mapping_patch(before, after):
    return {"set": {k: v for k, v in after.items() if k not in before or before[k] != v},
            "remove": sorted(before.keys() - after.keys())}


def apply_mapping(value, patch):
    value.update(patch["set"])
    for key in patch["remove"]:
        value.pop(key, None)


def peak_patch(before, after):
    changes = {}
    for side in ("ask", "bid"):
        old, new = normalize(before.get(side)), normalize(after.get(side))
        if old == new:
            continue
        if old is None or new is None or old["fields"].get("date") != new["fields"].get("date"):
            changes[side] = {"replace": after.get(side)}
            continue
        fields = mapping_patch(old["fields"], new["fields"])
        minutes = {field: mapping_patch(old["minutes"][field], new["minutes"][field]) for field in MINUTE_FIELDS}
        changes[side] = {"fields": fields, "minutes": minutes}
    return changes


class Producer:
    """Per-key base advances only when its frame enters the reliable ordered lane.

    prepare is pure: an overwritten pending snapshot must not advance its base.
    Full synchronization/RPC uses the same key revision as patches, never a
    separate unordered counter. Epoch/version and key removal remain explicit.
    """
    def __init__(self, mode="minute_patch", epoch="experiment", version=1):
        self.mode, self.epoch, self.version = mode, epoch, version
        self.previous, self.revisions = {}, {}
        self.latest, self.source_revisions = {}, {}

    def observe(self, current):
        for key in self.latest.keys() | current.keys():
            value = current.get(key)
            if key not in self.latest or self.latest[key] != value:
                self.latest[key] = value
                self.source_revisions[key] = self.source_revisions.get(key, 0) + 1

    def prepare(self, key, value):
        if key not in self.latest or self.latest[key] != value:
            self.latest[key] = value
            self.source_revisions[key] = self.source_revisions.get(key, 0) + 1
        old = self.previous.get(key)
        if self.source_revisions[key] == self.revisions.get(key, 0):
            return None
        revision = self.revisions.get(key, 0)
        frame = {"epoch": self.epoch, "desired_version": self.version, "key": key,
                 "base_revision": revision, "revision": self.source_revisions[key], "removed": value is None}
        if value is None:
            return {**frame, "full": True, "value": None}
        if old is None or self.mode == "key_snapshot":
            return {**frame, "full": True, "value": value}
        return {**frame, "full": False, "patch": peak_patch(old, value)}

    def commit(self, frame, value):
        self.revisions[frame["key"]] = frame["revision"]
        self.previous[frame["key"]] = value

    def frames(self, current):
        self.observe(current)
        for key in sorted(self.previous.keys() | current.keys()):
            value = current.get(key)
            frame = self.prepare(key, value)
            if frame is not None:
                encoded = encode(frame, limit=FRAME_BUDGET)
                yield encoded
                self.commit(frame, value)


class Replica:
    def __init__(self, epoch="experiment", version=1):
        self.epoch, self.version = epoch, version
        self.values, self.revisions = {}, {}
        self.needs_resync = set()
        self.expected = {}

    def heartbeat(self, revisions):
        self.expected = revisions.copy()

    def apply(self, frame):
        if frame["epoch"] != self.epoch or frame["desired_version"] != self.version:
            raise ValueError("old epoch/version")
        key = frame["key"]
        revision = self.revisions.get(key, 0)
        if frame["revision"] <= revision:
            return False
        if not frame["full"] and frame["base_revision"] != revision:
            self.needs_resync.add(key)
            return False
        if frame["removed"]:
            self.values.pop(key, None)
        elif frame["full"]:
            self.values[key] = {side: normalize(value) for side, value in frame["value"].items()}
        else:
            for side, patch in frame["patch"].items():
                if "replace" in patch:
                    self.values[key][side] = normalize(patch["replace"])
                    continue
                target = self.values[key][side]
                apply_mapping(target["fields"], patch["fields"])
                for field, delta in patch["minutes"].items():
                    apply_mapping(target["minutes"][field], delta)
                for field, delta in patch.get("arrays", {}).items():
                    target["fields"][field][delta["start"]:] = delta["values"]
        self.revisions[key] = frame["revision"]
        self.needs_resync.discard(key)
        return True

    def snapshot(self):
        return {key: {side: materialize(value) for side, value in sides.items()}
                for key, sides in self.values.items()
                if key not in self.needs_resync and self.revisions.get(key, 0) >= self.expected.get(key, 0)}


class NativeJournal:
    """Experiment: dirty minute versions collected at native mutation boundaries.

    Production does not yet provide these hints. Tests compare this extraction
    to real complete snapshots; integrating all ingest/seed/rollover mutations
    is a separate implementation requirement, not an assumed finished feature.
    """
    def __init__(self, states):
        self.states, self.pending = states, {}
        self.source_revisions, self.sent = {}, {}
        self.date, self.sent_dates = "20261023", {}
        self.force_full, self.available = {}, {}

    def initial_frames(self, current):
        for key, value in current.items():
            frame = {"epoch": "experiment", "desired_version": 1, "key": key,
                     "base_revision": 0, "revision": 1, "removed": False, "full": True, "value": value}
            yield encode(frame, limit=FRAME_BUDGET)
            self.source_revisions[key] = self.sent[key] = 1
            self.sent_dates[key] = self.date
            self.available[key] = {side: payload is not None for side, payload in value.items()}

    def record(self, hints, *, full=False):
        for key, sides in hints.items():
            revision = self.source_revisions.get(key, 0) + 1
            self.source_revisions[key] = revision
            if full:
                self.force_full[key] = revision
            pending = self.pending.setdefault(key, {})
            for side, fields in sides.items():
                target = pending.setdefault(side, {})
                for field, minutes in fields.items():
                    target.setdefault(field, {}).update(dict.fromkeys(minutes, revision))

    def prepare(self, key):
        revision = self.source_revisions[key]
        frame = {"epoch": "experiment", "desired_version": 1, "key": key,
                 "base_revision": self.sent.get(key, 0), "revision": revision, "removed": False,
                 "trading_date": self.date}
        if key not in self.states:
            return {**frame, "removed": True, "full": True, "value": None}
        if self.sent_dates.get(key) != self.date or key in self.force_full:
            value = native_value(self.states[key], self.date)
            return {**frame, "full": True, "value": value}
        patch = {}
        for side, fields in self.pending[key].items():
            native = self.states[key][side]
            # Reuse real scalar/rank logic with empty minute maps. No full-day
            # minute lists are constructed and no native object is modified.
            meta = replace(native, traded_bar_max={}, all_bar_max={}, unreached_bar_max={}, all_record=[]).snapshot()
            if meta is None or not self.available.get(key, {}).get(side, False):
                value = native.snapshot()
                patch[side] = {"replace": None if value is None else {"date": self.date, **value}}
                continue
            scalar = {"date": self.date,
                      **{k: v for k, v in meta.items() if k not in (*MINUTE_FIELDS, RECORD_FIELD)}}
            minutes = {}
            arrays = {}
            for field, dirty in fields.items():
                if field == RECORD_FIELD:
                    if dirty:
                        start = min(dirty)
                        arrays[field] = {"start": start,
                                         "values": [{"price": p.price, "qty": p.qty, "t_ms": p.t_ms}
                                                    for p in native.all_record[start:]]}
                    continue
                values = getattr(native, NATIVE_FIELDS[field])
                minutes[field] = {"set": {str(minute): {"price": values[minute].price, "qty": values[minute].qty,
                                                      "t_ms": values[minute].t_ms}
                                         for minute in dirty if minute in values},
                                  "remove": [str(minute) for minute in dirty if minute not in values]}
            patch[side] = {"fields": {"set": scalar, "remove": []}, "minutes": minutes, "arrays": arrays}
        return {**frame, "full": False, "patch": patch}

    def commit(self, frame):
        key, revision = frame["key"], frame["revision"]
        self.sent[key], self.sent_dates[key] = revision, frame["trading_date"]
        if frame["full"]:
            self.available[key] = {side: value is not None for side, value in (frame["value"] or {}).items()}
        else:
            for side, patch in frame["patch"].items():
                if "replace" in patch:
                    self.available.setdefault(key, {})[side] = patch["replace"] is not None
        if self.force_full.get(key, revision + 1) <= revision:
            self.force_full.pop(key)
        for fields in self.pending[key].values():
            for field, minutes in fields.items():
                fields[field] = {minute: version for minute, version in minutes.items() if version > revision}
        if self.source_revisions[key] <= revision:
            self.pending.pop(key)

    def frames(self):
        for key in sorted(self.pending):
            frame = self.prepare(key)
            yield encode(frame, limit=FRAME_BUDGET)
            self.commit(frame)


def native_states(count, minutes):
    states = {}
    for index in range(count):
        sides = {}
        for side, factory in (("ask", TodayAskPeakState), ("bid", TodayBidPeakState)):
            state = factory(coverage="full", day_extreme=100_000 + index)
            for field in ("traded_bar_max", "all_bar_max", "unreached_bar_max"):
                setattr(state, field, {(STAMP // 60_000) + minute:
                                      Peak(100_000 + index + minute % 7, 10_000 + minute,
                                           STAMP + minute * 60_000 + 1234)
                                      for minute in range(minutes)})
            top = list(state.all_bar_max.values())[-3:]
            state.all_top = state.closed_traded = top[::-1]
            state.all_peak, state.traded_peak = top[-1], top[-1]
            state.all_record = state.traded_record = top
            sides[side] = state
        states[f"{index:06}:KRX"] = sides
    return states


def native_value(sides, date="20261023"):
    result = {}
    for side, native in sides.items():
        value = native.snapshot()
        result[side] = None if value is None else {"date": date, **value}
    return result


def snapshots(states):
    return {key: native_value(sides) for key, sides in states.items()}


def mutate(states, changed, turn):
    hints = {}
    for key in sorted(states)[:changed]:
        hints[key] = {}
        for side, value in states[key].items():
            hints[key][side] = {}
            for field, native_field in NATIVE_FIELDS.items():
                minute = max(getattr(value, native_field))
                getattr(value, native_field)[minute].qty += turn + 1
                hints[key][side][field] = {minute}
            hints[key][side][RECORD_FIELD] = {0}  # Fixture's three record peaks share changed Peak objects.
            value.day_extreme += 1
    return hints


def status(peaks, sequence=1):
    return {"epoch": "experiment", "desired_version": 1, "sequence": sequence,
            "observed_at_ms": STAMP + sequence * 1000, "ready": True,
            "status": {"connected_accounts": 6, "last_tick_ms": STAMP},
            "storage_errors": [], "peaks": peaks}


def measure_frames(iterator):
    sizes, slices, started = [], [], time.perf_counter()
    while True:
        begin = time.perf_counter()
        try:
            frame = next(iterator)
        except StopIteration:
            slices.append((time.perf_counter() - begin) * 1000)
            break
        slices.append((time.perf_counter() - begin) * 1000)
        sizes.append(len(frame))
    return {"bytes": sum(sizes), "frames": len(sizes), "max_payload_bytes": max(sizes, default=4) - 4,
            "encode_ms": (time.perf_counter() - started) * 1000,
            "max_encoder_slice_ms": max(slices, default=0)}


def scenario(count, minutes, changed, repetitions):
    states = native_states(count, minutes)
    begin = time.perf_counter()
    initial = snapshots(states)
    initial_snapshot_ms = (time.perf_counter() - begin) * 1000
    baseline = PeakSnapshotDelta()
    a_initial = measure_frames(state_frames(baseline.apply(status(initial), queued=False)))
    producers = {mode: Producer(mode) for mode in ("key_snapshot", "minute_patch")}
    measurements = {"current": {"initial": a_initial, "updates": []}}
    for mode, producer in producers.items():
        measurements[mode] = {"initial": measure_frames(producer.frames(initial)), "updates": []}
    journal = NativeJournal(states)
    measurements["native_journal"] = {"initial": measure_frames(journal.initial_frames(initial)), "updates": []}
    snapshot_times = []
    record_times = []
    for turn in range(repetitions):
        hints = mutate(states, changed, turn)
        begin = time.perf_counter()
        journal.record(hints)
        record_times.append((time.perf_counter() - begin) * 1000)
        measurements["native_journal"]["updates"].append(measure_frames(journal.frames()))
        begin = time.perf_counter()
        current = snapshots(states)
        snapshot_times.append((time.perf_counter() - begin) * 1000)
        begin = time.perf_counter()
        delta = baseline.apply(status(current, turn + 2), queued=False)
        diff_ms = (time.perf_counter() - begin) * 1000
        result = measure_frames(state_frames(delta))
        result["encode_ms"] += diff_ms
        result["max_encoder_slice_ms"] = max(result["max_encoder_slice_ms"], diff_ms)
        measurements["current"]["updates"].append(result)
        for mode, producer in producers.items():
            measurements[mode]["updates"].append(measure_frames(producer.frames(current)))
    for result in measurements.values():
        updates = result.pop("updates")
        result["update_median"] = {key: statistics.median(item[key] for item in updates) for key in updates[0]}
    # Queue-pressure recovery costs: current regenerates every tracked key.
    recovery = measure_frames(state_frames(baseline.apply(status(current, repetitions + 2), queued=True)))
    return {"keys": count, "minutes": minutes, "changed_keys": changed,
            "snapshot_build_ms": {"initial": initial_snapshot_ms, "update_median": statistics.median(snapshot_times)},
            "journal_record_median_ms": statistics.median(record_times),
            "designs": measurements, "current_overwrite_recovery": recovery,
            "transport_model": {f"{rate}_MiB_per_s": {
                "current_initial_health_wait_s": a_initial["bytes"] / (rate * 1024 * 1024),
                "current_overwrite_health_wait_s": recovery["bytes"] / (rate * 1024 * 1024),
                "separate_health_payload_bytes": len(encode({k: v for k, v in status({}).items() if k != "peaks"})),
            } for rate in (1, 8)}}


async def blocked_peak_lane_probe():
    """Actual private socket backpressure; no artificial multi-second sleeps."""
    pairs = [socket.socketpair() for _ in range(2)]
    pairs[0][0].setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
    channels = [await open_channel(sock) for pair in pairs for sock in pair]
    (_, data_send), (_, data_recv), (_, health_send), (health_reader, health_recv) = channels
    data_recv.transport.pause_reading()
    frame = encode({"payload": "x" * (FRAME_BUDGET - 100)})
    data_send.write(frame)
    data_send.write(frame)  # Exceed open_channel's 256KiB high watermark.
    pending = asyncio.create_task(data_send.drain())
    try:
        await asyncio.sleep(0)
        blocked = not pending.done()
        samples = []
        for sequence in range(20):
            begin = time.perf_counter()
            health_send.write(encode({k: v for k, v in status({}, sequence).items() if k != "peaks"}))
            await health_send.drain()
            received = await read_frame(health_reader)
            assert received["sequence"] == sequence
            samples.append((time.perf_counter() - begin) * 1000)
        return {"peak_drain_blocked": blocked, "heartbeats_received_while_blocked": len(samples),
                "heartbeat_roundtrip_median_ms": statistics.median(samples),
                "heartbeat_roundtrip_max_ms": max(samples),
                "peak_drain_still_blocked": not pending.done()}
    finally:
        pending.cancel()
        for _, writer in channels:
            writer.transport.abort()
        await asyncio.gather(pending, return_exceptions=True)


def transaction_frames(message, *, limit=FRAME_BUDGET):
    """Prototype intra-key chunking, including histories larger than 8MiB.

    Uses incremental JSON tokens; no complete encoded message is built first.
    The receiver must stage one transaction and enforce a separate cache budget.
    """
    chunks, size, part = [], 0, 0
    for token in json.JSONEncoder(separators=(",", ":"), ensure_ascii=False).iterencode(message):
        for start in range(0, len(token), limit // 8):
            piece = token[start:start + limit // 8]
            if size + len(piece) > limit // 8 and chunks:
                yield encode({"epoch": message["epoch"], "desired_version": message["desired_version"],
                              "key": message["key"], "revision": message["revision"], "part": part,
                              "last": False, "data": "".join(chunks)}, limit=limit)
                chunks, size, part = [], 0, part + 1
            chunks.append(piece)
            size += len(piece)
    yield encode({"epoch": message["epoch"], "desired_version": message["desired_version"],
                  "key": message["key"], "revision": message["revision"], "part": part,
                  "last": True, "data": "".join(chunks)}, limit=limit)


def assemble_transaction(frames):
    parts, identity = [], None
    for expected, encoded in enumerate(frames):
        frame = json.loads(encoded[4:])
        current = (frame["epoch"], frame["desired_version"], frame["key"], frame["revision"])
        if identity is None:
            identity = current
        if current != identity or frame["part"] != expected:
            raise ValueError("mixed or missing transaction part")
        parts.append(frame["data"])
        if frame["last"]:
            result = json.loads("".join(parts))
            if (result["epoch"], result["desired_version"], result["key"], result["revision"]) != identity:
                raise ValueError("transaction identity mismatch")
            return result
    raise ValueError("incomplete transaction")


def dense_record_probe(count=200_000):
    states = native_states(1, 390)
    key = next(iter(states))
    for native in states[key].values():
        native.all_record = [Peak(100_000, 10_000 + i, STAMP + i * 50) for i in range(count)]
    current = snapshots(states)
    full = {"epoch": "experiment", "desired_version": 1, "key": key, "base_revision": 0,
            "revision": 1, "full": True, "removed": False, "value": current[key]}
    legacy_failure = None
    try:
        list(state_frames(status(current)))
    except ValueError as error:
        legacy_failure = str(error)
    begin = time.perf_counter()
    chunked = measure_frames(transaction_frames(full))
    chunked["total_ms"] = (time.perf_counter() - begin) * 1000
    journal = NativeJournal(states)
    journal.source_revisions[key] = journal.sent[key] = 1
    journal.sent_dates[key] = journal.date
    journal.available[key] = {"ask": True, "bid": True}
    for native in states[key].values():
        native.all_record.append(Peak(100_000, 10_000 + count, STAMP + count * 50))
    journal.record({key: {side: {RECORD_FIELD: {count}} for side in ("ask", "bid")}})
    update = measure_frames(journal.frames())
    return {"records_per_side": count, "current_single_key_failure": legacy_failure,
            "chunked_initial": chunked, "journal_append_update": update}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=5)
    args = parser.parse_args()
    cases = [(12, 30, 12), (12, 390, 12), (100, 390, 1), (100, 390, 100),
             (512, 390, 0), (512, 390, 512)]
    results = []
    for count, minutes, changed in cases:
        result = scenario(count, minutes, changed, args.repetitions)
        results.append(result)
        print(f"keys={count} minutes={minutes} changed={changed} "
              f"current={result['designs']['current']['update_median']['bytes']}B "
              f"patch={result['designs']['minute_patch']['update_median']['bytes']}B", flush=True)
    sources = [Path(__file__), Path("hoga/live/ask_peak_state.py"), Path("hoga/live/collector_ipc.py")]
    report = {"recorded_at_kst": datetime.now(ZoneInfo("Asia/Seoul")).isoformat(),
              "base_commit": subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip(),
              "input_sha256": {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources},
              "environment": {"python": platform.python_version(), "platform": platform.platform(),
                              "packages": {name: importlib.metadata.version(name) for name in ("pytest", "ruff")}},
              "repetitions": args.repetitions, "scenarios": results,
              "actual_socket_probe": asyncio.run(blocked_peak_lane_probe()),
              "dense_record_probe": dense_record_probe(),
              "caveats": ["Synthetic histories built using real TodayAsk/BidPeakState.snapshot().",
                          "Current/key_snapshot/minute_patch share full source snapshot cost, reported separately.",
                          "native_journal reads explicit dirty minutes and metadata, avoiding full update snapshots.",
                          "Minute diff scans full lists; native dirty revisions are not assumed.",
                          "native_journal needs exact dirty markers for ingest, seed and rollover.",
                          "Intra-key chunking is a prototype; production cache budgets remain to implement.",
                          "Timings cover diff/encoding, excluding receiver application, RSS and vendor load.",
                          "Transfer wait uses a bandwidth model; socket probe uses actual backpressure.",
                          "No production code replacement, restart or real credentials used."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
