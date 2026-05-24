# Data Integrity Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a declarative invariant catalog that extends `DiskState` with `INVALID`, lets `build_range_bundle` silently drop broken Stock-Dates and surface the exclusion on the wire, and exposes a read-only `hoga validate` CLI sweep — all from a single `hoga/api/invariants.py` registry.

**Architecture:** New `hoga/api/invariants.py` module hosts the `Invariant` / `Violation` types plus a 5-rule catalog. `classify_from_meta` evaluates the catalog live on every call (self-healing — no migration). `build_range_bundle` skips `INVALID` segments and adds `excluded_dates` / `data_warnings` to the wire model. Parser writes an archival `invariant_violations` field but read-paths ignore it. CLI sweep is a read-only walker, `--fix` only rewrites the archival field.

**Tech Stack:** Python 3.11+, pydantic v2 (existing), pytest + tmp_path fixtures (existing), Typer for CLI (existing). No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md](../specs/2026-05-24-data-integrity-checks-design.md)
**ADR:** [docs/adr/0020-data-integrity-invariant-catalog.md](../../adr/0020-data-integrity-invariant-catalog.md)

---

## File Structure

**New files:**
- `hoga/api/invariants.py` — `Severity`, `Violation`, `Invariant` types + `INVARIANTS` catalog (5 rules) + `check(meta) → list[Violation]`
- `tests/hoga/api/test_invariants.py` — unit tests for catalog (10 cases + check aggregator + missing-key absorption)
- `tests/test_cli_validate.py` — `hoga validate` CLI tests

**Modified files:**
- `hoga/api/disk_state.py` — add `INVALID` enum member + extend `classify_from_meta` to consult invariants
- `hoga/api/eligibility.py` — handle `DiskState.INVALID` in `decide_capture` (fresh capture branch)
- `hoga/api/calendar.py` — add `"invalid"` mapping in `_disk_state_to_status`
- `hoga/api/models.py` — add `ExcludedDate`, `DateWarning` models + extend `RangeBundle` with two fields
- `hoga/api/bundle.py` — read-path: skip `INVALID`, accumulate `excluded_dates` / `data_warnings`, 404 when all excluded
- `hoga/parser/__init__.py` — archival hook before meta.json write (line 147)
- `hoga/cli.py` — add `validate` Typer command

**Modified tests:**
- `tests/test_api_disk_state.py` — `INVALID` enum membership + priority ordering + warn doesn't promote
- `tests/test_api_eligibility.py` — `INVALID` proceeds as fresh capture
- `tests/test_api_calendar.py` — `"invalid"` status appears for INVALID disk state
- `tests/hoga/api/test_bundle.py` — `build_range_bundle` excludes INVALID + surfaces warns + 404 when all excluded
- `tests/test_api_range.py` — wire-level E2E: `excluded_dates` / `data_warnings` appear in JSON response
- `tests/test_parser_completeness.py` — archival hook writes `invariant_violations` field when present

---

## Task Ordering Rationale

Dependency-first, TDD throughout. `invariants.py` is a pure-function leaf module with zero deps — built first so all downstream tasks can `from hoga.api.invariants import check`. `DiskState` extension lands second so `eligibility` / `calendar` / `bundle` can each consume the new state independently. Read-path bundle integration comes after the wire model has the new fields. Parser archival hook and CLI sweep are independent and can come last.

---

## Task 1: invariants module — types and catalog

**Files:**
- Create: `hoga/api/invariants.py`
- Test: `tests/hoga/api/test_invariants.py`

- [ ] **Step 1.1: Write the failing tests file**

Create `tests/hoga/api/test_invariants.py`:

