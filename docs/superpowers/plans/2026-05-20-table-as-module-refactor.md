# Table-as-Module Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor hoga-ops so each Parquet table (`trades`, `snapshots`, `brokers`, `candles`) is a single module under `hoga/tables/` owning dataclass + parsers + pyarrow schema + writer + DuckDB queries + pydantic API model. Query functions return the Pydantic API model directly (no intermediate dict materialization). The schema becomes the explicit interface at the producer↔consumer seam.

**Plan revision 2026-05-20:** During eng review, the original plan exposed `query_*` as `-> dict[str, Any]` and a separate `to_api(row)` as `-> ApiX`. Revised so query functions return `ApiX` directly. Eliminates the implicit dict-shape contract (which was the original code smell). One conversion step, not two.

### Revision override for all per-table tasks (Tasks 2–5)

When implementing each table module, override the code shown later with this contract:

- **No `to_api` / `to_api_list` function.** Drop them entirely.
- **Query functions return Pydantic models, not dicts.** Construct the `ApiX` inline inside the query function from the DuckDB row tuple.

Concretely, for each table:

| Table | Old (in task code) | New (apply this) |
|---|---|---|
| trades | `query_up_to(...) -> list[dict[str, Any]]` + `to_api(row) -> ApiTrade` | `query_up_to(...) -> list[ApiTrade]` (Pydantic inline) |
| trades | `query_range(...) -> list[dict[str, Any]]` + `to_api` | `query_range(...) -> list[ApiTrade]` |
| snapshots | `query_at(...) -> dict[str, Any] \| None` + `to_api(row)` | `query_at(...) -> ApiOrderbookSnapshot \| None` |
| brokers | `query_at(...) -> list[dict[str, Any]]` + `to_api_list(rows)` | `query_at(...) -> tuple[int \| None, list[ApiBrokerEntry]]` (returns `(ts_ms, entries)`; both empty when no data) |
| candles | `query_all(...) -> list[dict[str, Any]]` + `to_api(row)` | `query_all(...) -> list[ApiCandle]` |

`query_time_bounds` and `query_first_ts` (snapshots) keep their primitive return types — they're not entity-shaped.

Example concrete shape for `trades.query_up_to`:

```python
def query_up_to(
    con: duckdb.DuckDBPyConnection, *, path: Path, t_ms: int, limit: int
) -> list[ApiTrade]:
    rows = con.execute(
        "SELECT ts_ms, seq, price, change_pct, qty, side, cum_vol, "
        "cum_trades, low_so_far, high_so_far, net_pressure "
        "FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT ?",
        [str(path), t_ms, limit],
    ).fetchall()
    return [
        ApiTrade(
            ts_ms=r[0], seq=r[1], price=r[2], change_pct=r[3], qty=r[4], side=r[5],
            cum_vol=r[6], cum_trades=r[7], low_so_far=r[8], high_so_far=r[9],
            net_pressure=r[10],
        )
        for r in rows
    ]
```

Tests in each `test_tables_*.py` should be updated to:
- Drop `test_to_api_*` tests entirely (no `to_api` exists).
- Update `query_*` tests to assert on `ApiX` attributes rather than dict keys (`assert rows[0].ts_ms == X` instead of `assert rows[0]["ts_ms"] == X`).

`routes.py` simplifies — no more `to_api(row)` calls:

```python
# Before (task code):
return OrderbookResponse(available_from=None, snapshot=snapshots_tbl.to_api(row))
# After (override):
return OrderbookResponse(available_from=None, snapshot=snapshots_tbl.query_at(engine.conn, path=path, t_ms=t))
```

**Architecture:** Pure structural refactor — no observable behavior change. Parquet column names, API responses, and CLI semantics are unchanged. All 53 existing tests must continue to pass at every commit. New tests at `hoga/tables/*` interfaces are added; obsolete tests on deleted modules (`tsv.py`, `writer.py`, `events.py`) are removed.

**Tech Stack:** Python 3.11+, pyarrow, duckdb, pydantic v2. Same as Phase 1.

**Decision record:** [`docs/adr/0001-table-as-module.md`](../../../docs/adr/0001-table-as-module.md)
**Architecture vocabulary:** [`CONTEXT.md`](../../../CONTEXT.md) (domain) + the `improve-codebase-architecture` skill's LANGUAGE.md (module, interface, depth, seam, adapter, leverage, locality)

---

## File map

### New files

| File | Responsibility |
|---|---|
| `hoga/tables/__init__.py` | package marker |
| `hoga/tables/dispatch.py` | TSV tokenizer (`split_row`, `FieldCountError`), event-type registry built from each table's `PARSERS`, skip set for Price Tick, `parse_row()` entry point |
| `hoga/tables/trades.py` | Trade entity: dataclass, parsers (event types 1 + 3), pa schema, write_parquet, query helpers, ApiTrade model (queries return ApiTrade directly) |
| `hoga/tables/snapshots.py` | Orderbook entity: dataclass, parsers (event type 2), pa schema (with flat ask_p1..p10 etc.), write_parquet, query helpers, ApiOrderbookSnapshot (queries return ApiOrderbookSnapshot directly) |
| `hoga/tables/brokers.py` | BrokerRow entity (long-format): dataclass, parser (event type 4, fans 1 row → 10 BrokerRows), pa schema, write_parquet, query helpers, ApiBrokerEntry (queries return list[ApiBrokerEntry] + ts_ms) |
| `hoga/tables/candles.py` | Candle entity: dataclass, `parse_candle_row(line)` (chart.tsv source, no EVENT_TYPES), pa schema, write_parquet, query helpers, ApiCandle (queries return list[ApiCandle] directly) |
| `tests/test_dispatch.py` | tokenizer + registry + skip behavior |
| `tests/test_tables_trades.py` | Trades module interface |
| `tests/test_tables_snapshots.py` | Snapshots module interface |
| `tests/test_tables_brokers.py` | Brokers module interface |
| `tests/test_tables_candles.py` | Candles module interface |

### Files to be modified

| File | Change |
|---|---|
| `hoga/parser/__init__.py` | Use `hoga.tables.dispatch.parse_row` instead of `hoga.parser.tsv.parse_row`. Use `tables.X.write_parquet` instead of `writer.write_X_parquet`. Use `parse_info_row` (kept local) for StockInfo. Cross-table validation stays here. |
| `hoga/api/queries.py` | Shrink to `list_stock_dates`, `get_meta`. Per-table queries (`get_orderbook_at`, `first_snapshot_ts`, `get_trades_*`, `get_candles`, `get_brokers_at`) delegate to `tables.X.query_*`. |
| `hoga/api/routes.py` | Replace inline row→model conversion with direct `tables.X.query_*` calls (queries return Pydantic models). |
| `hoga/api/models.py` | Keep only API container models (`OrderbookResponse`, `TradesResponse`, `CandlesResponse`, `BrokersResponse`, `Meta`, `StockDate`). Entity models (`Trade`, `OrderbookSnapshot`, `Candle`, `BrokerEntry`) become re-exports from `tables.X.ApiX` or are removed and `routes.py` imports directly. |

### Files to be deleted (in Task 6/7)

- `hoga/parser/events.py` — dataclasses now in `tables/*.py`
- `hoga/parser/tsv.py` — parsers + dispatcher absorbed into `tables/`
- `hoga/parser/writer.py` — writers in `tables/*.py`
- `tests/test_parser_tsv.py` — replaced by `test_dispatch.py` + per-table parsing tests in `test_tables_*.py`
- `tests/test_parser_writer.py` — replaced by per-table write tests in `test_tables_*.py`

### Files unchanged

- `hoga/config.py`, `hoga/cli.py`, `hoga/__main__.py`, `hoga/__init__.py`
- `hoga/collector/*` (orchestrator uses raw TSV split; not affected)
- `hoga/api/app.py`
- `tests/test_config.py`, `tests/test_collector_*.py`, `tests/test_parser_e2e.py`, `tests/test_api.py`
- `tests/conftest.py`, `tests/fixtures/`

---

## Task 0: Capture API baseline for byte-parity verification

**Goal:** Refactor's load-bearing invariant is "no observable behavior change." Capture the current API responses now so Task 8 can `diff` against them. This is the cheapest, most objective way to prove behavior preservation. Must be done BEFORE any code changes.

**Files:** none modified (captures go to `/tmp/api-baseline/`)

- [ ] **Step 1: Ensure data is parsed and server is reachable**

Existing data should already be at `data/parquet/20260519/{003490,005930}/` from Phase 1 validation. Verify:

```bash
cd C:\code\hoga-ops
ls data/parquet/20260519/
# expect: 003490/  005930/
```

If the parquet directories are missing, run `python -m hoga parse --code 003490 --date 20260519` first (raw data should still be at `data/raw/20260519/`).

- [ ] **Step 2: Start server in background**

```bash
python -m hoga serve --port 8000 &
SERVER_PID=$!
sleep 2
```

- [ ] **Step 3: Capture each endpoint's response**

```bash
mkdir -p /tmp/api-baseline
curl -sS "http://127.0.0.1:8000/api/stock-dates" > /tmp/api-baseline/stock-dates.json
curl -sS "http://127.0.0.1:8000/api/meta?code=003490&date=20260519" > /tmp/api-baseline/meta-003490.json
curl -sS "http://127.0.0.1:8000/api/orderbook?code=003490&date=20260519&t=120000000" > /tmp/api-baseline/orderbook-003490-12h.json
curl -sS "http://127.0.0.1:8000/api/orderbook?code=003490&date=20260519&t=80000000" > /tmp/api-baseline/orderbook-003490-before-data.json
curl -sS "http://127.0.0.1:8000/api/trades?code=003490&date=20260519&t=120000000&limit=20" > /tmp/api-baseline/trades-003490-t.json
curl -sS "http://127.0.0.1:8000/api/trades?code=003490&date=20260519&from=143000000&to=143010000&limit=100" > /tmp/api-baseline/trades-003490-range.json
curl -sS "http://127.0.0.1:8000/api/candles?code=003490&date=20260519" > /tmp/api-baseline/candles-003490.json
curl -sS "http://127.0.0.1:8000/api/brokers?code=003490&date=20260519&t=140000000" > /tmp/api-baseline/brokers-003490-14h.json
curl -sS "http://127.0.0.1:8000/api/brokers?code=003490&date=20260519&t=80000000" > /tmp/api-baseline/brokers-003490-before.json
ls -la /tmp/api-baseline/
```

Expected: 9 non-empty JSON files.

- [ ] **Step 4: Stop server**

```bash
kill $SERVER_PID
```

- [ ] **Step 5: Sanity check baseline isn't empty**

