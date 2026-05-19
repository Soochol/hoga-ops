# hoga-ops Design Doc

**Date:** 2026-05-19
**Status:** Draft (pending user review)
**Companion docs:** [CONTEXT.md](../../../CONTEXT.md), [schema-notes.md](./schema-notes.md)

> Terms used here are defined in `CONTEXT.md`. Notably: **Stock-Date**, **Page**, **Full Capture**, **Data Window**, **Regular Session**, **Page Step**, **Auction Cross**, **TSV Section**, **Global Sequence**.

## Goal

Build a personal, local-first tool that captures Korean stock orderbook + trade replay data from `hogaplay.com`, stores it in an analyzable format, and exposes it through a TradingView-style web UI with custom orderbook analysis features.

## Non-goals

- Multi-user / hosted service. This is a single-user local tool.
- Real-time live data feed from an exchange. We're replaying recorded sessions captured via hogaplay.
- Distributing hogaplay data publicly. Captured data stays local.

## Phasing

**Phase 1 (this spec, this plan) — Backend**

1. CLI (`hoga collect|parse|serve|ls`) to drive the whole backend for one Stock-Date at a time.
2. Collector: Page Step pagination loop with cap detection + progress file; mirrors hogaplay player's call pattern.
3. Parser: TSV → typed Parquet (snapshots, trades, brokers, candles) + `meta.json`. Dedup by `global_seq`.
4. FastAPI: time-indexed orderbook state, trade tape, candles, brokers, Stock-Date / meta listing.
5. Manual validation: hit each endpoint with curl, spot-check against hogaplay's web player.

**Phase 2 (separate spec + plan, later) — Frontend**

The frontend (TradingView-style chart, 10-level orderbook ladder, trade tape, scrubber, playback, CVD overlay) will be brainstormed separately once Phase 1 is shipped and data shape is concrete. Sketches in this doc's "Web component sketch" section are aspirational, not committed.

## Out of scope for both phases (v2+ wishlist)

- Multi-Stock-Date loading (more than one day at once).
- Live tail mode (continuously polling open market).
- Advanced analysis indicators (broker concentration, hoga wall detection, anomaly highlights).
- Bookmarks / annotated replays.
- Desktop packaging (Tauri).

---

## Architecture (Phase 1)