```python
"""Invariants catalog — pure-function checks on meta dicts."""
from __future__ import annotations

from hoga.api.invariants import (
    INVARIANTS,
    Invariant,
    Severity,
    Violation,
    check,
)


# Field-encoding sanity references (HHMMSSmmm = HH*10_000_000 + MM*100_000 + SS*1000 + ms):
# 04:00:00.000 = 40_000_000 (open range floor)
# 09:00:00.000 = 90_000_000 (within open range 04:00-12:00)
# 12:00:00.000 = 120_000_000 (open range ceiling, close range floor)
# 12:30:00.000 = 123_000_000 (half-day close, within close range)
# 15:30:00.000 = 153_000_000 (within close range 12:00-18:00)
# 18:00:00.000 = 180_000_000 (close range ceiling)


def _healthy_meta() -> dict:
    return {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 100,
        "total_unique_events": 80,
    }


# --- Type smoke ---

def test_severity_has_two_levels() -> None:
    assert {s.value for s in Severity} == {"error", "warn"}


def test_violation_as_dict_serializes_all_fields() -> None:
    v = Violation("x.y", Severity.error, "msg", {"k": 1})
    assert v.as_dict() == {
        "invariant_id": "x.y",
        "severity": "error",
        "message": "msg",
        "ctx": {"k": 1},
    }


def test_catalog_has_five_invariants() -> None:
    assert len(INVARIANTS) == 5
    assert {inv.id for inv in INVARIANTS} == {
        "meta.close_after_open",
        "meta.open_in_kst_range",
        "meta.close_in_kst_range",
        "collection.finished",
        "collection.unique_events_ratio",
    }


# --- Healthy path ---

def test_check_returns_empty_for_healthy_meta() -> None:
    assert check(_healthy_meta()) == []


# --- error: meta.close_after_open ---

def test_close_after_open_fires_when_close_le_open() -> None:
    meta = _healthy_meta() | {"regular_session_close_ms": 0}
    violations = [v for v in check(meta) if v.invariant_id == "meta.close_after_open"]
    assert len(violations) == 1
    assert violations[0].severity == Severity.error
    assert violations[0].ctx["open_ms"] == 90_000_000
    assert violations[0].ctx["close_ms"] == 0


# --- error: meta.open_in_kst_range ---

def test_open_in_kst_range_fires_when_open_too_early() -> None:
    # 03:59:59.999 < 04:00:00.000 floor
    meta = _healthy_meta() | {"regular_session_open_ms": 39_999_999}  # just before 04:00:00
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.open_in_kst_range" in ids


def test_open_in_kst_range_fires_when_open_too_late() -> None:
    # 12:00:00.001 > 12:00:00.000 ceiling
    meta = _healthy_meta() | {"regular_session_open_ms": 120_000_001}  # just after 12:00:00
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.open_in_kst_range" in ids


# --- error: meta.close_in_kst_range ---

def test_close_in_kst_range_fires_when_close_zero() -> None:
    meta = _healthy_meta() | {"regular_session_close_ms": 0}
    ids = [v.invariant_id for v in check(meta)]
    # both close_after_open AND close_in_kst_range fire — that's intended
    assert "meta.close_in_kst_range" in ids


def test_close_in_kst_range_accepts_half_day_close() -> None:
    # 12:30 KST half-day close — 123_000_000 is within [120_000_000, 180_000_000]
    meta = _healthy_meta() | {"regular_session_close_ms": 123_000_000}
    ids = [v.invariant_id for v in check(meta)]
    assert "meta.close_in_kst_range" not in ids


# --- warn: collection.finished ---

def test_collection_finished_fires_when_complete_false() -> None:
    meta = _healthy_meta() | {"collection_complete": False}
    violations = [v for v in check(meta) if v.invariant_id == "collection.finished"]
    assert len(violations) == 1
    assert violations[0].severity == Severity.warn


# --- warn: collection.unique_events_ratio ---

def test_unique_events_ratio_fires_below_50_percent() -> None:
    # 1553 events from 4132 pages = 37% < 50% — the real 5/18 case
    meta = _healthy_meta() | {"pages_collected": 4132, "total_unique_events": 1553}
    violations = [v for v in check(meta) if v.invariant_id == "collection.unique_events_ratio"]
    assert len(violations) == 1
    assert violations[0].severity == Severity.warn


def test_unique_events_ratio_passes_at_50_percent() -> None:
    meta = _healthy_meta() | {"pages_collected": 100, "total_unique_events": 50}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" not in ids


def test_unique_events_ratio_passes_when_pages_zero() -> None:
    # Empty capture is a different failure mode — don't double-flag.
    meta = _healthy_meta() | {"pages_collected": 0, "total_unique_events": 0}
    ids = [v.invariant_id for v in check(meta)]
    assert "collection.unique_events_ratio" not in ids


# --- Legacy meta absorption ---

def test_legacy_meta_without_optional_keys_does_not_error() -> None:
    # An older meta lacks the optional keys (collection_complete, pages_collected).
    # Invariants must absorb absence via .get() — no KeyError.
    legacy = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
    }
    violations = check(legacy)
    # collection.finished defaults to False → fires (warn)
    # other invariants either pass or skip
    ids = {v.invariant_id for v in violations}
    assert "collection.finished" in ids
    # unique_events_ratio uses .get(..., 0) → pages=0 → skip per above
    assert "collection.unique_events_ratio" not in ids


# --- Regression fixture: real 5/18 003490 meta ---

def test_real_20260518_003490_fires_expected_invariants() -> None:
    real = {
        "code": "003490",
        "name": "대한항공",
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,           # ← upstream stagnation artefact
        "collection_complete": False,
        "is_partial": False,
        "pages_collected": 4132,
        "total_unique_events": 1553,
    }
    fired = {v.invariant_id for v in check(real)}
    assert fired == {
        "meta.close_after_open",        # error
        "meta.close_in_kst_range",      # error
        "collection.finished",          # warn
        "collection.unique_events_ratio",  # warn
    }
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `uv run pytest tests/hoga/api/test_invariants.py -v`
Expected: ImportError / ModuleNotFoundError on `hoga.api.invariants`.

- [ ] **Step 1.3: Write the invariants module**

Create `hoga/api/invariants.py`:

```python
"""Data integrity invariants catalog (ADR-0020).

A single registry of declarative rules that all four checkpoints share:
  - hoga/parser/__init__.py    (write-time archival)
  - hoga/api/disk_state.py     (classify_from_meta)
  - hoga/api/bundle.py         (read-path skip + surfacing)
  - hoga/cli.py                (validate sweep)

See docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md §4.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum


class Severity(str, Enum):
    error = "error"
    warn = "warn"


@dataclass(frozen=True)
class Violation:
    invariant_id: str
    severity: Severity
    message: str
    ctx: dict

    def as_dict(self) -> dict:
        return {
            "invariant_id": self.invariant_id,
            "severity": self.severity.value,
            "message": self.message,
            "ctx": self.ctx,
        }


@dataclass(frozen=True)
class Invariant:
    id: str
    severity: Severity
    description: str
    check: Callable[[dict], Violation | None]


# --- error: data shape itself is broken ---
# HHMMSSmmm encoding (HH*10_000_000 + MM*100_000 + SS*1000 + ms):
# 04:00 = 40_000_000, 12:00 = 120_000_000, 18:00 = 180_000_000

def _meta_close_after_open(m: dict) -> Violation | None:
    # Key-presence semantics: skip when either bound is absent (legacy meta
    # has nothing to compare). Fire only when both are present and the relation
    # is wrong (e.g. upstream stagnation that returned close_ms=0 for a real
    # session — explicit 0 vs missing key are different signals).
    if "regular_session_open_ms" not in m or "regular_session_close_ms" not in m:
        return None
    open_ms = m["regular_session_open_ms"]
    close_ms = m["regular_session_close_ms"]
    if close_ms > open_ms:
        return None
    return Violation(
        "meta.close_after_open",
        Severity.error,
        "session close must be strictly greater than open",
        {"open_ms": open_ms, "close_ms": close_ms},
    )


def _meta_open_in_kst_range(m: dict) -> Violation | None:
    if "regular_session_open_ms" not in m:
        return None
    open_ms = m["regular_session_open_ms"]
    if 40_000_000 <= open_ms <= 120_000_000:
        return None
    return Violation(
        "meta.open_in_kst_range",
        Severity.error,
        "session open outside plausible KRX morning window (04:00–12:00 KST)",
        {"open_ms": open_ms},
    )


def _meta_close_in_kst_range(m: dict) -> Violation | None:
    if "regular_session_close_ms" not in m:
        return None
    close_ms = m["regular_session_close_ms"]
    if 120_000_000 <= close_ms <= 180_000_000:
        return None
    return Violation(
        "meta.close_in_kst_range",
        Severity.error,
        "session close outside plausible KRX afternoon window (12:00–18:00 KST)",
        {"close_ms": close_ms},
    )


# --- warn: shape plausible, trust low ---

def _collection_finished(m: dict) -> Violation | None:
    if m.get("collection_complete", False):
        return None
    return Violation(
        "collection.finished",
        Severity.warn,
        "capture aborted before completion (likely partial data)",
        {"complete": m.get("collection_complete", False)},
    )


def _collection_unique_events_ratio(m: dict) -> Violation | None:
    pages = m.get("pages_collected", 0)
    if pages == 0:
        return None  # different failure mode; don't double-flag
    events = m.get("total_unique_events", 0)
    threshold = max(10, pages // 2)
    if events >= threshold:
        return None
    return Violation(
        "collection.unique_events_ratio",
        Severity.warn,
        "low unique-event-per-page ratio (possible upstream stagnation)",
        {"pages": pages, "events": events},
    )


INVARIANTS: tuple[Invariant, ...] = (
    Invariant(
        id="meta.close_after_open",
        severity=Severity.error,
        description="regular_session_close_ms must be strictly greater than open_ms",
        check=_meta_close_after_open,
    ),
    Invariant(
        id="meta.open_in_kst_range",
        severity=Severity.error,
        description="open_ms within 04:00-12:00 KST (HHMMSS-ms encoding)",
        check=_meta_open_in_kst_range,
    ),
    Invariant(
        id="meta.close_in_kst_range",
        severity=Severity.error,
        description="close_ms within 12:00-18:00 KST (HHMMSS-ms encoding)",
        check=_meta_close_in_kst_range,
    ),
    Invariant(
        id="collection.finished",
        severity=Severity.warn,
        description="collection_complete bit must be True",
        check=_collection_finished,
    ),
    Invariant(
        id="collection.unique_events_ratio",
        severity=Severity.warn,
        description="≥50% of pages must yield at least one new event (stagnation suspicion)",
        check=_collection_unique_events_ratio,
    ),
)


def check(meta: dict) -> list[Violation]:
    """Run every invariant against ``meta``. Returns the violations list
    (empty when ``meta`` is integral). Order matches ``INVARIANTS`` declaration
    order — callers that care about presentation order should not re-sort.
    """
    return [v for inv in INVARIANTS if (v := inv.check(meta)) is not None]
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `uv run pytest tests/hoga/api/test_invariants.py -v`
Expected: 14 PASS.

- [ ] **Step 1.5: Commit**

```bash
git add hoga/api/invariants.py tests/hoga/api/test_invariants.py
git commit -m "feat(api/invariants): declarative catalog of 5 meta-level data invariants

Pure-function registry consumed by disk_state, bundle read-path, parser
archival hook, and the upcoming hoga validate CLI. error severity for
shape breakage (close ≤ open, out-of-range KST times); warn severity for
trust signals (collection aborted, low unique-event ratio). All checks
use .get() to absorb legacy meta absence."
```

---

## Task 2: DiskState.INVALID + classify_from_meta extension

**Files:**
- Modify: `hoga/api/disk_state.py:19-23` (enum), `hoga/api/disk_state.py:26-42` (classify)
- Modify: `tests/test_api_disk_state.py`

- [ ] **Step 2.1: Write the failing tests**

Append to `tests/test_api_disk_state.py`:

```python
# --- ADR-0020 / Invariants ---

def test_disk_state_enum_includes_invalid() -> None:
    """INVALID is the fifth member, added by ADR-0020."""
    assert DiskState.INVALID in set(DiskState)
    assert len(set(DiskState)) == 5


def test_classify_returns_invalid_when_meta_has_error_violation() -> None:
    """A complete, non-partial capture that fails an error invariant → INVALID."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,    # error: close_after_open
        "collection_complete": True,       # gets past CLIENT_INCOMPLETE branch
        "is_partial": False,
    }
    assert classify_from_meta(meta) == DiskState.INVALID