```bash
for f in /tmp/api-baseline/*.json; do
  size=$(wc -c < "$f")
  echo "$f: $size bytes"
  if [ "$size" -lt 10 ]; then
    echo "  WARNING: suspiciously small"
  fi
done
```

Expected: each file at least 50 bytes (HTTP 4xx responses are short — only `orderbook-before-data` and `brokers-before` are intentionally near-empty payloads, but valid JSON).

**Do not commit the baselines** — they're in `/tmp`, transient. They serve one purpose: Task 8 will diff against them. If you restart your machine between Task 0 and Task 8, re-run Task 0.

---

## Task 1: Scaffold `hoga/tables/` package + dispatcher shell

**Goal:** Create the package skeleton and the dispatcher module that holds tokenizer + registry infrastructure. No table modules yet; nothing called from this task. Existing 53 tests must pass unchanged.

**Files:**
- Create: `hoga/tables/__init__.py`
- Create: `hoga/tables/dispatch.py`
- Create: `tests/test_dispatch.py`

- [ ] **Step 1: Create `hoga/tables/__init__.py` (empty package marker)**

```python
"""Per-Parquet-table modules. Each table owns its dataclass, parsers, schema, writer, queries, and API mapping."""
```

- [ ] **Step 2: Write the failing test for dispatcher tokenizer**

Create `tests/test_dispatch.py`:

```python
from __future__ import annotations

import pytest

from hoga.tables.dispatch import FieldCountError, split_row


def test_split_row_strips_trailing_newline() -> None:
    assert split_row("a\tb\tc\n") == ["a", "b", "c"]


def test_split_row_strips_trailing_tab_empty_field() -> None:
    assert split_row("a\tb\tc\t\n") == ["a", "b", "c"]


def test_split_row_strips_crlf() -> None:
    assert split_row("a\tb\tc\r\n") == ["a", "b", "c"]


def test_split_row_preserves_inner_empties() -> None:
    assert split_row("a\t\tb\t\t\tc") == ["a", "", "b", "", "", "c"]


def test_field_count_error_is_value_error() -> None:
    assert issubclass(FieldCountError, ValueError)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python -m pytest tests/test_dispatch.py -v`
Expected: `ModuleNotFoundError: No module named 'hoga.tables.dispatch'`.

- [ ] **Step 4: Implement `hoga/tables/dispatch.py` with tokenizer only**

```python
"""TSV row dispatcher for first.tsv rows.

This module owns the tokenizer and (in Task 6, after table modules exist) the
event-type → table-module registry. Tables register themselves via their
``PARSERS`` dict; this module aggregates them.

For Task 1, the registry is empty — only the tokenizer is functional.
"""
from __future__ import annotations

# Skip set: event types known to carry no structured data.
SKIP_EVENT_TYPES: frozenset[int] = frozenset({5})  # Price Tick


class FieldCountError(ValueError):
    """A row's tab-separated field count doesn't match the expected count for its event_type."""


def split_row(line: str) -> list[str]:
    """Tokenize a TSV row.

    Strips trailing CR/LF and one trailing empty field (hogaplay rows often
    end with a trailing tab).
    """
    cleaned = line.rstrip("\n").rstrip("\r")
    parts = cleaned.split("\t")
    if parts and parts[-1] == "":
        parts.pop()
    return parts
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_dispatch.py -v`
Expected: 5 passed.

- [ ] **Step 6: Run full test suite (sanity)**

Run: `python -m pytest -q`
Expected: 58 passed (53 + 5 new).

- [ ] **Step 7: Ruff clean**

Run: `python -m ruff check hoga/ tests/ && python -m ruff format --check hoga/ tests/`
Apply `python -m ruff format hoga/tables/ tests/test_dispatch.py` if needed.

- [ ] **Step 8: Commit**

```bash
git add hoga/tables/ tests/test_dispatch.py
git commit -m "refactor(tables): scaffold tables package + dispatcher tokenizer"
```

---

## Task 2: Create `hoga/tables/trades.py`

**Goal:** Build the full Trades table module — Trade dataclass, both parsers (event types 1 and 3), pyarrow schema, write_parquet, query helpers, ApiTrade model (queries return ApiTrade directly). The module is **not yet wired** to parser/__init__.py or api/queries.py; old code paths continue to work. Existing 53 tests pass; ~10 new tests added.

**Files:**
- Create: `hoga/tables/trades.py`
- Create: `tests/test_tables_trades.py`

- [ ] **Step 1: Write the failing tests at module interface**

Create `tests/test_tables_trades.py`:

```python
from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from dataclasses import replace

import pytest

from hoga.tables.trades import (
    PARSERS,
    PARQUET_SCHEMA,
    ApiTrade,
    Trade,
    TradeValidationError,
    query_range,
    query_up_to,
    validate,
    write_parquet,
)

# Sample raw TSV rows (parts list, pre-split) for each event type the module handles.
_CONTINUOUS_TRADE = [
    "2", "1", "25", "2123", "90008726", "32408726",
    "274500", "-2.31", "+4", "789300", "216275",
    "274000", "274500", "274000", "-32765914", "2.35", "0.01", "500.00",
]
_AUCTION_TRADE = [
    "2", "1", "24", "2122", "90008618", "32408618",
    "274000", "-2.49", "788290", "789296", "216274",
    "274000", "274000", "274000", "-32765918", "2.35", "0.01", "500.00",
]
_PREMARKET = ["1", "3", "10", "11", "84000352", "31200352", "0", "0", "501", "0"]


def test_parsers_registered_for_event_types_1_and_3() -> None:
    assert set(PARSERS.keys()) == {1, 3}


def test_parse_continuous_trade_signed_positive() -> None:
    t = PARSERS[1](_CONTINUOUS_TRADE)
    assert isinstance(t, Trade)
    assert t.qty == 4
    assert t.side == 1
    assert t.cum_vol == 789300


def test_parse_auction_cross_trade_unsigned() -> None:
    t = PARSERS[1](_AUCTION_TRADE)
    assert t.qty == 788290
    assert t.side == 0


def test_parse_premarket_row_is_side_zero_trade() -> None:
    t = PARSERS[3](_PREMARKET)
    assert isinstance(t, Trade)
    assert t.qty == 501
    assert t.side == 0


def test_parquet_schema_has_expected_columns() -> None:
    names = PARQUET_SCHEMA.names
    for col in ("ts_ms", "seq", "price", "change_pct", "qty", "side", "cum_vol",
                "cum_trades", "low_so_far", "high_so_far", "net_pressure"):
        assert col in names, f"missing column {col}"


def test_write_parquet_roundtrip(tmp_path: Path) -> None:
    trades = [
        PARSERS[3](_PREMARKET),
        PARSERS[1](_AUCTION_TRADE),
        PARSERS[1](_CONTINUOUS_TRADE),
    ]
    out = tmp_path / "trades.parquet"
    write_parquet(trades, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 3
    assert tbl.column("ts_ms").to_pylist() == sorted(tbl.column("ts_ms").to_pylist()), "ascending"


def test_query_up_to_returns_api_models_descending(tmp_path: Path) -> None:
    out = tmp_path / "trades.parquet"
    write_parquet(
        [PARSERS[1](_AUCTION_TRADE), PARSERS[1](_CONTINUOUS_TRADE)], out
    )
    con = duckdb.connect()
    rows = query_up_to(con, path=out, t_ms=90009000, limit=10)
    assert len(rows) == 2
    assert all(isinstance(r, ApiTrade) for r in rows)
    assert rows[0].ts_ms >= rows[1].ts_ms  # descending
    # ApiTrade has no forensic fields (unknown_14, _16, _17, _18 absent).
    assert not hasattr(rows[0], "unknown_14")


def test_query_range_returns_api_models(tmp_path: Path) -> None:
    out = tmp_path / "trades.parquet"
    write_parquet(
        [PARSERS[3](_PREMARKET), PARSERS[1](_AUCTION_TRADE)], out
    )
    con = duckdb.connect()
    rows = query_range(con, path=out, from_ms=90008000, to_ms=90009000, limit=10)
    assert len(rows) == 1
    assert isinstance(rows[0], ApiTrade)
    assert rows[0].ts_ms == 90008618


def test_validate_passes_for_monotonic_cum_vol() -> None:
    # Auction Cross (side=0, cum_vol=0) is excluded; only the continuous trade is checked.
    trades = [PARSERS[3](_PREMARKET), PARSERS[1](_AUCTION_TRADE), PARSERS[1](_CONTINUOUS_TRADE)]
    validate(trades)  # should not raise


def test_validate_raises_on_cum_vol_regression() -> None:
    # Build two continuous trades where the second has lower cum_vol than the first.
    base = PARSERS[1](_CONTINUOUS_TRADE)  # cum_vol=789300, ts_ms=90008726
    earlier = replace(base, ts_ms=90008000, seq=2122, cum_vol=1000)
    later = replace(base, ts_ms=90008500, seq=2123, cum_vol=500)  # cum_vol drops!
    with pytest.raises(TradeValidationError, match="cum_vol decreased"):
        validate([earlier, later])


def test_validate_lenient_skips_violations() -> None:
    base = PARSERS[1](_CONTINUOUS_TRADE)
    earlier = replace(base, ts_ms=90008000, seq=2122, cum_vol=1000)
    later = replace(base, ts_ms=90008500, seq=2123, cum_vol=500)
    # No exception raised in lenient mode
    validate([earlier, later], lenient=True)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_tables_trades.py -v`
Expected: `ModuleNotFoundError: No module named 'hoga.tables.trades'`.

- [ ] **Step 3: Implement `hoga/tables/trades.py`**