```
┌────────────────────────────────────────────────────────────────────┐
│                        hoga-ops (Phase 1)                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  CLI:  python -m hoga collect --code 003490 --date 20260519        │
│           │                                                        │
│           ▼                                                        │
│  ┌──────────────────┐                                              │
│  │  collector       │  Page Step loop on first.php + chart.php×1   │
│  │  (httpx)         │  → data/raw/{date}/{code}/                   │
│  └────────┬─────────┘     info.tsv, first_NNN.tsv, chart.tsv,      │
│           │               _progress.json                           │
│           ▼                                                        │
│  ┌──────────────────┐                                              │
│  │  parser          │  TSV → dedup by global_seq → Parquet         │
│  │  (pandas/pyarrow)│  → data/parquet/{date}/{code}/               │
│  │                  │     snapshots.parquet                        │
│  │                  │     trades.parquet                           │
│  │                  │     brokers.parquet                          │
│  │                  │     candles.parquet                          │
│  │                  │     meta.json                                │
│  └────────┬─────────┘                                              │
│           ▼                                                        │
│  ┌──────────────────┐    ┌─────────────────────────────────────┐   │
│  │  duckdb          │◄───┤  FastAPI backend (sync, single proc)│   │
│  │  shared          │    │  /api/stock-dates                   │   │
│  │  read-only       │    │  /api/meta?code&date                │   │
│  │  connection      │    │  /api/orderbook?code&date&t         │   │
│  └──────────────────┘    │  /api/trades?code&date&t&limit      │   │
│                          │  /api/candles?code&date             │   │
│                          │  /api/brokers?code&date&t           │   │
│                          └─────────────────────────────────────┘   │
│                                         │                          │
│                                         ▼                          │
│                     (frontend deferred to Phase 2 spec)            │
└────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. `collector` — Python module

- **Responsibility**: idempotently capture the Full Capture for a Stock-Date.
- **Inputs**: `code`, `date` (YYYYMMDD), cookie loaded from `.cookie` or env.
- **Behavior**:
  1. Call `info.php` once → save `info.tsv`.
  2. Page Step loop: start at `time = 84000000` (08:40:00) to capture the pre-market `(1,3)` event and initial orderbook. Call `first.php?time=t` and save the response as `first_NNN.tsv`. Advance `t` by **Page Step** (default 60000ms). Mirrors hogaplay player behavior.
  3. **Cap detection**: after each Page, check `max(event_time) >= t + step`. If not, the response cap was hit before reaching the requested window → halve the step (60s → 30s → 15s → 5s → 1s, floor) and retry the gap. Restore step on success.
  4. **Termination**: stop when `t >= 160000000` (16:00:00) AND the last 3 Pages contain zero new events (after dedup against accumulated `global_seq` set).
  5. After loop ends, call `chart.php?time=153100000&bong=1&gap=60000` **exactly once** → save `chart.tsv`. (chart.php is cumulative; no per-step calls needed.)
- **Rate limiting**: 200ms between successful calls. 1s on retries. 3-attempt exponential backoff on 5xx/network.
- **Failure modes**:
  - HTTP 401/403 → cookie expired. Print refresh instructions, abort. `_progress.json` left in place for resume.
  - 4xx other → abort with the response body.
  - Same-day capture started before market close: stderr warning unless `--allow-partial` is passed. (Detect via `date == today_KST and now_KST < 16:00`.)
- **Progress file**: `data/raw/{date}/{code}/_progress.json` after every Page: `{"last_time_ms": int, "pages_done": int, "global_seqs_seen": int, "started_at": iso, "finished_at": iso | null}`. Resume reads this and continues from `last_time_ms`.
- **Output**: `data/raw/{date}/{code}/info.tsv`, `first_001.tsv` … `first_NNN.tsv`, `chart.tsv`, `_progress.json`.

### 2. `parser` — Python module

- **Responsibility**: TSV → typed Parquet for one Stock-Date.
- **Reads**: `data/raw/{date}/{code}/info.tsv` + all `first_*.tsv` + `chart.tsv`.
- **Dedup**: concatenate all `first_*.tsv` rows, then dedup by `global_seq` (each Stock-Date's seq is unique-and-stable per CONTEXT.md). TSV Section marker is **dropped** during parsing.
- **Event dispatch**: each row routed by **event type** (field 2) — TSV Section (field 1) is ignored. Type `3` rows (the single `(1, 3)` pre-market row) are merged into the trades table as `side = 0`.
  - type `1` → trades
  - type `2` → orderbook snapshots
  - type `3` → trades (with `side = 0`)
  - type `4` → brokers
- **Writes** to `data/parquet/{date}/{code}/`:
  - `snapshots.parquet` — flat columns: `ts_ms, seq, ask_p1..p10, ask_q1..q10, ask_d1..d10, bid_p1..p10, bid_q1..q10, bid_d1..d10, tot_ask, tot_ask_d, tot_bid, tot_bid_d`. Sorted ascending by `ts_ms`.
  - `trades.parquet` — `ts_ms, seq, price, change_pct, qty, side, cum_vol, cum_trades, low_so_far, high_so_far, net_pressure`. `side` ∈ `{+1, -1, 0}` where `0` = **Auction Cross** (sign-less qty in source). Sorted ascending by `ts_ms`.
  - `brokers.parquet` — long format: `ts_ms, seq, side, rank, broker, qty_today, qty_delta` (one row per broker per snapshot; `side` ∈ {`buy`, `sell`}, `rank` ∈ 1..5).
  - `candles.parquet` — `ts_ms, open, close, high, low, vol_a, vol_b`. Sorted ascending. (Note: `chart.tsv` is descending by time; parser reverses.)
  - `meta.json` — typed `{code, name, regular_session_open_ms, regular_session_close_ms, prev_close, upper_limit, lower_limit, today_open, today_high, today_low, today_close, high_52w?, low_52w?, raw_info_tsv, pages_collected, total_unique_events, parser_version}`.
- **Validation**: `cum_volume` monotonic non-decreasing across trade rows in time order; `global_seq` strictly increasing in time order; field counts match expected per event type (strict — fail-fast); ask/bid price arrays strictly ordered (ask increasing, bid decreasing); known event types only (warn on `(1,3)` etc. but accept; fail on truly unknown).
- **Flags**: `--lenient` switches strict validation to warnings (for one-off forensics). Default is strict.
- **Output of `parse --report`**: counts per event type, % auction-cross trades, validation summary.

### 3. `api` — FastAPI backend

Single process, reads Parquet via a **single shared read-only DuckDB connection**. Queries use `read_parquet(...)` directly against `data/parquet/` — no import step.

**Endpoints:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stock-dates` | List of `{date, code, name, regular_session_open_ms, regular_session_close_ms, data_window_first_ms, data_window_last_ms}` present in `data/parquet/`. |
| GET | `/api/meta?code&date` | Full stock metadata (parses `meta.json`). |
| GET | `/api/orderbook?code&date&t` | Orderbook state at time `t` (ms-of-day). Returns latest snapshot with `ts_ms <= t`. If `t` precedes the first snapshot, returns `{available_from: <first_ts>, snapshot: null}` (HTTP 200, not 404). |
| GET | `/api/trades?code&date&t&limit=50` | Last `limit` trades up to and including time `t` (descending by `ts_ms`). For range queries pass `from` & `to` instead. |
| GET | `/api/candles?code&date` | All 1-minute candles for the day, ascending. |
| GET | `/api/brokers?code&date&t` | Top-5 buy/sell brokers at time `t`. |

