"""disk_state.check_disk_state classifies a (code, date) directory into one of four states."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.disk_state import (
    DiskState,
    check_disk_state,
    classify_from_meta,
    has_meaningful_gaps,
)
from hoga.api.timeenc import HogaMs


def test_disk_state_enum_has_six_members() -> None:
    assert set(DiskState) == {
        DiskState.NONE,
        DiskState.NO_UPSTREAM_DATA,
        DiskState.CLIENT_INCOMPLETE,
        DiskState.SOURCE_PARTIAL,
        DiskState.INVALID,
        DiskState.COMPLETE,
    }


def test_none_when_no_directory_exists(tmp_path: Path) -> None:
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.NONE


def test_client_incomplete_when_only_raw_exists(tmp_path: Path) -> None:
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "first_001.tsv").write_text("dummy\n", encoding="utf-8")
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.CLIENT_INCOMPLETE


def test_client_incomplete_only_if_first_pages_exist(tmp_path: Path) -> None:
    """Empty raw dir or one with only info.tsv shouldn't be classified as in-progress."""
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "info.tsv").write_text("info\n", encoding="utf-8")
    # No first_*.tsv files yet — collector died before storing any page.
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.NONE


def _write_meta(tmp_path: Path, code: str, date: str, **fields: object) -> None:
    parquet_dir = tmp_path / "parquet" / date / code
    parquet_dir.mkdir(parents=True)
    (parquet_dir / "meta.json").write_text(
        json.dumps({
            "code": code,
            "name": "삼성전자",
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
            "prev_close": 50000,
            "upper_limit": 65000,
            "lower_limit": 35000,
            "today_open": 50500,
            "today_high": 51000,
            "today_low": 50000,
            "today_close": 50800,
            "pages_collected": 47,
            **fields,
        }, ensure_ascii=False),
        encoding="utf-8",
    )


def test_complete_when_meta_says_complete_and_not_partial(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=True, is_partial=False)
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.COMPLETE


def test_source_partial_when_meta_says_complete_but_partial(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=True, is_partial=True)
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.SOURCE_PARTIAL


def test_client_incomplete_when_meta_says_not_complete(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=False, is_partial=True)
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.CLIENT_INCOMPLETE


def test_legacy_meta_without_bits_defaults_to_client_incomplete(tmp_path: Path) -> None:
    """Pre-foundation meta.json has no completeness fields. Conservative default:
    treat as client_incomplete so the worker tries to resume and upgrade the meta."""
    _write_meta(tmp_path, "005930", "20260520")  # neither field
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.CLIENT_INCOMPLETE


def test_classify_from_meta_complete() -> None:
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
    }
    assert classify_from_meta(meta).state == DiskState.COMPLETE


def test_classify_from_meta_source_partial() -> None:
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": True,
    }
    assert classify_from_meta(meta).state == DiskState.SOURCE_PARTIAL


def test_classify_from_meta_client_incomplete_when_not_complete() -> None:
    # If collection didn't finish, the value of is_partial is irrelevant —
    # CLIENT_INCOMPLETE wins. This is the "normalize ambiguity" guarantee
    # callers rely on.
    assert classify_from_meta(
        {"collection_complete": False, "is_partial": False},
    ).state == DiskState.CLIENT_INCOMPLETE
    assert classify_from_meta(
        {"collection_complete": False, "is_partial": True},
    ).state == DiskState.CLIENT_INCOMPLETE


def test_classify_from_meta_legacy_empty_dict() -> None:
    """Pre-foundation meta with neither field → CLIENT_INCOMPLETE (conservative)."""
    assert classify_from_meta({}).state == DiskState.CLIENT_INCOMPLETE


def test_classify_from_meta_archived_series_error_forces_invalid() -> None:
    """ADR-0020: series invariants are too costly to live-evaluate on the read
    path (parquet I/O breaks the per-request SLO), so the parser archives them
    in meta.json's ``invariant_violations``. A series-level ``error`` (e.g.
    ``series.candles_ts_monotonic`` — the chart-crash root cause) must gate
    ``INVALID`` here too, not only on the write path + ``hoga validate``."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "invariant_violations": [
            {
                "invariant_id": "series.candles_ts_monotonic",
                "severity": "error",
                "message": "candles ts_ms must be strictly ascending",
                "ctx": {"index": 5, "prev_ts_ms": 1, "curr_ts_ms": 1},
            },
        ],
    }
    result = classify_from_meta(meta)
    assert result.state == DiskState.INVALID
    assert any(v.invariant_id == "series.candles_ts_monotonic" for v in result.errors)


def test_classify_from_meta_archived_series_warn_does_not_invalidate() -> None:
    """A series ``warn`` (e.g. snapshots_no_gaps) is surfaced via ``.warnings``
    but does not change the routing state — same rule meta warns follow."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "invariant_violations": [
            {
                "invariant_id": "series.snapshots_no_gaps",
                "severity": "warn",
                "message": "snapshot stream has >=60s gap",
                "ctx": {"datapoint_count": 10},
            },
        ],
    }
    result = classify_from_meta(meta)
    assert result.state == DiskState.COMPLETE
    assert any(v.invariant_id == "series.snapshots_no_gaps" for v in result.warnings)