```python
"""Trades table — continuous trading + Auction Cross matchings.

This module owns everything about trades.parquet: in-memory entity, TSV parsers
for event types 1 (continuous trade) and 3 (single-price/premarket summary),
the pyarrow schema, the writer, DuckDB query helpers, the API model, and the
row→API mapping.

Auction Cross trades have ``side=0`` and ``cum_vol=0`` (they are excluded from
the parser's cum_vol monotonicity check; see hoga/parser/__init__.py).
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel


# === In-memory entity ===


@dataclass(frozen=True)
class Trade:
    ts_ms: int
    seq: int
    price: int
    change_pct: float
    qty: int
    side: int  # +1 buy-aggressor, -1 sell-aggressor, 0 Auction Cross / premarket
    cum_vol: int
    cum_trades: int
    low_so_far: int
    high_so_far: int
    net_pressure: int
    # Forensic / not-yet-decoded fields, kept for analysis but not exposed via API.
    unknown_14: int
    unknown_16: float
    unknown_17: float
    unknown_18: float


# === TSV parsers (registered with dispatcher in Task 6) ===


def _parse_continuous_trade(parts: list[str]) -> Trade:
    """Event type 1: regular tick. qty is signed (+N buy-aggressor / -N sell-aggressor / N=auction cross)."""
    qty_raw = parts[8]
    if qty_raw.startswith("+"):
        side = 1
        qty = int(qty_raw[1:])
    elif qty_raw.startswith("-"):
        side = -1
        qty = int(qty_raw[1:])
    else:
        side = 0
        qty = int(qty_raw)
    return Trade(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        price=int(parts[6]),
        change_pct=float(parts[7]),
        qty=qty,
        side=side,
        cum_vol=int(parts[9]),
        cum_trades=int(parts[10]),
        low_so_far=int(parts[11]),
        high_so_far=int(parts[12]),
        net_pressure=int(parts[14]),
        unknown_14=int(parts[13]),
        unknown_16=float(parts[15]),
        unknown_17=float(parts[16]),
        unknown_18=float(parts[17]),
    )


def _parse_premarket_summary(parts: list[str]) -> Trade:
    """Event type 3: single-price-auction summary (opening, closing, pre-market). Stored as side=0 trade."""
    return Trade(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        price=0,
        change_pct=0.0,
        qty=int(parts[8]),
        side=0,
        cum_vol=0,
        cum_trades=0,
        low_so_far=0,
        high_so_far=0,
        net_pressure=0,
        unknown_14=int(parts[6]),
        unknown_16=float(parts[7]),
        unknown_17=float(parts[9]),
        unknown_18=0.0,
    )


# Field counts expected for each event type this module handles.
EXPECTED_FIELD_COUNTS: dict[int, int] = {1: 18, 3: 10}

# Dispatcher registry: event_type -> parser function.
PARSERS: dict[int, Callable[[list[str]], Trade]] = {
    1: _parse_continuous_trade,
    3: _parse_premarket_summary,
}


# === Wire schema (Parquet column contract) ===


PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),
        pa.field("seq", pa.int32()),
        pa.field("price", pa.int32()),
        pa.field("change_pct", pa.float32()),
        pa.field("qty", pa.int32()),
        pa.field("side", pa.int8()),
        pa.field("cum_vol", pa.int64()),
        pa.field("cum_trades", pa.int32()),
        pa.field("low_so_far", pa.int32()),
        pa.field("high_so_far", pa.int32()),
        pa.field("net_pressure", pa.int64()),
        pa.field("unknown_14", pa.int32()),
        pa.field("unknown_16", pa.float32()),
        pa.field("unknown_17", pa.float32()),
        pa.field("unknown_18", pa.float32()),
    ]
)


# === Persist ===


def write_parquet(trades: Iterable[Trade], path: Path) -> None:
    rows = sorted(trades, key=lambda t: t.ts_ms)
    cols = {
        field.name: pa.array([getattr(t, field.name) for t in rows], type=field.type)
        for field in PARQUET_SCHEMA
    }
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), path)


# === Within-table invariants ===


class TradeValidationError(ValueError):
    """A trades-table invariant was violated (e.g. cum_vol regressed)."""


def validate(trades: list[Trade], *, lenient: bool = False) -> None:
    """Check trades-table invariants.

    Invariant: ``cum_vol`` is non-decreasing across continuous-trading rows
    (``side != 0``) ordered by ``ts_ms``. Auction Cross rows (``side == 0``)
    carry ``cum_vol = 0`` and are excluded — their volume folds into the next
    continuous trade.

    In strict mode (default) raises ``TradeValidationError`` on first violation.
    In lenient mode skips violations silently (caller is responsible for noting
    the data may be imperfect).
    """
    sorted_trades = sorted(
        (t for t in trades if t.side != 0),
        key=lambda t: t.ts_ms,
    )
    prev = -1
    for t in sorted_trades:
        if t.cum_vol < prev:
            if lenient:
                continue
            raise TradeValidationError(
                f"cum_vol decreased at seq={t.seq}: {prev} -> {t.cum_vol}"
            )
        prev = t.cum_vol


# === API representation (wire format for clients; excludes forensic fields) ===


class ApiTrade(BaseModel):
    ts_ms: int
    seq: int
    price: int
    change_pct: float
    qty: int
    side: int  # -1, 0, +1
    cum_vol: int
    cum_trades: int
    low_so_far: int
    high_so_far: int
    net_pressure: int


# === Query (returns ApiTrade directly — no intermediate dict) ===


_QUERY_COLS = (
    "ts_ms", "seq", "price", "change_pct", "qty", "side", "cum_vol",
    "cum_trades", "low_so_far", "high_so_far", "net_pressure",
)
_SELECT = ", ".join(_QUERY_COLS)


def _row_to_api(r: tuple) -> ApiTrade:
    return ApiTrade(
        ts_ms=r[0], seq=r[1], price=r[2], change_pct=r[3], qty=r[4], side=r[5],
        cum_vol=r[6], cum_trades=r[7], low_so_far=r[8], high_so_far=r[9],
        net_pressure=r[10],
    )


def query_up_to(
    con: duckdb.DuckDBPyConnection, *, path: Path, t_ms: int, limit: int
) -> list[ApiTrade]:
    rows = con.execute(
        f"SELECT {_SELECT} FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT ?",
        [str(path), t_ms, limit],
    ).fetchall()
    return [_row_to_api(r) for r in rows]


def query_range(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    from_ms: int,
    to_ms: int,
    limit: int,
) -> list[ApiTrade]:
    rows = con.execute(
        f"SELECT {_SELECT} FROM read_parquet(?) WHERE ts_ms >= ? AND ts_ms <= ? "
        "ORDER BY ts_ms DESC LIMIT ?",
        [str(path), from_ms, to_ms, limit],
    ).fetchall()
    return [_row_to_api(r) for r in rows]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_tables_trades.py -v`
Expected: 11 passed.

- [ ] **Step 5: Run full test suite (no regressions)**

Run: `python -m pytest -q`
Expected: 69 passed (58 + 11 new).

- [ ] **Step 6: Ruff clean**

Run: `python -m ruff check hoga/ tests/ && python -m ruff format --check hoga/ tests/`
Apply `python -m ruff format hoga/tables/trades.py tests/test_tables_trades.py` if needed.

- [ ] **Step 7: Commit**

```bash
git add hoga/tables/trades.py tests/test_tables_trades.py
git commit -m "refactor(tables): Trades module (dataclass + parsers + schema + writer + queries + api)"
```

---

## Task 3: Create `hoga/tables/snapshots.py`

**Goal:** Build the Snapshots table module. Snapshots is structurally similar to Trades but has flat columns (`ask_p1..p10`, `ask_q1..q10`, `ask_d1..d10`, `bid_p1..p10`, `bid_q1..q10`, `bid_d1..d10`, plus 4 totals). The in-memory entity uses 10-tuples; the Parquet schema flattens. `write_parquet` and `query_at` handle the flatten/unflatten across the seam. Same gating: not wired yet, existing tests still pass.

**Files:**
- Create: `hoga/tables/snapshots.py`
- Create: `tests/test_tables_snapshots.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_tables_snapshots.py`:

```python
from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from dataclasses import replace

import pytest

from hoga.tables.snapshots import (
    PARSERS,
    PARQUET_SCHEMA,
    ApiOrderbookSnapshot,
    Orderbook,
    SnapshotValidationError,
    query_at,
    query_first_ts,
    query_time_bounds,
    validate,
    write_parquet,
)


def _ob_parts(ts_ms: int = 90000435, seq: int = 847) -> list[str]:
    header = ["2", "2", "835", str(seq), str(ts_ms), "32400435"]
    ask_p = ["25700", "25750", "25800"] + ["0"] * 7
    ask_q = ["657", "72", "111"] + ["0"] * 7
    ask_d = ["0"] * 10
    bid_p = ["25650", "25600", "25550"] + ["0"] * 7
    bid_q = ["2776", "4193", "4259"] + ["0"] * 7
    bid_d = ["0"] * 10
    totals = ["840", "-2387", "11228", "6383"]
    return header + ask_p + ask_q + ask_d + bid_p + bid_q + bid_d + totals


def test_parser_registered_for_event_type_2() -> None:
    assert set(PARSERS.keys()) == {2}


def test_parse_orderbook() -> None:
    ob = PARSERS[2](_ob_parts())
    assert isinstance(ob, Orderbook)
    assert ob.ts_ms == 90000435
    assert ob.seq == 847
    assert ob.ask_p[:3] == (25700, 25750, 25800)
    assert ob.bid_p[:3] == (25650, 25600, 25550)
    assert ob.tot_ask == 840
    assert ob.tot_bid == 11228


def test_parquet_schema_has_flat_level_columns() -> None:
    names = PARQUET_SCHEMA.names
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, 11):
            assert f"{prefix}{i}" in names, f"missing {prefix}{i}"
    for total in ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d"):
        assert total in names


def test_write_parquet_roundtrip(tmp_path: Path) -> None:
    ob1 = PARSERS[2](_ob_parts(ts_ms=90000435, seq=847))
    ob2 = PARSERS[2](_ob_parts(ts_ms=90001000, seq=848))
    out = tmp_path / "snapshots.parquet"
    write_parquet([ob2, ob1], out)  # passed out of order
    tbl = pq.read_table(out)
    assert tbl.num_rows == 2
    assert tbl.column("ts_ms").to_pylist() == [90000435, 90001000]  # writer sorts ascending
    assert tbl.column("ask_p1").to_pylist() == [25700, 25700]


def test_query_at_returns_api_model_for_latest_before(tmp_path: Path) -> None:
    obs = [PARSERS[2](_ob_parts(ts_ms=t, seq=i)) for i, t in enumerate([90000000, 90001000, 90002000], start=1)]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    api = query_at(con, path=out, t_ms=90001500)
    assert isinstance(api, ApiOrderbookSnapshot)
    assert api.ts_ms == 90001000
    # 10-level arrays unflattened from flat ask_pN columns
    assert api.ask_p == [25700, 25750, 25800, 0, 0, 0, 0, 0, 0, 0]
    assert len(api.ask_d) == 10
    assert len(api.bid_d) == 10


def test_query_at_returns_none_before_first(tmp_path: Path) -> None:
    obs = [PARSERS[2](_ob_parts(ts_ms=90000000, seq=1))]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    assert query_at(con, path=out, t_ms=80000000) is None


def test_query_time_bounds(tmp_path: Path) -> None:
    obs = [PARSERS[2](_ob_parts(ts_ms=t, seq=i)) for i, t in enumerate([90000000, 90001000, 90002000], start=1)]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    assert query_time_bounds(con, path=out) == (90000000, 90002000)


def test_query_time_bounds_empty(tmp_path: Path) -> None:
    con = duckdb.connect()
    missing = tmp_path / "missing.parquet"
    write_parquet([], missing)
    assert query_time_bounds(con, path=missing) is None


def test_query_first_ts(tmp_path: Path) -> None:
    obs = [PARSERS[2](_ob_parts(ts_ms=t, seq=i)) for i, t in enumerate([90000000, 90001000], start=1)]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    assert query_first_ts(con, path=out) == 90000000
    empty = tmp_path / "empty.parquet"
    write_parquet([], empty)
    assert query_first_ts(con, path=empty) is None


def test_validate_passes_for_correctly_ordered_book() -> None:
    obs = [PARSERS[2](_ob_parts())]  # ask 25700/25750/25800 ascending, bid 25650/25600/25550 descending
    validate(obs)  # should not raise


def test_validate_raises_when_ask_prices_not_sorted() -> None:
    base = PARSERS[2](_ob_parts())
    bad_ask = (25700, 25800, 25750) + tuple([0] * 7)  # 25800 > 25750 — out of order
    broken = replace(base, ask_p=bad_ask)
    with pytest.raises(SnapshotValidationError, match="ask prices not sorted"):
        validate([broken])


def test_validate_raises_when_bid_prices_not_sorted() -> None:
    base = PARSERS[2](_ob_parts())
    bad_bid = (25650, 25550, 25600) + tuple([0] * 7)  # 25550 < 25600 — should be descending
    broken = replace(base, bid_p=bad_bid)
    with pytest.raises(SnapshotValidationError, match="bid prices not sorted"):
        validate([broken])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_tables_snapshots.py -v`
Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement `hoga/tables/snapshots.py`**

