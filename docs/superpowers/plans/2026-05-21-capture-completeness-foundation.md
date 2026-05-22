# Capture Completeness Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two completeness bits (`collection_complete`, `is_partial`) to the on-disk `meta.json` and surface them through the API, with a shared `disk_state` module that future capture/calendar/parser callers can rely on. Foundation for Plans B (queue + APIs) and C (frontend UI).

**Architecture:** Three layered changes, bottom-up:
1. **Collector** writes a `finished: true` marker into `_progress.json` only on natural termination (Page Step loop exits via `decision.should_stop`).
2. **Parser** reads that marker, plus snapshot-derived gap analysis, and writes both bits to `meta.json`.
3. A new `hoga/api/disk_state.py` module is the single source of truth that classifies a (code, date) directory into `{NONE, CLIENT_INCOMPLETE, SOURCE_PARTIAL, COMPLETE}`. Worker `deciding` phase (Plan B), calendar markers (Plan B), and `list_stock_dates` (this plan) all read through this module.

Spec authority: `docs/superpowers/specs/2026-05-21-capture-range-redesign-design.md` §3.5, §3.6, §11.Q17. ADR-0007 is authored as the first task to make the relationship to ADR-0006 explicit before any code changes land.

**Tech Stack:** Python 3.14, `pydantic`, `duckdb`, `pyarrow`, `pytest`. No new runtime dependencies.

---

## File Structure

```
docs/adr/0007-capture-grows-disk-state-extracted.md        [new]    ADR amending 0006
hoga/api/disk_state.py                                     [new]    DiskState enum + check_disk_state + has_meaningful_gaps
hoga/collector/orchestrator.py                             [modify] _write_progress gains finished arg; terminal write sets True
hoga/parser/__init__.py                                    [modify] _build_meta reads _progress.json finished + computes is_partial
hoga/api/models.py                                         [modify] StockDate gains collection_complete + is_partial fields
hoga/api/queries.py                                        [modify] list_stock_dates reads new meta fields with safe legacy defaults

tests/test_collector_progress_finished.py                  [new]    finished:true on natural term; False on cancel/exception
tests/test_api_disk_state.py                               [new]    four-state classification covers all branches
tests/test_parser_completeness.py                          [new]    meta written with both bits; gap heuristic triggers
tests/test_api_stock_dates_completeness.py                 [new]    list_stock_dates surfaces both bits
```

Each module has one responsibility:
- `disk_state.py` — classification logic only; no I/O beyond reading `meta.json` and snapshot parquet metadata via DuckDB
- `orchestrator.py` change — additive parameter; CLI behavior unchanged
- `parser/__init__.py` change — reads `_progress.json` once, writes two new keys
- `models.py` + `queries.py` — wire surface additions only

---

## Pre-flight (do before Task 0)

- [ ] **Step P1: Verify you're on the right worktree branch**

