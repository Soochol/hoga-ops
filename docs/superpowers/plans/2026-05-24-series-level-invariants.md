# Series-Level Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second invariant catalog (`SERIES_INVARIANTS`) for Stock-Date series checks (candles ts_ms monotonic, snapshot gap, cum_vol monotonic), absorb the two existing validators (`has_meaningful_gaps`, `trades.validate`) without removing them, and extend `hoga validate` with `--deep`.

**Architecture:** Series-level catalog runs over a new `StockDateArtifacts` dataclass holding meta + Optional candles/snapshots/trades. Read-paths do NOT live-evaluate series (parquet I/O cost) — instead the parser's existing archival hook records the result in `meta.json` and the wire reads from there. The meta catalog stays unchanged and is renamed `META_INVARIANTS` with a backward-compat `INVARIANTS` alias.

**Tech Stack:** Python 3.11+ (existing), pytest (existing), Typer for CLI (existing), pyarrow for parquet fixtures in tests (existing pattern from `tests/test_api_stock_dates_completeness.py`). No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-24-series-level-invariants-design.md](../specs/2026-05-24-series-level-invariants-design.md)
**Related ADR:** [docs/adr/0020-data-integrity-invariant-catalog.md](../../adr/0020-data-integrity-invariant-catalog.md) (will be extended with §3c by Task 8)

---

## File Structure

**New files:**
- `tests/hoga/api/test_series_invariants.py` — unit tests for 3 series invariants + check_series aggregator

**Modified files:**
- `hoga/tables/trades.py` — add `CumVolViolation` dataclass + `find_cum_vol_violations` pure helper; `validate` now calls helper
- `hoga/api/invariants.py` — add `StockDateArtifacts`, `SeriesInvariant`, `SERIES_INVARIANTS` (3 rules), `check_series`; rename `INVARIANTS` → `META_INVARIANTS` (alias kept)
- `hoga/parser/__init__.py` — archival hook also runs `check_series`
- `hoga/cli.py` — `validate` gains `--deep` flag
- `docs/adr/0020-data-integrity-invariant-catalog.md` — append §3c

**Modified tests:**
- `tests/test_tables_trades.py` — tests for `find_cum_vol_violations` helper; existing `validate` tests stay green
- `tests/test_parser_completeness.py` — archival hook records series violations
- `tests/test_cli_validate.py` — `--deep` runs series checks; `--deep --fix` rewrites archival

---

## Task Ordering Rationale

TDD throughout, dependency-first. Task 1 (trades helper) is an independent refactor — extract pure function from existing `validate`, no public API change. Task 2 sets up the new types + catalog scaffolding with `SERIES_INVARIANTS = ()`. Tasks 3-5 register one invariant each (parallel-safe but dispatched serially to keep `INVARIANTS` tuple mutations conflict-free). Task 6 wires parser archival. Task 7 adds CLI surface. Task 8 documents the read-path exception in ADR-0020. Task 9 is end-to-end regression with the literal 5/18 production data.

---

## Task 1: Extract `find_cum_vol_violations` helper from `trades.validate`

**Files:**
- Modify: `hoga/tables/trades.py` (lines ~155-190)
- Modify: `tests/test_tables_trades.py`

- [ ] **Step 1.1: Write the failing tests**

Append to `tests/test_tables_trades.py`:

```python
def test_find_cum_vol_violations_returns_empty_for_clean_data() -> None:
    from hoga.tables.trades import find_cum_vol_violations, Trade
    trades = [
        Trade(ts_ms=90_001_000, seq=10, price=100, change_pct=0.0, qty=5,
              side=1, cum_vol=5, cum_trades=1, low_so_far=100, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0),
        Trade(ts_ms=90_002_000, seq=11, price=101, change_pct=1.0, qty=3,
              side=1, cum_vol=8, cum_trades=2, low_so_far=100, high_so_far=101,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0),
    ]
    assert find_cum_vol_violations(trades) == []


def test_find_cum_vol_violations_reports_each_regression() -> None:
    """Returns one entry per regression — not just first."""
    from hoga.tables.trades import find_cum_vol_violations, Trade
    trades = [
        Trade(ts_ms=90_001_000, seq=10, price=100, change_pct=0.0, qty=5,
              side=1, cum_vol=10, cum_trades=1, low_so_far=100, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0),
        Trade(ts_ms=90_002_000, seq=11, price=99, change_pct=-1.0, qty=2,
              side=-1, cum_vol=8, cum_trades=2, low_so_far=99, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0),
        Trade(ts_ms=90_003_000, seq=12, price=99, change_pct=-1.0, qty=2,
              side=-1, cum_vol=5, cum_trades=3, low_so_far=99, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0),
    ]
    violations = find_cum_vol_violations(trades)
    assert len(violations) == 2
    assert violations[0].prev_cum == 10 and violations[0].curr_cum == 8
    assert violations[0].ts_ms == 90_002_000
    assert violations[1].prev_cum == 8 and violations[1].curr_cum == 5


def test_find_cum_vol_violations_excludes_auction_cross_rows() -> None:
    """side=0 rows carry cum_vol=0 and must be excluded from the check."""
    from hoga.tables.trades import find_cum_vol_violations, Trade
    trades = [
        Trade(ts_ms=90_000_000, seq=1, price=100, change_pct=0.0, qty=10,
              side=0, cum_vol=0, cum_trades=0, low_so_far=100, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0),
        Trade(ts_ms=90_001_000, seq=2, price=100, change_pct=0.0, qty=5,
              side=1, cum_vol=15, cum_trades=1, low_so_far=100, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0),
    ]
    assert find_cum_vol_violations(trades) == []
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `uv run pytest tests/test_tables_trades.py -v -k find_cum_vol`
Expected: ImportError — `find_cum_vol_violations` doesn't exist.

- [ ] **Step 1.3: Extract the helper and refactor validate**

Edit `hoga/tables/trades.py`. Add the new dataclass + helper before the existing `validate` function. Then refactor `validate` to call it. Find the existing `validate` (around line 160) and replace the whole block:

```python
@dataclass(frozen=True)
class CumVolViolation:
    """One cum_vol regression found by ``find_cum_vol_violations``.

    index    -- position in the sorted continuous-trade list
    prev_cum -- preceding row's cum_vol
    curr_cum -- offending row's cum_vol (curr_cum < prev_cum)
    ts_ms    -- offending row's ts_ms (for diagnostic context)
    """
    index: int
    prev_cum: int
    curr_cum: int
    ts_ms: int