```python
"""Snapshots table — 10-level orderbook state.

Each event type 2 row is a full state snapshot. In-memory the entity uses
10-tuples for price/qty/delta arrays; on disk those are flattened into
``ask_p1..ask_p10``, ``ask_q1..ask_q10``, ``ask_d1..ask_d10`` etc. columns.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

ORDERBOOK_LEVELS = 10

# === In-memory entity ===


@dataclass(frozen=True)
class Orderbook:
    ts_ms: int
    seq: int
    ask_p: tuple[int, ...]  # length 10
    ask_q: tuple[int, ...]
    ask_d: tuple[int, ...]
    bid_p: tuple[int, ...]
    bid_q: tuple[int, ...]
    bid_d: tuple[int, ...]
    tot_ask: int
    tot_ask_d: int
    tot_bid: int
    tot_bid_d: int


# === TSV parser ===


def _parse_orderbook(parts: list[str]) -> Orderbook:
    base = 6
    ask_p = tuple(int(x) for x in parts[base : base + ORDERBOOK_LEVELS])
    ask_q = tuple(int(x) for x in parts[base + ORDERBOOK_LEVELS : base + 2 * ORDERBOOK_LEVELS])
    ask_d = tuple(int(x) for x in parts[base + 2 * ORDERBOOK_LEVELS : base + 3 * ORDERBOOK_LEVELS])
    bid_p = tuple(int(x) for x in parts[base + 3 * ORDERBOOK_LEVELS : base + 4 * ORDERBOOK_LEVELS])
    bid_q = tuple(int(x) for x in parts[base + 4 * ORDERBOOK_LEVELS : base + 5 * ORDERBOOK_LEVELS])
    bid_d = tuple(int(x) for x in parts[base + 5 * ORDERBOOK_LEVELS : base + 6 * ORDERBOOK_LEVELS])
    totals_start = base + 6 * ORDERBOOK_LEVELS
    return Orderbook(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        ask_p=ask_p,
        ask_q=ask_q,
        ask_d=ask_d,
        bid_p=bid_p,
        bid_q=bid_q,
        bid_d=bid_d,
        tot_ask=int(parts[totals_start]),
        tot_ask_d=int(parts[totals_start + 1]),
        tot_bid=int(parts[totals_start + 2]),
        tot_bid_d=int(parts[totals_start + 3]),
    )


EXPECTED_FIELD_COUNTS: dict[int, int] = {2: 70}
PARSERS: dict[int, Callable[[list[str]], Orderbook]] = {2: _parse_orderbook}


# === Wire schema ===


def _build_schema() -> pa.Schema:
    fields: list[pa.Field] = [
        pa.field("ts_ms", pa.int64()),
        pa.field("seq", pa.int32()),
    ]
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, ORDERBOOK_LEVELS + 1):
            fields.append(pa.field(f"{prefix}{i}", pa.int32()))
    for total in ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d"):
        fields.append(pa.field(total, pa.int32()))
    return pa.schema(fields)


PARQUET_SCHEMA: pa.Schema = _build_schema()


# === Persist (flattens tuple-fields into per-level columns) ===


def write_parquet(snapshots: Iterable[Orderbook], path: Path) -> None:
    rows = sorted(snapshots, key=lambda o: o.ts_ms)
    cols: dict[str, pa.Array] = {
        "ts_ms": pa.array([o.ts_ms for o in rows], type=pa.int64()),
        "seq": pa.array([o.seq for o in rows], type=pa.int32()),
    }
    for prefix, attr in (
        ("ask_p", "ask_p"), ("ask_q", "ask_q"), ("ask_d", "ask_d"),
        ("bid_p", "bid_p"), ("bid_q", "bid_q"), ("bid_d", "bid_d"),
    ):
        for i in range(ORDERBOOK_LEVELS):
            cols[f"{prefix}{i + 1}"] = pa.array(
                [getattr(o, attr)[i] for o in rows], type=pa.int32()
            )
    for total in ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d"):
        cols[total] = pa.array([getattr(o, total) for o in rows], type=pa.int32())
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), path)


# === Within-table invariants ===


class SnapshotValidationError(ValueError):
    """A snapshots-table invariant was violated (e.g. price arrays out of order)."""


def validate(snapshots: list[Orderbook], *, lenient: bool = False) -> None:
    """Check snapshots-table invariants.

    Invariants:
    - ``ask_p`` is non-decreasing (excluding placeholder ``0``s at the tail).
    - ``bid_p`` is non-increasing (excluding placeholder ``0``s at the tail).

    These mirror Korean orderbook ladder semantics: best ask is the lowest sell
    price, deeper asks rise; best bid is the highest buy price, deeper bids fall.

    In strict mode (default) raises ``SnapshotValidationError`` on first violation.
    In lenient mode skips violations silently.
    """
    for ob in snapshots:
        nz_ask = [p for p in ob.ask_p if p > 0]
        if nz_ask != sorted(nz_ask):
            if lenient:
                continue
            raise SnapshotValidationError(
                f"ask prices not sorted at seq={ob.seq}: {nz_ask}"
            )
        nz_bid = [p for p in ob.bid_p if p > 0]
        if nz_bid != sorted(nz_bid, reverse=True):
            if lenient:
                continue
            raise SnapshotValidationError(
                f"bid prices not sorted at seq={ob.seq}: {nz_bid}"
            )


# === API representation ===


class ApiOrderbookSnapshot(BaseModel):
    ts_ms: int
    seq: int
    ask_p: list[int]  # length 10
    ask_q: list[int]
    ask_d: list[int]
    bid_p: list[int]
    bid_q: list[int]
    bid_d: list[int]
    tot_ask: int
    tot_ask_d: int
    tot_bid: int
    tot_bid_d: int


# === Query (returns ApiOrderbookSnapshot directly — unflattens flat columns inline) ===


def query_at(
    con: duckdb.DuckDBPyConnection, *, path: Path, t_ms: int
) -> ApiOrderbookSnapshot | None:
    """Return the latest snapshot at ts_ms <= t_ms as an ApiOrderbookSnapshot, or None
    if before any data."""
    row = con.execute(
        "SELECT * FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1",
        [str(path), t_ms],
    ).fetchone()
    if row is None:
        return None
    cols = [d[0] for d in con.description]
    by_name = dict(zip(cols, row, strict=True))
    return ApiOrderbookSnapshot(
        ts_ms=by_name["ts_ms"],
        seq=by_name["seq"],
        ask_p=[by_name[f"ask_p{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        ask_q=[by_name[f"ask_q{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        ask_d=[by_name[f"ask_d{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        bid_p=[by_name[f"bid_p{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        bid_q=[by_name[f"bid_q{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        bid_d=[by_name[f"bid_d{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        tot_ask=by_name["tot_ask"],
        tot_ask_d=by_name["tot_ask_d"],
        tot_bid=by_name["tot_bid"],
        tot_bid_d=by_name["tot_bid_d"],
    )


def query_time_bounds(
    con: duckdb.DuckDBPyConnection, *, path: Path
) -> tuple[int, int] | None:
    """Return (min ts_ms, max ts_ms) across the snapshots, or None if empty."""
    row = con.execute(
        "SELECT min(ts_ms), max(ts_ms) FROM read_parquet(?)", [str(path)]
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return int(row[0]), int(row[1])


def query_first_ts(con: duckdb.DuckDBPyConnection, *, path: Path) -> int | None:
    """Return min ts_ms or None."""
    bounds = query_time_bounds(con, path=path)
    return bounds[0] if bounds else None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_tables_snapshots.py -v`
Expected: 12 passed.

- [ ] **Step 5: Run full test suite**

Run: `python -m pytest -q`
Expected: 81 passed (69 + 12 new).

- [ ] **Step 6: Ruff + commit**

```bash
python -m ruff check hoga/ tests/
python -m ruff format hoga/tables/snapshots.py tests/test_tables_snapshots.py
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -m "refactor(tables): Snapshots module"
```

---

## Task 4: Create `hoga/tables/brokers.py`

**Goal:** Build the Brokers table module. Brokers parser is unique — one TSV row produces 10 BrokerRow entities (5 buy × 5 sell). The schema is long-format (one row per broker per snapshot).

**Files:**
- Create: `hoga/tables/brokers.py`
- Create: `tests/test_tables_brokers.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_tables_brokers.py`:

```python
from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from hoga.tables.brokers import (
    PARSERS,
    PARQUET_SCHEMA,
    ApiBrokerEntry,
    BrokerRow,
    query_at,
    write_parquet,
)


def _broker_parts(ts_ms: int = 90019919, seq: int = 912) -> list[str]:
    return [
        "2", "4", "0", str(seq), str(ts_ms), "32419919",
        "미래에셋", "NH투자증권", "키움증권", "한국투자증권", "신한투자증권",
        "1798", "1291", "1210", "1164", "804",
        "1798", "1291", "1210", "1164", "804",
        "아이엠증권", "유비에스증권", "NH투자증권", "JP모간서울", "키움증권",
        "3450", "1236", "968", "602", "549",
        "3450", "1236", "968", "602", "549",
        "0", "0", "1838", "1838", "1838", "1838",
    ]


def test_parser_registered_for_event_type_4() -> None:
    assert set(PARSERS.keys()) == {4}


def test_parse_fans_one_row_into_ten() -> None:
    rows = PARSERS[4](_broker_parts())
    assert isinstance(rows, list)
    assert all(isinstance(r, BrokerRow) for r in rows)
    assert len(rows) == 10
    sells = [r for r in rows if r.side == "sell"]
    buys = [r for r in rows if r.side == "buy"]
    assert len(sells) == 5
    assert len(buys) == 5
    assert sells[0].broker == "미래에셋"
    assert sells[0].rank == 1
    assert sells[0].qty_today == 1798
    assert buys[0].broker == "아이엠증권"


def test_parquet_schema_columns() -> None:
    names = PARQUET_SCHEMA.names
    for col in ("ts_ms", "seq", "side", "rank", "broker", "qty_today", "qty_delta"):
        assert col in names


def test_write_parquet_roundtrip(tmp_path: Path) -> None:
    rows = PARSERS[4](_broker_parts())
    out = tmp_path / "brokers.parquet"
    write_parquet(rows, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 10
    assert set(tbl.column("side").to_pylist()) == {"sell", "buy"}


def test_query_at_returns_ts_and_api_entries(tmp_path: Path) -> None:
    earlier = PARSERS[4](_broker_parts(ts_ms=90019919, seq=912))
    later = PARSERS[4](_broker_parts(ts_ms=90030000, seq=913))
    out = tmp_path / "brokers.parquet"
    write_parquet(earlier + later, out)
    con = duckdb.connect()
    ts_ms, entries = query_at(con, path=out, t_ms=90025000)
    # The latest snapshot <= t_ms is the earlier one.
    assert ts_ms == 90019919
    assert len(entries) == 10
    assert all(isinstance(e, ApiBrokerEntry) for e in entries)
    sides = {e.side for e in entries}
    assert sides == {"buy", "sell"}


def test_query_at_returns_none_and_empty_before_any_data(tmp_path: Path) -> None:
    rows = PARSERS[4](_broker_parts())
    out = tmp_path / "brokers.parquet"
    write_parquet(rows, out)
    con = duckdb.connect()
    ts_ms, entries = query_at(con, path=out, t_ms=80000000)
    assert ts_ms is None
    assert entries == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_tables_brokers.py -v`
Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement `hoga/tables/brokers.py`**

```python
"""Brokers table — top-5 buy + top-5 sell broker rankings (상위 거래원).

One TSV row (event type 4) produces 10 BrokerRow entities in long format.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

BrokerSide = Literal["buy", "sell"]
TOP_N = 5


# === In-memory entity ===


@dataclass(frozen=True)
class BrokerRow:
    """One broker's slot at one snapshot. ts_ms + seq + side + rank is unique."""

    ts_ms: int
    seq: int
    side: BrokerSide
    rank: int  # 1..5
    broker: str
    qty_today: int
    qty_delta: int


# === TSV parser (one row -> 10 entities) ===


def _parse_broker(parts: list[str]) -> list[BrokerRow]:
    ts_ms = int(parts[4])
    seq = int(parts[3])
    base = 6
    sell_names = parts[base : base + TOP_N]
    sell_today = parts[base + TOP_N : base + 2 * TOP_N]
    sell_delta = parts[base + 2 * TOP_N : base + 3 * TOP_N]
    buy_names = parts[base + 3 * TOP_N : base + 4 * TOP_N]
    buy_today = parts[base + 4 * TOP_N : base + 5 * TOP_N]
    buy_delta = parts[base + 5 * TOP_N : base + 6 * TOP_N]
    rows: list[BrokerRow] = []
    for i, (name, today, delta) in enumerate(
        zip(sell_names, sell_today, sell_delta, strict=True), start=1
    ):
        rows.append(
            BrokerRow(
                ts_ms=ts_ms, seq=seq, side="sell", rank=i, broker=name,
                qty_today=int(today), qty_delta=int(delta),
            )
        )
    for i, (name, today, delta) in enumerate(
        zip(buy_names, buy_today, buy_delta, strict=True), start=1
    ):
        rows.append(
            BrokerRow(
                ts_ms=ts_ms, seq=seq, side="buy", rank=i, broker=name,
                qty_today=int(today), qty_delta=int(delta),
            )
        )
    return rows


EXPECTED_FIELD_COUNTS: dict[int, int] = {4: 42}
PARSERS: dict[int, Callable[[list[str]], list[BrokerRow]]] = {4: _parse_broker}


# === Wire schema ===


PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),
        pa.field("seq", pa.int32()),
        pa.field("side", pa.string()),
        pa.field("rank", pa.int8()),
        pa.field("broker", pa.string()),
        pa.field("qty_today", pa.int32()),
        pa.field("qty_delta", pa.int32()),
    ]
)


# === Persist ===


def write_parquet(rows: Iterable[BrokerRow], path: Path) -> None:
    sorted_rows = sorted(rows, key=lambda r: (r.ts_ms, r.side, r.rank))
    cols = {
        "ts_ms": pa.array([r.ts_ms for r in sorted_rows], type=pa.int64()),
        "seq": pa.array([r.seq for r in sorted_rows], type=pa.int32()),
        "side": pa.array([r.side for r in sorted_rows], type=pa.string()),
        "rank": pa.array([r.rank for r in sorted_rows], type=pa.int8()),
        "broker": pa.array([r.broker for r in sorted_rows], type=pa.string()),
        "qty_today": pa.array([r.qty_today for r in sorted_rows], type=pa.int32()),
        "qty_delta": pa.array([r.qty_delta for r in sorted_rows], type=pa.int32()),
    }
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), path)


# === API representation ===


class ApiBrokerEntry(BaseModel):
    side: str  # "buy" | "sell"
    rank: int
    broker: str
    qty_today: int
    qty_delta: int


# === Query (returns (ts_ms, [ApiBrokerEntry]) directly) ===


def query_at(
    con: duckdb.DuckDBPyConnection, *, path: Path, t_ms: int
) -> tuple[int | None, list[ApiBrokerEntry]]:
    """Return (ts_ms, entries) for the latest broker snapshot at ts_ms <= t_ms.

    Returns ``(None, [])`` if no broker snapshot exists at or before ``t_ms``.
    Otherwise ``ts_ms`` is the snapshot's timestamp and ``entries`` has all 10
    rows (5 sell + 5 buy) as ApiBrokerEntry objects.
    """
    latest = con.execute(
        "SELECT max(ts_ms) FROM read_parquet(?) WHERE ts_ms <= ?",
        [str(path), t_ms],
    ).fetchone()
    if latest is None or latest[0] is None:
        return None, []
    ts_ms_value = int(latest[0])
    rows = con.execute(
        "SELECT side, rank, broker, qty_today, qty_delta FROM read_parquet(?) "
        "WHERE ts_ms = ? ORDER BY side, rank",
        [str(path), ts_ms_value],
    ).fetchall()
    entries = [
        ApiBrokerEntry(
            side=r[0], rank=r[1], broker=r[2], qty_today=r[3], qty_delta=r[4]
        )
        for r in rows
    ]
    return ts_ms_value, entries
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_tables_brokers.py -v`
Expected: 6 passed.

- [ ] **Step 5: Run full test suite**

Run: `python -m pytest -q`
Expected: 87 passed (81 + 6 new).

- [ ] **Step 6: Ruff + commit**

```bash
python -m ruff format hoga/tables/brokers.py tests/test_tables_brokers.py
python -m ruff check hoga/ tests/
git add hoga/tables/brokers.py tests/test_tables_brokers.py
git commit -m "refactor(tables): Brokers module"
```

---

## Task 5: Create `hoga/tables/candles.py`

**Goal:** Build the Candles table module. Candles is the only table parsed from `chart.tsv` (not `first_*.tsv`), so it has no `PARSERS` registered with the dispatcher. Instead it exports `parse_row(line)` for the parser orchestrator to call directly.

**Files:**
- Create: `hoga/tables/candles.py`
- Create: `tests/test_tables_candles.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_tables_candles.py`:

```python
from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from hoga.tables.candles import (
    PARQUET_SCHEMA,
    ApiCandle,
    Candle,
    parse_row,
    query_all,
    write_parquet,
)


def test_parse_row() -> None:
    line = "30600000\t08:30:00\t281000\t281000\t281000\t281000\t119\t0\t0\t43\t5"
    c = parse_row(line)
    assert isinstance(c, Candle)
    assert c.ts_ms == 30600000
    assert c.open_ == c.close_ == c.high == c.low == 281000
    assert c.vol_a == 119
    assert c.vol_b == 0


def test_candles_not_in_dispatcher_registry() -> None:
    """Candles is parsed from chart.tsv, not first.tsv. It must NOT register any event_type.

    This is a contract test against the dispatcher: if a future change accidentally
    adds ``PARSERS = {6: parse_row}`` to candles.py, the dispatcher would pick it up
    and try to feed first.tsv rows through it. Catch that here.
    """
    from hoga.tables import candles as candles_mod
    from hoga.tables.dispatch import PARSERS as registry

    assert getattr(candles_mod, "PARSERS", {}) == {}, "candles must not declare PARSERS"
    # And no registry entry should call into candles.parse_row.
    candles_funcs = {candles_mod.parse_row}
    assert not (set(registry.values()) & candles_funcs), (
        "candles.parse_row leaked into the dispatcher registry"
    )


def test_parquet_schema_columns() -> None:
    names = PARQUET_SCHEMA.names
    for col in ("ts_ms", "open", "close", "high", "low", "vol_a", "vol_b"):
        assert col in names


def test_write_parquet_sorts_ascending(tmp_path: Path) -> None:
    candles = [
        Candle(ts_ms=30660000, open_=281000, close_=281000, high=281000, low=281000, vol_a=10, vol_b=2),
        Candle(ts_ms=30600000, open_=281000, close_=281000, high=281000, low=281000, vol_a=119, vol_b=0),
    ]
    out = tmp_path / "candles.parquet"
    write_parquet(candles, out)
    tbl = pq.read_table(out)
    assert tbl.column("ts_ms").to_pylist() == [30600000, 30660000]


def test_query_all_returns_ascending_api_models(tmp_path: Path) -> None:
    out = tmp_path / "candles.parquet"
    write_parquet(
        [
            Candle(ts_ms=30660000, open_=1, close_=1, high=1, low=1, vol_a=1, vol_b=1),
            Candle(ts_ms=30600000, open_=2, close_=2, high=2, low=2, vol_a=2, vol_b=2),
        ],
        out,
    )
    con = duckdb.connect()
    rows = query_all(con, path=out)
    assert all(isinstance(r, ApiCandle) for r in rows)
    assert [r.ts_ms for r in rows] == [30600000, 30660000]
    assert rows[0].open == 2  # ascending sort moves second-inserted to first
    assert rows[1].open == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_tables_candles.py -v`
Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement `hoga/tables/candles.py`**

