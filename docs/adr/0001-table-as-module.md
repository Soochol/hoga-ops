# 0001 — Tables are modules, not layers

**Status:** accepted (2026-05-20)

## Decision

Each Parquet table in hoga-ops (`trades`, `snapshots`, `brokers`, `candles`) is a single Python module under `hoga/tables/` that owns **everything** about that table: the internal dataclass, the TSV row parser(s), the pyarrow schema, the Parquet writer, the DuckDB query helpers, the pydantic API entity model, and the row→API mapping. The parser orchestrator (`hoga/parser/__init__.py`) and the API routes (`hoga/api/routes.py`) coordinate across tables but delegate all table-specific knowledge to the table module.

## Why

Before this design, the same Parquet schema lived implicitly in four places: the dataclass attribute list, the writer's `pa.array(...)` enumeration, the DuckDB SELECT column list, and the route handler's row→model assembly (`row[f"ask_p{i}"]`). The schema was the **interface** between producer and consumer, but it wasn't expressed anywhere a caller could read — adding a column required edits in four files with no compiler help. The seam (Parquet files) was correct; the interface that lived at the seam was implicit.

Co-locating all knowledge of one table in one module makes the schema the interface — explicit, single-source. It gives **locality** (one file to read when reasoning about "the Trades table") and **leverage** (adding a Phase 2 analyzer table = one new module, no shotgun edits).

## Considered alternatives

- **Layered: keep `parser/writer.py` + `api/queries.py` + `api/models.py` separate, with a shared `schema.py`.** Rejected because the schema constants would be the only artifact a developer reads when adding a column, but the work to add a column is still spread across four files. The schema module fixes the *naming* duplication but not the *behavioral* duplication (each layer still needs its own logic touching the new field).

- **Inline parser writer into `parser/__init__.py` (delete `writer.py` only).** Rejected because it leaves the writer↔reader coupling unchanged — routes.py would still hard-code `row[f"ask_p{i}"]` and have no declared dependency on the writer.

- **Hide Parquet columns behind a single object-oriented `Table` base class with subclasses.** Rejected because the tables differ structurally (Trades has signed-qty parsing, Brokers fans 1 TSV row → 10 entities, Candles has no `EVENT_TYPES`). A shared base would either be empty or full of `if isinstance(self, Brokers)` branches.

## Consequences worth flagging for future readers

- **Module size grows.** Each table module is ~150 lines (dataclass + parsers + schema + writer + queries + API model + mapping). This is intentional — locality beats line-count minimization for this kind of work.

- **Cross-table behavior still lives elsewhere.** Validation that spans tables (`cum_vol` monotonic across trades, `global_seq` dedup across event types) stays in `parser/__init__.py`. List/index queries that span tables (`list_stock_dates`, which uses `meta.json` + snapshot time bounds) stay in `api/queries.py`. The table modules are not self-sufficient applications; they are the unit of *table-shaped concern*, not the unit of feature.

- **The dispatcher (`hoga/tables/dispatch.py`) builds its registry from each table's `PARSERS: dict[int, Callable]` at import time.** Adding a new event type means adding an entry to one table's `PARSERS`. Skip-list (`{5}` for Price Tick) lives in `dispatch.py` since it's truly cross-table.

- **Don't push this pattern further than tables.** `StockInfo` (info.tsv → meta.json) is not a table — there's one per Stock-Date, no row stream. Resist the temptation to invent `hoga/tables/info.py`; leave its parsing in `parser/__init__.py`.