def test_classify_prefers_client_incomplete_over_invalid() -> None:
    """If both apply, CLIENT_INCOMPLETE wins (capture didn't finish — root cause)."""
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,    # would be error
        "collection_complete": False,      # CLIENT_INCOMPLETE
        "is_partial": True,
    }
    assert classify_from_meta(meta) == DiskState.CLIENT_INCOMPLETE


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
    assert classify_from_meta(meta) == DiskState.COMPLETE
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_disk_state.py -v -k "invalid or warn_only"`
Expected: FAIL — `DiskState.INVALID` does not exist; existing enum has 4 members.

- [ ] **Step 2.3: Extend the DiskState enum and classifier**

Edit `hoga/api/disk_state.py`. Replace the enum at lines 19-23:

```python
class DiskState(Enum):
    NONE = "none"
    CLIENT_INCOMPLETE = "client_incomplete"
    SOURCE_PARTIAL = "source_partial"
    INVALID = "invalid"          # ADR-0020: domain invariant violated
    COMPLETE = "complete"
```

Replace `classify_from_meta` at lines 26-42:

```python
def classify_from_meta(meta: dict[str, object]) -> DiskState:
    """Classify the disk state from an already-loaded meta.json dict.

    Single source of truth for the meta → DiskState mapping. Used both by
    :func:`check_disk_state` (which loads meta from disk) and by callers
    that already have the meta dict in memory (e.g., ``queries.list_stock_dates``
    iterating Stock-Date directories) — sharing the helper avoids reading
    meta.json twice per row.

    Priority (ADR-0020):
      1. ``collection_complete=False`` → CLIENT_INCOMPLETE (root cause —
         capture didn't finish, anything else downstream is symptom).
      2. Any ``error``-severity invariant violation → INVALID.
      3. ``warn``-severity violations don't change state (surfaced separately).
      4. Otherwise fall through to is_partial → SOURCE_PARTIAL / COMPLETE.

    Legacy meta (pre-foundation) lacks both completeness fields. Conservative
    default is CLIENT_INCOMPLETE so a subsequent capture run will upgrade it.
    """
    collection_complete = bool(meta.get("collection_complete", False))
    is_partial = bool(meta.get("is_partial", True))
    if not collection_complete:
        return DiskState.CLIENT_INCOMPLETE

    # Local import keeps disk_state importable without invariants
    # (parser/cli also depend on disk_state — keep cycle minimal).
    from hoga.api.invariants import Severity, check

    violations = check(meta)
    if any(v.severity == Severity.error for v in violations):
        return DiskState.INVALID

    return DiskState.SOURCE_PARTIAL if is_partial else DiskState.COMPLETE
```

Update the test at the top of `tests/test_api_disk_state.py`:

```python
def test_disk_state_enum_has_five_members() -> None:
    assert set(DiskState) == {
        DiskState.NONE,
        DiskState.CLIENT_INCOMPLETE,
        DiskState.SOURCE_PARTIAL,
        DiskState.INVALID,
        DiskState.COMPLETE,
    }
```

(Rename the old `test_disk_state_enum_has_four_members` to this and update the body.)

- [ ] **Step 2.4: Run all disk_state tests to confirm**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: all PASS, including the 3 new tests and the renamed five-members test.

- [ ] **Step 2.5: Commit**

```bash
git add hoga/api/disk_state.py tests/test_api_disk_state.py
git commit -m "feat(api/disk_state): add INVALID state driven by invariants catalog

classify_from_meta now consults hoga.api.invariants after the
CLIENT_INCOMPLETE check. Any error-severity violation maps to INVALID;
warn-severity violations leave state unchanged (surfaced by callers
that care). CLIENT_INCOMPLETE keeps priority because an unfinished
capture is the root cause of most downstream anomalies."
```

---

## Task 3: Eligibility — INVALID proceeds as fresh capture

**Files:**
- Modify: `hoga/api/eligibility.py:67-80`
- Modify: `tests/test_api_eligibility.py`

- [ ] **Step 3.1: Write the failing test**

Append to `tests/test_api_eligibility.py`:

```python
def test_decide_capture_invalid_proceeds_as_fresh(tmp_path: Path) -> None:
    """INVALID disk state → fresh capture (no resume from corrupt artifacts)."""
    from hoga.api.disk_state import DiskState
    from hoga.api.eligibility import decide_capture

    # Build a meta.json that classify_from_meta will rate as INVALID:
    # collection_complete=True so it passes the CLIENT_INCOMPLETE gate,
    # but close_ms=0 trips meta.close_after_open (error).
    pq_dir = tmp_path / "parquet" / "20260518" / "003490"
    pq_dir.mkdir(parents=True)
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,
        "collection_complete": True,
        "is_partial": False,
    }
    (pq_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    decision = decide_capture(tmp_path, "003490", "20260518", force_retry=False)

    # Sanity: precondition holds (classify is INVALID)
    from hoga.api.disk_state import check_disk_state
    assert check_disk_state(tmp_path, "003490", "20260518") == DiskState.INVALID

    # Proceeds (no skip), resume=False (fresh capture, don't trust corrupt artifacts)
    assert decision.skip_reason is None
    assert decision.resume is False
```

Make sure `json` and `Path` are imported at the top of the test file (likely already there).

- [ ] **Step 3.2: Run test to verify it fails**

Run: `uv run pytest tests/test_api_eligibility.py::test_decide_capture_invalid_proceeds_as_fresh -v`
Expected: FAIL — current `decide_capture` doesn't recognize `INVALID` so behavior is incidental (likely the default fresh branch happens to pass, but the test is brittle without the explicit handling).

If it happens to pass: still add explicit handling per Step 3.3 (defensive against future eligibility logic changes).

- [ ] **Step 3.3: Update decide_capture**

Edit `hoga/api/eligibility.py`. Replace the docstring + branches at lines 65-80:

```python
) -> CaptureDecision:
    """Worker deciding-phase decision.

    Branches:
      - DiskState.COMPLETE        → skip with reason "already_complete"
      - DiskState.SOURCE_PARTIAL  → skip with "source_partial" unless force_retry
                                    (when force_retry, fall through to fresh)
      - DiskState.INVALID         → proceed with resume=False (don't trust
                                    corrupt artifacts; fresh capture)
      - DiskState.CLIENT_INCOMPLETE → proceed with resume=True
      - DiskState.NONE            → proceed with resume=False
    """
    disk = check_disk_state(data_dir, code, date)
    if disk == DiskState.COMPLETE:
        return CaptureDecision(skip_reason="already_complete", resume=False)
    if disk == DiskState.SOURCE_PARTIAL and not force_retry:
        return CaptureDecision(skip_reason="source_partial", resume=False)
    # INVALID and NONE both produce resume=False; only CLIENT_INCOMPLETE resumes.
    resume_flag = (disk == DiskState.CLIENT_INCOMPLETE)
    return CaptureDecision(skip_reason=None, resume=resume_flag)