```python
"""Candles table — 1-minute OHLCV bars parsed from chart.tsv.

Unlike the other table modules, Candles does not register with the first.tsv
dispatcher. Its rows come from a separate endpoint (chart.php) which the
collector saves to chart.tsv. The parser orchestrator calls ``parse_row`` here
directly.
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

from hoga.tables.dispatch import FieldCountError, split_row

CANDLE_MIN_FIELDS = 8


# === In-memory entity ===


@dataclass(frozen=True)
class Candle:
    ts_ms: int
    open_: int
    close_: int
    high: int
    low: int
    vol_a: int
    vol_b: int


# === Parser ===


def parse_row(line: str) -> Candle:
    """Parse one chart.tsv row into a Candle.

    chart.tsv columns: relative_ts_ms, HH:MM:SS, open, close, high, low,
    vol_a, vol_b, [unknown], cum_a, cum_b. We only retain the first 8.
    """
    parts = split_row(line)
    if len(parts) < CANDLE_MIN_FIELDS:
        raise FieldCountError(
            f"candle row expects >={CANDLE_MIN_FIELDS} fields, got {len(parts)}"
        )
    return Candle(
        ts_ms=int(parts[0]),
        open_=int(parts[2]),
        close_=int(parts[3]),
        high=int(parts[4]),
        low=int(parts[5]),
        vol_a=int(parts[6]),
        vol_b=int(parts[7]),
    )


# === Wire schema ===


PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),
        pa.field("open", pa.int32()),
        pa.field("close", pa.int32()),
        pa.field("high", pa.int32()),
        pa.field("low", pa.int32()),
        pa.field("vol_a", pa.int32()),
        pa.field("vol_b", pa.int32()),
    ]
)


# === Persist ===


def write_parquet(candles: Iterable[Candle], path: Path) -> None:
    rows = sorted(candles, key=lambda c: c.ts_ms)
    cols = {
        "ts_ms": pa.array([c.ts_ms for c in rows], type=pa.int64()),
        "open": pa.array([c.open_ for c in rows], type=pa.int32()),
        "close": pa.array([c.close_ for c in rows], type=pa.int32()),
        "high": pa.array([c.high for c in rows], type=pa.int32()),
        "low": pa.array([c.low for c in rows], type=pa.int32()),
        "vol_a": pa.array([c.vol_a for c in rows], type=pa.int32()),
        "vol_b": pa.array([c.vol_b for c in rows], type=pa.int32()),
    }
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), path)


# === Query ===


# === API representation ===


class ApiCandle(BaseModel):
    ts_ms: int
    open: int
    close: int
    high: int
    low: int
    vol_a: int
    vol_b: int


# === Query (returns list[ApiCandle] directly) ===


def query_all(con: duckdb.DuckDBPyConnection, *, path: Path) -> list[ApiCandle]:
    rows = con.execute(
        'SELECT ts_ms, "open", "close", high, low, vol_a, vol_b '
        "FROM read_parquet(?) ORDER BY ts_ms ASC",
        [str(path)],
    ).fetchall()
    return [
        ApiCandle(
            ts_ms=r[0], open=r[1], close=r[2], high=r[3], low=r[4], vol_a=r[5], vol_b=r[6]
        )
        for r in rows
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_tables_candles.py -v`
Expected: 5 passed.

- [ ] **Step 5: Run full test suite**

Run: `python -m pytest -q`
Expected: 92 passed (87 + 5 new).

- [ ] **Step 6: Ruff + commit**

```bash
python -m ruff format hoga/tables/candles.py tests/test_tables_candles.py
python -m ruff check hoga/ tests/
git add hoga/tables/candles.py tests/test_tables_candles.py
git commit -m "refactor(tables): Candles module"
```

---

## Task 6: Build registry-based dispatcher; migrate parser/__init__.py; delete tsv.py + events.py

**Goal:** Replace the old `hoga/parser/tsv.py` dispatcher with the registry-based one in `hoga/tables/dispatch.py`. Migrate `hoga/parser/__init__.py` to import from `hoga.tables`. Delete `hoga/parser/tsv.py`, `hoga/parser/events.py`, and `tests/test_parser_tsv.py` (those tests have equivalents now in `tests/test_tables_*.py`).

**Files:**
- Modify: `hoga/tables/dispatch.py`
- Modify: `hoga/parser/__init__.py`
- Delete: `hoga/parser/tsv.py`
- Delete: `hoga/parser/events.py`
- Delete: `tests/test_parser_tsv.py`
- Create: `tests/test_dispatch.py` (extend existing — add registry tests)

- [ ] **Step 1: Extend `tests/test_dispatch.py` with registry tests**

Append to `tests/test_dispatch.py`:

```python
from hoga.tables.dispatch import EXPECTED_FIELD_COUNTS, parse_row
from hoga.tables.trades import Trade
from hoga.tables.snapshots import Orderbook
from hoga.tables.brokers import BrokerRow


def test_registry_built_from_tables() -> None:
    # Trades registers 1, 3; Snapshots 2; Brokers 4.
    assert {1, 2, 3, 4}.issubset(EXPECTED_FIELD_COUNTS.keys())
    # Candles is not in the dispatcher.
    assert 5 not in EXPECTED_FIELD_COUNTS  # type 5 is SKIP, not registered


def test_parse_trade_row() -> None:
    line = "\t".join(
        ["2", "1", "25", "2123", "90008726", "32408726",
         "274500", "-2.31", "+4", "789300", "216275",
         "274000", "274500", "274000", "-32765914", "2.35", "0.01", "500.00"]
    )
    assert isinstance(parse_row(line), Trade)


def test_parse_orderbook_row() -> None:
    header = ["2", "2", "835", "847", "90000435", "32400435"]
    levels = ["0"] * 60
    totals = ["0", "0", "0", "0"]
    line = "\t".join(header + levels + totals) + "\t"
    assert isinstance(parse_row(line), Orderbook)


def test_parse_broker_row() -> None:
    header = ["2", "4", "0", "912", "90019919", "32419919"]
    names1 = ["A", "B", "C", "D", "E"]
    qty1 = ["1", "1", "1", "1", "1"]
    qty2 = ["1", "1", "1", "1", "1"]
    names2 = ["F", "G", "H", "I", "J"]
    qty3 = ["1", "1", "1", "1", "1"]
    qty4 = ["1", "1", "1", "1", "1"]
    extras = ["0", "0", "0", "0", "0", "0"]
    line = "\t".join(header + names1 + qty1 + qty2 + names2 + qty3 + qty4 + extras)
    result = parse_row(line)
    assert isinstance(result, list)
    assert all(isinstance(r, BrokerRow) for r in result)


def test_skip_price_tick_returns_none() -> None:
    assert parse_row("3\t5\t25700") is None


def test_unknown_event_type_raises() -> None:
    import pytest
    with pytest.raises(ValueError, match="unknown event type"):
        parse_row("2\t9\t0\t1\t90000000\t0")


def test_wrong_field_count_raises() -> None:
    import pytest
    from hoga.tables.dispatch import FieldCountError
    with pytest.raises(FieldCountError):
        parse_row("2\t1\t0\t1\t90000000")  # type 1 expects 18 fields
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_dispatch.py -v`
Expected: New tests fail with AttributeError (no `EXPECTED_FIELD_COUNTS`, no `parse_row` in dispatch).

- [ ] **Step 3: Replace `hoga/tables/dispatch.py` with full registry implementation**

Replace the file contents:

```python
"""TSV row dispatcher for first.tsv rows.

Tables register themselves via their ``PARSERS`` dict; this module aggregates
those into a single registry at import time, then dispatches each row to the
right table's parser.

To add a new event type:
1. Add an entry to the table module's ``PARSERS`` and ``EXPECTED_FIELD_COUNTS`` dicts.
2. Import the table module here in ``_TABLES``.
3. No changes to this dispatcher required.

Event types in ``SKIP_EVENT_TYPES`` are accepted but produce ``None`` (no
structured data; e.g. the Price Tick heartbeat).
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from hoga.tables import brokers, snapshots, trades

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import Any

# Tables that register parsers with the dispatcher. Candles is intentionally
# excluded — it's parsed from chart.tsv, not first.tsv.
_TABLES = (trades, snapshots, brokers)

# Skip set: event types known to carry no structured data.
SKIP_EVENT_TYPES: frozenset[int] = frozenset({5})  # Price Tick


class FieldCountError(ValueError):
    """A row's tab-separated field count doesn't match the expected count for its event_type."""


# Build registry by aggregating each table module's PARSERS + EXPECTED_FIELD_COUNTS.
# The collision check below is an import-time safety net (loud failure if two
# tables claim the same event type). It is intentionally not unit-tested:
# triggering it requires mutating module globals at import time, which is
# awkward and lower value than the protection itself.
PARSERS: dict[int, Callable[[list[str]], Any]] = {}
EXPECTED_FIELD_COUNTS: dict[int, int] = {}
for _table in _TABLES:
    for _et, _parser in _table.PARSERS.items():
        if _et in PARSERS:
            raise RuntimeError(
                f"event type {_et} registered by multiple table modules: "
                f"{_table.__name__} conflicts with an earlier registration"
            )
        PARSERS[_et] = _parser
    for _et, _count in _table.EXPECTED_FIELD_COUNTS.items():
        EXPECTED_FIELD_COUNTS[_et] = _count


def split_row(line: str) -> list[str]:
    """Tokenize a TSV row.

    Strips trailing CR/LF and one trailing empty field (hogaplay rows often
    end with a trailing tab).
    """
    cleaned = line.rstrip("\n").rstrip("\r")
    parts = cleaned.split("\t")
    if parts and parts[-1] == "":
        parts.pop()
    return parts


_MIN_DISPATCH_FIELDS = 2


def parse_row(line: str) -> Any:
    """Dispatch on field 2 (event_type). Returns the parsed entity, a list of
    entities (broker rows), or None (skip set)."""
    parts = split_row(line)
    if len(parts) < _MIN_DISPATCH_FIELDS:
        raise FieldCountError(f"row too short: {len(parts)} fields")
    try:
        event_type = int(parts[1])
    except ValueError as e:
        raise FieldCountError(f"non-numeric event_type: {parts[1]!r}") from e

    if event_type in SKIP_EVENT_TYPES:
        return None
    if event_type not in PARSERS:
        raise ValueError(f"unknown event type {event_type}")
    expected = EXPECTED_FIELD_COUNTS[event_type]
    if len(parts) != expected:
        raise FieldCountError(
            f"event_type={event_type} expects {expected} fields, got {len(parts)}"
        )
    return PARSERS[event_type](parts)
```

