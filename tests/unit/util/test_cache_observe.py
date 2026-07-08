from pathlib import Path

from hoga.util.cache_observe import (
    append_record,
    format_report,
    make_record,
    poll_loop,
    read_records,
    summarize,
)


def _status(started_at_ms, *, fresh=0, errors=0, ratio_kind=None):
    cache_stats = {
        "minute_backfill": {"fresh_past_fetches": fresh, "fresh_past_fetch_errors": errors},
        "past_candles": {
            "past": {"hit_rate": 0.9, "lookups": 100},
            "today": {"hit_rate": 0.5, "lookups": 10},
        },
        "index_minute_candles": {"hit_rate": 0.8, "lookups": 20},
    }
    if ratio_kind is not None:
        cache_stats["past_indicators"] = {"ratio": ratio_kind}
    return {"started_at_ms": started_at_ms, "cache_stats": cache_stats}


def test_make_record_keeps_only_needed_fields():
    rec = make_record(_status(1000, fresh=7), wall_ms=42)
    assert rec["wall_ms"] == 42
    assert rec["started_at_ms"] == 1000
    assert rec["cache_stats"]["minute_backfill"]["fresh_past_fetches"] == 7


def test_make_record_tolerates_missing_cache_stats():
    rec = make_record({"started_at_ms": None}, wall_ms=1)
    assert rec["cache_stats"] == {}


def test_summarize_empty():
    r = summarize([])
    assert r["records"] == 0 and r["lifetimes"] == 0 and r["latest"] is None


def test_summarize_segments_by_lifetime_and_resets_fresh_fetches():
    # Run A: fresh climbs 5 → 12. Restart (new started_at_ms). Run B: 0 → 3.
    records = [
        make_record(_status(1000, fresh=5), 1),
        make_record(_status(1000, fresh=12), 2),
        make_record(_status(2000, fresh=0), 3),
        make_record(_status(2000, fresh=3), 4),
    ]
    r = summarize(records)
    assert r["lifetimes"] == 2
    # Each run's final (cumulative peak) fresh count.
    assert [run["fresh_past_fetches"] for run in r["runs"]] == [12, 3]
    # Headline: worst-case session cold re-spend.
    assert r["max_fresh_past_fetches"] == 12


def test_summarize_indicator_disk_ratio():
    # 10 hits, 4 of them from disk → LRU churn ratio 0.4.
    kind = {"hit_rate": 0.7, "lookups": 30, "misses": 9, "hits": 10, "disk_hits": 4}
    r = summarize([make_record(_status(1000, ratio_kind=kind), 1)])
    ratio = r["latest"]["past_indicators"]["ratio"]
    assert ratio["disk_ratio"] == 0.4
    assert ratio["hit_rate"] == 0.7


def test_summarize_latest_uses_most_recent_snapshot():
    records = [make_record(_status(1000, fresh=1), 1), make_record(_status(1000, fresh=9), 2)]
    r = summarize(records)
    assert r["latest"]["past_candles"]["past"]["hit_rate"] == 0.9
    assert r["latest"]["index_minute_candles"]["hit_rate"] == 0.8


def test_format_report_has_gate_sections():
    kind = {"hit_rate": 0.6, "lookups": 5, "misses": 2, "hits": 3, "disk_hits": 2}
    records = [make_record(_status(1000, fresh=42, ratio_kind=kind), 1)]
    text = format_report(summarize(records))
    assert "분봉 디스크 영속 게이트" in text
    assert "42" in text  # the cold re-spend number surfaces
    assert "지표 LRU 사이징" in text


def test_format_report_empty():
    assert "no records" in format_report(summarize([]))


def test_append_and_read_roundtrip(tmp_path: Path):
    path = tmp_path / "sub" / "trail.jsonl"
    append_record(path, make_record(_status(1000, fresh=1), 1))
    append_record(path, make_record(_status(1000, fresh=2), 2))
    records = read_records(path)
    assert len(records) == 2
    assert summarize(records)["runs"][0]["fresh_past_fetches"] == 2


def test_read_records_missing_file(tmp_path: Path):
    assert read_records(tmp_path / "nope.jsonl") == []


def test_poll_loop_writes_count_and_survives_fetch_error(tmp_path: Path, monkeypatch):
    path = tmp_path / "trail.jsonl"
    calls = {"n": 0}

    def fake_fetch(base_url, *, timeout_s=5.0):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("transient server hiccup")
        return _status(1000, fresh=calls["n"])

    monkeypatch.setattr("hoga.util.cache_observe.fetch_status", fake_fetch)
    errors: list[object] = []
    written = poll_loop(
        "http://x", path, interval_s=0, count=3,
        on_sample=lambda rec, err: errors.append(err) if err else None,
        sleep=lambda _s: None, now_ms=lambda: 0,
    )
    # 3 successful writes; the transient error was skipped, not fatal.
    assert written == 3
    assert len(read_records(path)) == 3
    assert len(errors) == 1