def test_classify_from_meta_archived_cum_vol_regression_is_warn_not_invalid() -> None:
    """Regression for the 003490/20260506 blank-호가-panes bug (2026-06-08):
    a single hogaplay page-overlap rebase produces ONE ``series.cum_vol_monotonic``
    violation. cum_vol is a forensic trust signal — nothing on the read path
    consumes it (candles carry vol_a/vol_b, fill_strength is SUM(qty), quote_ratio
    is snapshot-derived) — so the Stock-Date must be INCLUDED with a data_warning,
    NOT excluded. Before the fix it archived as ``error`` and ``build_range_bundle``
    dropped the whole date, leaving 총잔량·호가비·체결강도 panes blank while the
    10호가·거래원 sidebar (per-cursor endpoints, no invariant gate) still rendered.
    ctx values are the literal regression captured for 003490/20260506."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "invariant_violations": [
            {
                "invariant_id": "series.cum_vol_monotonic",
                "severity": "warn",
                "message": "cum_vol regressed across continuous-trade rows",
                "ctx": {"index": 3459, "prev_cum": 465068,
                        "curr_cum": 452839, "ts_ms": 100656387},
            },
        ],
    }
    result = classify_from_meta(meta)
    assert result.state == DiskState.COMPLETE
    assert result.errors == []
    assert any(v.invariant_id == "series.cum_vol_monotonic" for v in result.warnings)


def test_classify_from_meta_ignores_archived_meta_violations() -> None:
    """The archived field holds BOTH meta and series violations (parser archives
    the union). Meta invariants are re-checked live above, so classify must take
    ONLY ``series.*`` from the archive — never re-consume an archived *meta*
    violation (which could be stale after the meta was fixed). Here the live
    meta is clean, so a stale archived meta error must NOT force INVALID."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "invariant_violations": [
            {
                "invariant_id": "session_close_after_open",  # a META invariant id
                "severity": "error",
                "message": "stale archived meta violation (already fixed live)",
                "ctx": {},
            },
        ],
    }
    result = classify_from_meta(meta)
    assert result.state == DiskState.COMPLETE
    assert result.violations == []


def test_malformed_meta_json_returns_client_incomplete(tmp_path: Path) -> None:
    """Truncated / corrupt meta.json must not crash callers — conservative fallback."""
    parquet_dir = tmp_path / "parquet" / "20260520" / "005930"
    parquet_dir.mkdir(parents=True)
    (parquet_dir / "meta.json").write_text("{not valid json", encoding="utf-8")
    assert check_disk_state(tmp_path, "005930", "20260520").state == DiskState.CLIENT_INCOMPLETE


# HogaMs is HHMMSSmmm packed-decimal (non-linear — see timeenc.py:54).
# Regular session open = 90000000 (09:00:00.000), close = 153000000 (15:30:00.000).
# Closing Auction Window spans the last 10 minutes (15:20–15:30 on a regular day).
_REGULAR_CLOSE = HogaMs(153000000)