- [ ] **Step 4: Modify `hoga/parser/__init__.py` to use the new dispatcher**

Find and replace these imports at the top:

```python
from hoga.parser.events import BrokerRow, Candle, Orderbook, StockInfo, Trade
from hoga.parser.tsv import (
    FieldCountError,
    parse_candle_row,
    parse_info_row,
    parse_row,
)
from hoga.parser.writer import (
    write_brokers_parquet,
    write_candles_parquet,
    write_snapshots_parquet,
    write_trades_parquet,
)
```

Replace with:

```python
from hoga.tables import brokers, candles, snapshots, trades
from hoga.tables.brokers import BrokerRow
from hoga.tables.candles import Candle
from hoga.tables.dispatch import FieldCountError, parse_row, split_row
from hoga.tables.snapshots import Orderbook
from hoga.tables.trades import Trade
```

`StockInfo` and `parse_info_row` are defined inline in this same file (see Step 5 below — kept here because `StockInfo` is a singleton metadata record per Stock-Date, not a table-shaped concern that warrants its own module).

Then find and replace the four writer calls in `parse_stock_date`:

```python
    write_trades_parquet(trades_list, out_dir / "trades.parquet")
    write_snapshots_parquet(snapshots_list, out_dir / "snapshots.parquet")
    write_brokers_parquet(brokers_list, out_dir / "brokers.parquet")
    write_candles_parquet(candles_list, out_dir / "candles.parquet")
```

Replace with:

```python
    trades.write_parquet(trades_list, out_dir / "trades.parquet")
    snapshots.write_parquet(snapshots_list, out_dir / "snapshots.parquet")
    brokers.write_parquet(brokers_list, out_dir / "brokers.parquet")
    candles.write_parquet(candles_list, out_dir / "candles.parquet")
```

Find the `parse_candle_row` call (in `_collect_candles`):

```python
            candles_list.append(parse_candle_row(line))
```

Replace with:

```python
            candles_list.append(candles.parse_row(line))
```

(Rename the local list variables: existing code uses `trades`, `snapshots`, `brokers`, `candles` as both local variable names AND imported module names — that will shadow imports. Rename locals to `trades_list`, `snapshots_list`, `brokers_list`, `candles_list` throughout `_collect_events`, `_collect_candles`, and `parse_stock_date`. Do the rename carefully; check every usage.)

Find the validator calls in `parse_stock_date`:

```python
    _validate_trades_monotonic(trades_list, lenient=lenient)
    _validate_snapshot_price_order(snapshots_list, lenient=lenient)
```

Replace with delegated per-table calls (the validators now live in their table modules — see ADR 0001):

```python
    trades.validate(trades_list, lenient=lenient)
    snapshots.validate(snapshots_list, lenient=lenient)
```

Then **delete** the now-unused functions `_validate_trades_monotonic` and `_validate_snapshot_price_order` from `parser/__init__.py`. The orchestrator only handles cross-table concerns (dedup across event types via `seen_seqs`) — per-table invariants live with their table.

- [ ] **Step 5: Inline `StockInfo` + `parse_info_row` into `hoga/parser/__init__.py`**

Move from the soon-to-be-deleted `hoga/parser/tsv.py` (current `parse_info_row` + `StockInfo` from `events.py`) directly into the top of `hoga/parser/__init__.py`. Add these definitions right after the imports added in Step 4:

```python
# === StockInfo: the singleton metadata row from info.tsv ===
#
# Not a table — there is exactly one StockInfo per Stock-Date, written into
# meta.json rather than Parquet. Lives here in parser/__init__.py (not
# hoga/tables/) for that reason. See docs/adr/0001-table-as-module.md.

INFO_MIN_FIELDS = 22


@dataclass(frozen=True)
class StockInfo:
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    prev_close: int
    upper_limit: int
    lower_limit: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    raw_line: str
    unknowns: dict[str, str]


def parse_info_row(line: str) -> StockInfo:
    parts = split_row(line)
    if len(parts) < INFO_MIN_FIELDS:
        raise FieldCountError(f"info row expects >={INFO_MIN_FIELDS} fields, got {len(parts)}")
    unknowns = {
        "f11": parts[10],
        "f16": parts[15],
        "f17": parts[16],
        "f21": parts[20],
        "f22": parts[21],
    }
    return StockInfo(
        code=parts[1],
        name=parts[2],
        regular_session_open_ms=int(parts[4]),
        regular_session_close_ms=int(parts[5]),
        prev_close=int(parts[11]),
        upper_limit=int(parts[12]),
        lower_limit=int(parts[13]),
        today_open=int(parts[14]),
        today_high=int(parts[17]),
        today_low=int(parts[18]),
        today_close=int(parts[19]),
        raw_line=line.rstrip("\n"),
        unknowns=unknowns,
    )
```

Make sure `from dataclasses import dataclass` is imported at the top of `parser/__init__.py` (it likely already is — the orchestrator may already use `@dataclass` for return-value containers; if not, add the import).

- [ ] **Step 6: Delete obsolete files**

```bash
rm hoga/parser/tsv.py
rm hoga/parser/events.py
rm tests/test_parser_tsv.py
```

- [ ] **Step 7: Run full test suite**

Run: `python -m pytest -q`
Expected: 92 − 11 (deleted test_parser_tsv) + 7 (new dispatch registry tests) = 88 passed. Adjust count if numbers differ.

If tests fail:
- Look for remaining imports of `hoga.parser.events` / `hoga.parser.tsv` / `hoga.parser.writer` in any file under `hoga/`. Replace with the new locations.
- Look for the local-variable shadowing (`trades` = local list vs `trades` = module) — rename locals.

- [ ] **Step 8: Ruff clean**

Run: `python -m ruff check hoga/ tests/`
Run: `python -m ruff format --check hoga/ tests/`
Apply format if needed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(tables): dispatch via registry; delete parser/tsv.py + parser/events.py"
```

---

## Task 7: Migrate writers + API; delete writer.py; shrink api/queries.py + api/models.py

**Goal:** Now all table modules export `write_parquet`. Delete `hoga/parser/writer.py` and `tests/test_parser_writer.py` (writer tests are duplicated in `test_tables_*.py`). Shrink `api/queries.py` to cross-table-only (`list_stock_dates`, `get_meta`); the per-table query methods delegate to `tables.X.query_*` (which return Pydantic models directly). Update `api/routes.py` to use those queries directly with no row→model translation. Shrink `api/models.py` to API container models only.

**Files:**
- Delete: `hoga/parser/writer.py`
- Delete: `tests/test_parser_writer.py`
- Modify: `hoga/api/queries.py`
- Modify: `hoga/api/routes.py`
- Modify: `hoga/api/models.py`

- [ ] **Step 1: Delete obsolete files**

```bash
rm hoga/parser/writer.py
rm tests/test_parser_writer.py
```

- [ ] **Step 2: Replace `hoga/api/queries.py` with cross-table coordinator only**

```python
"""Cross-table query coordinator. Per-table queries live in ``hoga/tables/``."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb

from hoga.tables import snapshots


class StockDateNotFound(LookupError):
    """No parquet directory for (date, code)."""


class QueryEngine:
    """Owns the shared DuckDB connection; exposes cross-table queries (inventory + meta).

    Per-table queries (orderbook, trades, candles, brokers) live in the table
    modules and are called by routes.py directly with this engine's connection.
    """

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._conn = duckdb.connect(database=":memory:", read_only=False)

    def close(self) -> None:
        self._conn.close()

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        return self._conn

    def parquet_dir(self, date: str, code: str) -> Path:
        d = self.data_dir / "parquet" / date / code
        if not d.exists():
            raise StockDateNotFound(f"{date}/{code}")
        return d

    def list_stock_dates(self) -> list[dict[str, Any]]:
        base = self.data_dir / "parquet"
        if not base.exists():
            return []
        out: list[dict[str, Any]] = []
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            for code_dir in sorted(date_dir.iterdir()):
                if not (code_dir / "meta.json").exists():
                    continue
                meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
                bounds = snapshots.query_time_bounds(
                    self._conn, path=code_dir / "snapshots.parquet"
                )
                out.append(
                    {
                        "date": date_dir.name,
                        "code": code_dir.name,
                        "name": meta["name"],
                        "regular_session_open_ms": meta["regular_session_open_ms"],
                        "regular_session_close_ms": meta["regular_session_close_ms"],
                        "data_window_first_ms": bounds[0] if bounds else meta["regular_session_open_ms"],
                        "data_window_last_ms": bounds[1] if bounds else meta["regular_session_close_ms"],
                    }
                )
        return out

    def get_meta(self, date: str, code: str) -> dict[str, Any]:
        path = self.parquet_dir(date, code) / "meta.json"
        return json.loads(path.read_text(encoding="utf-8"))
```

- [ ] **Step 3: Replace `hoga/api/routes.py` with table-module-delegating handlers**

```python
"""FastAPI route handlers. Each per-table handler delegates to the table
module's ``query_*`` function, which returns Pydantic models directly.
This file is the thin glue layer.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import (
    BrokersResponse,
    CandlesResponse,
    Meta,
    OrderbookResponse,
    StockDate,
    TradesResponse,
)
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.tables import brokers as brokers_tbl
from hoga.tables import candles as candles_tbl
from hoga.tables import snapshots as snapshots_tbl
from hoga.tables import trades as trades_tbl


