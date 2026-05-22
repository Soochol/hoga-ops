# 0015 — Symbol Master is disk-persisted; pykrx is the refresh-only entry point

**Status:** proposed (2026-05-22) — pending implementation of `docs/superpowers/specs/2026-05-22-symbol-master-disk-cache-design.md`
**Related:**
- `docs/superpowers/specs/2026-05-22-symbol-master-disk-cache-design.md` — the spec this ADR documents the structural decisions of.
- `docs/superpowers/specs/2026-05-22-krx-env-symbol-design.md` — direct predecessor (env loader + recovery UX). This ADR removes that spec's pykrx-on-boot assumption.
- ADR-0006 (`captures-as-single-module`) — referenced in §3 for the decision to keep disk I/O inside `hoga/api/symbols.py` rather than extracting a `symbol_store.py`.
- ADR-0009 (`upstream-code-separate-enum`) — `UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED` joins that enum here.

## Decision

The **Symbol Master** (`(Code, name, market)` catalog) is persisted to a JSON file at `~/.local/share/hoga-ops/symbol-master.json` (XDG default; `$XDG_DATA_HOME/hoga-ops/symbol-master.json` when set). The disk file is the source of truth for boot; pykrx is contacted only on explicit user request.

The structural decisions this ADR records:

1. **JSON format with `schema_version: 1`**, not parquet or DuckDB. The catalog belongs to the *metadata* category (alongside `meta.json` and `_progress.json`), not the *time-series capture* category that uses parquet. The hot path (substring search) operates on the in-memory list; disk format affects only the once-per-boot read.

2. **Boot reads disk; boot never touches pykrx.** `hoga/api/symbols.py::load_disk_state` is called from FastAPI lifespan. The previous `ensure_cache_warm` fire-and-forget pattern is removed. If the disk file is absent or corrupt, the server starts in `SymbolCacheState.unavailable(reason=SYMBOL_MASTER_NOT_INITIALIZED)`.

3. **`GET /api/symbols/*` endpoints never trigger fetches.** They return whatever is in `_cache`. The previous "lazy GET-time fetch" behavior in `get_all()` is removed.

4. **`POST /api/symbols/refresh` is the only pykrx entry point.** Two UI surfaces feed it: the new Settings page "Symbol Master" section's [Update Now] button, and the existing SymbolSearch Refresh button (visible on `unavailable`/`stale`).

5. **TTL removed.** `_CACHE_TTL_MS`, `_is_fresh()`, and 24h auto-refetch are deleted. The disk file's age is informational only — surfaced as "Last fetched: N days ago" in Settings and as an empty-result staleness nudge in SymbolSearch when ≥ 7 days old.

6. **All-or-nothing partial fetch.** If pykrx succeeds for KOSPI but fails for KOSDAQ (or vice versa), the disk file is not written and the previous (good) state is preserved. Half-catalog persistence is rejected because it would produce silent gaps — the anti-pattern this whole feature exists to eliminate.

7. **`captured_breakdown` is refreshed only at boot and successful refresh.** No SSE-driven update, no per-event hook into `captures.py`/`sse.py`. The dropdown badge can therefore lag the live capture state; authoritative live state remains on the Inventory and CaptureQueue pages (both of which invalidate on `capture_finished` via `STOCK_DATES_QUERY_KEY`).

## Context

The predecessor spec (`2026-05-22-krx-env-symbol-design.md`) added `.env` discovery and reason-aware recovery UX but kept pykrx as a boot dependency: `ensure_cache_warm` ran at startup, and `get_all()` lazily fetched when the cache was empty or stale. T15 happy-path validation surfaced a pykrx 1.2.8 column drift (`get_market_cap` no longer returns `종목명`), but the deeper structural issue is that *any* pykrx fragility (login rejection, KRX rate-limit, schema change, transient network failure) cascades into broken first-time UX for every user, every boot.

KRX listings change slowly (new listings/delistings ~1–2 per week). A fetched catalog stays useful for days to weeks. There is no reason to re-fetch on every server start, and no reason to make the user wait for KRX during their first interaction.

The mismatch — frequent fetches against a slowly-changing source — created brittle boot semantics. Persisting the catalog to disk and treating pykrx as a "refresh on demand" dependency aligns boot stability with how the underlying data actually behaves.

## Alternatives considered

### A. Keep pykrx on boot, fix only the 1.2.8 column drift

The minimal patch — change `df.loc[code, "종목명"]` to whatever pykrx 1.2.8 exposes. Smallest diff.

Rejected because it addresses the symptom, not the structural issue. The next pykrx schema drift, KRX login outage, or rate-limit episode would re-create the same broken UX. The recovery flow built in the predecessor spec (`reason='krx_fetch_failed'`, Refresh button, hint copy) papers over the wound; disk persistence is the cure.

### B. Auto-fetch in background on a schedule (e.g., 24h cron)

Keep pykrx as a *background* dependency rather than a *boot/GET-time* one. The disk file would still exist, but a scheduled task would refresh it without user action.

Rejected because:

- The user has no signal that the catalog is fetching, and no way to cancel it.
- KRX rate-limits become a server-side problem instead of a user-visible one (silent failures).
- The 24h cadence is arbitrary against KRX's actual change rate (~1–2 listings/week).
- "Explicit user trigger" is the simpler mental model: the catalog is fresh when *you* refreshed it, not when some daemon last succeeded.

A future spec can add scheduled refresh if a concrete need emerges (e.g., a long-running headless deployment). The hook surface is already there: `POST /api/symbols/refresh` is callable.