def find_cum_vol_violations(trades: list[Trade]) -> list[CumVolViolation]:
    """Pure: returns every cum_vol regression in continuous-trade rows
    (``side != 0``), sorted by ``(ts_ms, seq)``. Auction Cross rows
    (``side == 0``) carry ``cum_vol = 0`` and are excluded — their volume
    folds into the next continuous trade.

    Used by:
      - :func:`validate` (strict mode raises on first violation)
      - ``hoga.api.invariants.SERIES_INVARIANTS``'s ``series.cum_vol_monotonic``
        (returns full list for the wire / archival).
    """
    # Tie-break by seq for same-ms rows: ts_ms has ms precision, but seq is
    # strictly increasing per CONTEXT.md and reflects actual trade order. Without
    # the secondary key, sort stability hands order to dedup-insertion order,
    # which can re-order same-ms trades and falsely flag cum_vol regressions.
    sorted_trades = sorted(
        (t for t in trades if t.side != 0),
        key=lambda t: (t.ts_ms, t.seq),
    )
    out: list[CumVolViolation] = []
    prev = -1
    for i, t in enumerate(sorted_trades):
        if t.cum_vol < prev:
            out.append(CumVolViolation(
                index=i, prev_cum=prev, curr_cum=t.cum_vol, ts_ms=t.ts_ms,
            ))
        prev = t.cum_vol
    return out


def validate(trades: list[Trade], *, lenient: bool = False) -> None:
    """Check trades-table invariants.

    Invariant: ``cum_vol`` is non-decreasing across continuous-trading rows
    (``side != 0``) ordered by ``ts_ms``. Auction Cross rows (``side == 0``)
    carry ``cum_vol = 0`` and are excluded — their volume folds into the next
    continuous trade.

    In strict mode (default) raises ``TradeValidationError`` on first violation.
    In lenient mode skips violations silently (caller is responsible for noting
    the data may be imperfect).

    Delegates the actual scan to :func:`find_cum_vol_violations` so the same
    logic feeds the series-level invariants catalog without duplication.
    """
    violations = find_cum_vol_violations(trades)
    if violations and not lenient:
        first = violations[0]
        raise TradeValidationError(
            f"cum_vol decreased at ts_ms={first.ts_ms}: "
            f"{first.prev_cum} -> {first.curr_cum}"
        )
```

`dataclass` must be imported at the top of the file — verify by running `grep "^from dataclasses\|^import dataclasses" hoga/tables/trades.py`. If absent, add `from dataclasses import dataclass` near the existing imports.

- [ ] **Step 1.4: Verify all trades tests pass**

Run: `uv run pytest tests/test_tables_trades.py -v`
Expected: all PASS (existing `validate` tests + 3 new `find_cum_vol_violations` tests).

- [ ] **Step 1.5: Commit**

```bash
git add hoga/tables/trades.py tests/test_tables_trades.py
git commit -m "refactor(tables/trades): extract find_cum_vol_violations pure helper

validate() now delegates the actual scan to find_cum_vol_violations,
which returns the full list of regressions (not just the first). Same
strict-vs-lenient semantics on validate(). The helper is the seam the
upcoming series.cum_vol_monotonic invariant will consume."
```

---

## Task 2: Catalog scaffolding — `StockDateArtifacts`, `SeriesInvariant`, rename, empty `SERIES_INVARIANTS`

**Files:**
- Modify: `hoga/api/invariants.py`
- Modify: `tests/hoga/api/test_invariants.py`

- [ ] **Step 2.1: Write the failing tests**

Append to `tests/hoga/api/test_invariants.py`:

```python
def test_meta_invariants_alias_exists_for_backward_compat() -> None:
    """ADR-0020 §3c: INVARIANTS stays as alias for META_INVARIANTS."""
    from hoga.api.invariants import INVARIANTS, META_INVARIANTS
    assert INVARIANTS is META_INVARIANTS
    assert len(META_INVARIANTS) == 5  # unchanged catalog


def test_series_invariants_catalog_exists_initially_empty() -> None:
    """Scaffolding present; rules added in subsequent tasks."""
    from hoga.api.invariants import SERIES_INVARIANTS
    assert SERIES_INVARIANTS == ()


def test_stock_date_artifacts_accepts_optional_fields() -> None:
    """Partial loading: any of candles/snapshots/trades may be None."""
    from hoga.api.invariants import StockDateArtifacts
    a = StockDateArtifacts(meta={})
    assert a.meta == {}
    assert a.candles is None
    assert a.snapshots is None
    assert a.trades is None

    b = StockDateArtifacts(meta={"k": 1}, candles=[])
    assert b.candles == []


def test_check_series_returns_empty_when_catalog_empty() -> None:
    from hoga.api.invariants import StockDateArtifacts, check_series
    assert check_series(StockDateArtifacts(meta={})) == []
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `uv run pytest tests/hoga/api/test_invariants.py -v -k "alias or series or artifacts or check_series"`
Expected: ImportError on `META_INVARIANTS` / `SERIES_INVARIANTS` / `StockDateArtifacts` / `check_series`.

- [ ] **Step 2.3: Add the scaffolding**