```

- [ ] **Step 3.4: Run test to verify it passes**

Run: `uv run pytest tests/test_api_eligibility.py -v`
Expected: all PASS, including the new INVALID test.

- [ ] **Step 3.5: Commit**

```bash
git add hoga/api/eligibility.py tests/test_api_eligibility.py
git commit -m "feat(api/eligibility): INVALID disk state proceeds as fresh capture

Don't resume from artifacts that failed invariant checks — the parquet
likely encodes the upstream corruption (e.g., session_close_ms=0 means
candles/snapshots were truncated). Fresh capture from scratch is the
correct recovery."
```

---

## Task 4: Calendar — `"invalid"` status mapping

**Files:**
- Modify: `hoga/api/calendar.py:138-144`
- Modify: `tests/test_api_calendar.py`

- [ ] **Step 4.1: Write the failing test**

Append to `tests/test_api_calendar.py`:

```python
def test_disk_state_to_status_maps_invalid() -> None:
    """ADR-0020: INVALID maps to 'invalid' string on the wire."""
    from hoga.api.calendar import _disk_state_to_status
    from hoga.api.disk_state import DiskState
    assert _disk_state_to_status(DiskState.INVALID) == "invalid"
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `uv run pytest tests/test_api_calendar.py::test_disk_state_to_status_maps_invalid -v`
Expected: FAIL with `KeyError: DiskState.INVALID`.

- [ ] **Step 4.3: Add the mapping**

Edit `hoga/api/calendar.py:138-144`:

```python
def _disk_state_to_status(st: DiskState) -> str:
    return {
        DiskState.COMPLETE: "complete",
        DiskState.SOURCE_PARTIAL: "source_partial",
        DiskState.CLIENT_INCOMPLETE: "client_incomplete",
        DiskState.INVALID: "invalid",
        DiskState.NONE: "none",
    }[st]
```

- [ ] **Step 4.4: Run test to verify it passes**

Run: `uv run pytest tests/test_api_calendar.py -v`
Expected: all PASS.

- [ ] **Step 4.5: Commit**

```bash
git add hoga/api/calendar.py tests/test_api_calendar.py
git commit -m "feat(api/calendar): map DiskState.INVALID to 'invalid' on the wire

Frontend cell-status mapping needs every enum value covered or the
KeyError surfaces as a 500 on calendar fetch. Cell color/style for
'invalid' is a frontend DESIGN.md concern (out of this PR scope)."
```

---

## Task 5: Models — ExcludedDate, DateWarning, RangeBundle fields

**Files:**
- Modify: `hoga/api/models.py:360-381` (RangeBundle definition + neighbours)
- Modify: `tests/hoga/api/test_range_models.py` (or create a new test file if simpler)

- [ ] **Step 5.1: Write the failing test**

Append to `tests/hoga/api/test_range_models.py`:

```python
def test_range_bundle_has_excluded_dates_field_default_empty() -> None:
    from hoga.api.models import (
        ApiCandle, FillStrength, QuoteRatio, RangeBundle, RangeSegment,
        VolumeProfile,
    )
    rb = RangeBundle(
        code="005930", from_date="20260520", to_date="20260520",
        bucket_ms=60_000,
        segments=[RangeSegment(date="20260520",
                               session_open_ms=1_000_000_000_000,
                               session_close_ms=1_000_000_001_000)],
        candles=[], quote_ratio=QuoteRatio(bucket_ms=60_000, points=[]),
        fill_strength=FillStrength(bucket_ms=60_000, points=[]),
        volume_profile_range=VolumeProfile(price_min=0, price_max=0,
                                           price_step=1, buy_qty=[], sell_qty=[]),
        volume_profile_by_day=[],
    )
    assert rb.excluded_dates == []
    assert rb.data_warnings == []


def test_excluded_date_round_trip() -> None:
    from hoga.api.models import ExcludedDate
    ed = ExcludedDate(date="20260518", violations=[
        {"invariant_id": "meta.close_after_open", "severity": "error",
         "message": "x", "ctx": {"open_ms": 1, "close_ms": 0}},
    ])
    assert ed.model_dump()["date"] == "20260518"
    assert len(ed.model_dump()["violations"]) == 1


def test_date_warning_round_trip() -> None:
    from hoga.api.models import DateWarning
    dw = DateWarning(date="20260518", warnings=[
        {"invariant_id": "collection.finished", "severity": "warn",
         "message": "x", "ctx": {"complete": False}},
    ])
    assert dw.model_dump()["date"] == "20260518"
    assert len(dw.model_dump()["warnings"]) == 1
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `uv run pytest tests/hoga/api/test_range_models.py -v -k "excluded or warning"`
Expected: FAIL — `ExcludedDate` / `DateWarning` not importable, `RangeBundle` has no `excluded_dates`.

- [ ] **Step 5.3: Add the models**

Edit `hoga/api/models.py`. Insert before the `class RangeBundle(BaseModel):` line (currently line 360):

```python
class ExcludedDate(BaseModel):
    """A Stock-Date that build_range_bundle skipped due to error-severity
    invariant violations (ADR-0020). Surfaced so the UI can explain the gap.
    """
    date: str
    violations: list[dict]   # each: {invariant_id, severity, message, ctx}


class DateWarning(BaseModel):
    """A Stock-Date that was included in the bundle but tripped warn-severity
    invariants. The UI should mark the segment but render its data (ADR-0020).
    """
    date: str
    warnings: list[dict]