def build_router(engine: QueryEngine) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/stock-dates", response_model=list[StockDate])
    def stock_dates() -> list[StockDate]:
        return [StockDate(**s) for s in engine.list_stock_dates()]

    @router.get("/meta", response_model=Meta)
    def meta(code: str, date: str) -> Meta:
        try:
            m = engine.get_meta(date, code)
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return Meta(**{k: m[k] for k in Meta.model_fields})

    @router.get("/orderbook", response_model=OrderbookResponse)
    def orderbook(code: str, date: str, t: int = Query(...)) -> OrderbookResponse:
        try:
            path = engine.parquet_dir(date, code) / "snapshots.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        snap = snapshots_tbl.query_at(engine.conn, path=path, t_ms=t)
        if snap is None:
            first_ts = snapshots_tbl.query_first_ts(engine.conn, path=path)
            return OrderbookResponse(available_from=first_ts, snapshot=None)
        return OrderbookResponse(available_from=None, snapshot=snap)

    @router.get("/trades", response_model=TradesResponse)
    def trades(
        code: str,
        date: str,
        t: int | None = Query(None),
        from_ms: int | None = Query(None, alias="from"),
        to_ms: int | None = Query(None, alias="to"),
        limit: int = 50,
    ) -> TradesResponse:
        try:
            path = engine.parquet_dir(date, code) / "trades.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        if from_ms is not None and to_ms is not None:
            rows = trades_tbl.query_range(engine.conn, path=path, from_ms=from_ms, to_ms=to_ms, limit=limit)
        elif t is not None:
            rows = trades_tbl.query_up_to(engine.conn, path=path, t_ms=t, limit=limit)
        else:
            raise HTTPException(status_code=400, detail="provide either ?t= or ?from=&to=")
        return TradesResponse(trades=rows)

    @router.get("/candles", response_model=CandlesResponse)
    def candles(code: str, date: str) -> CandlesResponse:
        try:
            path = engine.parquet_dir(date, code) / "candles.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return CandlesResponse(candles=candles_tbl.query_all(engine.conn, path=path))

    @router.get("/brokers", response_model=BrokersResponse)
    def brokers(code: str, date: str, t: int = Query(...)) -> BrokersResponse:
        try:
            path = engine.parquet_dir(date, code) / "brokers.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        ts_ms, entries = brokers_tbl.query_at(engine.conn, path=path, t_ms=t)
        return BrokersResponse(ts_ms=ts_ms, entries=entries)

    return router
```

- [ ] **Step 4: Shrink `hoga/api/models.py` to API container models only**

```python
"""API response container models. Per-entity models live in their table
module (``hoga/tables/{trades,snapshots,brokers,candles}.py``).
"""
from __future__ import annotations

from pydantic import BaseModel

from hoga.tables.brokers import ApiBrokerEntry
from hoga.tables.candles import ApiCandle
from hoga.tables.snapshots import ApiOrderbookSnapshot
from hoga.tables.trades import ApiTrade


class StockDate(BaseModel):
    """Inventory entry: one captured Stock-Date with its boundaries."""

    date: str
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    data_window_first_ms: int
    data_window_last_ms: int


class OrderbookResponse(BaseModel):
    available_from: int | None = None
    snapshot: ApiOrderbookSnapshot | None


class TradesResponse(BaseModel):
    trades: list[ApiTrade]


class CandlesResponse(BaseModel):
    candles: list[ApiCandle]


class BrokersResponse(BaseModel):
    ts_ms: int | None
    entries: list[ApiBrokerEntry]


class Meta(BaseModel):
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    prev_close: int
    upper_limit: int
    lower_limit: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    pages_collected: int
    total_unique_events: int
    parser_version: str
```

- [ ] **Step 5: Run full test suite**

Run: `python -m pytest -q`
Expected: 88 − 4 (deleted test_parser_writer) = 84 passed.

If tests fail:
- Check imports in `hoga/api/app.py` (should be unaffected).
- Check the existing `test_api.py` for any references to entity models by their old import path (e.g., `from hoga.api.models import Trade`). Such imports should become `from hoga.tables.trades import ApiTrade`.

- [ ] **Step 6: Ruff clean**

Run: `python -m ruff check hoga/ tests/ && python -m ruff format --check hoga/ tests/`
Apply format if needed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(api): delegate per-table queries to tables/*; shrink api/queries + api/models"
```

---

## Task 8: Self-review + final sweep + smoke-test against real data

**Goal:** Verify the refactor preserves all observable behavior. Run the full test suite, check that the captured 003490 + 005930 data still parses to identical Parquet shapes, and exercise the API end-to-end.

**Files:** none modified (verification only)

- [ ] **Step 1: Full test suite green**

Run: `python -m pytest -v`
Expected: ~84 passed (final count). No failures or errors.

- [ ] **Step 2: Ruff complete clean**

Run: `python -m ruff check hoga/ tests/`
Run: `python -m ruff format --check hoga/ tests/`
Expected: both pass.

- [ ] **Step 3: Re-parse 003490 (already captured to data/raw/) and check output shape unchanged**

The captured raw data from Phase 1 validation is at `data/raw/20260519/003490/`. Reparse it and compare schemas:

```bash
# Save the old Parquet column lists.
python -c "
import duckdb
for tbl in ('trades', 'snapshots', 'brokers', 'candles'):
    cols = duckdb.sql(f\"SELECT * FROM read_parquet('data/parquet/20260519/003490/{tbl}.parquet') LIMIT 0\").columns
    print(f'{tbl}: {cols}')
" > /tmp/cols-before.txt 2>&1
cat /tmp/cols-before.txt
```

Then re-parse and compare:

```bash
rm -rf data/parquet/20260519/003490
python -m hoga parse --code 003490 --date 20260519 --report
python -c "
import duckdb
for tbl in ('trades', 'snapshots', 'brokers', 'candles'):
    cols = duckdb.sql(f\"SELECT * FROM read_parquet('data/parquet/20260519/003490/{tbl}.parquet') LIMIT 0\").columns
    print(f'{tbl}: {cols}')
" > /tmp/cols-after.txt 2>&1
diff /tmp/cols-before.txt /tmp/cols-after.txt
```

Expected: `diff` produces no output (schemas identical).

- [ ] **Step 4: Row count + key value parity**

```bash
python -c "
import duckdb
con = duckdb.connect()
for tbl in ('trades', 'snapshots', 'brokers', 'candles'):
    n = con.execute(f\"SELECT count(*) FROM read_parquet('data/parquet/20260519/003490/{tbl}.parquet')\").fetchone()[0]
    print(f'{tbl}: {n} rows')
print('day_vol:', con.execute(\"SELECT max(cum_vol) FROM read_parquet('data/parquet/20260519/003490/trades.parquet')\").fetchone()[0])
"
```

Expected: trades ≈ 16,363; day_vol = 1,956,286 (same as Phase 1 validation).

- [ ] **Step 5: Restart server and capture post-refactor responses**

```bash
python -m hoga serve --port 8000 &
SERVER_PID=$!
sleep 2

mkdir -p /tmp/api-after
curl -sS "http://127.0.0.1:8000/api/stock-dates" > /tmp/api-after/stock-dates.json
curl -sS "http://127.0.0.1:8000/api/meta?code=003490&date=20260519" > /tmp/api-after/meta-003490.json
curl -sS "http://127.0.0.1:8000/api/orderbook?code=003490&date=20260519&t=120000000" > /tmp/api-after/orderbook-003490-12h.json
curl -sS "http://127.0.0.1:8000/api/orderbook?code=003490&date=20260519&t=80000000" > /tmp/api-after/orderbook-003490-before-data.json
curl -sS "http://127.0.0.1:8000/api/trades?code=003490&date=20260519&t=120000000&limit=20" > /tmp/api-after/trades-003490-t.json
curl -sS "http://127.0.0.1:8000/api/trades?code=003490&date=20260519&from=143000000&to=143010000&limit=100" > /tmp/api-after/trades-003490-range.json
curl -sS "http://127.0.0.1:8000/api/candles?code=003490&date=20260519" > /tmp/api-after/candles-003490.json
curl -sS "http://127.0.0.1:8000/api/brokers?code=003490&date=20260519&t=140000000" > /tmp/api-after/brokers-003490-14h.json
curl -sS "http://127.0.0.1:8000/api/brokers?code=003490&date=20260519&t=80000000" > /tmp/api-after/brokers-003490-before.json

kill $SERVER_PID
```

- [ ] **Step 5b: Byte-parity diff against Task 0 baselines**

The refactor's load-bearing invariant is "no observable behavior change." Diff every captured endpoint:

```bash
for name in stock-dates meta-003490 orderbook-003490-12h orderbook-003490-before-data \
            trades-003490-t trades-003490-range candles-003490 \
            brokers-003490-14h brokers-003490-before; do
    if diff -q "/tmp/api-baseline/$name.json" "/tmp/api-after/$name.json" > /dev/null 2>&1; then
        echo "$name: IDENTICAL"
    else
        echo "$name: DIFFERS"
        diff "/tmp/api-baseline/$name.json" "/tmp/api-after/$name.json" | head -20
    fi
done
```

Expected: **all 9 lines report IDENTICAL.**

If any DIFFERS, investigate before declaring the refactor done. The most likely culprits:
- Pydantic field order in a model differs from the dict-key order DuckDB returned (e.g. `seq` before `ts_ms` instead of after) — fix by reordering the model fields to match the prior layout.
- A float field renders differently (`0.59` vs `0.5900000000000001`) — usually means the pydantic model field type changed; verify it's still `float` and not `Decimal`.
- A field is missing entirely — check the `_row_to_api` helper (or the inline construction in `query_at`) maps every column the prior `to_api` produced.

If `/tmp/api-baseline/` is missing (e.g., you started Task 8 on a fresh machine), re-run Task 0 against the **current** HEAD's parent (`git stash && git checkout HEAD~1` etc.) to regenerate baselines. Don't skip this step — silent JSON shape drift is the failure mode this refactor must prove it doesn't have.

- [ ] **Step 6: Inspect final file structure**

```bash
ls hoga/ hoga/parser/ hoga/tables/ hoga/api/
```

Expected:
- `hoga/parser/` contains only `__init__.py` (StockInfo + parse_info_row inlined; orchestrator is the rest)
- `hoga/tables/` contains `__init__.py`, `dispatch.py`, `trades.py`, `snapshots.py`, `brokers.py`, `candles.py`
- `hoga/api/` contains `__init__.py`, `app.py`, `queries.py`, `routes.py`, `models.py`
- `events.py`, `tsv.py`, `writer.py` are all gone from `hoga/parser/`

- [ ] **Step 7: Final commit recording the verification**

```bash
git add -A  # no changes expected
git commit --allow-empty -m "verify(refactor): table-as-module preserves Parquet schemas + API contract"
```

- [ ] **Step 8: Look at the deepening with fresh eyes**

Read the ADR (`docs/adr/0001-table-as-module.md`) and check:

1. Does each table module's interface match what the ADR claims? (dataclass + parsers + schema + writer + queries + API model + mapping)
2. Is the schema now a first-class artifact (`PARQUET_SCHEMA`) visible in the interface, not buried in the implementation?
3. Does adding a new table require only one new file + one line in `dispatch.py::_TABLES`?
4. Are the entity models gone from `api/models.py` (which now holds only response containers)?

If any of the above is "no," the refactor is incomplete and needs follow-up work. Document any deviations in a follow-up commit.

---

## Plan complete

The refactor is structural only — no observable behavior change. The deepening converts an implicit, schema-by-convention seam into an explicit, schema-as-interface seam at each table module's boundary. Future work to add a new analyzer table (Phase 2 CVD) becomes: write one file in `hoga/tables/`, add one line to `dispatch.py::_TABLES`, done.