**Response shape**: pydantic v2 models; integers preserved as integers (not converted to strings). All times are `ms-of-day` int64 unless explicitly documented as epoch ms.

**Errors**: 400 for malformed params; 404 only when the `(code, date)` Stock-Date is not present at all; 200 with explicit empty/null payload for "before data exists".

CORS open to `http://localhost:5173` only (dev). (CVD endpoint moves to Phase 2 with the analyzer module.)

### 4. `web` — DEFERRED to Phase 2

Frontend stack, components, layout, interactions, and analysis overlays are all out of scope for this spec. A separate brainstorming + spec + plan cycle will handle them once Phase 1 backend is shipped and the data is queryable. Sketch below is aspirational only — do not implement.

#### Web component sketch (aspirational, Phase 2 will revise)

- Single replay view: chart on top, orderbook ladder on the right, trade tape on the right-bottom, scrubber + playback at the bottom.
- TradingView-style candle/volume via lightweight-charts.
- Orderbook ladder via Canvas (21 rows: 10 ask + spread + 10 bid).
- Trade tape colored by aggressor side.
- Scrubber spans the Data Window with markers at Regular Session boundaries.
- CVD overlay on the chart.

### 5. `analyzer` — DEFERRED to Phase 2

Analysis features (CVD, broker concentration, hoga walls, etc.) are tied to UI overlays. Phase 1 stops at exposing raw + lightly-derived data via the API; the analyzer module ships with Phase 2.

---

## Data model

### Orderbook snapshot (Parquet flat schema)

```
ts_ms          int64    # event_time in ms-of-day
seq            int32    # global_seq
ask_p1..p10    int32    # won
ask_q1..q10    int32    # shares
ask_d1..d10    int32    # signed
bid_p1..p10    int32
bid_q1..q10    int32
bid_d1..d10    int32
tot_ask        int32
tot_ask_d      int32
tot_bid        int32
tot_bid_d      int32
```

### Trade

```
ts_ms          int64
seq            int32
price          int32
change_pct     float32
qty            int32     # absolute
side           int8      # +1/-1/0
cum_vol        int64
cum_trades     int32
low_so_far     int32
high_so_far    int32
net_pressure   int64
```

### Replay query (the critical one)

Given `t_ms`, get current orderbook in <5ms:

```sql
SELECT *
FROM snapshots
WHERE code = ? AND date = ? AND ts_ms <= ?
ORDER BY ts_ms DESC
LIMIT 1
```

With Parquet + DuckDB and an index/sort on `ts_ms`, this is microseconds.

---

## Replay engine semantics

The orderbook at time `t` is simply the latest snapshot row with `ts_ms <= t`. We do **not** reconstruct from deltas at query time — every snapshot is a full 10-level state. (Deltas are stored for visualization animation, not for state reconstruction.)

Trade tape at time `t` = last `limit` trades with `ts_ms <= t`, descending by `ts_ms`. Default `limit=50`. Frontend may issue range queries (`from/to`) instead when scrolling.

**Auction Cross trades** (side=0) are returned in the tape unmodified — Phase 2 frontend decides whether to render them differently. Analyzer (Phase 2) excludes them from aggressor-based metrics like CVD.

When the scrubber jumps backward, the UI re-fetches both orderbook and tape.

---

## Failure modes