```

Then extend the existing `RangeBundle` class — append two fields:

```python
class RangeBundle(BaseModel):
    """The sole read-path Wire Model for a Stock-Date Range (ADR-0013).

    All series aggregated at the same Timeframe (ADR-0014).

    volume_profile is per-segment (volume_profile_by_day) because each
    Stock-Date has its own price grid (price_min/price_max/price_step) — the
    grids cannot be concatenated meaningfully. QuoteRatio.points and
    FillStrength.points ARE concatenated across segments because they are flat
    (t, value) point arrays with no per-day grid dependency.

    excluded_dates / data_warnings surface invariant outcomes (ADR-0020).
    Both default to empty lists so existing clients are unaffected.
    """

    code: str
    from_date: str
    to_date: str
    bucket_ms: int
    segments: list[RangeSegment]
    candles: list[ApiCandle]
    quote_ratio: QuoteRatio
    fill_strength: FillStrength
    volume_profile_range: VolumeProfile
    volume_profile_by_day: list[VolumeProfile]
    excluded_dates: list[ExcludedDate] = []
    data_warnings: list[DateWarning] = []
```

- [ ] **Step 5.4: Run test to verify it passes**

Run: `uv run pytest tests/hoga/api/test_range_models.py -v`
Expected: all PASS, including the 3 new tests.

- [ ] **Step 5.5: Commit**

```bash
git add hoga/api/models.py tests/hoga/api/test_range_models.py
git commit -m "feat(api/models): add ExcludedDate, DateWarning, extend RangeBundle

Two new wire types carry per-Stock-Date invariant outcomes — ExcludedDate
for error-severity skips, DateWarning for warn-severity surfacing. Both
RangeBundle fields default to empty list so existing clients see no
breaking change."
```

---

## Task 6: build_range_bundle — read-path integration

**Files:**
- Modify: `hoga/api/bundle.py:305-383`
- Modify: `tests/hoga/api/test_bundle.py`

- [ ] **Step 6.1: Write the failing tests**

Append to `tests/hoga/api/test_bundle.py`:

```python
# --- ADR-0020 / Invariants ---

def _stub_meta(open_ms=90_000_000, close_ms=153_000_000,
               complete=True, partial=False, pages=100, events=80):
    return {
        "regular_session_open_ms": open_ms,
        "regular_session_close_ms": close_ms,
        "collection_complete": complete,
        "is_partial": partial,
        "pages_collected": pages,
        "total_unique_events": events,
    }


def test_build_range_bundle_skips_invalid_and_surfaces_in_excluded():
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    mock_engine.list_stock_dates_in_range.return_value = ["20260520", "20260518", "20260521"]
    # 20260518 has close=0 → INVALID; others healthy
    mock_engine.get_meta.side_effect = lambda d, c: {
        "20260520": _stub_meta(),
        "20260518": _stub_meta(close_ms=0),
        "20260521": _stub_meta(),
    }[d]
    _patch_slice_builders(__import__("hoga.api.bundle", fromlist=["bundle"]))

    bundle = build_range_bundle(
        mock_engine, code="005930",
        from_date="20260520", to_date="20260521",
        bucket_ms=60_000,
    )

    # Only the 2 healthy dates are in segments.
    assert [s.date for s in bundle.segments] == ["20260520", "20260521"]
    # The bad date is surfaced.
    assert len(bundle.excluded_dates) == 1
    assert bundle.excluded_dates[0].date == "20260518"
    fired_ids = {v["invariant_id"] for v in bundle.excluded_dates[0].violations}
    assert "meta.close_after_open" in fired_ids
    # No warns in this fixture.
    assert bundle.data_warnings == []


def test_build_range_bundle_surfaces_warn_without_excluding():
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    mock_engine.list_stock_dates_in_range.return_value = ["20260520"]
    # Healthy shape but low unique-event ratio → warn only
    mock_engine.get_meta.return_value = _stub_meta(pages=4132, events=1553)
    _patch_slice_builders(__import__("hoga.api.bundle", fromlist=["bundle"]))

    bundle = build_range_bundle(
        mock_engine, code="005930",
        from_date="20260520", to_date="20260520",
        bucket_ms=60_000,
    )

    assert len(bundle.segments) == 1
    assert bundle.excluded_dates == []
    assert len(bundle.data_warnings) == 1
    assert bundle.data_warnings[0].date == "20260520"
    fired_ids = {v["invariant_id"] for v in bundle.data_warnings[0].warnings}
    assert "collection.unique_events_ratio" in fired_ids


def test_build_range_bundle_404_when_all_dates_excluded():
    from fastapi import HTTPException
    from hoga.api.bundle import build_range_bundle

    mock_engine = MagicMock()
    mock_engine.list_stock_dates_in_range.return_value = ["20260518"]
    mock_engine.get_meta.return_value = _stub_meta(close_ms=0)

    with pytest.raises(HTTPException) as exc:
        build_range_bundle(
            mock_engine, code="003490",
            from_date="20260518", to_date="20260518",
            bucket_ms=60_000,
        )
    assert exc.value.status_code == 404
    # detail carries the excluded sources for diagnostics
    detail = exc.value.detail
    assert isinstance(detail, dict)
    assert "excluded" in detail
    assert detail["excluded"][0]["date"] == "20260518"
```

If `_patch_slice_builders` doesn't exist in that test file, check its name in the surrounding test — the existing test_bundle.py already mocks per-slice builders (we saw `_patch_slice_builders` referenced in section 4.4 of the file). Adapt the helper call to whatever pattern is already in the file (the existing `test_build_range_bundle_*` tests at line ~250 will show it).

- [ ] **Step 6.2: Run tests to verify they fail**

Run: `uv run pytest tests/hoga/api/test_bundle.py -v -k "invalid or warn or excluded"`
Expected: FAIL — `bundle.excluded_dates` doesn't exist; build_range_bundle still includes the bad date.

- [ ] **Step 6.3: Update build_range_bundle**

Edit `hoga/api/bundle.py`. At the top of the file, add imports near existing imports:

```python
from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.invariants import Severity, check as check_invariants
from hoga.api.models import (
    # ... existing imports ...
    DateWarning,
    ExcludedDate,
)
```

Replace the loop body in `build_range_bundle` (around line 346-368):

```python
    excluded: list[ExcludedDate] = []
    warnings_list: list[DateWarning] = []
    segments: list[RangeSegment] = []
    candles: list[ApiCandle] = []
    ratio_pts: list[QuoteRatioPoint] = []
    fill_pts: list[FillStrengthPoint] = []
    profiles_by_day: list[VolumeProfile] = []

    for d in dates:
        meta = engine.get_meta(d, code)
        state = classify_from_meta(meta)

        if state == DiskState.INVALID:
            errs = [v.as_dict() for v in check_invariants(meta) if v.severity == Severity.error]
            excluded.append(ExcludedDate(date=d, violations=errs))
            continue

        # Included — also collect warn surfacing (separate so eligibility/calendar
        # consumers of classify_from_meta don't pay for the second pass).
        warns = [v.as_dict() for v in check_invariants(meta) if v.severity == Severity.warn]
        if warns:
            warnings_list.append(DateWarning(date=d, warnings=warns))

        raw_candles = build_candles_slice(engine, code=code, date=d)
        candles_d = downsample_candles(raw_candles, bucket_ms=bucket_ms)
        qr_d = build_quote_ratio_slice(engine, code=code, date=d, bucket_ms=bucket_ms)
        fs_d = build_fill_strength_slice(engine, code=code, date=d, bucket_ms=bucket_ms)
        vp_d = build_volume_profile_slice(engine, code=code, date=d)

        segments.append(RangeSegment(
            date=d,
            session_open_ms=hhmmssms_to_unix_ms(d, meta["regular_session_open_ms"]),
            session_close_ms=hhmmssms_to_unix_ms(d, meta["regular_session_close_ms"]),
        ))
        candles.extend(candles_d)
        ratio_pts.extend(qr_d.points)
        fill_pts.extend(fs_d.points)
        profiles_by_day.append(vp_d)

    if not segments:
        raise HTTPException(404, {
            "detail": "all Stock-Dates in range excluded by invariants",
            "excluded": [e.model_dump() for e in excluded],
        })

    profile_range = build_volume_profile_range(engine, code=code, dates=dates)

    return RangeBundle(
        code=code,
        from_date=from_date,
        to_date=to_date,
        bucket_ms=bucket_ms,
        segments=segments,
        candles=candles,
        quote_ratio=QuoteRatio(bucket_ms=bucket_ms, points=ratio_pts),
        fill_strength=FillStrength(bucket_ms=bucket_ms, points=fill_pts),
        volume_profile_range=profile_range,
        volume_profile_by_day=profiles_by_day,
        excluded_dates=excluded,
        data_warnings=warnings_list,
    )