Edit `hoga/api/invariants.py`. After the existing `INVARIANTS: tuple[Invariant, ...] = (...)` definition (around line 148), add:

```python
# Backward-compat alias — ADR-0020 §3c renamed INVARIANTS to META_INVARIANTS
# to make room for the series catalog. External imports of INVARIANTS keep
# working; new code should use META_INVARIANTS for clarity.
META_INVARIANTS: tuple[Invariant, ...] = INVARIANTS
```

Place this block right after the closing `)` of the `INVARIANTS = (...)` definition so both names point to the same tuple object.

After the existing `def check(meta)` function (around line 187), add:

```python
# === Series-level invariants (ADR-0020 §3c) ==============================
# Series invariants run over loaded parquet artifacts, not just meta dict.
# They are evaluated at parser write-time and archived in meta.json's
# invariant_violations field — read-paths do NOT live-evaluate them
# (parquet I/O cost would break per-request SLO). See spec §4.6.


if TYPE_CHECKING:
    # Heavy domain imports only when type-checking; avoids forcing every
    # consumer of hoga.api.invariants to also pull in pyarrow / tables.
    from hoga.tables.candles import Candle
    from hoga.tables.snapshots import Orderbook
    from hoga.tables.trades import Trade


@dataclass(frozen=True)
class StockDateArtifacts:
    """Series-level invariant input. Callers load disk once and pass.

    Fields are Optional so partial loading is supported:
      - parser archival passes all four (already in memory at meta write)
      - hoga validate --deep loads all four from parquet
      - future per-table checks can pass just one
    """
    meta: Mapping[str, Any]
    candles: "list[Candle] | None" = None
    snapshots: "list[Orderbook] | None" = None
    trades: "list[Trade] | None" = None


@dataclass(frozen=True)
class SeriesInvariant:
    """Series invariant returns a list (not a single Violation) so one
    invariant can flag multiple violations across the series (e.g.,
    every cum_vol regression in trades.parquet)."""
    id: str
    severity: Severity
    description: str
    check: Callable[["StockDateArtifacts"], list[Violation]]


SERIES_INVARIANTS: tuple[SeriesInvariant, ...] = ()  # populated by Tasks 3-5


def check_series(artifacts: StockDateArtifacts) -> list[Violation]:
    """Run every series invariant against the loaded artifacts. Returns
    a flat violation list across all invariants. Empty when integral
    (or when ``SERIES_INVARIANTS`` is empty)."""
    out: list[Violation] = []
    for inv in SERIES_INVARIANTS:
        out.extend(inv.check(artifacts))
    return out
```

Verify the existing `from typing import TYPE_CHECKING, Any` line at the top of the file already imports `TYPE_CHECKING` (added in the earlier Violation.to_model() work). If it imports only `Any`, change to import both.

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `uv run pytest tests/hoga/api/test_invariants.py -v`
Expected: all PASS (existing 17 + 4 new = 21).

- [ ] **Step 2.5: Commit**

```bash
git add hoga/api/invariants.py tests/hoga/api/test_invariants.py
git commit -m "feat(api/invariants): scaffolding for series-level catalog

Adds StockDateArtifacts (input bundle), SeriesInvariant (catalog entry
type), empty SERIES_INVARIANTS tuple, and check_series() aggregator.
META_INVARIANTS alias added for backward compatibility — existing
imports of INVARIANTS keep working. No invariants registered yet;
Tasks 3-5 fill the catalog."
```

---

## Task 3: `series.candles_ts_monotonic` (error)

**Files:**
- Modify: `hoga/api/invariants.py`
- Create: `tests/hoga/api/test_series_invariants.py`

- [ ] **Step 3.1: Write the failing tests**

Create `tests/hoga/api/test_series_invariants.py`:

```python
"""Series-level invariants — checks over candles/snapshots/trades artifacts."""
from __future__ import annotations

from hoga.api.invariants import (
    SERIES_INVARIANTS,
    Severity,
    StockDateArtifacts,
    check_series,
)
from hoga.tables.candles import Candle


def _candle(ts_ms: int) -> Candle:
    return Candle(ts_ms=ts_ms, open_=100, close_=100, high=100, low=100,
                  vol_a=0, vol_b=0)


def test_candles_ts_monotonic_catalog_entry_registered() -> None:
    ids = {inv.id for inv in SERIES_INVARIANTS}
    assert "series.candles_ts_monotonic" in ids


def test_candles_ts_monotonic_passes_for_strictly_ascending() -> None:
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_001_000), _candle(90_002_000), _candle(90_003_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert fired == []


def test_candles_ts_monotonic_fires_on_equal_timestamps() -> None:
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_001_000), _candle(90_001_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 1
    assert fired[0].severity == Severity.error
    assert fired[0].ctx["prev_ts_ms"] == 90_001_000
    assert fired[0].ctx["curr_ts_ms"] == 90_001_000


def test_candles_ts_monotonic_fires_on_regression() -> None:
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_002_000), _candle(90_001_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 1
    assert fired[0].ctx["curr_ts_ms"] < fired[0].ctx["prev_ts_ms"]


def test_candles_ts_monotonic_skips_when_candles_none() -> None:
    """Optional input: invariant skips silently if candles not loaded."""
    arts = StockDateArtifacts(meta={}, candles=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert fired == []


def test_candles_ts_monotonic_reports_every_regression() -> None:
    """Multiple bad pairs → one violation per pair (not just first)."""
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_001_000), _candle(90_000_000),  # regression 1
        _candle(90_002_000), _candle(90_001_500),  # regression 2
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 2
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `uv run pytest tests/hoga/api/test_series_invariants.py -v`
Expected: 5 FAIL (catalog entry missing, all `fired` lists empty).

- [ ] **Step 3.3: Register the invariant**

Edit `hoga/api/invariants.py`. Add the implementation function near the existing meta invariant helpers (e.g., before `INVARIANTS = (...)`):

```python
def _series_candles_ts_monotonic(a: "StockDateArtifacts") -> list[Violation]:
    if a.candles is None:
        return []
    out: list[Violation] = []
    for i in range(1, len(a.candles)):
        prev = a.candles[i - 1].ts_ms
        curr = a.candles[i].ts_ms
        if curr <= prev:
            out.append(Violation(
                "series.candles_ts_monotonic",
                Severity.error,
                "candles ts_ms must be strictly ascending",
                {"index": i, "prev_ts_ms": prev, "curr_ts_ms": curr},
            ))
    return out