Run: `git rev-parse --abbrev-ref HEAD`
Expected: `worktree-feat+frontend2` (or whatever the user's current worktree branch is — confirm with the user if different).

- [ ] **Step P2: Verify tests run green at baseline**

Run: `uv run pytest -q tests/test_collector_progress_callback.py tests/test_parser_e2e.py`
Expected: all tests pass. If any fail, stop and investigate before starting — these are the test files this plan most resembles.

- [ ] **Step P3: Verify `pyarrow` and `duckdb` are importable** (needed by disk_state)

Run: `uv run python -c "import pyarrow, duckdb; print('ok')"`
Expected: `ok`.

---

## Task 0: Author ADR-0007 amending ADR-0006

**Files:**
- Create: `docs/adr/0007-capture-grows-disk-state-extracted.md`

**Why this is task 0:** ADR-0006 (written 2026-05-21) explicitly says "if the module passes ~700 lines AND a clean horizontal seam appears, revisit." This plan introduces a second caller for the disk-state classification (calendar endpoint in Plan B), which is exactly the seam ADR-0006 anticipated. Recording the decision before code lands prevents the same grilling from recurring later.

- [ ] **Step 1: Create the ADR file with full content**

Create `docs/adr/0007-capture-grows-disk-state-extracted.md`:

```markdown
# 0007 — Capture module grows to queue + workers; `disk_state` extracted as horizontal seam

**Status:** accepted (2026-05-21) — amends ADR-0006
**Supersedes parts of:** ADR-0006 (`captures.py` stays single module)

## Decision

A new module `hoga/api/disk_state.py` hosts the classification of a (code, date) directory into one of four states: `NONE`, `CLIENT_INCOMPLETE`, `SOURCE_PARTIAL`, `COMPLETE`. The module exports:

- `class DiskState(Enum)`
- `def check_disk_state(data_dir: Path, code: str, date: str) -> DiskState`
- `def has_meaningful_gaps(snapshots_parquet: Path) -> bool`

Callers: (a) `hoga/parser/__init__.py::_build_meta` writes the two completeness bits derived from this module's logic; (b) the worker `deciding` phase in `hoga/api/captures.py` (Plan B) decides skip/resume/fresh; (c) the `GET /api/inventory/calendar` endpoint (Plan B) renders cell markers; (d) `hoga/api/queries.py::list_stock_dates` exposes the bits on the wire.

`captures.py` itself stays a single module per ADR-0006's spirit even as it grows to host queue state, worker pool, cookie-pause handling, and the expanded route surface. The growth budget threshold (~700 lines) from ADR-0006 is acknowledged as imminent; the plan accepts it.

## Why amend ADR-0006

ADR-0006 set two conditions for revisiting the "stay single module" rule:
1. ~700 lines, AND
2. A clean horizontal seam appears.

Both conditions are now met in different parts of the surface:
- (1) becomes true inside `captures.py` after Plan B (queue + workers + pause adds ~400 lines on top of the current 442).
- (2) becomes true *between* `captures.py` and a new sibling: the calendar endpoint needs the same disk classification, and inlining it as a `captures.py` private function would make the function look "owned by captures" when it is actually shared.

The two-adapters rule from the architecture vocabulary (introduce a seam only when something actually varies across it): the calendar endpoint is the *second adapter*. With one caller, inlining is right. With two callers, a shared module is right.

`captures.py` itself does not split — the queue/worker/pause concepts are one cohesive lifecycle around one singleton state. ADR-0006's anti-split arguments still apply there.

## Consequences worth flagging for future readers

- **`disk_state.py` is a pure-logic module.** No global state, no async, no SSE. Tests should be straightforward unit tests against a `tmp_path`-style fixture directory.
- **If a fifth caller appears** (e.g., a CLI inventory-status command), they import from `disk_state.py` like everyone else — no further extraction needed.
- **The growth budget in ADR-0006 has effectively retired.** Future growth in `captures.py` is judged on the same internal-cohesion grounds, not against a line count.
- **`has_meaningful_gaps` heuristic is intentionally crude in v1** — "≥1 minute consecutive empty in continuous-trading hours." Refine after observing real data; not an ADR-level decision.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0007-capture-grows-disk-state-extracted.md
git commit -m "$(cat <<'EOF'
docs(adr): add ADR-0007 amending 0006 — disk_state extracted as horizontal seam

ADR-0006 set two conditions for revisiting "captures.py stays single module":
(1) ~700 lines and (2) a clean horizontal seam appears. Plan B will hit (1)
inside captures.py and (2) is met now — calendar endpoint becomes a second
caller for the disk-state classification.

Records the decision before code lands so the same grilling doesn't recur.
EOF
)"
```

---

## Task 1: Add `finished` to `_progress.json` schema

**Files:**
- Modify: `hoga/collector/orchestrator.py:136-157` (`_write_progress`), `hoga/collector/orchestrator.py:224-231` (mid-loop call), `hoga/collector/orchestrator.py:321-328` (terminal call)
- Test: `tests/test_collector_progress_finished.py` [new]

**Note on existing tests:** `tests/test_collector_progress_callback.py` already exercises the cancel and natural-termination paths with `_FakeClient`. Reuse the same fake-client shape in the new test file; do not modify the existing tests (they assert different invariants).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_collector_progress_finished.py`:

```python
"""_progress.json["finished"] tracks whether the collector naturally terminated."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.collector.orchestrator import (
    CancelToken,
    CaptureCancelled,
    collect_stock_date,
)


class _FakeClientNaturalTerm:
    """3 small pages then drained empties → controller stops normally."""
    def __init__(self) -> None:
        self.first_calls = 0

    def fetch_info(self, code: str, date: str) -> str:
        del code, date
        return "info_field\tvalue\n"

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        del code, date, time_ms
        self.first_calls += 1
        if self.first_calls > 3:
            return ""
        seq_base = self.first_calls * 1000
        t_base = 90000000 + (self.first_calls - 1) * 60000
        return "\n".join(
            f"1\t1\t0\t{seq_base + i}\t{t_base + i}\t000\t1000" for i in range(5)
        ) + "\n"

    def fetch_chart(self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000) -> str:
        del code, date, time_ms, bong, gap
        return ""


class _FakeClientNeverEnds:
    """Always returns non-empty page with new seqs → only cancel can stop it."""
    def __init__(self) -> None:
        self.first_calls = 0

    def fetch_info(self, code: str, date: str) -> str:
        del code, date
        return "info_field\tvalue\n"

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        del code, date, time_ms
        self.first_calls += 1
        seq_base = self.first_calls * 1000
        t_base = 90000000 + (self.first_calls - 1) * 60000
        return "\n".join(
            f"1\t1\t0\t{seq_base + i}\t{t_base + i}\t000\t1000" for i in range(5)
        ) + "\n"

    def fetch_chart(self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000) -> str:
        del code, date, time_ms, bong, gap
        return ""


def test_progress_json_has_finished_true_on_natural_termination(tmp_path: Path) -> None:
    collect_stock_date(
        client=_FakeClientNaturalTerm(),
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        allow_partial=True,  # required because date 20260520 is "today" in some clocks; keeps test deterministic
    )
    progress = json.loads(
        (tmp_path / "raw" / "20260520" / "005930" / "_progress.json").read_text(encoding="utf-8")
    )
    assert progress["finished"] is True


def test_progress_json_finished_false_on_cancel(tmp_path: Path) -> None:
    token = CancelToken()
    token.cancel()  # pre-cancel so the loop bails on first iteration
    with pytest.raises(CaptureCancelled):
        collect_stock_date(
            client=_FakeClientNeverEnds(),
            code="005930",
            date="20260520",
            data_dir=tmp_path,
            rate_limit_s=0.0,
            allow_partial=True,
            cancel_token=token,
        )
    progress_path = tmp_path / "raw" / "20260520" / "005930" / "_progress.json"
    if progress_path.exists():
        progress = json.loads(progress_path.read_text(encoding="utf-8"))
        assert progress["finished"] is False
    # If progress_path doesn't exist (pre-cancel bailed before first write),
    # absence is also valid — finished defaults to False at the parser layer.


def test_progress_json_missing_finished_treated_as_false(tmp_path: Path) -> None:
    """Backward-compat: legacy _progress.json without the key is read as not finished."""
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "_progress.json").write_text(
        json.dumps({
            "last_time_ms": 90000000,
            "pages_done": 5,
            "global_seqs_seen": 25,
            "started_at": "2026-05-20T09:00:00+09:00",
            "finished_at": None,
        }),
        encoding="utf-8",
    )
    # This test only asserts the file format we expect to coexist with. The
    # parser-layer interpretation is tested in test_parser_completeness.py.
    progress = json.loads((raw_dir / "_progress.json").read_text(encoding="utf-8"))
    assert "finished" not in progress  # legacy shape
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_collector_progress_finished.py -v`
Expected: First two tests FAIL with `KeyError: 'finished'` or `assert False == True` (the field doesn't exist yet). Third test PASSES (it only documents legacy shape).

- [ ] **Step 3: Update `_write_progress` to accept and write `finished`**

In `hoga/collector/orchestrator.py:136-157`, replace the function with:

```python
def _write_progress(
    path: Path,
    *,
    last_time_ms: int,
    pages_done: int,
    seq_count: int,
    started_at: str,
    finished_at: str | None,
    finished: bool = False,
) -> None:
    path.write_text(
        json.dumps(
            {
                "last_time_ms": last_time_ms,
                "pages_done": pages_done,
                "global_seqs_seen": seq_count,
                "started_at": started_at,
                "finished_at": finished_at,
                "finished": finished,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
```

- [ ] **Step 4: Update the terminal call site to pass `finished=True`**

In `hoga/collector/orchestrator.py:321-328`, replace the terminal `_write_progress` call with:

```python
    finished_at = _now_kst().isoformat()
    _write_progress(
        raw_dir / "_progress.json",
        last_time_ms=t,
        pages_done=page_idx,
        seq_count=len(seen_seqs),
        started_at=started_at,
        finished_at=finished_at,
        finished=True,
    )
```

The mid-loop call at lines 224-231 already passes `finished_at=None`; leave the default `finished=False` to apply.

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_collector_progress_finished.py -v`
Expected: All three tests PASS.

- [ ] **Step 6: Run the broader collector test suite to verify no regression**

Run: `uv run pytest tests/test_collector_progress_callback.py tests/test_collector_orchestrator.py -v`
Expected: All tests PASS (the additive `finished` field shouldn't break existing assertions).

- [ ] **Step 7: Commit**

```bash
git add hoga/collector/orchestrator.py tests/test_collector_progress_finished.py
git commit -m "$(cat <<'EOF'
feat(collector): add finished marker to _progress.json

Mid-loop writes carry finished=False (default). The terminal write at the
end of collect_stock_date sets finished=True only when the Page Step loop
exited via natural termination (decision.should_stop). Cancel paths raise
CaptureCancelled before the terminal write, leaving the marker False on
disk — exactly the signal the parser will use to compute collection_complete.
EOF
)"
```

---

## Task 2: Create `hoga/api/disk_state.py` with enum + signatures (red tests)

**Files:**
- Create: `hoga/api/disk_state.py`
- Create: `tests/test_api_disk_state.py`

- [ ] **Step 1: Write the failing tests for the enum + signature**

Create `tests/test_api_disk_state.py`:

```python
"""disk_state.check_disk_state classifies a (code, date) directory into one of four states."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api.disk_state import DiskState, check_disk_state


def test_disk_state_enum_has_four_members() -> None:
    assert set(DiskState) == {
        DiskState.NONE,
        DiskState.CLIENT_INCOMPLETE,
        DiskState.SOURCE_PARTIAL,
        DiskState.COMPLETE,
    }


def test_none_when_no_directory_exists(tmp_path: Path) -> None:
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.NONE
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.api.disk_state'`.

- [ ] **Step 3: Create the module with enum and NONE-only implementation**

Create `hoga/api/disk_state.py`:

```python
"""Classifies a (code, date) Stock-Date directory into one of four completeness states.

Shared by the parser (writes the two completeness bits into meta.json), the
worker `deciding` phase (decides skip/resume/fresh — Plan B), the calendar
endpoint (cell markers — Plan B), and `queries.list_stock_dates` (surfaces
the bits on the wire). See ADR-0007 for why this lives in its own module.
"""

from __future__ import annotations

import json
from enum import Enum
from pathlib import Path


class DiskState(Enum):
    NONE = "none"
    CLIENT_INCOMPLETE = "client_incomplete"
    SOURCE_PARTIAL = "source_partial"
    COMPLETE = "complete"


def check_disk_state(data_dir: Path, code: str, date: str) -> DiskState:
    """Classify the on-disk state for (code, date) under ``data_dir``.

    Resolution order:
      1. ``data/parquet/{date}/{code}/meta.json`` exists → COMPLETE or SOURCE_PARTIAL
         (depending on meta["collection_complete"] and meta["is_partial"]).
         Falls through to CLIENT_INCOMPLETE if meta says the capture was
         interrupted (collection_complete=False) — this matches the case
         where parse ran on partial raw and we want to resume.
      2. ``data/raw/{date}/{code}/`` has any TSV files → CLIENT_INCOMPLETE.
      3. Otherwise → NONE.
    """
    parquet_dir = data_dir / "parquet" / date / code
    meta_path = parquet_dir / "meta.json"
    if meta_path.exists():
        # Implemented in Task 4
        raise NotImplementedError("meta.json branch — see Task 4")

    raw_dir = data_dir / "raw" / date / code
    if raw_dir.exists() and any(raw_dir.glob("first_*.tsv")):
        # Implemented in Task 3
        raise NotImplementedError("raw-only branch — see Task 3")

    return DiskState.NONE
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: Both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/disk_state.py tests/test_api_disk_state.py
git commit -m "feat(api): introduce disk_state module with DiskState enum + NONE branch

ADR-0007 spans the rationale. CLIENT_INCOMPLETE / SOURCE_PARTIAL / COMPLETE
branches arrive in the next tasks."
```

---

## Task 3: Implement CLIENT_INCOMPLETE (raw-only) branch

**Files:**
- Modify: `hoga/api/disk_state.py`
- Modify: `tests/test_api_disk_state.py`

- [ ] **Step 1: Add the failing test**

Append to `tests/test_api_disk_state.py`:

```python
def test_client_incomplete_when_only_raw_exists(tmp_path: Path) -> None:
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "first_001.tsv").write_text("dummy\n", encoding="utf-8")
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.CLIENT_INCOMPLETE


def test_client_incomplete_only_if_first_pages_exist(tmp_path: Path) -> None:
    """Empty raw dir or one with only info.tsv shouldn't be classified as in-progress."""
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.mkdir(parents=True)
    (raw_dir / "info.tsv").write_text("info\n", encoding="utf-8")
    # No first_*.tsv files yet — collector died before storing any page.
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.NONE
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: `test_client_incomplete_when_only_raw_exists` FAILS with `NotImplementedError: raw-only branch — see Task 3`. The new "only info.tsv" test PASSES already (the `any(glob)` check is False).

- [ ] **Step 3: Replace the `NotImplementedError` raw-only branch**

In `hoga/api/disk_state.py::check_disk_state`, replace:

```python
    if raw_dir.exists() and any(raw_dir.glob("first_*.tsv")):
        # Implemented in Task 3
        raise NotImplementedError("raw-only branch — see Task 3")
```

with:

```python
    if raw_dir.exists() and any(raw_dir.glob("first_*.tsv")):
        return DiskState.CLIENT_INCOMPLETE
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: All four tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/disk_state.py tests/test_api_disk_state.py
git commit -m "feat(disk_state): CLIENT_INCOMPLETE branch (raw pages present, no meta)"
```

---

## Task 4: Implement COMPLETE / SOURCE_PARTIAL branch (meta.json present)

**Files:**
- Modify: `hoga/api/disk_state.py`
- Modify: `tests/test_api_disk_state.py`

- [ ] **Step 1: Add the failing tests**

Append to `tests/test_api_disk_state.py`:

```python
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
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.COMPLETE


def test_source_partial_when_meta_says_complete_but_partial(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=True, is_partial=True)
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.SOURCE_PARTIAL


def test_client_incomplete_when_meta_says_not_complete(tmp_path: Path) -> None:
    _write_meta(tmp_path, "005930", "20260520", collection_complete=False, is_partial=True)
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.CLIENT_INCOMPLETE


def test_legacy_meta_without_bits_defaults_to_client_incomplete(tmp_path: Path) -> None:
    """Pre-foundation meta.json has no completeness fields. Conservative default:
    treat as client_incomplete so the worker tries to resume and upgrade the meta."""
    _write_meta(tmp_path, "005930", "20260520")  # neither field
    assert check_disk_state(tmp_path, "005930", "20260520") == DiskState.CLIENT_INCOMPLETE
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: The four new tests FAIL with `NotImplementedError: meta.json branch — see Task 4`.

- [ ] **Step 3: Replace the `NotImplementedError` meta.json branch**

In `hoga/api/disk_state.py::check_disk_state`, replace:

```python
    if meta_path.exists():
        # Implemented in Task 4
        raise NotImplementedError("meta.json branch — see Task 4")
```

with:

```python
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        # Legacy meta (pre-foundation) lacks both fields. Conservative default
        # is "client incomplete" so a subsequent capture run will upgrade it.
        collection_complete = bool(meta.get("collection_complete", False))
        is_partial = bool(meta.get("is_partial", True))
        if not collection_complete:
            return DiskState.CLIENT_INCOMPLETE
        return DiskState.SOURCE_PARTIAL if is_partial else DiskState.COMPLETE
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: All eight tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/disk_state.py tests/test_api_disk_state.py
git commit -m "feat(disk_state): COMPLETE / SOURCE_PARTIAL branch reading meta.json

Legacy meta without the two completeness fields defaults to client_incomplete,
matching the spec §3.9 conservative migration rule."
```

---

## Task 5: Implement `has_meaningful_gaps` (list-based signature)

**Files:**
- Modify: `hoga/api/disk_state.py`
- Modify: `tests/test_api_disk_state.py`

**Design decision (eng review D1, option B):** `has_meaningful_gaps` takes an in-memory list of `ts_ms` ints rather than reading the parquet file itself. The parser already has the snapshot entities in memory at the moment it computes meta — re-reading the just-written parquet is wasteful and creates a hidden ordering invariant ("must run after snapshots.write_parquet"). Passing data directly makes the dependency explicit.

`has_meaningful_gaps(ts_ms_values)` returns True if any consecutive pair within the continuous-trading window has a gap ≥ 60_000 ms. Pure function — no I/O.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api_disk_state.py`:

```python
from hoga.api.disk_state import has_meaningful_gaps


# CHART_FINAL_TIME_MS = 153100000 (15:31:00.000 in HHMMSSmmm)
# Regular session open ≈ 90000000 (09:00:00.000)


def test_no_gaps_when_snapshots_dense() -> None:
    # One snapshot per second from 09:00:00 to 09:00:30 — no gap exceeds 1s.
    ts = [90000000 + i * 1000 for i in range(31)]
    assert has_meaningful_gaps(ts) is False


def test_gap_detected_when_60s_empty() -> None:
    # 09:00:00 then jump to 09:01:30 (90 seconds later) — gap exceeds threshold.
    assert has_meaningful_gaps([90000000, 90130000]) is True


def test_gap_outside_continuous_session_ignored() -> None:
    """A gap that crosses the pre-session/session boundary must not count.
    Three dense in-session events prove there is no gap WITHIN the session;
    the pre-session sample at 08:40 is filtered out before gap analysis."""
    ts = [84000000, 90000000, 90001000, 90002000]
    # in_session = [90000000, 90001000, 90002000] — three points, 1s apart, no 60s gap.
    assert has_meaningful_gaps(ts) is False


def test_empty_list_returns_true() -> None:
    """Empty input → True (conservative: caller can't prove completeness)."""
    assert has_meaningful_gaps([]) is True


def test_single_in_session_event_returns_true() -> None:
    """One in-session datapoint isn't enough to compute gap presence; conservative True."""
    assert has_meaningful_gaps([90000000]) is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: The five new tests FAIL with `ImportError: cannot import name 'has_meaningful_gaps' from 'hoga.api.disk_state'`.

- [ ] **Step 3: Add `has_meaningful_gaps` to the module**

Append to `hoga/api/disk_state.py`:

```python
from collections.abc import Iterable

_SESSION_OPEN_MS = 90000000      # 09:00:00.000 in HHMMSSmmm
_CHART_FINAL_TIME_MS = 153100000  # 15:31:00.000 in HHMMSSmmm — the orchestrator's terminus
_GAP_THRESHOLD_MS = 60_000        # 1 minute


def has_meaningful_gaps(ts_ms_values: Iterable[int]) -> bool:
    """True if any consecutive pair within continuous-trading hours has a gap
    ≥ 1 minute. Pure function — no I/O.

    Args:
      ts_ms_values: snapshot timestamps in HHMMSSmmm encoding (parser's native form).
        Pre-session and post-close events are filtered out before gap analysis,
        so passing the full snapshot stream is safe and intended.

    Returns:
      True if a gap is detected OR input has fewer than 2 in-session datapoints
      (too sparse to prove completeness — conservative default).
    """
    in_session = sorted(
        t for t in ts_ms_values if _SESSION_OPEN_MS <= t <= _CHART_FINAL_TIME_MS
    )
    if len(in_session) < 2:
        return True
    for prev, curr in zip(in_session, in_session[1:]):
        if curr - prev >= _GAP_THRESHOLD_MS:
            return True
    return False
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_disk_state.py -v`
Expected: All tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/disk_state.py tests/test_api_disk_state.py
git commit -m "$(cat <<'EOF'
feat(disk_state): add has_meaningful_gaps heuristic (1-min threshold)

Pure function over an iterable of HHMMSSmmm timestamps — no I/O. Parser passes
the in-memory snapshot list directly rather than re-reading the just-written
parquet (avoids the hidden ordering invariant flagged in eng review D1).
EOF
)"
```

---

## Task 6: Parser writes `collection_complete` + `is_partial` into `meta.json`

**Files:**
- Modify: `hoga/parser/__init__.py:92-138` (`parse_stock_date`), `hoga/parser/__init__.py:222-244` (`_build_meta`)
- Create: `tests/test_parser_completeness.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_parser_completeness.py`:

```python
"""Parser writes collection_complete + is_partial bits into meta.json."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

# Reuse a small e2e fixture from the existing parser test infra.
# These tests assume tests/fixtures/tiny_tsv/ has been used as a working
# parser fixture before (see test_parser_e2e.py).


def _stage_raw(tmp_path: Path, fixture_name: str, code: str, date: str, *, finished: bool) -> Path:
    """Copy a tiny tsv fixture into a raw dir and stamp _progress.json with `finished`."""
    import shutil
    src = Path(__file__).parent / "fixtures" / fixture_name
    dst = tmp_path / "raw" / date / code
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst)
    (dst / "_progress.json").write_text(
        json.dumps({
            "last_time_ms": 153100000,
            "pages_done": 3,
            "global_seqs_seen": 15,
            "started_at": "2026-05-20T09:00:00+09:00",
            "finished_at": "2026-05-20T15:31:00+09:00" if finished else None,
            "finished": finished,
        }),
        encoding="utf-8",
    )
    return dst


def test_meta_has_collection_complete_true_when_progress_finished(tmp_path: Path) -> None:
    from hoga.parser import parse_stock_date
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta = json.loads((tmp_path / "parquet" / "20260520" / "005930" / "meta.json").read_text(encoding="utf-8"))
    assert meta["collection_complete"] is True


def test_meta_has_collection_complete_false_when_progress_not_finished(tmp_path: Path) -> None:
    from hoga.parser import parse_stock_date
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=False)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta = json.loads((tmp_path / "parquet" / "20260520" / "005930" / "meta.json").read_text(encoding="utf-8"))
    assert meta["collection_complete"] is False


def test_meta_collection_complete_false_when_progress_missing(tmp_path: Path) -> None:
    from hoga.parser import parse_stock_date
    raw = _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    (raw / "_progress.json").unlink()
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta = json.loads((tmp_path / "parquet" / "20260520" / "005930" / "meta.json").read_text(encoding="utf-8"))
    assert meta["collection_complete"] is False


def test_meta_is_partial_field_present(tmp_path: Path) -> None:
    """is_partial may be True or False depending on the fixture's coverage — what
    matters here is that the field exists and is boolean."""
    from hoga.parser import parse_stock_date
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta = json.loads((tmp_path / "parquet" / "20260520" / "005930" / "meta.json").read_text(encoding="utf-8"))
    assert isinstance(meta.get("is_partial"), bool)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_parser_completeness.py -v`
Expected: All four tests FAIL with `KeyError: 'collection_complete'` (or `assert ... is True` on `None`).

- [ ] **Step 3: Update `_build_meta` to accept snapshot data + emit both fields**

In `hoga/parser/__init__.py:222-248`, change `_build_meta`'s signature and body. The new `snapshots_list` parameter makes the gap-analysis input explicit — no implicit dependency on `snapshots.write_parquet` having run already.

Add a top-level import (with the other imports near the top of the file):

```python
from hoga.api.disk_state import has_meaningful_gaps
```

Then replace `_build_meta`:

```python
def _build_meta(
    *,
    info: StockInfo,
    seen_seqs: set[int],
    skipped: list[tuple[str, int, str]],
    raw_dir: Path,
    snapshots_list: list[Orderbook],
) -> dict[str, object]:
    pages = sorted(raw_dir.glob("first_*.tsv"))
    progress_path = raw_dir / "_progress.json"
    collection_complete = False
    if progress_path.exists():
        try:
            progress = json.loads(progress_path.read_text(encoding="utf-8"))
            collection_complete = bool(progress.get("finished", False))
        except (ValueError, OSError):
            collection_complete = False

    # Pure data-in/data-out: pass the in-memory snapshot timestamps directly.
    # Avoids re-reading the just-written parquet and the hidden ordering
    # invariant that would create (must run after snapshots.write_parquet).
    is_partial = has_meaningful_gaps(s.ts_ms for s in snapshots_list)

    return {
        "code": info.code,
        "name": info.name,
        "regular_session_open_ms": info.regular_session_open_ms,
        "regular_session_close_ms": info.regular_session_close_ms,
        "prev_close": info.prev_close,
        "upper_limit": info.upper_limit,
        "lower_limit": info.lower_limit,
        "today_open": info.today_open,
        "today_high": info.today_high,
        "today_low": info.today_low,
        "today_close": info.today_close,
        "info_unknowns": info.unknowns,
        "raw_info_tsv": info.raw_line,
        "pages_collected": len(pages),
        "total_unique_events": len(seen_seqs),
        "parser_version": PARSER_VERSION,
        "warnings": [{"file": f, "line": ln, "reason": r} for f, ln, r in skipped],
        "collection_complete": collection_complete,
        "is_partial": is_partial,
    }
```

The three keys `total_unique_events`, `parser_version`, and `warnings` are preserved from the existing implementation — do not drop them. The diff is purely additive: new `out_dir` parameter, two new bottom keys (`collection_complete`, `is_partial`), and the `progress.json` / `has_meaningful_gaps` reads above.

Then update the call site at `hoga/parser/__init__.py:134`:

```python
    meta = _build_meta(
        info=info,
        seen_seqs=seen_seqs,
        skipped=skipped,
        raw_dir=raw_dir,
        snapshots_list=snapshots_list,
    )
```

`snapshots_list` is the local variable already populated by `_collect_events()` earlier in `parse_stock_date` (line 110-112); passing it through requires no other plumbing change.

- [ ] **Step 4: Run parser completeness tests to verify they pass**

Run: `uv run pytest tests/test_parser_completeness.py -v`
Expected: All four tests PASS.

- [ ] **Step 5: Run the parser e2e test to verify no regression**

Run: `uv run pytest tests/test_parser_e2e.py -v`
Expected: All tests PASS. If `test_parser_e2e.py` asserts on meta keys, it may need updating to allow the new keys — only update if the failure is "unexpected key" (additive); not if it's about wrong values.

- [ ] **Step 6: Commit**

```bash
git add hoga/parser/__init__.py tests/test_parser_completeness.py
git commit -m "$(cat <<'EOF'
feat(parser): write collection_complete + is_partial into meta.json

collection_complete is read from _progress.json["finished"] (False if missing).
is_partial is computed via disk_state.has_meaningful_gaps against the in-memory
snapshots_list — explicit data-in/data-out, no hidden ordering invariant on
parquet writes.

Together these two bits drive the four-state classification in
disk_state.check_disk_state.
EOF
)"
```

---

## Task 7: Surface both bits through `StockDate` wire model

**Files:**
- Modify: `hoga/api/models.py:17-38` (`StockDate` class)
- Modify: `hoga/api/queries.py:44-126` (`list_stock_dates`)
- Create: `tests/test_api_stock_dates_completeness.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_api_stock_dates_completeness.py`:

```python
"""GET /api/stock-dates surfaces collection_complete and is_partial per row."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api.queries import QueryEngine