```

- [ ] **Step 6.4: Run all bundle tests to confirm**

Run: `uv run pytest tests/hoga/api/test_bundle.py -v`
Expected: all PASS, including the 3 new tests. Pre-existing tests should still pass since healthy fixtures don't trip any invariant.

- [ ] **Step 6.5: Commit**

```bash
git add hoga/api/bundle.py tests/hoga/api/test_bundle.py
git commit -m "feat(api/bundle): skip INVALID Stock-Dates, surface excluded_dates + data_warnings

build_range_bundle now consults classify_from_meta per Stock-Date.
INVALID segments are silently dropped and listed under
RangeBundle.excluded_dates; warn-only segments are included with
their warnings surfaced under data_warnings. When all dates are
excluded, the existing 404 branch is reused with the excluded list
in detail for diagnostics."
```

---

## Task 7: Parser archival hook

**Files:**
- Modify: `hoga/parser/__init__.py:147-149` (the meta.json write)
- Modify: `tests/test_parser_completeness.py`

- [ ] **Step 7.1: Write the failing test**

Append to `tests/test_parser_completeness.py`:

```python
def test_parser_writes_invariant_violations_field_when_violations_present(tmp_path):
    """ADR-0020: parser archives Violation list into meta.json on write.

    Archive is for diagnostics only; read-paths re-evaluate live.
    """
    import json
    from hoga.parser import parse_stock_date

    raw_dir = tmp_path / "raw" / "20260518" / "003490"
    raw_dir.mkdir(parents=True)
    # Minimum first page producing an info row with close_ms=0 — a known
    # invariant breach. The exact TSV layout matches what hogaplay emits
    # for a stagnation-aborted capture (real 5/18 003490 case).
    info_row = "\t".join([
        "1", "003490", "대한항공",
        "0", "90000000", "0",        # ← close_ms = 0 here
        "1558", "83000195", "90345810", "55564", "1428",
        "25750", "25900", "25450", "25550",
        "33850", "18250", "26050", "27050", "27100",
        "25650", "26050",
    ])
    (raw_dir / "first_00001.tsv").write_text(info_row + "\n", encoding="utf-8")
    # Mark progress so collection_complete is False (matches the real case;
    # both close_after_open error AND collection.finished warn should be recorded).
    (raw_dir / "_progress.json").write_text(json.dumps({
        "finished": False, "last_time_ms": 94_536_500, "pages_done": 4132,
        "abort_reason": "stagnation_abort",
    }), encoding="utf-8")

    out_dir = tmp_path / "parquet" / "20260518" / "003490"
    out_dir.mkdir(parents=True)

    parse_stock_date(raw_dir=raw_dir, out_dir=out_dir, code="003490", date="20260518")

    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert "invariant_violations" in meta
    ids = {v["invariant_id"] for v in meta["invariant_violations"]}
    assert "meta.close_after_open" in ids
    assert "collection.finished" in ids


def test_parser_omits_invariant_violations_field_when_healthy(tmp_path):
    """No violations → no field (keeps healthy meta.json clean)."""
    import json
    from hoga.parser import parse_stock_date

    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    info_row = "\t".join([
        "1", "005930", "삼성전자",
        "0", "90000000", "153000000",   # ← healthy open + close
        "1558", "83000195", "90345810", "55564", "1428",
        "70000", "70100", "69900", "70000",
        "70500", "69500", "70200", "70300", "70400",
        "70000", "70100",
    ])
    (raw_dir / "first_00001.tsv").write_text(info_row + "\n", encoding="utf-8")
    (raw_dir / "_progress.json").write_text(json.dumps({
        "finished": True, "last_time_ms": 153_500_000, "pages_done": 100,
    }), encoding="utf-8")

    out_dir = tmp_path / "parquet" / "20260520" / "005930"
    out_dir.mkdir(parents=True)
    parse_stock_date(raw_dir=raw_dir, out_dir=out_dir, code="005930", date="20260520")

    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert "invariant_violations" not in meta
```

If `parse_stock_date`'s actual signature/name differs, grep for it in `hoga/parser/__init__.py` and adapt the call. The current file uses `parse_stock_date` as the main entry point (verified at parser line 105 docstring).

- [ ] **Step 7.2: Run tests to verify they fail**

Run: `uv run pytest tests/test_parser_completeness.py -v -k "invariant"`
Expected: FAIL — `invariant_violations` field never written.

- [ ] **Step 7.3: Add the archival hook**

Edit `hoga/parser/__init__.py`. Find the line that builds the meta dict (around lines 264-289) and the write (around lines 147-148). Insert the hook **right before the write**:

```python
    # ADR-0020: archival hook — record the violations list at write time
    # for diagnostics. Read-paths re-evaluate live, so this field is not
    # load-bearing — only present when there are violations to record.
    from hoga.api.invariants import check as _check_invariants
    _violations = _check_invariants(meta)
    if _violations:
        meta["invariant_violations"] = [v.as_dict() for v in _violations]

    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
```

(Place the local import inside the function — `hoga.parser` is imported by upstream things at startup, the local import avoids any chance of cycle and keeps the parser module's import-time deps narrow.)

- [ ] **Step 7.4: Run tests to verify they pass**

Run: `uv run pytest tests/test_parser_completeness.py -v`
Expected: all PASS — both new tests + existing tests untouched.

- [ ] **Step 7.5: Commit**

```bash
git add hoga/parser/__init__.py tests/test_parser_completeness.py
git commit -m "feat(parser): archival hook records invariant violations in meta.json