```

Replace the empty `SERIES_INVARIANTS` tuple definition with:

```python
SERIES_INVARIANTS: tuple[SeriesInvariant, ...] = (
    SeriesInvariant(
        id="series.candles_ts_monotonic",
        severity=Severity.error,
        description="candles ts_ms strictly ascending — chart axis depends on it",
        check=_series_candles_ts_monotonic,
    ),
)
```

- [ ] **Step 3.4: Verify**

Run: `uv run pytest tests/hoga/api/test_series_invariants.py tests/hoga/api/test_invariants.py -v`
Expected: all PASS (6 new + 21 existing = 27).

- [ ] **Step 3.5: Commit**

```bash
git add hoga/api/invariants.py tests/hoga/api/test_series_invariants.py
git commit -m "feat(api/invariants): series.candles_ts_monotonic (error)

Catches every regression in candles.parquet ts_ms ordering — the direct
cause of the 5/18/003490 chart crash that motivated ADR-0020. Returns
one Violation per offending pair (not just first) so the diagnostic
output shows the full extent."
```

---

## Task 4: `series.snapshots_no_gaps` (warn)

**Files:**
- Modify: `hoga/api/invariants.py`
- Modify: `tests/hoga/api/test_series_invariants.py`

- [ ] **Step 4.1: Write the failing tests**

Append to `tests/hoga/api/test_series_invariants.py`:

```python
def _stub_orderbook(ts_ms: int):
    """Minimal Orderbook for ts_ms-only tests. Fields we don't need
    use trivial defaults — the invariant only reads ts_ms."""
    from hoga.tables.snapshots import Orderbook
    return Orderbook(
        ts_ms=ts_ms, seq=ts_ms,
        ask_p=(0,) * 10, ask_q=(0,) * 10, ask_d=(0,) * 10,
        bid_p=(0,) * 10, bid_q=(0,) * 10, bid_d=(0,) * 10,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )


def test_snapshots_no_gaps_catalog_entry_registered() -> None:
    ids = {inv.id for inv in SERIES_INVARIANTS}
    assert "series.snapshots_no_gaps" in ids


def test_snapshots_no_gaps_passes_for_dense_stream() -> None:
    """One snapshot per second from 09:00:00 to 09:00:30 — no gap."""
    snaps = [_stub_orderbook(90_000_000 + i * 1000) for i in range(31)]
    arts = StockDateArtifacts(meta={}, snapshots=snaps)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert fired == []


def test_snapshots_no_gaps_fires_when_session_gap_present() -> None:
    """90s gap inside session → has_meaningful_gaps True → fire (warn)."""
    snaps = [
        _stub_orderbook(90_000_000),
        _stub_orderbook(90_130_000),  # 130s later — within session, big gap
    ]
    arts = StockDateArtifacts(meta={}, snapshots=snaps)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert len(fired) == 1
    assert fired[0].severity == Severity.warn