def _write_full_stock_date(tmp_path: Path, code: str, date: str, **completeness: object) -> None:
    """Create a parquet dir with the minimum files queries.list_stock_dates expects."""
    parquet_dir = tmp_path / "parquet" / date / code
    parquet_dir.mkdir(parents=True)

    # Minimum: meta.json, snapshots.parquet (empty OK), candles.parquet (empty OK)
    import pyarrow as pa
    import pyarrow.parquet as pq
    pq.write_table(pa.table({"ts_ms": pa.array([], type=pa.int64())}), parquet_dir / "snapshots.parquet")
    pq.write_table(
        pa.table({"low": pa.array([], type=pa.int64()), "high": pa.array([], type=pa.int64()),
                  "vol_a": pa.array([], type=pa.int64()), "vol_b": pa.array([], type=pa.int64())}),
        parquet_dir / "candles.parquet",
    )

    meta = {
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
        **completeness,
    }
    (parquet_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def test_stock_date_exposes_collection_complete_and_is_partial(tmp_path: Path) -> None:
    _write_full_stock_date(tmp_path, "005930", "20260520", collection_complete=True, is_partial=False)
    eng = QueryEngine(tmp_path)
    try:
        rows = eng.list_stock_dates()
    finally:
        eng.close()
    assert len(rows) == 1
    assert rows[0].collection_complete is True
    assert rows[0].is_partial is False


def test_stock_date_legacy_meta_defaults_to_safe_values(tmp_path: Path) -> None:
    """Legacy meta without the two fields → conservative defaults."""
    _write_full_stock_date(tmp_path, "005930", "20260520")  # neither field
    eng = QueryEngine(tmp_path)
    try:
        rows = eng.list_stock_dates()
    finally:
        eng.close()
    assert rows[0].collection_complete is False
    assert rows[0].is_partial is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_stock_dates_completeness.py -v`
Expected: FAIL with `AttributeError: 'StockDate' object has no attribute 'collection_complete'`.

- [ ] **Step 3: Add the two fields to `StockDate`**

In `hoga/api/models.py:17-38`, append the two fields to the `StockDate` class (after `today_close`):

```python
class StockDate(BaseModel):
    """Inventory entry: one captured Stock-Date with its boundaries.

    All time fields are Unix epoch ms (UTC) per ADR 0003 — the on-disk
    HHMMSSmmm encoding is converted at the API boundary.
    """

    date: str
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    data_window_first_ms: int
    data_window_last_ms: int
    price_min: int
    price_max: int
    captured_at: int
    total_volume: int
    pages_collected: int
    file_size_bytes: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    collection_complete: bool
    is_partial: bool
```

- [ ] **Step 4: Pass the two fields through `list_stock_dates`**

In `hoga/api/queries.py:105-125`, add the two reads inside the loop (between `meta = json.loads(...)` at line 56 and the `out.append(StockDate(...))` call at line 105). Change the `StockDate(...)` invocation to include:

```python
                out.append(
                    StockDate(
                        date=date,
                        code=code_dir.name,
                        name=meta["name"],
                        regular_session_open_ms=open_ms,
                        regular_session_close_ms=close_ms,
                        data_window_first_ms=first_ms,
                        data_window_last_ms=last_ms,
                        price_min=price_min,
                        price_max=price_max,
                        captured_at=captured_at,
                        total_volume=total_volume,
                        pages_collected=int(meta["pages_collected"]),
                        file_size_bytes=file_size_bytes,
                        today_open=int(meta["today_open"]),
                        today_high=int(meta["today_high"]),
                        today_low=int(meta["today_low"]),
                        today_close=int(meta["today_close"]),
                        collection_complete=bool(meta.get("collection_complete", False)),
                        is_partial=bool(meta.get("is_partial", True)),
                    )
                )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_stock_dates_completeness.py -v`
Expected: Both tests PASS.

- [ ] **Step 6: Run the existing stock-dates test to verify no regression**

Run: `uv run pytest tests/test_api_stock_dates.py -v`
Expected: All tests PASS. If a test asserts the full shape of a `StockDate` response, it may need the two new fields added — only update if the failure is a missing-field error on a pydantic model construction.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/models.py hoga/api/queries.py tests/test_api_stock_dates_completeness.py
git commit -m "$(cat <<'EOF'
feat(api): expose collection_complete + is_partial on StockDate

list_stock_dates reads the two new meta keys with conservative defaults
(False, True) for legacy meta.json files lacking them. The two bits flow
through unchanged to Inventory consumers and become the source of truth
for the calendar markers in Plan B.
EOF
)"
```

---

## Task 8: End-to-end smoke — collect → parse → query reflects new bits

**Files:**
- Create: `tests/test_e2e_completeness.py`

The earlier tasks each tested one layer in isolation. This task verifies the bits flow correctly through the full collect → parse → query pipeline, using the existing `FakeHogaplayClient` pattern.

- [ ] **Step 1: Write the e2e test**

Create `tests/test_e2e_completeness.py`:

```python
"""End-to-end: collect → parse → list_stock_dates round-trip preserves both bits."""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api.queries import QueryEngine
from hoga.collector.orchestrator import collect_stock_date
from hoga.parser import parse_stock_date


class _NaturalTermFakeClient:
    """Same shape as test_collector_progress_finished._FakeClientNaturalTerm.
    Reproduced here to keep this e2e file self-contained."""
    def __init__(self) -> None:
        self.first_calls = 0

    def fetch_info(self, code: str, date: str) -> str:
        # info.tsv shape required by parser: code, name, then 17+ fields.
        # Minimum that parses successfully — pad with zeros.
        del code, date
        return (
            "005930\t삼성전자\t" + "\t".join(["0"] * 20) + "\n"
        )

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        del code, date, time_ms
        self.first_calls += 1
        if self.first_calls > 3:
            return ""
        seq_base = self.first_calls * 1000
        # Dense timestamps so has_meaningful_gaps returns False.
        t_base = 90000000 + (self.first_calls - 1) * 1000  # 1s apart
        # Section=2, type=2 (trade), seq, ts, ms, qty → minimum trade row shape.
        return "\n".join(
            f"2\t2\t0\t{seq_base + i}\t{t_base + i * 100}\t000\t1000"
            for i in range(5)
        ) + "\n"

    def fetch_chart(self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000) -> str:
        del code, date, time_ms, bong, gap
        return ""


def test_collect_then_parse_then_query_marks_complete(tmp_path: Path) -> None:
    collect_stock_date(
        client=_NaturalTermFakeClient(),
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        allow_partial=True,
    )
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    eng = QueryEngine(tmp_path)
    try:
        rows = eng.list_stock_dates()
    finally:
        eng.close()
    assert len(rows) == 1
    assert rows[0].collection_complete is True
    # is_partial value depends on whether the fake's tiny event stream creates
    # gaps within the continuous-trading window. The fake places 15 events all
    # within the first ~3 seconds of session, then nothing for the rest — so
    # gaps exist. Assert is_partial is True (and that's correct: this fake
    # didn't capture a full Data Window).
    assert rows[0].is_partial is True
```

- [ ] **Step 2: Run the e2e test**

Run: `uv run pytest tests/test_e2e_completeness.py -v`
Expected: PASS. If `parse_stock_date` rejects the fake's info row format (TSV column count), simplify the fake's `fetch_info` to match what `parse_info_row` actually expects — read `hoga/parser/__init__.py:parse_info_row` and align. Do not change the parser to accept looser input.

- [ ] **Step 3: Commit**

```bash
git add tests/test_e2e_completeness.py
git commit -m "test(e2e): round-trip completeness bits through collect → parse → query"
```

---

## Task 9: Full test sweep + final commit

- [ ] **Step 1: Run the full test suite**

Run: `uv run pytest -q`
Expected: All tests PASS. If anything broke that wasn't caught by per-task runs, fix the regression — most likely candidates are tests in `test_api_stock_dates.py` or `test_parser_e2e.py` that assert the exact shape of meta/StockDate. Add the new keys to expected payloads; do not remove the keys to "fix" the test.

- [ ] **Step 2: Type-check**

Run: `uv run pyright hoga/api/disk_state.py hoga/collector/orchestrator.py hoga/parser/__init__.py hoga/api/queries.py hoga/api/models.py`
Expected: 0 errors. If pyright complains about pyarrow/duckdb stubs, those are pre-existing and orthogonal.

- [ ] **Step 3: Lint**

Run: `uv run ruff check hoga/api/disk_state.py hoga/collector/orchestrator.py hoga/parser/__init__.py hoga/api/queries.py hoga/api/models.py tests/test_collector_progress_finished.py tests/test_api_disk_state.py tests/test_parser_completeness.py tests/test_api_stock_dates_completeness.py tests/test_e2e_completeness.py`
Expected: All checks pass.

- [ ] **Step 4: Verify the spec's authoritative sections are satisfied**

Manually verify against `docs/superpowers/specs/2026-05-21-capture-range-redesign-design.md`:
- §3.5 "Completeness — two bits on meta.json" ✓ Task 6
- §3.6 "`has_meaningful_gaps` (initial heuristic)" ✓ Task 5
- §11.Q17 "disk_state.py extracted as horizontal seam" ✓ Tasks 2-5 + ADR-0007 ✓ Task 0
- §3.9 "Data migration — conservative defaults" ✓ Tasks 4, 7

- [ ] **Step 5: Final cleanup commit (if any uncommitted changes from fixes during Step 1)**

```bash
git status   # verify clean
# if not clean:
git add -A && git commit -m "chore: post-plan fix-ups from full-suite verification"
```

---

## Done criteria

- All tasks' commits are on the worktree branch.
- `uv run pytest -q` is green.
- `meta.json` written by `parse_stock_date` carries both `collection_complete` and `is_partial`.
- `disk_state.check_disk_state(data_dir, code, date)` returns the correct `DiskState` for all four branches.
- ADR-0007 exists and references ADR-0006 explicitly.
- `GET /api/stock-dates` response items include both bits.

## What's NOT in this plan (intentional)

- **Plan B** (queue + workers + symbols + calendar + new SSE event topics + `today_too_early` backend guard + `_inflight_paths` dedupe + cookie-pause pool + Cancel-All-in-paused semantics).
- **Plan C** (frontend — SymbolSearch, DateRangePicker, CaptureQueue, hooks, LeftNav pill rewrite, paused banner, force-retry chip, calendar `as_of_ms` reconciliation).
- Removing `allow_partial` from the collector / API surface — Plan B work (paired with the 18:00 backend guard).
- Migrating any existing on-disk meta.json files — none in current state; `disk_state.check_disk_state` handles legacy defensively.

---

## What already exists (reuse audit)

- **`hoga/api/queries.py::QueryEngine.list_stock_dates`** — already iterates `data/parquet/{date}/{code}/`, reads `meta.json`, builds `StockDate`. Plan A extends this in place rather than building a parallel scanner. ✓
- **`hoga/collector/orchestrator.py::_write_progress`** — already manages `_progress.json` lifecycle (mid-loop + terminal writes). Plan A adds one field; does NOT add a parallel state file. ✓
- **`hoga/parser/__init__.py::_build_meta`** — already produces `meta.json`. Plan A appends two keys; does NOT branch a second writer. ✓
- **`tests/fixtures/tiny_tsv/`** — already used by `test_parser_e2e.py`. Plan A's `test_parser_completeness.py` reuses it via `_stage_raw`. ✓
- **`pyarrow.parquet`** — already a transitive dep via `hoga/tables/*`. No new runtime dep introduced. ✓

No parallel implementations were considered necessary. The plan's bottom-up extension pattern reuses every existing boundary.

---

## Implementation Tasks (synthesized from this review)

Both findings produced inline plan patches (already applied above). No additional tasks remain post-review.

- [x] **T1 (P1, human: ~5min / CC: ~2min)** — Plan A Task 5 + Task 6 — _build_meta + has_meaningful_gaps signature refactor
  - Surfaced by: Section 1 / D1 — _build_meta's implicit ordering invariant on `snapshots.write_parquet`
  - Files: `docs/superpowers/plans/2026-05-21-capture-completeness-foundation.md`
  - Verify: plan patches replace parquet-path-based signature with `Iterable[int]` + `snapshots_list` parameter
  - Status: applied inline before this report

- [x] **T2 (P1, human: ~3min / CC: ~1min)** — Plan A Task 5 — test_gap_outside_continuous_session_ignored fixture fix
  - Surfaced by: Section 3 / D2 — fixture only has 1 in-session datapoint, falls into "too sparse" branch
  - Files: `docs/superpowers/plans/2026-05-21-capture-completeness-foundation.md`
  - Verify: fixture now uses `[84000000, 90000000, 90001000, 90002000]` (3 in-session datapoints)
  - Status: applied inline before this report

No P2/P3 tasks. Plan B and Plan C absorb every remaining spec requirement.

---

## Failure modes (per new codepath)

| Codepath | Realistic failure | Test? | Error handling? | User signal? |
|---|---|---|---|---|
| `_write_progress(finished=True)` | disk full at terminal write | no (existing path) | inherits orchestrator's `OSError` propagation | yes (capture fails loudly) |
| `check_disk_state` (meta read) | malformed `meta.json` JSON | no — silent default to client_incomplete | conservative default | NO — silent. Calendar would show ✗ on a date that's actually fine. |
| `has_meaningful_gaps` | empty input | yes (`test_empty_list_returns_true`) | conservative True | yes (would mark as partial) |
| `list_stock_dates` (legacy meta) | missing both bits | yes (`test_stock_date_legacy_meta_defaults_to_safe_values`) | safe defaults | UI shows as `client_incomplete` per spec |

**Critical gaps flagged:** 1 — malformed `meta.json` in `check_disk_state` silently degrades to `client_incomplete` without logging. **Follow-up TODO** (not blocking): add a warning log when `json.loads` raises so a corrupted meta surface in a structured way rather than as a phantom incomplete marker.

---

## Worktree parallelization strategy

**Sequential implementation, limited parallelization opportunity.**

| Task | Modules touched | Depends on |
|---|---|---|
| Task 0 (ADR-0007) | `docs/adr/` | — |
| Task 1 (collector finished marker) | `hoga/collector/` | — |
| Tasks 2-5 (disk_state.py) | `hoga/api/` (new module) | — |
| Task 6 (parser writes meta bits) | `hoga/parser/` | Tasks 1, 5 |
| Task 7 (StockDate wire + queries) | `hoga/api/`, `hoga/api/models.py` | Task 6 |
| Task 8 (E2E smoke) | `tests/` | Tasks 1, 6, 7 |
| Task 9 (full sweep) | — | all above |

Lane A: Tasks 0 → 1 → 6 → 7 → 8 → 9 (parser/wire chain, fully sequential)
Lane B: Tasks 2 → 3 → 4 → 5 (disk_state module, independent until Task 6 needs it)

**Parallel opportunity:** Lane A (Task 1) and Lane B (Tasks 2-5) can run side-by-side until Task 6 joins them. Saves ~10 min on a ~40 min plan. For Plan A's small size, sequential execution in one worktree is simpler and the parallelization gain doesn't justify the merge overhead.

---

## Completion Summary

- Step 0: Scope Challenge — **scope accepted as-is** (11 files justified by spec decomposition + 4 are tests + 1 is ADR)
- Architecture Review: **1 issue found** (D1 — implicit ordering invariant → fixed via signature refactor)
- Code Quality Review: **0 issues found**
- Test Review: diagram produced, **1 gap identified** (D2 — fixture contradiction → fixed)
- Performance Review: **0 issues found** (D1 fix even improves perf — eliminates 1 parquet read)
- NOT in scope: written (existing in plan)
- What already exists: written
- TODOS.md updates: 0 new (one critical-gap follow-up noted for malformed meta.json logging — bundled into Plan B as part of disk_state hardening)
- Failure modes: 1 critical gap flagged (silent meta.json corruption → client_incomplete)
- Outside voice: skipped (Plan A scope is foundational + small; outside voice deferred until Plan B which has bigger architectural surface)
- Parallelization: 2 lanes (collector + disk_state in parallel), sequential merge at parser
- Lake Score: 2/2 recommendations chose complete option (D1B explicit-data-flow, D2A test fixture fix vs deletion)

**Unresolved decisions:** none — both D1 and D2 received explicit user responses.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (Plan A is implementation foundation, scope set by spec brainstorming) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run (deferred to Plan B per skill recommendation for smaller plans) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 findings (D1 ordering invariant, D2 test fixture bug) — both fixed inline |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | N/A | Plan A is backend-only; design review applies to Plan C |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | N/A | Plan A doesn't ship developer-facing surface |

**UNRESOLVED:** 0
**VERDICT:** **ENG CLEARED** — ready to implement Plan A via `/superpowers:subagent-driven-development`. Plan B/C reviews will be run when those plans are authored (after Plan A merges).