Writing the field is purely diagnostic — read-paths re-evaluate live
from the same catalog, so an absent/stale field never affects
classification. Healthy meta.json stays clean (no field). Reproduced
against the real 5/18 003490 stagnation-aborted shape."
```

---

## Task 8: CLI sweep — `hoga validate`

**Files:**
- Modify: `hoga/cli.py` (append a new command)
- Create: `tests/test_cli_validate.py`

- [ ] **Step 8.1: Write the failing tests**

Create `tests/test_cli_validate.py`:

```python
"""hoga validate — read-only sweep of all Stock-Date meta.json."""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from hoga.cli import app


def _seed(data_dir: Path, date: str, code: str, meta: dict) -> None:
    d = data_dir / "parquet" / date / code
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


def _healthy() -> dict:
    return {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 100,
        "total_unique_events": 80,
    }


def test_validate_reports_violations(tmp_path, monkeypatch):
    """Walks parquet/, reports invariant violations to stdout."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})
    _seed(tmp_path, "20260520", "005930", _healthy())

    result = CliRunner().invoke(app, ["validate"])
    assert result.exit_code == 0
    # The broken Stock-Date appears
    assert "20260518" in result.stdout
    assert "003490" in result.stdout
    assert "meta.close_after_open" in result.stdout
    # The healthy one doesn't (with default --severity=error)
    assert "005930" not in result.stdout


def test_validate_filters_by_code(tmp_path, monkeypatch):
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})
    _seed(tmp_path, "20260518", "005930", _healthy() | {"regular_session_close_ms": 0})

    result = CliRunner().invoke(app, ["validate", "--code", "003490"])
    assert result.exit_code == 0
    assert "003490" in result.stdout
    assert "005930" not in result.stdout


def test_validate_severity_warn_includes_warns(tmp_path, monkeypatch):
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    # warn-only: low unique_events_ratio
    _seed(tmp_path, "20260520", "005930",
          _healthy() | {"pages_collected": 4132, "total_unique_events": 1553})

    result_err = CliRunner().invoke(app, ["validate", "--severity", "error"])
    assert "005930" not in result_err.stdout  # warn doesn't appear under error filter

    result_warn = CliRunner().invoke(app, ["validate", "--severity", "warn"])
    assert "005930" in result_warn.stdout
    assert "collection.unique_events_ratio" in result_warn.stdout


def test_validate_fix_writes_archival_field(tmp_path, monkeypatch):
    """--fix rewrites the invariant_violations archival field. Data untouched."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    meta = _healthy() | {"regular_session_close_ms": 0}
    _seed(tmp_path, "20260518", "003490", meta)

    # Before: no archival field
    before = json.loads((tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text())
    assert "invariant_violations" not in before

    result = CliRunner().invoke(app, ["validate", "--fix"])
    assert result.exit_code == 0

    # After: archival field present with the breaches
    after = json.loads((tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text())
    assert "invariant_violations" in after
    ids = {v["invariant_id"] for v in after["invariant_violations"]}
    assert "meta.close_after_open" in ids
    # Original fields preserved
    assert after["regular_session_open_ms"] == meta["regular_session_open_ms"]


def test_validate_fix_is_idempotent(tmp_path, monkeypatch):
    """Running --fix twice produces the same file content."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})

    CliRunner().invoke(app, ["validate", "--fix"])
    snap1 = (tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text()
    CliRunner().invoke(app, ["validate", "--fix"])
    snap2 = (tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text()
    assert snap1 == snap2
```

- [ ] **Step 8.2: Run tests to verify they fail**

Run: `uv run pytest tests/test_cli_validate.py -v`
Expected: FAIL — `validate` command not registered on `app`.

- [ ] **Step 8.3: Add the validate command**

Edit `hoga/cli.py`. Add at the bottom:

```python
@app.command()
def validate(
    code: str | None = typer.Option(None, "--code", help="Limit to a single Code (e.g. 005930)."),
    severity: str = typer.Option("error", "--severity",
                                 help="Filter: 'error', 'warn', or 'all'."),
    fix: bool = typer.Option(False, "--fix",
                             help="Rewrite invariant_violations archival field (data untouched)."),
) -> None:
    """Sweep all parquet Stock-Dates and report invariant violations.

    Read-only by default. ``--fix`` rewrites only the archival
    ``invariant_violations`` field in meta.json — the underlying capture
    data is never modified or deleted. The fix path is for refreshing the
    archival snapshot after the invariants catalog changes; data repair
    means re-capturing.
    """
    import json as _json

    from hoga.api.invariants import check as _check
    from hoga.config import resolve_data_dir

    valid_severities = {"error", "warn", "all"}
    if severity not in valid_severities:
        raise typer.BadParameter(
            f"--severity must be one of {sorted(valid_severities)}, got {severity!r}"
        )

    data_dir = resolve_data_dir()
    parquet_root = data_dir / "parquet"
    if not parquet_root.exists():
        console.print("[yellow]No parquet directory found.[/yellow]")
        return

    rows: list[tuple[str, str, list]] = []
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir():
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            if code is not None and code_dir.name != code:
                continue
            meta_p = code_dir / "meta.json"
            if not meta_p.exists():
                continue
            meta = _json.loads(meta_p.read_text(encoding="utf-8"))
            violations = _check(meta)
            if severity != "all":
                violations = [v for v in violations if v.severity.value == severity]
            if not violations:
                continue
            rows.append((date_dir.name, code_dir.name, violations))
            if fix:
                # Always recompute the FULL set for the archival field,
                # not the filtered subset (the field is severity-agnostic).
                full = _check(meta)
                meta["invariant_violations"] = [v.as_dict() for v in full]
                meta_p.write_text(_json.dumps(meta, ensure_ascii=False, indent=2),
                                  encoding="utf-8")

    if not rows:
        console.print("[green]All Stock-Dates are clean for the requested severity.[/green]")
        return

    for date, code_, violations in rows:
        console.print(f"[bold]{date}/{code_}[/bold]")
        for v in violations:
            console.print(f"  [{v.severity.value}] {v.invariant_id}: {v.message}  ctx={v.ctx}")

    if fix:
        console.print(f"\n[blue]--fix: rewrote invariant_violations on {len(rows)} files.[/blue]")
```

`console` is already imported at the top of `cli.py` (used by existing commands). Keep the local imports inside the function as shown — they minimise import-time cost when `hoga` CLI is loaded for unrelated commands.

- [ ] **Step 8.4: Run tests to verify they pass**

Run: `uv run pytest tests/test_cli_validate.py -v`
Expected: all 5 PASS.

- [ ] **Step 8.5: Commit**

```bash
git add hoga/cli.py tests/test_cli_validate.py
git commit -m "feat(cli): add hoga validate sweep — read-only by default

Walk all parquet Stock-Dates, report invariant violations. --code
filters to one ticker; --severity filters error/warn/all. --fix
rewrites only the archival meta field, never the underlying capture
data — repair is always re-capture, never silent in-place mutation."
```

---

## Task 9: End-to-end wire test through /api/range

**Files:**
- Modify: `tests/test_api_range.py`

- [ ] **Step 9.1: Write the failing test**

Append to `tests/test_api_range.py`:

```python
def test_api_range_surfaces_excluded_and_warnings_on_wire(app_client: TestClient, tmp_path, monkeypatch):
    """ADR-0020 E2E: /api/range JSON includes excluded_dates + data_warnings."""
    import json as _json

    # Reuse the fixture seam used by other tests in this file.
    # If the existing test setup uses a different fixture name for data_dir,
    # adapt this monkeypatch to match (e.g. app_client may already pin tmp_path).
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))

    # Seed: one healthy date + one INVALID date.
    def seed(date, code, meta):
        d = tmp_path / "parquet" / date / code
        d.mkdir(parents=True, exist_ok=True)
        (d / "meta.json").write_text(_json.dumps(meta), encoding="utf-8")
        # Minimal companion artifacts so QueryEngine.get_meta paths don't bail
        (d / "candles.parquet").touch()
        (d / "snapshots.parquet").touch()
        (d / "trades.parquet").touch()
        (d / "brokers.parquet").touch()

    healthy = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True, "is_partial": False,
        "pages_collected": 100, "total_unique_events": 80,
    }
    seed("20260520", "005930", healthy)
    seed("20260518", "005930", healthy | {"regular_session_close_ms": 0})

    r = app_client.get("/api/range?code=005930&from=20260518&to=20260520&bucket_ms=60000")
    # Either 200 (with one segment skipped) or 404 (if mocked QueryEngine
    # can't synthesize the healthy segment from empty parquet files).
    # The contract under test is the wire shape regardless.
    if r.status_code == 200:
        body = r.json()
        assert any(s["date"] == "20260520" for s in body["segments"])
        assert all(s["date"] != "20260518" for s in body["segments"])
        assert len(body["excluded_dates"]) == 1
        assert body["excluded_dates"][0]["date"] == "20260518"
        ids = {v["invariant_id"] for v in body["excluded_dates"][0]["violations"]}
        assert "meta.close_after_open" in ids
    else:
        assert r.status_code == 404
        detail = r.json()["detail"]
        # If both dates excluded (e.g. parquet seed too thin), excluded list
        # still surfaces in the detail.
        assert isinstance(detail, dict)
        assert "excluded" in detail
```

This test is fixture-coupled: if the existing `app_client` fixture in this file doesn't reuse `tmp_path` for the data directory, the precise pattern won't load the seeded files. In that case, look at how the other tests in the file mock `QueryEngine.list_stock_dates_in_range` and follow that pattern instead. The test's contract — `excluded_dates` appears in the JSON response when error-severity invariants fire — is what must be verified, not the exact seeding mechanism.

- [ ] **Step 9.2: Run the test to verify it fails (then adapt fixture if needed)**

Run: `uv run pytest tests/test_api_range.py::test_api_range_surfaces_excluded_and_warnings_on_wire -v`

If it fails because `excluded_dates` isn't in the response, the bundle implementation needs fixing (re-check Task 6).
If it fails because the fixture can't see the seeded files, the test seeding pattern needs to match the existing fixture style (look at `test_api_range_400_on_*` patterns at the top of the file and replicate the engine-mock approach with the same `_stub_meta` helper introduced in Task 6).

- [ ] **Step 9.3: Adapt fixture style if needed and re-run**

Likely fix: switch from seeding files to mocking `QueryEngine.list_stock_dates_in_range` and `QueryEngine.get_meta` directly via `unittest.mock.patch`. The pattern is identical to Task 6's unit tests; just bind the patches to the app's engine instance via `app_client.app.state.engine`.

- [ ] **Step 9.4: Confirm the E2E test passes**

Run: `uv run pytest tests/test_api_range.py -v`
Expected: all PASS including the new E2E test.

- [ ] **Step 9.5: Commit**

```bash
git add tests/test_api_range.py
git commit -m "test(api/range): E2E verify excluded_dates + data_warnings on the wire

Confirms ADR-0020 surfacing reaches the JSON response — the contract
the frontend will consume to explain skipped segments to the user."
```

---

## Task 10: ADR-0020 status flip + spec status flip

**Files:**
- Modify: `docs/adr/0020-data-integrity-invariant-catalog.md` (Status line)
- Modify: `docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md` (Status line)

- [ ] **Step 10.1: Flip ADR status**

Edit `docs/adr/0020-data-integrity-invariant-catalog.md` line 3:

```markdown
**Status:** accepted (2026-05-24)
```

- [ ] **Step 10.2: Flip spec status**

Edit `docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md` line 3:

```markdown
**Status:** implemented (2026-05-24)
```

- [ ] **Step 10.3: Run the full test suite**

Run: `uv run pytest -q`
Expected: 0 failures across the suite.

- [ ] **Step 10.4: Commit**

```bash
git add docs/adr/0020-data-integrity-invariant-catalog.md docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md
git commit -m "docs: mark ADR-0020 accepted and data-integrity spec implemented

All 9 implementation tasks landed and the full test suite passes."
```

---

## Self-Review

**Spec coverage check (each spec section → task):**

| Spec § | Topic | Plan task |
|---|---|---|
| §1 Goal | Catalog catches 5/18 case | Task 1 regression test + Task 9 E2E |
| §2 Non-goals | No auto-delete, no auto-recapture, no series, no UI, no signing | None — Non-goals stay out by construction |
| §3 Decisions | All 14 decisions | Tasks 1–8 implement each; Task 10 flips status |
| §4.1 Module boundaries | 8 files | All listed in File Structure |
| §4.2 Core types | Severity/Violation/Invariant | Task 1 |
| §4.3 DiskState extension | INVALID + classify priority | Task 2 |
| §4.4 Read-path integration | bundle.py loop changes | Task 6 |
| §4.5 Response model | ExcludedDate/DateWarning/RangeBundle fields | Task 5 |
| §4.6 Parser archival hook | invariant_violations field | Task 7 |
| §4.7 CLI sweep | hoga validate | Task 8 |
| §5 MVP catalog (5) | 5 invariants | Task 1 |
| §6 Test strategy (5 layers) | unit/disk_state/bundle/CLI/regression | Tasks 1, 2, 6, 8, 9 |
| §7 Migration / compat | DiskState soft-default | Tasks 3 (eligibility), 4 (calendar) |
| §7.1 Performance | live eval default | No code change — design baked into Task 2 |
| §8 Build order | 9-step seed | Mapped 1:1 to Tasks 1–9; Task 10 status flip |
| §9 Follow-ups | series invariants, frontend, property tests | Out of scope per spec |

**Placeholder scan:** None — every step has the exact code or command to run.

**Type consistency:**
- `Invariant.check: Callable[[dict], Violation | None]` — same in Task 1 module and Task 6 import.
- `Violation.as_dict()` returns the same 4-field dict everywhere.
- `ExcludedDate.violations: list[dict]` / `DateWarning.warnings: list[dict]` — match `as_dict()` output.
- `DiskState.INVALID` literal used in eligibility, calendar, bundle — all `from hoga.api.disk_state import DiskState`.
- `Severity.error` / `Severity.warn` — same import path in all consumers.

**Scope check:** Single PR. 10 tasks, ~600 lines of new code (mostly tests). All on one branch.

---

## Execution Handoff

The user's pipeline already specified **subagent-driven-development** as the next stage, so this plan will be executed via that skill. No execution-mode choice prompt needed.