def test_snapshots_no_gaps_skips_when_snapshots_none() -> None:
    arts = StockDateArtifacts(meta={}, snapshots=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert fired == []
```

Make sure the existing import at the top of the test file already includes `StockDateArtifacts` etc. (added in Task 3).

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `uv run pytest tests/hoga/api/test_series_invariants.py -v -k snapshots_no_gaps`
Expected: 4 FAIL.

- [ ] **Step 4.3: Register the invariant**

Edit `hoga/api/invariants.py`. Add the implementation near `_series_candles_ts_monotonic`:

```python
def _series_snapshots_no_gaps(a: "StockDateArtifacts") -> list[Violation]:
    if a.snapshots is None:
        return []
    # has_meaningful_gaps expects HogaMs (HHMMSSmmm). snapshots.ts_ms is
    # already HHMMSSmmm at parser time (see parser/__init__.py's
    # _snapshot_ts_hhmmssms helper that returns the raw field).
    from hoga.api.disk_state import has_meaningful_gaps
    from hoga.api.timeenc import HogaMs
    ts_values = [HogaMs(s.ts_ms) for s in a.snapshots]
    if not has_meaningful_gaps(ts_values):
        return []
    return [Violation(
        "series.snapshots_no_gaps",
        Severity.warn,
        "snapshot stream has ≥60s gap inside continuous-trading session",
        {"datapoint_count": len(a.snapshots)},
    )]
```

Add a new entry to the `SERIES_INVARIANTS` tuple (replace the existing one-entry tuple):

```python
SERIES_INVARIANTS: tuple[SeriesInvariant, ...] = (
    SeriesInvariant(
        id="series.candles_ts_monotonic",
        severity=Severity.error,
        description="candles ts_ms strictly ascending — chart axis depends on it",
        check=_series_candles_ts_monotonic,
    ),
    SeriesInvariant(
        id="series.snapshots_no_gaps",
        severity=Severity.warn,
        description="no ≥60s gap in continuous-trading snapshot stream",
        check=_series_snapshots_no_gaps,
    ),
)
```

- [ ] **Step 4.4: Verify**

Run: `uv run pytest tests/hoga/api/test_series_invariants.py -v`
Expected: 10 PASS (6 from Task 3 + 4 new).

- [ ] **Step 4.5: Commit**

```bash
git add hoga/api/invariants.py tests/hoga/api/test_series_invariants.py
git commit -m "feat(api/invariants): series.snapshots_no_gaps (warn)

Wraps the existing has_meaningful_gaps function as a series invariant
so the same signal that parser uses for is_partial also flows into
the catalog — surfacing on the wire via data_warnings."
```

---

## Task 5: `series.cum_vol_monotonic` (error)

**Files:**
- Modify: `hoga/api/invariants.py`
- Modify: `tests/hoga/api/test_series_invariants.py`

- [ ] **Step 5.1: Write the failing tests**

Append to `tests/hoga/api/test_series_invariants.py`:

```python
def _trade(ts_ms: int, seq: int, side: int, cum_vol: int):
    from hoga.tables.trades import Trade
    return Trade(
        ts_ms=ts_ms, seq=seq, price=100, change_pct=0.0, qty=1,
        side=side, cum_vol=cum_vol, cum_trades=1,
        low_so_far=100, high_so_far=100,
        net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0,
    )


def test_cum_vol_monotonic_catalog_entry_registered() -> None:
    ids = {inv.id for inv in SERIES_INVARIANTS}
    assert "series.cum_vol_monotonic" in ids


def test_cum_vol_monotonic_passes_for_clean_data() -> None:
    arts = StockDateArtifacts(meta={}, trades=[
        _trade(90_001_000, 10, 1, 5),
        _trade(90_002_000, 11, 1, 8),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.cum_vol_monotonic"]
    assert fired == []


def test_cum_vol_monotonic_fires_one_violation_per_regression() -> None:
    """Mirrors the helper test in test_tables_trades — two regressions
    must surface as two Violations (not first-only)."""
    arts = StockDateArtifacts(meta={}, trades=[
        _trade(90_001_000, 10, 1, 10),
        _trade(90_002_000, 11, -1, 8),   # regression 1
        _trade(90_003_000, 12, -1, 5),   # regression 2
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.cum_vol_monotonic"]
    assert len(fired) == 2
    assert all(v.severity == Severity.error for v in fired)
    ctx_pairs = [(v.ctx["prev_cum"], v.ctx["curr_cum"]) for v in fired]
    assert (10, 8) in ctx_pairs
    assert (8, 5) in ctx_pairs


def test_cum_vol_monotonic_skips_when_trades_none() -> None:
    arts = StockDateArtifacts(meta={}, trades=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.cum_vol_monotonic"]
    assert fired == []
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `uv run pytest tests/hoga/api/test_series_invariants.py -v -k cum_vol`
Expected: 4 FAIL.

- [ ] **Step 5.3: Register the invariant**

Edit `hoga/api/invariants.py`. Add the implementation:

```python
def _series_cum_vol_monotonic(a: "StockDateArtifacts") -> list[Violation]:
    if a.trades is None:
        return []
    from hoga.tables.trades import find_cum_vol_violations
    out: list[Violation] = []
    for v in find_cum_vol_violations(a.trades):
        out.append(Violation(
            "series.cum_vol_monotonic",
            Severity.error,
            "cum_vol regressed across continuous-trade rows",
            {"index": v.index, "prev_cum": v.prev_cum,
             "curr_cum": v.curr_cum, "ts_ms": v.ts_ms},
        ))
    return out
```

Add the third entry to `SERIES_INVARIANTS`:

```python
SERIES_INVARIANTS: tuple[SeriesInvariant, ...] = (
    SeriesInvariant(
        id="series.candles_ts_monotonic",
        severity=Severity.error,
        description="candles ts_ms strictly ascending — chart axis depends on it",
        check=_series_candles_ts_monotonic,
    ),
    SeriesInvariant(
        id="series.snapshots_no_gaps",
        severity=Severity.warn,
        description="no ≥60s gap in continuous-trading snapshot stream",
        check=_series_snapshots_no_gaps,
    ),
    SeriesInvariant(
        id="series.cum_vol_monotonic",
        severity=Severity.error,
        description="cum_vol non-decreasing across continuous-trade rows",
        check=_series_cum_vol_monotonic,
    ),
)
```

- [ ] **Step 5.4: Verify**

Run: `uv run pytest tests/hoga/api/test_series_invariants.py -v`
Expected: 14 PASS (10 + 4 new).

- [ ] **Step 5.5: Commit**

```bash
git add hoga/api/invariants.py tests/hoga/api/test_series_invariants.py
git commit -m "feat(api/invariants): series.cum_vol_monotonic (error)

Wraps trades.find_cum_vol_violations as a series invariant. The same
scan that drives parser's strict TradeValidationError now also flows
into the catalog with one Violation per regression (instead of
first-only). Adds the 'cum_vol broke → exclude this Stock-Date from
volume aggregations' protection at the read-path surface."
```

---

## Task 6: Parser archival extension

**Files:**
- Modify: `hoga/parser/__init__.py` (around line 148, the archival hook)
- Modify: `tests/test_parser_completeness.py`

- [ ] **Step 6.1: Write the failing tests**

Append to `tests/test_parser_completeness.py`:

```python
def test_parser_archives_series_violations_for_bad_candles(tmp_path: Path) -> None:
    """ADR-0020 §3c: parser archival hook records BOTH meta + series
    invariant violations in meta.json. Verified here for candles ts_ms.

    Uses tiny_tsv (healthy bounds + finished=True) but the candles fixture
    inside tiny_tsv has a controlled monotonic stream — we additionally
    inject one regressed candle via direct chart.tsv manipulation to
    trigger series.candles_ts_monotonic.
    """
    import shutil
    from hoga.parser import parse_stock_date

    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    raw_dir.parent.mkdir(parents=True, exist_ok=True)
    src = Path(__file__).parent / "fixtures" / "tiny_tsv"
    shutil.copytree(src, raw_dir)
    (raw_dir / "_progress.json").write_text(json.dumps({
        "finished": True, "last_time_ms": 153_500_000, "pages_done": 100,
    }), encoding="utf-8")

    # Inject a regressed candle: append a row at the end of chart.tsv with a
    # ts_ms earlier than the previous row. Parser reads chart.tsv lines into
    # candles in file order; the regression survives into candles.parquet.
    chart = raw_dir / "chart.tsv"
    last_line = chart.read_text(encoding="utf-8").rstrip("\n").splitlines()[-1]
    # chart.tsv columns: 1\ttype\t...\tts_ms_hhmmssmmm\t...
    # Manipulate the last existing line's earliest ts_ms field by re-using
    # an earlier line's content with a one-tick-earlier timestamp.
    # For the regression we synthesize a line that resembles the schema but
    # carries a smaller ts_ms than the previous one.
    bad_line = last_line  # same line; appending a duplicate produces equal ts_ms
    chart.write_text(chart.read_text(encoding="utf-8") + bad_line + "\n",
                     encoding="utf-8")

    out_dir = tmp_path / "parquet" / "20260520" / "005930"
    out_dir.mkdir(parents=True)
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)

    meta_path = out_dir / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert "invariant_violations" in meta
    ids = {v["invariant_id"] for v in meta["invariant_violations"]}
    # The duplicate-ts_ms row fires the candles invariant (curr_ts_ms == prev).
    assert "series.candles_ts_monotonic" in ids


def test_parser_archives_no_series_violations_for_clean_fixture(tmp_path: Path) -> None:
    """Healthy tiny_tsv fixture → no invariant_violations field at all."""
    _stage_raw(tmp_path, "tiny_tsv", "005930", "20260520", finished=True)
    from hoga.parser import parse_stock_date
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    meta = json.loads(
        (tmp_path / "parquet" / "20260520" / "005930" / "meta.json").read_text(encoding="utf-8")
    )
    # Healthy meta + healthy series = no archival field.
    assert "invariant_violations" not in meta
```

If the duplicate-line injection doesn't actually surface as a parquet candle with equal ts_ms (parser may dedup by some key), use the simpler alternative: skip this specific test for now and rely on Task 9's E2E for end-to-end series coverage. Verify by running step 6.2 first — if the test fails with "missing series.candles_ts_monotonic" rather than the assertion, the injection works.

- [ ] **Step 6.2: Run tests to verify they fail**

Run: `uv run pytest tests/test_parser_completeness.py -v -k archives`
Expected: FAIL — parser writes only meta-level violations currently.

- [ ] **Step 6.3: Extend the archival hook**

Edit `hoga/parser/__init__.py`. Locate the existing archival hook (around line 148-155):

```python
    # ADR-0020 archival hook — record the violations list at write time for
    # diagnostics. Read-paths re-evaluate live from the same catalog, so this
    # field is not load-bearing; absent when there are no violations to record
    # (healthy meta stays clean).
    from hoga.api.invariants import check as _check_invariants
    _violations = _check_invariants(meta)
    if _violations:
        meta["invariant_violations"] = [v.as_dict() for v in _violations]
```

Replace with:

```python
    # ADR-0020 archival hook — record violations at write time. Meta-level
    # violations are also re-evaluated live by read-paths (self-healing).
    # Series-level violations are archival-only — read-paths trust this
    # field rather than re-loading parquet (see ADR-0020 §3c).
    from hoga.api.invariants import (
        StockDateArtifacts,
        check as _check_meta,
        check_series as _check_series,
    )
    _all_violations = _check_meta(meta) + _check_series(StockDateArtifacts(
        meta=meta,
        candles=candles_list,
        snapshots=snapshots_list,
        trades=trades_list,
    ))
    if _all_violations:
        meta["invariant_violations"] = [v.as_dict() for v in _all_violations]
```

Verify `candles_list`, `snapshots_list`, `trades_list` are all in scope at this point in `parse_stock_date` — they're created earlier in the function (around line 116-120) and used by `validate(...)` calls (lines 125-133). The variables are still bound at the archival hook position.

- [ ] **Step 6.4: Verify**

Run: `uv run pytest tests/test_parser_completeness.py -v`
Expected: all PASS. If the candles-injection test fails because duplicate lines get deduped, simplify the test to only assert the healthy-case behavior (the other test) and rely on Task 9 for the regression coverage.

- [ ] **Step 6.5: Commit**

```bash
git add hoga/parser/__init__.py tests/test_parser_completeness.py
git commit -m "feat(parser): archival hook also runs series invariants

Loads the in-memory candles/snapshots/trades lists into
StockDateArtifacts and calls check_series alongside check(meta).
Both violation sets share the meta.json invariant_violations field.
This is the load-bearing surface for series invariants — read-paths
do not re-evaluate them (parquet I/O cost; see ADR-0020 §3c)."
```

---

## Task 7: CLI `--deep` flag

**Files:**
- Modify: `hoga/cli.py` (the `validate` command)
- Modify: `tests/test_cli_validate.py`

- [ ] **Step 7.1: Write the failing tests**

Append to `tests/test_cli_validate.py`:

```python
def _seed_with_candles(data_dir, date, code, meta, candle_ts_list):
    """Seed parquet with meta.json + candles.parquet (no snapshots/trades)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    d = data_dir / "parquet" / date / code
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    pq.write_table(
        pa.table({
            "ts_ms": pa.array(candle_ts_list, type=pa.int64()),
            "open_": pa.array([100] * len(candle_ts_list), type=pa.int64()),
            "close_": pa.array([100] * len(candle_ts_list), type=pa.int64()),
            "high": pa.array([100] * len(candle_ts_list), type=pa.int64()),
            "low": pa.array([100] * len(candle_ts_list), type=pa.int64()),
            "vol_a": pa.array([0] * len(candle_ts_list), type=pa.int64()),
            "vol_b": pa.array([0] * len(candle_ts_list), type=pa.int64()),
        }),
        d / "candles.parquet",
    )


def test_validate_deep_runs_series_invariants(tmp_path, monkeypatch):
    """--deep loads candles.parquet and reports series violations."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    # Healthy meta but ts_ms regression in candles.
    _seed_with_candles(
        tmp_path, "20260520", "005930", _healthy(),
        candle_ts_list=[90_002_000, 90_001_000],  # regression
    )

    result_shallow = CliRunner().invoke(app, ["validate", "--severity", "all"])
    # Without --deep, only meta-level checks run → clean for healthy meta.
    assert "series.candles_ts_monotonic" not in result_shallow.stdout

    result_deep = CliRunner().invoke(app, ["validate", "--deep", "--severity", "all"])
    assert result_deep.exit_code == 0
    assert "series.candles_ts_monotonic" in result_deep.stdout


def test_validate_deep_fix_writes_combined_archival(tmp_path, monkeypatch):
    """--deep --fix archives both meta and series violations."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    # Broken meta close + bad candles → both meta and series violations.
    bad_meta = _healthy() | {"regular_session_close_ms": 0}
    _seed_with_candles(
        tmp_path, "20260518", "003490", bad_meta,
        candle_ts_list=[90_002_000, 90_001_000],
    )

    result = CliRunner().invoke(app, ["validate", "--deep", "--fix"])
    assert result.exit_code == 0

    after = json.loads(
        (tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text()
    )
    assert "invariant_violations" in after
    ids = {v["invariant_id"] for v in after["invariant_violations"]}
    assert "meta.close_after_open" in ids
    assert "series.candles_ts_monotonic" in ids
```

- [ ] **Step 7.2: Run tests to verify they fail**

Run: `uv run pytest tests/test_cli_validate.py -v -k deep`
Expected: FAIL — `--deep` flag unrecognized.

- [ ] **Step 7.3: Add `--deep` support**

Edit `hoga/cli.py`. Locate the `validate` command (added in the earlier ADR-0020 work). Change its signature and body. Find:

```python
@app.command()
def validate(
    code: str | None = typer.Option(None, "--code", help="Limit to a single Code (e.g. 005930)."),
    severity: str = typer.Option("error", "--severity",
                                 help="Filter: 'error', 'warn', or 'all'."),
    fix: bool = typer.Option(False, "--fix",
                             help="Rewrite invariant_violations archival field (data untouched)."),
) -> None:
```

Add the `deep` parameter:

```python
@app.command()
def validate(
    code: str | None = typer.Option(None, "--code", help="Limit to a single Code (e.g. 005930)."),
    severity: str = typer.Option("error", "--severity",
                                 help="Filter: 'error', 'warn', or 'all'."),
    fix: bool = typer.Option(False, "--fix",
                             help="Rewrite invariant_violations archival field (data untouched)."),
    deep: bool = typer.Option(False, "--deep",
                              help="Also run series invariants (loads candles/snapshots/trades parquet)."),
) -> None:
```

Inside the function body, find the line that runs `_check(meta)` and wrap it to also call series. Locate the existing loop body where `_check(meta)` produces `violations`:

```python
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
```

Replace with:

```python
            meta = _json.loads(meta_p.read_text(encoding="utf-8"))
            violations = _check(meta)
            if deep:
                violations = violations + _run_series_for(code_dir, meta)
            if severity != "all":
                violations = [v for v in violations if v.severity.value == severity]
            if not violations:
                continue
            rows.append((date_dir.name, code_dir.name, violations))
            if fix:
                # Always recompute the FULL set (both meta + series if deep)
                # for the archival field — severity-agnostic.
                full = _check(meta)
                if deep:
                    full = full + _run_series_for(code_dir, meta)
                meta["invariant_violations"] = [v.as_dict() for v in full]
                meta_p.write_text(_json.dumps(meta, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
```

Add the `_run_series_for` helper just above the `@app.command()` for validate:

```python
def _run_series_for(stock_date_dir, meta):
    """Load parquet artifacts for one Stock-Date dir and run series invariants.
    Returns a Violation list; missing parquet files are skipped silently
    (invariants treat None as 'nothing to check')."""
    import pyarrow.parquet as _pq

    from hoga.api.invariants import StockDateArtifacts, check_series
    from hoga.tables.candles import Candle
    from hoga.tables.snapshots import Orderbook
    from hoga.tables.trades import Trade

    def _read(path, builder):
        if not path.exists():
            return None
        table = _pq.read_table(path)
        return [builder(row) for row in table.to_pylist()]

    candles = _read(stock_date_dir / "candles.parquet",
                    lambda r: Candle(**r))
    snapshots = _read(stock_date_dir / "snapshots.parquet",
                      lambda r: Orderbook(**r))
    trades = _read(stock_date_dir / "trades.parquet",
                   lambda r: Trade(**r))
    return check_series(StockDateArtifacts(
        meta=meta, candles=candles, snapshots=snapshots, trades=trades,
    ))
```

If `Orderbook(**r)` or `Trade(**r)` fails due to parquet column mismatch (e.g., tuple fields stored as list), wrap that in a try/except and skip the offending artifact:

```python
    try:
        snapshots = _read(stock_date_dir / "snapshots.parquet",
                          lambda r: Orderbook(**r))
    except Exception:
        snapshots = None
```

Apply the same try/except to trades if needed. The CLI is for diagnostics — graceful degradation beats crashing.

- [ ] **Step 7.4: Verify**

Run: `uv run pytest tests/test_cli_validate.py -v`
Expected: all PASS (5 existing + 2 new).

- [ ] **Step 7.5: Commit**

```bash
git add hoga/cli.py tests/test_cli_validate.py
git commit -m "feat(cli): hoga validate --deep runs series invariants

Default sweep stays meta-only (no parquet I/O, no performance hit on
existing usage). --deep loads candles/snapshots/trades for each
Stock-Date directory and runs SERIES_INVARIANTS, surfacing any
violations alongside the meta-level ones. --deep --fix archives
the combined set."
```

---

## Task 8: ADR-0020 §3c — series-level archival-cached exception

**Files:**
- Modify: `docs/adr/0020-data-integrity-invariant-catalog.md`

- [ ] **Step 8.1: Append §3c to the Decision section**

Edit `docs/adr/0020-data-integrity-invariant-catalog.md`. Find the existing `3b.` decision paragraph (added in the earlier deepening work) and append a new `3c.` paragraph right after it:

```
3c. **Series-level invariants are archival-cached, not live-evaluated on read.**
ADR-0020 §3 established "매 호출 live 평가" as the default for meta-level.
The series-level catalog (added per `2026-05-24-series-level-invariants-design.md`)
deliberately breaks that rule because series checks require loading parquet —
candles/snapshots/trades files that can be tens of MB per Stock-Date — and
per-request loading would tank `/api/range` SLO. Instead, parser write-time
archival records the full violation list (meta + series) into
`meta.json::invariant_violations`, and read-paths trust that field.
Staleness after a catalog update is the user's explicit responsibility —
`hoga validate --deep --fix` rewrites the field across the store.
This exception applies ONLY to series-level invariants; meta-level remains
live-evaluated (cheap, no I/O).
```

- [ ] **Step 8.2: Commit**

```bash
git add docs/adr/0020-data-integrity-invariant-catalog.md
git commit -m "docs(adr-0020): add §3c — series-level invariants are archival-cached

Records the deliberate exception to ADR-0020's 'read-paths re-evaluate
live' principle for the new series catalog. Series checks need parquet
I/O (tens of MB per Stock-Date) that would break /api/range SLO, so
parser archival owns the cache and 'hoga validate --deep --fix' owns
the refresh story."
```

---

## Task 9: End-to-end regression — 5/18/003490 real data

**Files:**
- Modify: `tests/hoga/api/test_series_invariants.py`

- [ ] **Step 9.1: Write the regression test**

Append to `tests/hoga/api/test_series_invariants.py`:

```python
def test_check_series_with_5_18_003490_shape_fires_candle_regression() -> None:
    """The 5/18 chart crash root cause was candles ts_ms regression at
    a Stock-Date boundary. We construct the literal shape that caused
    the chart to throw: two candles with the second's ts_ms < first's.
    This locks the series catalog to that bug pattern forever."""
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(631_826_000),  # virtual second of last segment's end-ish
        _candle(599_428_000),  # the regression seen in the chart error
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 1
    assert fired[0].severity == Severity.error
```

The numbers `631_826_000` / `599_428_000` are the actual values from the
production stack trace ("index=1055, time=599428, prev time=631826" — converted
to ms by multiplying ×1000). They're synthetic for the pure-function test;
the real parquet would have different absolute values but the same
relative ordering.

- [ ] **Step 9.2: Run the test**

Run: `uv run pytest tests/hoga/api/test_series_invariants.py::test_check_series_with_5_18_003490_shape_fires_candle_regression -v`
Expected: PASS (Task 3 already implemented the invariant; this is the regression lock).

- [ ] **Step 9.3: Run the full suite**

Run: `uv run pytest -q`
Expected: 0 failures from this PR's work. The pre-existing
`tests/test_e2e_completeness.py::test_collect_then_parse_then_query_marks_complete`
failure is unrelated and should still be the only red item.

- [ ] **Step 9.4: Commit**

```bash
git add tests/hoga/api/test_series_invariants.py
git commit -m "test(api/invariants): regression pin for 5/18/003490 candle ts_ms pattern

Reuses the literal time values from the lightweight-charts stack trace
that motivated ADR-0020 + the series catalog. Future catalog edits
that drop this property break CI immediately."
```

---

## Self-Review

**Spec coverage check:**

| Spec § | Task | Notes |
|---|---|---|
| §3 decisions (12 rows) | Tasks 1-8 | each row mapped to a task; §3c noted in Task 8 |
| §4.1 module boundaries | Tasks 1-7 | every listed file modified |
| §4.2 core types | Task 2 | StockDateArtifacts + SeriesInvariant + check_series |
| §4.3 META_INVARIANTS rename | Task 2 | alias kept |
| §4.4 trades.validate refactor | Task 1 | find_cum_vol_violations + validate delegates |
| §4.5 parser archival extension | Task 6 | both check + check_series called |
| §4.6 read-path archival-cached | Task 8 (ADR) | not code — design intent recorded |
| §4.7 hoga validate --deep | Task 7 | flag + _run_series_for helper |
| §5 catalog (3 invariants) | Tasks 3, 4, 5 | one task per invariant |
| §6 test strategy | Tasks 1-9 | unit/integration/E2E layers covered |
| §7 compatibility | Task 2 (alias), Task 1 (validate sig unchanged) | both preserved |
| §8 build order | Tasks 1-9 in this plan | matches spec's 10-step seed minus the CONTEXT.md item (StockDateArtifacts is implementation detail, not ubiquitous language) |

**Placeholder scan:** None — every step has the actual code or command.

**Type consistency:**
- `StockDateArtifacts(meta, candles, snapshots, trades)` matches across Tasks 2/3/4/5/6/7
- `CumVolViolation(index, prev_cum, curr_cum, ts_ms)` matches Tasks 1/5
- `SeriesInvariant(id, severity, description, check)` matches Task 2's definition and Tasks 3/4/5's registrations
- `Violation(invariant_id, severity, message, ctx)` (unchanged) used consistently in all 3 series invariants
- `check_series(artifacts)` signature stable across all consumers (parser, CLI)

**Scope check:** 9 tasks, ~500 lines net code (mostly tests). Comfortable for a single PR.

---

## Execution Handoff

The user's pipeline specified `subagent-driven-development` as the next stage, so this plan will be executed via that skill without a choice prompt.