def test_no_gaps_when_snapshots_dense() -> None:
    # One snapshot per second from 09:00:00 to 09:00:30 — no gap exceeds 1s.
    ts = [HogaMs(90000000 + i * 1000) for i in range(31)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_gap_detected_when_60s_empty() -> None:
    # 09:00:00 then jump to 09:01:30 (90 seconds later) — gap exceeds threshold.
    assert has_meaningful_gaps(
        [HogaMs(90000000), HogaMs(90130000)], session_close_ms=_REGULAR_CLOSE,
    ) is True


def test_gap_outside_continuous_session_ignored() -> None:
    """A gap that crosses the pre-session/session boundary must not count.
    Three dense in-session events prove there is no gap WITHIN the session;
    the pre-session sample at 08:40 is filtered out before gap analysis."""
    ts = [HogaMs(84000000), HogaMs(90000000), HogaMs(90001000), HogaMs(90002000)]
    # in_session = [90000000, 90001000, 90002000] — three points, 1s apart, no 60s gap.
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_empty_list_returns_true() -> None:
    """Empty input → True (conservative: caller can't prove completeness)."""
    assert has_meaningful_gaps([], session_close_ms=_REGULAR_CLOSE) is True


def test_single_in_session_event_returns_true() -> None:
    """One in-session datapoint isn't enough to compute gap presence; conservative True."""
    assert has_meaningful_gaps([HogaMs(90000000)], session_close_ms=_REGULAR_CLOSE) is True


def test_gap_across_minute_boundary_is_real_duration() -> None:
    """Regression: HHMMSSmmm is non-linear (timeenc.py:54). A real 30-second
    pause spanning 09:00:45 → 09:01:15 must NOT be flagged. Raw HogaMs
    subtraction gives 70,000 (looks like 70 sec) but real elapsed is 30 sec."""
    ts = [HogaMs(90045000), HogaMs(90115000)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_gap_across_hour_boundary_is_real_duration() -> None:
    """Hour boundary is the worst encoding-bug case: 09:59:45 → 10:00:15 is
    30 sec real, but raw subtraction gives 4,000,030 ms — would falsely flag
    every multi-hour stream as partial. This is the dominant prod false-positive."""
    ts = [HogaMs(95945000), HogaMs(100015000)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_real_gap_above_threshold_still_detected() -> None:
    """Sanity: real 90-second pause within the hour is still True after the fix."""
    ts = [HogaMs(100000000), HogaMs(100130000)]  # 10:00:00 → 10:01:30
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is True


def test_auction_window_snapshots_excluded_from_gap_analysis() -> None:
    """Snapshots inside the closing Auction Window (last 10 min of Regular
    Session) are excluded: no continuous matching happens there, so absence
    of churn is normal market behavior, not a data gap. With ONLY Auction-
    Window snapshots → empty in-session set → conservative True."""
    # 10 dense snapshots at 15:25:00..15:25:09 (inside the 15:20–15:30 window).
    ts = [HogaMs(152500000 + i * 1000) for i in range(10)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is True


# --- WS1: analyze_gaps returns gap boundaries in original HHMMSSmmm ---

def test_analyze_gaps_returns_boundary_in_original_encoding() -> None:
    """The gap range boundaries must be the ORIGINAL HogaMs timestamps, not a
    linear-ms value back-converted (that round-trip is unsafe)."""
    from hoga.api.disk_state import analyze_gaps
    ts = [HogaMs(100000000), HogaMs(100130000)]  # 10:00:00 → 10:01:30 (90s gap)
    a = analyze_gaps(ts, session_close_ms=_REGULAR_CLOSE)
    assert a.gap_ranges == [(HogaMs(100000000), HogaMs(100130000))]
    assert a.is_partial is True
    assert a.in_session_count == 2


def test_analyze_gaps_boundary_across_minute_is_original() -> None:
    """A gap spanning a minute boundary reports the raw HHMMSSmmm endpoints —
    09:59:40 → 10:01:20 is a real 100s gap; boundaries stay native."""
    from hoga.api.disk_state import analyze_gaps
    ts = [HogaMs(95940000), HogaMs(100120000)]
    a = analyze_gaps(ts, session_close_ms=_REGULAR_CLOSE)
    assert a.gap_ranges == [(HogaMs(95940000), HogaMs(100120000))]


def test_analyze_gaps_no_false_positive_across_hour_boundary() -> None:
    """The dominant prod false-positive: 09:59:45 → 10:00:15 is 30s real; no gap."""
    from hoga.api.disk_state import analyze_gaps
    a = analyze_gaps([HogaMs(95945000), HogaMs(100015000)], session_close_ms=_REGULAR_CLOSE)
    assert a.gap_ranges == []
    assert a.is_partial is False


def test_analyze_gaps_multiple_ranges_sorted() -> None:
    """Unsorted input still yields ordered, per-gap boundary pairs."""
    from hoga.api.disk_state import analyze_gaps
    # 10:02:00, then dense 10:00:00/10:00:01, then 10:03:30 — two ≥60s gaps.
    ts = [HogaMs(100200000), HogaMs(100000000), HogaMs(100001000), HogaMs(100330000)]
    a = analyze_gaps(ts, session_close_ms=_REGULAR_CLOSE)
    assert a.gap_ranges == [
        (HogaMs(100001000), HogaMs(100200000)),
        (HogaMs(100200000), HogaMs(100330000)),
    ]


def test_analyze_gaps_sparse_window_has_no_ranges_but_is_partial() -> None:
    """< 2 in-session datapoints → is_partial True by the count rule, but no
    discrete ranges (nothing to point the user at)."""
    from hoga.api.disk_state import analyze_gaps
    a = analyze_gaps([HogaMs(90000000)], session_close_ms=_REGULAR_CLOSE)
    assert a.gap_ranges == []
    assert a.in_session_count == 1
    assert a.is_partial is True


# --- ADR-0020 / Invariants ---

def test_disk_state_enum_includes_invalid() -> None:
    """INVALID was the fifth member, added by ADR-0020. ADR-0021 adds NO_UPSTREAM_DATA (sixth)."""
    assert DiskState.INVALID in set(DiskState)
    assert len(set(DiskState)) == 6


def test_classification_carries_violations_so_callers_avoid_redoing_work() -> None:
    """Deepening regression: classify_from_meta must return both the state
    and the violations that drove it, so downstream surfacing callers
    (build_range_bundle) don't re-run hoga.api.invariants.check() to recover
    them. The .errors / .warnings property helpers must partition by severity."""
    from hoga.api.disk_state import Classification
    from hoga.api.invariants import Severity

    # Healthy bounds, complete, but low unique-event ratio → warn only.
    c = classify_from_meta({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 4132,
        "total_unique_events": 1553,
    })
    assert isinstance(c, Classification)
    assert c.state == DiskState.COMPLETE
    assert c.errors == []                                              # no error
    assert {v.invariant_id for v in c.warnings} == {                   # warn surfaced
        "collection.unique_events_ratio",
    }

    # Broken bounds → INVALID + the error violation carried through.
    c2 = classify_from_meta({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,
        "collection_complete": True,
        "is_partial": False,
    })
    assert c2.state == DiskState.INVALID
    error_ids = {v.invariant_id for v in c2.errors}
    assert "meta.close_after_open" in error_ids
    assert all(v.severity == Severity.error for v in c2.errors)


def test_check_disk_state_empty_path_returns_no_violations() -> None:
    """Classification.violations is empty for NONE / raw-only CLIENT_INCOMPLETE
    paths — those branches don't have a meta dict to evaluate."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        c = check_disk_state(Path(td), "005930", "20260520")
    assert c.state == DiskState.NONE
    assert c.violations == []


def test_classify_returns_invalid_when_meta_has_error_violation() -> None:
    """A complete, non-partial capture that fails an error invariant → INVALID."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,    # error: close_after_open
        "collection_complete": True,       # gets past CLIENT_INCOMPLETE branch
        "is_partial": False,
    }
    assert classify_from_meta(meta).state == DiskState.INVALID


def test_classify_prefers_invalid_over_client_incomplete() -> None:
    """If both apply, INVALID wins — broken data shape is more serious than
    mere incompleteness. The real 5/18/003490 case (collection_complete=False
    AND close_ms=0) must classify INVALID, not CLIENT_INCOMPLETE — otherwise
    build_range_bundle's INVALID filter misses it and the chart still crashes.
    Eligibility also routes INVALID to fresh-capture (resume=False), which is
    the correct recovery for upstream-corrupted artifacts."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,    # error: close_after_open + close_in_kst_range
        "collection_complete": False,      # would be CLIENT_INCOMPLETE under old priority
        "is_partial": True,
    }
    assert classify_from_meta(meta).state == DiskState.INVALID


def test_classify_client_incomplete_when_only_completeness_bit_false() -> None:
    """Healthy bounds but capture aborted early → CLIENT_INCOMPLETE (resume
    path). This is the case the original priority was protecting."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": False,
        "is_partial": True,
    }
    assert classify_from_meta(meta).state == DiskState.CLIENT_INCOMPLETE


def test_classify_warn_only_does_not_promote_to_invalid() -> None:
    """warn-severity violations don't change DiskState (surfaced separately)."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 100,
        "total_unique_events": 30,         # warn: unique_events_ratio
    }
    # warn-only → still COMPLETE
    assert classify_from_meta(meta).state == DiskState.COMPLETE


def test_check_disk_state_returns_no_upstream_data_for_sentinel(tmp_path: Path) -> None:
    """A .no_upstream_data sentinel alone in raw_dir classifies as
    DiskState.NO_UPSTREAM_DATA (ADR-0021 sentinel-first ordering)."""
    from hoga.api.disk_state import DiskState, check_disk_state

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    (raw_dir / ".no_upstream_data").touch()

    result = check_disk_state(tmp_path, "003490", "20260319")
    assert result.state == DiskState.NO_UPSTREAM_DATA
    assert result.violations == []


def test_check_disk_state_sentinel_takes_precedence_over_stray_parquet(tmp_path: Path) -> None:
    """If a stale parquet/meta.json exists alongside the sentinel (invariant
    violation that the implementation must still survive gracefully), the
    sentinel wins. Sentinel-first ordering protects the UI from showing
    `complete` for a (code, date) the user explicitly knows is empty."""
    from hoga.api.disk_state import DiskState, check_disk_state

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    (raw_dir / ".no_upstream_data").touch()

    parquet_dir = tmp_path / "parquet" / "20260319" / "003490"
    parquet_dir.mkdir(parents=True)
    (parquet_dir / "meta.json").write_text("{}", encoding="utf-8")

    result = check_disk_state(tmp_path, "003490", "20260319")
    assert result.state == DiskState.NO_UPSTREAM_DATA


# --- latest_complete_date: Watchlist disk-reconcile helper ---

def test_latest_complete_date_returns_none_when_no_data(tmp_path: Path) -> None:
    """No parquet root → None (the "Code was never captured" case)."""
    from hoga.api.disk_state import latest_complete_date
    assert latest_complete_date(tmp_path, "098460") is None


def test_latest_complete_date_returns_none_when_parquet_empty(tmp_path: Path) -> None:
    """Parquet root exists but holds no Stock-Dates for this Code → None."""
    from hoga.api.disk_state import latest_complete_date
    (tmp_path / "parquet").mkdir()
    assert latest_complete_date(tmp_path, "098460") is None


def test_latest_complete_date_finds_max_complete(tmp_path: Path, monkeypatch) -> None:
    """Picks the lexicographically largest YYYYMMDD that is COMPLETE for the
    matching Code; ignores other codes' directories."""
    from hoga.api import disk_state
    (tmp_path / "parquet" / "20260301" / "098460").mkdir(parents=True)
    (tmp_path / "parquet" / "20260315" / "098460").mkdir(parents=True)
    (tmp_path / "parquet" / "20260310" / "098460").mkdir(parents=True)
    # Different code — must not influence the result.
    (tmp_path / "parquet" / "20260320" / "005930").mkdir(parents=True)

    def fake_check(_dir, code, date, *, source=None):
        return disk_state.Classification(state=disk_state.DiskState.COMPLETE)
    monkeypatch.setattr(disk_state, "check_disk_state", fake_check)

    assert disk_state.latest_complete_date(tmp_path, "098460") == "20260315"
    assert disk_state.latest_complete_date(tmp_path, "999999") is None


def test_latest_complete_date_skips_non_complete(tmp_path: Path, monkeypatch) -> None:
    """SOURCE_PARTIAL / CLIENT_INCOMPLETE / INVALID Stock-Dates are skipped —
    only COMPLETE counts as "마지막 성공"."""
    from hoga.api import disk_state
    (tmp_path / "parquet" / "20260301" / "098460").mkdir(parents=True)
    (tmp_path / "parquet" / "20260315" / "098460").mkdir(parents=True)

    def fake_check(_dir, code, date, *, source=None):
        if date == "20260301":
            return disk_state.Classification(state=disk_state.DiskState.COMPLETE)
        return disk_state.Classification(state=disk_state.DiskState.INVALID)
    monkeypatch.setattr(disk_state, "check_disk_state", fake_check)

    assert disk_state.latest_complete_date(tmp_path, "098460") == "20260301"


def test_latest_complete_date_integration_with_real_meta(tmp_path: Path) -> None:
    """End-to-end: real check_disk_state on real meta.json files. Confirms
    the helper's predicate matches the production COMPLETE definition."""
    from hoga.api.disk_state import latest_complete_date

    def write_complete(date: str, code: str) -> None:
        d = tmp_path / "parquet" / date / code
        d.mkdir(parents=True)
        (d / "meta.json").write_text(json.dumps({
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
            "collection_complete": True,
            "is_partial": False,
        }), encoding="utf-8")

    def write_partial(date: str, code: str) -> None:
        d = tmp_path / "parquet" / date / code
        d.mkdir(parents=True)
        (d / "meta.json").write_text(json.dumps({
            "regular_session_open_ms": 90000000,
            "regular_session_close_ms": 153000000,
            "collection_complete": True,
            "is_partial": True,    # SOURCE_PARTIAL — must not count
        }), encoding="utf-8")

    write_complete("20260520", "098460")
    write_complete("20260522", "098460")
    write_partial("20260524", "098460")     # latest by date, but partial
    assert latest_complete_date(tmp_path, "098460") == "20260522"


# --- ADR-0063: open_ms=0 normalisation ---

def test_open_ms_zero_classifies_complete_with_warning() -> None:
    meta = {
        "regular_session_open_ms": 0,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
    }
    c = classify_from_meta(meta)
    assert c.state is DiskState.COMPLETE
    assert [v.invariant_id for v in c.warnings] == ["meta.open_ms_normalized"]
    assert c.errors == []


def test_open_ms_zero_but_incomplete_stays_client_incomplete() -> None:
    meta = {
        "regular_session_open_ms": 0,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": False,   # 수집 미완은 정상화로 안 살아남
        "is_partial": False,
    }
    assert classify_from_meta(meta).state is DiskState.CLIENT_INCOMPLETE


def test_close_ms_zero_still_invalid() -> None:
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,     # 별도 트랙: 여전히 INVALID
        "collection_complete": True,
        "is_partial": False,
    }
    assert classify_from_meta(meta).state is DiskState.INVALID


# === ADR-0115 — analyze_gaps(anchor_edges=True) session-edge detection ===

def test_anchor_edges_off_by_default_ignores_late_head() -> None:
    """Default (anchor_edges=False) keeps consecutive-pairs-only: a stream that
    starts at 13:00 with no interior gap is NOT flagged — hogaplay's behavior."""
    ts = [HogaMs(130000000 + i * 1000) for i in range(120)]
    assert has_meaningful_gaps(ts, session_close_ms=_REGULAR_CLOSE) is False


def test_anchor_edges_flags_late_head() -> None:
    from hoga.api.disk_state import analyze_gaps

    ts = [HogaMs(130000000 + i * 1000) for i in range(120)]
    g = analyze_gaps(ts, session_close_ms=_REGULAR_CLOSE, anchor_edges=True)
    assert g.is_partial is True
    # Head gap boundary: session open → first snapshot.
    assert g.gap_ranges[0] == (HogaMs(90000000), HogaMs(130000000))


def test_anchor_edges_flags_early_tail() -> None:
    from hoga.api.disk_state import (
        _hhmmssms_to_intra_ms, _intra_ms_to_hhmmssms, analyze_gaps,
    )

    # Dense from 09:00 but the stream dies at 11:00 — a big tail gap runs to the
    # auction-window start (15:20). Build proper HHMMSSmmm via linear encode.
    t = _hhmmssms_to_intra_ms(HogaMs(90000000))
    end = _hhmmssms_to_intra_ms(HogaMs(110000000))  # 11:00:00
    ts = []
    while t < end:
        ts.append(_intra_ms_to_hhmmssms(t))
        t += 30_000
    g = analyze_gaps(ts, session_close_ms=_REGULAR_CLOSE, anchor_edges=True)
    assert g.is_partial is True
    # The final gap runs from the last snapshot to the auction-window start.
    assert g.gap_ranges[-1][1] == HogaMs(152000000)


def test_anchor_edges_empty_flags_whole_window() -> None:
    from hoga.api.disk_state import analyze_gaps

    g = analyze_gaps([], session_close_ms=_REGULAR_CLOSE, anchor_edges=True)
    assert g.in_session_count == 0
    assert g.is_partial is True
    assert g.gap_ranges == [(HogaMs(90000000), HogaMs(152000000))]


def test_anchor_edges_dense_full_window_no_gap() -> None:
    from hoga.api.disk_state import (
        _hhmmssms_to_intra_ms, _intra_ms_to_hhmmssms, analyze_gaps,
    )

    t = _hhmmssms_to_intra_ms(HogaMs(90000000))
    end = _hhmmssms_to_intra_ms(_REGULAR_CLOSE) - 10 * 60 * 1000
    ts = []
    while t < end:
        ts.append(_intra_ms_to_hhmmssms(t))
        t += 30_000
    g = analyze_gaps(ts, session_close_ms=_REGULAR_CLOSE, anchor_edges=True)
    assert g.is_partial is False
    assert g.gap_ranges == []