- **Cookie expired** (401/403): collector aborts with refresh instructions; `_progress.json` preserved for resume.
- **Network drop mid-collection**: 3-attempt exponential backoff per call; on persistent failure, abort with `_progress.json` intact. `hoga collect --resume` picks up where it left off.
- **Same-day partial capture**: collector refuses to run unless `--allow-partial` is passed. Avoids accidentally producing a "complete" record of an incomplete day.
- **TSV row has unexpected field count**: parser fails by default (strict). `--lenient` downgrades to warning + skip. All skipped rows logged with line numbers.
- **`global_seq` gap detected after dedup**: parser warning with the gap range (`seq 1234..1240 missing`). Does not abort — parser writes what it has and lists gaps in `meta.json.warnings`.
- **Auction Cross with non-zero side** (shouldn't happen): treat as ordinary trade; record one-time warning. Hogaplay format change probe.

---

## Testing (Phase 1)

- Collector: small fixture server (or mocked httpx) → assert pagination loop terminates and writes expected raw TSV chunks.
- Parser: golden TSV samples in `tests/fixtures/` → assert exact Parquet output (schema + row counts + monotonic invariants).
- API: `pytest` + FastAPI TestClient against sample Parquet → check time-slice queries return correct snapshot/trades/candles for known timestamps.

---

## Open questions to resolve during implementation

1. Empirical cap of `first.php` response (event count or byte size?) — Page Step cap-detection observes it in practice; record the threshold in `meta.json`.
2. Unknown fields in `info.tsv` (positions 11, 16, 17, 21, 22) — store as `unknown_N`, decode later.
3. Trade schema fields 14, 16–18 — store as `unknown_N`, decode later.
4. Broker totals (43-field row's last 7 fields).
5. Whether after-hours single-price (~16:00–18:00) appears in `first.php` for some stocks. Probe by collecting a past date and checking events beyond 15:30.
6. Does `chart.php` support `bong != 1` or `gap != 60000`? Phase 1 uses only the defaults.

See `schema-notes.md` for the full field-level audit.

---

## Repo layout

```
hoga-ops/
├── CONTEXT.md
├── README.md
├── pyproject.toml
├── .cookie                          # gitignored: "k_=...; n_=..."
├── .gitignore
├── hoga/
│   ├── __init__.py
│   ├── __main__.py                  # `python -m hoga` → cli.app
│   ├── cli.py                       # typer subcommands
│   ├── config.py                    # paths, env loading
│   ├── collector/
│   │   ├── __init__.py
│   │   ├── client.py                # httpx wrapper + cookie + retries
│   │   └── orchestrator.py          # Page Step loop, cap detection, progress
│   ├── parser/
│   │   ├── __init__.py
│   │   ├── tsv.py                   # row tokenizer + event dispatcher
│   │   ├── events.py                # dataclasses per event type
│   │   └── writer.py                # parquet writer per table
│   ├── api/
│   │   ├── __init__.py
│   │   ├── app.py                   # FastAPI factory
│   │   ├── routes.py
│   │   ├── queries.py               # duckdb sql helpers
│   │   └── models.py                # pydantic response schemas
│   └── replay.py                    # shared time-slice helpers (used by api)
├── explorer/                        # ad-hoc probes (kept; e.g. fetch.py)
├── data/                            # gitignored
│   ├── raw/{date}/{code}/
│   └── parquet/{date}/{code}/
├── docs/
│   ├── adr/                         # lazily created
│   └── superpowers/specs/
│       ├── schema-notes.md
│       └── 2026-05-19-hoga-ops-design.md
└── tests/
    ├── fixtures/
    │   └── tiny_tsv/                # 40–50 row golden samples
    ├── test_parser.py
    └── test_api.py
```

## CLI surface

```
hoga collect --code CODE --date YYYYMMDD [--allow-partial] [--resume]
hoga parse   --code CODE --date YYYYMMDD [--lenient] [--report]
hoga serve   [--port 8000] [--data-dir data/]
hoga ls                                                      # show collected/parsed status grid
```

`python -m hoga <subcommand>` is the canonical entry point. Typer powers it.

## Dependencies (Phase 1)

**Runtime**: `httpx`, `pandas`, `pyarrow`, `duckdb`, `fastapi`, `uvicorn[standard]`, `pydantic` (v2), `typer`, `python-dotenv`, `rich`.
**Dev**: `pytest`, `ruff` (lint + format), `mypy` (optional, not strict).
**Python**: 3.11+ (target 3.13). Single-process, sync I/O for Phase 1 — no async complexity unless profiling shows a need.
**OS**: Windows + WSL + Linux. Paths via `pathlib.Path` only.

---

## Implementation order — Phase 1 only

1. **Project scaffold** — `pyproject.toml`, `ruff` config, `hoga/` package skeleton, typer entry point with empty subcommands.
2. **`hoga/collector/client.py`** — httpx wrapper: cookie loading, retries, headers, error mapping.
3. **`hoga/collector/orchestrator.py`** — Page Step loop, cap detection, progress file, partial-capture guard. Replaces `explorer/fetch.py` once stable.
4. **`hoga/parser/`** — TSV tokenizer, event dispatcher, parquet writers for all 4 tables + meta.json. Strict validation. Golden-fixture tests.
5. **`hoga/api/`** — FastAPI app with `/symbols`, `/meta`, `/orderbook`, `/trades`, `/candles`, `/brokers`. DuckDB shared connection. Pydantic models. TestClient tests.
6. **`hoga ls`** — status grid: rows = Stock-Dates, columns = `raw / parsed / total_events`.
7. **End-to-end validation** — collect one full day for 2–3 stocks, parse, run server, hit each endpoint with curl + spot-check values against hogaplay's web player.

Phase 2 (frontend) will be planned separately.