### C. Persist to parquet, query via DuckDB

The project uses parquet + DuckDB extensively for time-series capture data (`hoga/api/queries.py`, `hoga/tables/*.py`). Storing the catalog the same way would be uniform.

Rejected because the Symbol Master does not match the parquet+DuckDB regime:

- It's a flat catalog, not a time series.
- Lookup is in-memory substring scan, never SQL JOIN.
- The hot path operates on the in-memory list; disk format is irrelevant to search latency.
- The project's metadata category (`meta.json`, `_progress.json`) is JSON. Symbol Master belongs there, not in the time-series storage layer.
- A persistent DuckDB DB file does not exist anywhere in the project today (all DuckDB use is `:memory:` over external parquet). Introducing one for 6000 flat rows would set a precedent without payoff.

If a future use case requires JOINing the Symbol Master against capture inventory (e.g., "top-N codes with zero captures this month"), the `schema_version: 1` field is the migration entry point — a follow-up ADR can introduce a parquet sibling.

### D. Extract a `hoga/api/symbol_store.py` module for disk I/O

Considered during spec drafting. Rejected by ADR-0006's "introduce a seam only when something actually varies across it" principle: the I/O does not vary across consumers, monkeypatch on `_fetch_from_pykrx` covers the test-isolation use case, and a second module disperses one cohesive concept across two files. The disk helpers live inside `hoga/api/symbols.py` as private functions.

### E. Distinguish "file corrupt" from "file missing" with separate `UpstreamCode` values

The disk file may be absent (first use) or present-but-malformed (rare — atomic write should prevent it, but external tampering or a botched manual migration could produce it). Both currently surface as `SYMBOL_MASTER_NOT_INITIALIZED`.

Rejected at the wire level: user remediation is identical (click Update). Adding a `SYMBOL_MASTER_CORRUPT` value would expand the `UpstreamCode` enum and the four `upstream-hints.ts` maps without changing user behavior. Corruption is diagnosed via server logs (a warning is logged when `_load_from_disk` returns `None` due to parse failure), which is where developer-facing diagnosis belongs.

### F. Cancellable refresh

A pykrx fetch can take 30–120 seconds. The user may want to abandon a slow refresh.

Out of scope. The `_inflight` Future collapses concurrent clicks to one fetch, but does not expose cancellation. If a refresh is genuinely stuck, the user restarts the server (which restores from the previous disk file). Adding cancellation would require plumbing a cancel token through `_fetch_from_pykrx`'s thread executor; the cost outweighs the benefit for an action triggered ~once per week at most.

## Consequences worth flagging for future readers

- **Pykrx fragility no longer breaks boot.** A user can start the server, see the empty-state UI, and continue working with manual 6-digit Code entry (`promoteUnverifiedCode`) even if KRX is down. The cost of getting the autocomplete feature is one explicit click — and that click is the only moment when pykrx fragility matters.

- **Disk file is the source of truth.** If the disk file is wrong (manually edited, partially restored from backup, corrupted), the server will trust it until the user clicks Refresh. There is no checksum or validation beyond schema_version. This is acceptable for a single-user local tool where the user owns their `~/.local/share/hoga-ops/`.

- **The disk file outlives the worktree.** Path is at `~/.local/share/hoga-ops/`, not in `data/`. A `git clean -fdx` or worktree deletion does not remove it. Test fixtures must monkeypatch `resolve_symbol_master_path` to avoid trampling the user's real catalog.

- **`captured_breakdown` drift is intentional.** A reader who sees stale `captured_count` in SymbolSearch after capturing a new Stock-Date should not "fix" this by adding an SSE hook into symbols.py. The trade-off (acceptable lag vs. cross-module coupling) is documented in the spec §7.8; a follow-up spec is the right way to revisit, not an inline patch.

- **The 7-day staleness threshold is a frontend constant.** Wire contract does not encode it; backend always reports `status='fresh'` when the disk file is valid. If a future spec needs server-side stale signalling, that's a wire-shape change with its own ADR.

- **`reason='krx_fetch_failed'` carries multiple meanings.** Pykrx exception, disk write permission failure, all-or-nothing partial fetch rejection — all collapsed under one `UpstreamCode`. The hint copy and remediation ("verify creds, try Refresh") are the same, so the collapse is acceptable; server logs preserve the precise exception class for developer-facing diagnosis.

- **Schema evolution is one ADR away.** `schema_version: 1` is the only version supported. `_load_from_disk` rejects v0 and v2 alike. A future ADR introducing v2 will add a dispatch table in `_load_from_disk` — the entry point is in place, but no implementation lives here today.

## When to revisit

- Pykrx changes its API in a way that makes the in-spec fetch implementation non-viable, *and* the fix requires architectural changes beyond `_fetch_from_pykrx`'s body.
- A real user complaint about `captured_count` lag emerges that cannot be solved by training users to click Refresh.
- A multi-instance or shared deployment scenario appears that requires per-instance catalog paths (the dropped `HOGA_SYMBOL_MASTER_PATH` env-var becomes a real prod need, not a hypothetical seam).
- The user-facing remediation for "missing file" and "corrupt file" diverges (e.g., a future "restore from backup" workflow), justifying a `SYMBOL_MASTER_CORRUPT` reason after all.
- A second persistence target appears (e.g., a second KRX-derived catalog like sector/industry tags) that would benefit from a shared atomic-write helper — at that point, extract the helper into a util module via a new ADR.
