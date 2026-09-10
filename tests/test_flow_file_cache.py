from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pydantic import BaseModel

from hoga.live.flow_file_cache import load_flow_samples
from hoga.live.investor_flow_store import IntradaySample, compute_coverage


class Sample(BaseModel):
    value: int


def test_coalesces_parallel_reads_and_invalidates_on_append(tmp_path, monkeypatch):
    path = tmp_path / "day.jsonl"
    path.write_bytes(b'{"value":1}\n')
    calls = []
    original = Path.read_bytes

    def read(p):
        calls.append(p)
        return original(p)

    monkeypatch.setattr(Path, "read_bytes", read)
    with ThreadPoolExecutor(max_workers=5) as pool:
        result = list(pool.map(lambda _: load_flow_samples(path, Sample), range(5)))
    assert len(calls) == 1
    assert all(samples[0].value == 1 for samples in result)
    result[0].clear()  # returned list is not the cache's container
    with path.open("ab") as f:
        f.write(b'{"value":2}\n')
    assert [s.value for s in load_flow_samples(path, Sample)] == [1, 2]
    assert len(calls) == 2


def test_partial_tail_corruption_replacement_truncate_and_delete(tmp_path):
    path = tmp_path / "day.jsonl"
    path.write_bytes(b'{"value":1}\nBAD\n{"value":')
    assert [s.value for s in load_flow_samples(path, Sample)] == [1]
    with path.open("ab") as f:
        f.write(b'2}\n')
    assert [s.value for s in load_flow_samples(path, Sample)] == [1, 2]
    replacement = tmp_path / "new.jsonl"
    replacement.write_bytes(b'{"value":3}\n')
    replacement.replace(path)
    assert load_flow_samples(path, Sample)[0].value == 3
    path.write_bytes(b'')
    assert load_flow_samples(path, Sample) == []
    path.unlink()
    assert load_flow_samples(path, Sample) == []


def test_append_during_read_is_not_cached_as_newer_version(tmp_path, monkeypatch):
    path = tmp_path / "day.jsonl"
    path.write_bytes(b'{"value":1}\n')
    original = Path.read_bytes

    def read(p):
        raw = original(p)
        with p.open("ab") as f:
            f.write(b'{"value":2}\n')
        return raw

    monkeypatch.setattr(Path, "read_bytes", read)
    assert len(load_flow_samples(path, Sample)) == 1
    monkeypatch.setattr(Path, "read_bytes", original)
    assert len(load_flow_samples(path, Sample)) == 2


def test_new_cadence_does_not_reinterpret_legacy_samples():
    def sample(t, interval=None):
        return IntradaySample(sampled_at_ms=t, poll_interval_ms=interval, request={}, rows=[])

    samples = [sample(0), sample(31_000), sample(61_000, 10_000), sample(92_000, 10_000)]
    gaps = compute_coverage(samples, poll_interval_ms=10_000).gap_ranges
    assert gaps == [{"start_ms": 61_000, "end_ms": 92_000}]
