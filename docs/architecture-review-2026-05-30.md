# Architecture Review — hoga-ops (2026-05-30)

> Read-only architecture audit produced by a 4-phase multi-agent workflow
> (`codebase-architecture-review`). **64 agents · 4.18M tokens · ~42 min.**
> Pipeline: Map → Audit (8 region auditors + 3 cross-cut lenses) → adversarial
> Verify → Synthesize. **50 raw findings → 47 candidates → 21 confirmed / 26
> dropped.** Every finding was checked against the 54 ADRs; none re-litigates a
> settled decision. The deliverable is a *plan*; no code was changed.

Vocabulary: **domain** terms come from `CONTEXT.md`; **architecture** terms
(module, interface, depth, seam, locality, deletion test) come from the
*improve-codebase-architecture* skill. Rule held throughout: **size is not a
finding; shallowness is.**

---

## 1. Executive summary

hoga-ops is a healthy, deliberately-documented codebase — 54 ADRs with real
tradeoff records, genuinely **deep modules** (`KisClient`, the collector
orchestrator, the read-side bundle), and **real seams** (table-as-module,
single-websocket, queue-client scheduler). Friction is **concentrated, not
pervasive**, and it clusters in four places:

1. An **untyped live WebSocket payload** that erases a typed contract at the
   `LiveBuffer` boundary and forces four independent string-keyed readers — the
   single highest-leverage refactor.
2. A **false "TypeScript catches drift" claim** guarding the by-hand BE↔FE wire
   mirror (stated twice — in `models.py:189` and ADR-0004).
3. **Duplicated domain rules** smeared across regions (KST calendar-day,
   auction-window length, page-layout enumeration, capture-dismissed bookkeeping).
4. **Chart-overlay / drawing wiring** that is the real bug surface yet has no
   test locality.

The standout ship-today fix is a **one-line atomic-write correction** in
`candles.write_parquet` that closes a real torn-write window on the hot
read-path parquet. Two `CONTEXT.md` entries have drifted from correct code
(phase codomain, scheduler fire-time) and need doc-only sharpening.

---

## 2. Health assessment

### What is already good — and load-bearing

- **ADR discipline is real, not ceremonial.** 54 ADRs record decisions *with*
  their rejected alternatives and tradeoffs (ADR-0006 keeps `captures.py`
  single-module against a 3-file split; ADR-0004 accepts ~30% JSON bloat to
  avoid an adapter; ADR-0005 hops all `CaptureJobState` mutation to the event
  loop instead of locks). Every finding here was checked for ADR conflict and
  none re-litigate a settled decision — the catalog is doing its job of
  foreclosing churn.
- **Deep modules with narrow interfaces exist and are clean:**
  `live/kis_client.py` (auth / token-bucket / orderbook behind one `KisClient`),
  `collector/orchestrator.py::collect_stock_date` (page-step resume loop, one
  entry, helpers private), `api/bundle.py` (pure slice/downsample over
  `ApiCandle`). These pass the deletion test — complexity would reappear across
  callers.
- **Real seams, not hypothetical ones:** table-as-module (ADR-0001), the single
  `/api/ws` multiplex (ADR-0053), the scheduler-as-queue-client boundary
  (ADR-0034 — `Scheduler` only calls `enqueue_items_core`, inheriting all
  enqueue policy). The atomic-write helper is a real seam used by three of four
  table writers.
- **The team already pins wiring where it has been burned.**
  `LiveChartRoot.test.tsx` exercises render-time axis publish, crosshair→cursor,
  and a named "timeframe-switch axis freshness (regression)" test — exactly
  where the R2 / axisRef-timing bug lived. The 2026-05-28 `ts_ms`/`t_ms` parquet
  incident produced a real column-contract test.

### Where friction concentrates

| # | Cluster | Where | Severity |
|---|---------|-------|----------|
| 1 | Live wire seam | typed `kis_models` die at `snapshot.py`'s `dict[str, Any]`; contract re-derived by hand in poller/buffer/promote + the frontend adapter | **HIGH** — a field rename silently zeros a `kis_live` parquet column *and* blanks a frontend indicator with no compile error |
| 2 | Wire-mirror drift safety | `models.py:189` + ADR-0004 both claim "drift is caught by TypeScript" — false across the hand-written BE↔FE boundary | medium |
| 3 | Duplicated domain rules | KST calendar-day ×3, auction-window length ×2, page-layout glob ×4, `capture_dismissed` ×2 | medium |
| 4 | Chart overlay/drawing testability | `hitTestAt` + three overlay repaint loops are the bug surface but untestable through the component | medium |

### Infrastructure context (noted, *not* headlined)

From the tooling survey (not verified architecture findings, so kept out of the
ranked list): **no CI workflow exists**; frontend `tsconfig` has no `strict`;
`pytest` has `pytest-cov` installed but **no coverage gate**; the backend test
tree carries **four parallel conventions** for API tests. These are real
friction *multipliers* — they are *why* the drift and wiring gaps above stay
invisible — but they are infrastructure decisions for the team, not
architecture refactors. (Note: the recommended `fe-chart` fix below does **not**
depend on enabling `strict`.)

---

## 3. Quick wins (≤ low effort, high leverage)

### QW-1 · `candles.write_parquet` must use the atomic-write helper its three siblings already use
- **Files:** `hoga/tables/candles.py`, `hoga/api/_atomic_write.py`
- **Change:** `candles.py:92` — replace the bare `pq.write_table(...)` with
  `atomic_write_parquet_table(path, pa.table(cols, schema=PARQUET_SCHEMA))` (the
  exact `(path, pa.Table)` shape candles already builds and snapshots/trades/
  brokers all route through). **One line.** Stays strictly inside ADR-0001's
  table-as-module boundary — no generic writer, no module merge.
- **Impact:** medium · **Effort:** low
- **Why:** candles is the lone parquet writer doing a truncate-then-stream
  in-place write. `parse_stock_date` runs in a thread-pool executor (incl.
  re-parse on Implicit Retry / inventory recapture) while the FastAPI loop serves
  DuckDB reads of `candles.parquet` for price-range and volume on the `/live`
  read-path. An in-place write during a re-parse can leave a torn / zero-length
  parquet a concurrent reader observes — exactly what `os.replace` prevents. The
  helper's own docstring says "Use from `hoga.tables.*.write_parquet`"; candles
  is the one ignoring it. *(Promotion never writes candles, so the trigger is
  specifically a hogaplay re-parse overlapping a read — real but narrow → medium,
  not high.)*

### QW-2 · Delete dead Stage-7-α live-lifecycle scaffolding + the misleading empty `status.py`
- **Files:** `hoga/live/lifecycle.py`, `hoga/live/status.py`, `tests/unit/live/test_lifecycle.py`
- **Change:** Delete `lifecycle.start()`/`stop()` (the stub `start()` raises
  `NotImplementedError` for any non-dry-run call; `stop()` has zero callers) and
  delete `status.py` (a 1-line docstring file with zero importers that promises a
  `LiveStatus` model actually implemented in `lifecycle.py`). Delete the stub's
  dead test. **Do not** relocate the `dry_run` affordance or re-point tests — the
  production seam `start_live_poller`/`stop_live_poller` is already
  comprehensively covered by `tests/unit/live/test_lifecycle_start.py`.
- **Impact:** low · **Effort:** low
- **Why:** the live region carries two parallel start/stop vocabularies; a reader
  must hold both and discover which is real. `status.py` is the name a
  contributor would search for Live Session status, landing them disconnected
  from the real model in `lifecycle.py`. Git history (`7f892b8` "correct stale
  lifecycle docstring") shows the team already treats this staleness as friction.

### QW-3 · Inline-and-delete `cursor.py` — a one-caller pass-through with no real seam
- **Files:** `hoga/api/cursor.py`, `hoga/api/routes.py`
- **Change:** Inline `cursor.py`'s `try/except ValueError → HTTPException(400)`
  at its single call site (`routes.py:136`), deleting `cursor.py`. `routes.py`
  already uses this exact inline idiom twice nearby (lines 128-132, 196-199), so
  it matches local convention. The timeenc-stays-pure property is preserved (the
  400 translation stays in the route handler that already imports FastAPI).
- **Impact:** low · **Effort:** low
- **Why:** `cursor.py` is a 13-line function whose body is one `try/except` over
  `unix_ms_to_hhmmssms`, with exactly one production caller and zero test callers.
  One adapter = hypothetical seam, not real; interface as wide as implementation;
  deletion test fails. ADR-0003's Unix-ms contract is untouched.

### QW-4 · Add a schema-diff guard for the BE↔FE wire mirror + correct the false "TS catches drift" comment
- **Files:** `hoga/api/models.py`, `frontend/src/api/types.ts`, `tests/unit/api/test_wire_schema_contract.py` (new)
- **Change:** Add an **additive** test (the BE↔FE analog of
  `test_source_schema_contract.py`) that dumps `model_json_schema()` for the wire
  models and diffs field names / enum members against a checked-in snapshot; a
  rename or added `Literal` value fails CI with the exact drifted field. At
  minimum, correct `models.py:189` (and ADR-0004 lines 43-44) to state the mirror
  is hand-maintained and unguarded across the boundary. Preserves ADR-0004's
  by-hand, no-codegen choice.
- **Impact:** medium · **Effort:** low
- **Why:** `models.py:189` asserts "drift is caught by TypeScript at compile
  time" — false, since TS has zero visibility into `models.py`. A backend field
  rename compiles clean on both sides and surfaces as runtime `undefined` (or a
  silently dropped enum case) in the browser. The team already paid for this
  exact failure mode on the parquet side and added a column-contract test; the
  HTTP wire mirror has no equivalent. One schema-diff test covers all ~30
  mirrored models and every future addition. Additive — **not** codegen, **not** a
  re-litigation of ADR-0004.

### QW-5 · Extract `useChartFrameSync` — collapse three hand-rolled overlay repaint loops to one seam
- **Files:** `frontend/src/chart/DrawingOverlay.tsx`, `AuctionWindowOverlay.tsx`, `DayBoundaryOverlay.tsx`
- **Change:** Add `useChartFrameSync(chart, observedEl, onFrame): { schedule }`
  to `chart/` (beside `chartCoordinates`). It owns the
  `subscribeVisibleLogicalRangeChange` + `ResizeObserver` + RAF-coalesce +
  teardown quadruple and returns `schedule` for the one caller (`DrawingOverlay`)
  that triggers a frame imperatively. No behaviour change.
- **Impact:** medium · **Effort:** low
- **Why:** the byte-near-identical subscribe/observe/RAF/teardown loop appears at
  `DayBoundaryOverlay.tsx:27-44`, `AuctionWindowOverlay.tsx:29-46`,
  `DrawingOverlay.tsx:179-190` — each copy can drift (one forgetting the RAF
  cancel, another the unobserve). The viewport-repaint contract gets one owner;
  a new overlay becomes a 3-line call, and the coalescing/teardown becomes
  unit-testable once against the existing `chartWithHeights` stub pattern.

---

## 4. Strategic refactors (ranked, sequenced)

### SR-1 · Give the live WebSocket payload a real wire model — type it end-to-end behind the `LiveBuffer` seam  ·  **impact HIGH / effort medium**
- **Files:** `hoga/live/{snapshot,kis_models,poller,promote,api}.py`,
  `frontend/src/api/types.ts`, `frontend/src/live/{useLiveBundle,bucketHogaSeries,liveSidebarAdapters}.ts`,
  `frontend/src/api/liveSeries.ts`
- **Change:** Promote the existing `kis_models.py` models
  (`KisOrderbook`/`KisTrade`/`KisBrokers`) to be the actual per-kind live wire
  models behind the `LiveBuffer` seam. Type `LiveSnapshot.payload` as a
  **discriminated union keyed by `SnapshotKind`**, with typed per-kind
  builders/readers on `snapshot.py` (e.g. `LiveSnapshot.from_orderbook(...)`) so
  `snapshot.py` serializes a known shape and poller/promote depend on it instead
  of string literals. Give `/api/live/series` and `/api/live/snapshot` real
  `response_model`s. Mirror the three payload shapes in `types.ts` as a
  discriminated `LiveSnapshotEntry` union (`ob`|`trade`|`broker`) replacing the
  open `[field: string]: unknown`.
  - **Sequenced FE step (SR-1b, was `fe-live-02`):** once the union exists,
    `useLiveBundle.ts:134-135` drops its two `as unknown as ObSnapshot[]` /
    `TradeSnapshot[]` casts and `bucketHogaSeries` reads typed fields.
  - **Design decision to settle when writing:** reconcile the FE target type —
    reuse existing `ObSnapshot`/`TradeSnapshot`, or introduce a kis-mirrored
    `LiveSnapshotEntry` union; pick one as canonical so bundle and adapter agree.
- **Benefit:** collapses four independent field-name dependencies (poller writes,
  promote re-parses with defensive `.get(...)`/`0`, frontend adapter
  reconstructs, bundle double-casts) onto one declared interface. A KIS field
  rename becomes a **compile error on both sides** instead of zeroed `kis_live`
  parquet columns *or* a blank Quote-Totals / FillStrength indicator. The
  per-kind union becomes the test surface, so a poller→jsonl→promote round-trip
  drift is caught at type-check time. Strengthens ADR-0049's HHMMSSmmm guarantee.
- **Dependencies:** none blocking. Pairs naturally with QW-4 (both harden the
  wire seam) but is independent. SR-1b is the dependent FE half, sequenced after
  the backend union lands.
- **ADR:** no conflict. Compatible with ADR-0004 (the FE union is still a
  hand-mirror, no adapter/reshape) and ADR-0053 (single-websocket envelope
  unchanged — this types the inner payload the envelope test doesn't cover).

### SR-2 · Replace the Optional timing collector with a `NullTimingCollector`  ·  **impact medium / effort low**
- **Files:** `hoga/collector/timing.py`, `hoga/collector/orchestrator.py`, `hoga/api/captures.py`
- **Change:** Introduce `NullTimingCollector` implementing the same surface
  (`phase` yielding a no-op context manager, plus empty
  `mark_page_boundary`/`record_event_count`/`record_error` — empty bodies, **not**
  inheriting the real `phase` which writes `pages[-1]`). Default callers to it
  instead of `None`. Collapse each paired `if/else` branch (orchestrator 374-387,
  398-410, 470-474, 517-534, 555-564; captures 591-596, 672-686) to the single
  instrumented form `with collector.phase(...): <call>`. The report-emit gate at
  `captures.py:762` stays (preserving `HOGA_CAPTURE_TIMING=0` = no JSON/no SSE)
  via an explicit `enabled` flag or `isinstance` check.
- **Benefit:** the on/off decision lives **once** at construction, not at ~10
  call sites. The orchestrator loop body shrinks by roughly half its
  instrumentation lines. A future `cookie_pause` phase (already declared in
  `PhaseName`) is added without touching any conditional. Tests inject a
  recording or null collector, never `None`-vs-object branches.
- **Dependencies:** none — self-contained. **ADR:** preserves ADR-0017 timing
  surface and the `HOGA_CAPTURE_TIMING` escape hatch.

### SR-3 · Extract the `/live` lazy-fetch decision as a pure kernel out of the subscription+debounce effect  ·  **impact medium / effort low**
- **Files:** `frontend/src/live/LiveChartRoot.tsx`, `frontend/src/live/liveDateTime.ts`
- **Change:** Extract a pure
  `nextHistoricalFetch({ logicalFrom, axisEarliestMs, historicalFromDate, timeframe }): string | null`
  into `liveDateTime.ts` (where `prefetchChunkDaysFor` already lives). The
  `subscribeVisibleLogicalRangeChange` effect shrinks to: subscribe, 150ms
  debounce, call the kernel, dispatch `extendHistoricalRange` when non-null.
  *(This is the confirmed `fe-live-01`.)*
- **Benefit:** the core read-path policy of `/live`'s infinite scroll (the
  holiday-span / monotonic-decrease backfill rule) currently has no module — it
  is fused to the lightweight-charts subscription, the debounce timer, and a
  zustand `getState` read, so it can only be tested by driving a chart mock. The
  kernel becomes the test surface (direct table-driven cases on the arithmetic),
  and the same kernel is reusable by any future pan-driven fetch.
- **Dependencies:** none — touches a *different* effect in the same component than
  QW-5's overlay loops. **ADR:** no conflict.

### SR-4 · Make the queue snapshot the single owner of `capture_dismissed`  ·  **impact medium / effort medium**
- **Files:** `frontend/src/capture/useCaptureQueue.ts`, `frontend/src/inventory/useInventoryRecaptureOrigins.ts`, `frontend/src/App.tsx`
- **Change:** **Use option (b) only.** Keep the inventory-origins `Set`
  client-only (it is a purely client-side fact — which UI button fired the
  enqueue), but consolidate `capture_dismissed` pruning into the single
  `useCaptureQueue` reducer (the snapshot owner): drive the `Set`'s removal from
  the snapshot reducer output (a derived selector over the snapshot) rather than a
  second raw-SSE subscription. That collapses two subscribers to one and dissolves
  the undocumented cross-store key invariant. **Do not** use option (a) — carrying
  an origin marker on `QueueItem` injects a client-only fact into a backend-owned
  Wire Model.
- **Benefit:** today `capture_dismissed` has two independent subscribers in two
  regions (`useCaptureQueue` prunes the React-Query snapshot;
  `useInventoryRecaptureOriginsCleanup`, mounted at `App` root, prunes a separate
  zustand `Set` driving the inventory badge), joined only by the implicit
  invariant that the origins-Set keys stay a subset of the snapshot's `item_id`s.
  The module's own "review finding 2026-05-27" monotonic-accumulation note is
  evidence this coupling already bit once. One reducer owns dismissal bookkeeping.
- **Dependencies:** none blocking. **ADR:** option (a) would **violate** ADR-0004;
  option (b) is fully ADR-0004-clean. *Record the rejection of option (a) as a
  non-goal (see NG below).*

### SR-5 · Lift `DrawingOverlay`'s hit-test out of the component  ·  **impact medium / effort low**
- **Files:** `frontend/src/chart/DrawingOverlay.tsx`, `frontend/src/chart/drawing/hitTest.ts`, `DrawingOverlay.test.tsx`
- **Change:** Lift `hitTestAt`'s body (`DrawingOverlay.tsx:248-276`) to a pure
  `hitTestDrawings(coord, drawings, px, py): Drawing | null` in `chart/drawing/`,
  taking the coordinate closures as an injected bag. `DrawingOverlay` calls it
  with its real closures; tests call it with the `makeProjectCtx`-style stubs
  already in `render.test.ts:46-60`. **Drop** the `buildCtx` half of the original
  proposal — `buildCtx` is a thin fully-typed field assembler with no runtime
  branching, so a missing field is a `tsc` error, not a unit-testable bug.
- **Benefit:** `hitTestAt` is the kind-dispatch interaction core
  (hline/trendline/pencil, stored realMs/price → canvas pixels, pane-match guard,
  threshold compare) consumed by three call sites — yet has zero coverage, while
  the layers beneath are individually tested. A regression in pencil-polyline hit
  dispatch fails a unit test rather than only surfacing in manual QA.
- **Dependencies:** independent of QW-5 but sits in the same `DrawingOverlay`
  file — **sequence after QW-5** to avoid edit overlap.
- **⇄ Swap candidate:** `fe-shared-02` (the KST calendar-day rule implemented 3×
  across util/api/live, see appendix) is a defensible substitute for this slot —
  also medium impact, and git history (`216fd24`) shows a prior consolidation pass
  that missed two copies. Pick by leverage; either is sound.
- **ADR:** no conflict (ADR-0024/0028/0032 drawing persistence + selection
  untouched — pure-function extraction of hit geometry).

---

## 5. Non-goals (explicitly **not** recommended — candidates to record as ADRs)

These are re-litigations the review deliberately rejected. Recording them keeps
future reviews from re-suggesting the same thing.

| Non-goal | Why (settled) |
|----------|---------------|
| **Do not split `captures.py`** into multiple modules or add a `CaptureManager` class | ADR-0006 settled single-module (3-file split rejected for import friction, class for being a hypothetical seam); ADR-0007 retired the growth budget. |
| **Do not add a BE↔FE adapter / reshape mirrored types / codegen them** | ADR-0004 settled the verbatim wire model + by-hand mirror, accepting ~30% JSON bloat to avoid a hidden reshape contract. QW-4 adds an *additive* schema-diff guard; SR-4 option (a) is rejected. |
| **Do not merge the four table modules into a generic writer** | ADR-0001 settled table-as-module (each Parquet table owns its dataclass+parser+schema+writer+queries). QW-1 / the page-layout owner stay inside this boundary. |
| **Do not introduce per-series timeframe overrides on the chart** | ADR-0014 settled single-timeframe for x-coordinate coherence; per-series overrides + zoom-Auto rejected. |
| **Do not replace the single `/api/ws` multiplex** with SSE / HTTP/2 / SharedWorker | ADR-0053 settled the single-websocket channel against HTTP/1.1 6-socket-pool exhaustion (hover starve). SR-1 types the payload *inside* this channel. |

---

## 6. Domain-doc updates (`CONTEXT.md` drift — doc-only, code is correct)

### DD-1 · Timing Phase codomain (`CONTEXT.md:110`)
The parenthetical enumerating the Capture Queue item's `phase` codomain is
wrong: it lists `queued/active/done/failed/cancelled/skipped`. `active` is a
queue **bucket** name, not a `phase` value, and the three in-flight phases are
omitted. Correct it to the true eight-value codomain
`queued/deciding/capturing/parsing/done/failed/cancelled/skipped`, matching
`CapturePhase` (`models.py:128-131`), its verbatim mirror in `types.ts:107-115`,
and the direct `state.phase` assignments in `captures.py` (deciding 967,
capturing 626, parsing 660). **Note:** line 114 is already correct (it describes
`active` as a bucket holding deciding/capturing/parsing items), so the document
is internally inconsistent — only line 110 needs the fix.

### DD-2 · Daily Scheduler fire-time (`CONTEXT.md:159`)
Change both literal `18:00` tokens on line 159 ("sleeps until the next KST
18:00" and "The 18:00 today_too_early rule (Q14)") to **`17:00`**. The code
schedules at 17:00 KST (`scheduler.py:29` `seconds_until_next_17_kst`, `:35`
`hour=17`), the eligibility gate is the 17-KST `today_too_early` rule
(`eligibility.py:8,100`), and ADR-0038/0040/0043/0044/0049 all say 17:00.
CONTEXT even contradicts itself — its Live Capture (line 286) and Daily
Promotion (line 308) entries already say 17:00. This **confirms** the ADRs; it
does not reopen them.

---

## 7. Appendix A — demoted confirmed findings (the long tail)

These survived adversarial verification but fell below the headline-10 cap.

- **be-capture-03** *(design-depth, low/low)* — `disk_state.py`:
  `classify_stock_date` returns only `dict[str, DiskState]`, discarding the
  per-source `Classification` (state + violations) it already built;
  `check_disk_state` re-derives the winning source via a fragile equality scan
  and **re-reads that source's `meta.json` a second time** to recover violations
  it computed and dropped. Fix: return `dict[str, Classification]`, aggregate
  over `{src: c.state}`, look up the winning Classification directly — no second
  disk read on the hot `decide_capture`/`latest_complete_date`/`_finalize_item`
  path, no order-dependent tie-break. *(Module's own docstring already endorses
  "violations flow through once".)*
- **be-live-05** *(design-depth, low/low)* — `writer.py` + `poller.py`:
  `fsync_all()` re-walks the entire `live_root` tree and fsyncs every JSONL on
  every ~20s cycle, but `run_one_cycle` only appends to today's active-watchlist
  files. Fix: track the `(date, code)` set `append()` dirtied since the last
  flush (under the existing per-code lock), fsync only that set, then clear.
  Cost → O(active codes); flush interface narrows from "flush the tree" to "flush
  my pending writes" and gains a real test surface. *Performance win is
  edge-case-bounded (multi-day promotion outage); the locality/testability wins
  are the durable ones.*
- **be-ingest-04** *(structural, low/low)* — `orchestrator.py` + `parser/__init__.py`
  (+ `disk_state.py`): the `first_*.tsv` page-layout contract (filename format +
  numeric-not-lexical sort) is re-implemented at **four** sites across three
  regions (orchestrator 267, parser 80, parser 314, disk_state 184). Fix: one
  `raw_pages(raw_dir) -> list[Path]` owner with `page_sort_key` + the rationale
  comment living once. *Genuine consolidation, but testability is already
  realized (boundary test exists) and the go-forward write side now zero-pads to
  `:05d`, so impact is low.*
- **fe-capture-02** *(structural, low/low)* — `inventory/StockDateGroupDetail.tsx`
  + `StockDateGroupList.tsx` + `pages/Inventory.tsx` + `useStockDateGroups.ts`:
  `useStockDateGroups` is called 3× over the same rows; the detail panel
  re-implements grouping *and* re-derives the default-to-first-group policy the
  page already owns. Fix: lift grouping to `Inventory.tsx`, pass a resolved
  `group: StockDateGroup | null` down — narrowing the detail interface from
  `(rows, selectedCode)` to `(group)`. *The grouping algorithm is already
  well-extracted; only the policy wrapper is at issue → modest impact.*
- **fe-capture-04** *(consistency, low/low)* — `capture/CaptureQueueRow.tsx` +
  `inventory/StockDateGroupDetail.tsx`: `FullCaptureCountBadge` is defined twice
  (same tokens, same Korean tooltips, same `null→×1` "legacy meta lower-bound ≥1"
  rule) with deliberately different `undefined` handling. Fix: extract one badge
  parameterized on whether `undefined` is reachable; the load-bearing `null→×1`
  rule + tooltip copy live once.
- **fe-chart-04** *(contract, low/low)* — `chart/RangeSeriesPane.tsx` +
  `projectors/candle.ts` + `projectors/fillStrength.ts`: `SeriesSpec` is
  `type: any; options: any; data: () => any[]`, so "the data your projector emits
  must match the series you declared" is enforced by nothing. **Verifier
  correction:** the originally-proposed `defineSeries<T>` factory *provably
  catches nothing* (excess-property check is lost through the generic inference
  site). The **sound** fix is to type each projector's return *directly*
  (`projectCandle(): CandlestickData<Time>[]`, etc.) — which errors TS2353 at the
  projector even *without* `strict`, and is already practiced by
  `ratio.ts`/`quoteTotals.ts` — plus narrow `SeriesSpec` to a `SeriesEntry<T>`
  discriminated by `T`. *Demoted: smaller, lower-leverage than SR-1.*
- **fe-shared-02** *(consistency, medium/low)* — `util/time.ts` + `api/liveSeries.ts`
  + `live/liveDateTime.ts`: the "Unix-ms → YYYYMMDD KST" calendar-day rule (which
  decides which Stock-Date a Cursor / "today" resolves to) is implemented 3× with
  identical +9h-shift + `getUTC*` math. Fix: make `util/time.ts::unixMsToKSTDate`
  the single source; `liveDateTime.realMsToYyyymmdd` delegates,
  `liveSeries.ts` imports instead of inlining a private copy. Git history
  (`216fd24`) shows a prior pass that stayed inside `live/` and missed both other
  copies. **⇄ Swap candidate for SR-5.**
- **fe-shared-04** *(consistency, low/low)* — `util/sessionTime.ts` +
  `virtualAxis.ts` + `chart/AuctionWindowOverlay.tsx`: `sessionTime.ts` is the
  single source for the Closing Auction Window length but carries a **stale
  comment** ("Mirrors `AUCTION_WINDOW_LENGTH_MS` in `util/virtualAxis.ts` — keep
  both in sync") pointing at a constant `virtualAxis.ts` no longer defines, while
  the real un-synced duplicate literal lives in `AuctionWindowOverlay.tsx:22`.
  `virtualAxis.ts:76-85`'s docstring also still describes the band as a
  full-day-only offset, contradicting the half-day-safe semantics. Fix:
  `AuctionWindowOverlay` imports the exported constant; delete the false comment;
  correct the docstring. *Latent/maintainability, not a live bug.*

---

## 8. Appendix B — dropped findings (26) and why

The adversarial verify phase dropped 26 of 47 candidates. The pattern is
instructive: **most "this is untested" claims were refuted by tests the auditor
missed**, and **most "this is duplicated" claims didn't survive reading the
code**. This is the audit's quality signal — the surviving 21 are the ones that
withstood a skeptic reading the primary source.

| id | claim | why dropped |
|----|-------|-------------|
| be-capture-01 | `fail_streak.py` public API is a test-only shadow; prod reimplements inline | Sub-facts true, but the load-bearing claim is false: the terminal-write path shares `_apply_terminal_to_streaks` (tested at the prod site) and the gate is pinned by integration tests (`test_api_captures_queue.py:1645-1697`). |
| be-capture-02 | "which Source is authoritative" implemented 5× with divergent rules | The five functions answer *different* questions (badge vs row vs layout vs preference) with different inputs/returns; `bundle.py:403` shows two are *composed in sequence*, not competing. `kis_live` exclusion is documented schema reason, not drift. |
| be-read-01 | `ts_ms` wire-conversion re-implemented at every read-path site, no seam | Uniform `model_copy` pattern is only 4 sites, not "6+"; the others convert *computed* bucket-ms, not rows. `timeenc` is already pure-tested. Proposed cross-table `wireize.py` cuts against ADR-0001 locality. |
| be-read-02 | four slice builders duplicate path-resolve / empty / DuckDB preamble | Shared stanza is 2 mechanical lines; the "5 copies" have different return types + different empty shapes; the ADR-0043 decision stays distributed after the fix. Marginal. |
| be-read-03 | quote_ratio/fill_strength duplicate the linearize-before-bucket SQL | The dangerous decode is *already* extracted + shared (`hhmmssms_to_intra_ms_sql`). The remaining `//N`/`*N` differs structurally (window vs combined). ADR-0010 contradicts the causal story. Already end-to-end tested. |
| be-read-04 | `build_range_bundle` testable only with all 4 builders mock-patched | Refuted by `test_bundle_source_aware.py` (real `QueryEngine`, no patching) — exactly the "wrong source threaded" bug, already shipped. Headline factually wrong. |
| be-read-05 | `Code`/`StockDate` regex re-spelled across Query/Path/Field in 5 modules | Facts accurate (even found a 6th site), but 8 of 15 sites are pydantic `Field` in Wire Models (ADR-0004); Query/Path/Field/re can't collapse; proposed fix *widens* `params.py`'s interface. Cosmetic. |
| be-live-02 | `/past-candles` is a 90-line state machine with no seam below the route | Single caller; extraction *moves* ~70 lines, doesn't concentrate scatter. Headline ("mirrors the daily handler") is backwards — the daily handler is *also* inline + extracts pure helpers. |
| be-live-04 | KIS response→model decoding has no parse seam | False premise: `classify_side` (the only real domain logic) is already a pure module-level fn, already dict-tested; the prior-day guard already isolated-tested; every fetcher decode pinned via `MockTransport`. |
| be-ingest-02 | `_fetch_first_body` pass-through; retry state has no seam | The 429 backoff + phantom-row footgun are *already* driven through the `HogaplayClientProto` seam by four dedicated tests. Only true kernel is a ~13-line cosmetic cleanup. |
| be-ingest-05 | Timing DTOs pull collector region upward into `api.models` | They are genuine Wire Models (`CaptureTimingEvent` emitted over the push channel, hand-mirrored in `types.ts:226-273`). Producer-builds-wire-shape, not a misfiled primitive. |
| fe-live-03 | MA projection inlined where every sibling extracts a pure projector | Convention asymmetry real, but the MA math is *already* pure-tested (`movingAverage.test.ts`) + integration-asserted; proposed signature would re-run the `inSession` filter per slot (perf regression). |
| fe-live-04 | initial-viewport policy fused into a chart-imperative effect | Every branch *already* pinned at exact-argument granularity in `LiveChartRoot.test.tsx`; the "chart mock" is a 15-line spy. Proposed extraction adds interface surface, still needs a chart-mock test. Cosmetic relocation. |
| fe-capture-03 | `useInventoryRecapture` is a shallow wrapper | Already isolation-tested via `renderHook`; inlining would *delete* that surface. "Duplicate error-hint" is false (both import the same shared `enqueueErrorHints`). `origins` is already an extracted store, not the hook's behaviour. |
| fe-capture-05 | timing composite key `${code}:${date}` re-derived at 4 sites | Exactly ONE FE derivation (others are comments); the real producer is the backend in Python — a TS helper can't span that boundary. One-adapter = hypothetical seam. |
| fe-chart-03 | series-lifecycle guard re-hand-rolled by `MovingAverageOverlay` | The two components have divergent lifecycle shapes (fixed positional + primary-series callbacks vs keyed reconcile); only the one-liner `try{removeSeries}catch{}` is shared. **ADR-0046 explicitly defers** cross-model unification to a future ADR not yet triggered. |
| fe-shared-01 | persistent stores hand-roll 5× localStorage while `attachPersistence` has 1 caller | History is backwards: the seam dropped from 2 → 1 caller when `/replay` was removed, making it now *hypothetical*. The other stores predate it; they persist a single bool/enum with no burst path. |
| fe-shared-03 | three `/live` read hooks copy `useQuery` + code-aware `placeholderData` | The shared artifact is a one-line lambda → proposed helper is a textbook shallow module. Rule already unit-tested at 2 of 3 sites; the merge sub-proposal loses warning-type precision. |
| consistency-01 | backend test suite splits one API surface across 4 conventions | Facts true, but it's a directory reorg (no interface narrows); `testpaths=['tests']` already discovers everything; the 30+ file move + 3-conftest merge is exactly the high-risk/low-payoff churn the bar rejects. *(Better served by a one-line documented convention.)* |
| consistency-03 | FE wire-type mirror split between `types.ts` and ~10 fetch modules | Evidence materially wrong on 2 of 7 cited files (`LiveSeriesResponse` doesn't exist; `brokerSeries.ts` is a compliance *counter*-example). Real offenders ~3-4; layout partly intentional + already greppable. |
| consistency-04 | `DiskState` plain-`Enum` vs sibling `StrEnum` forces `.value` hop | False: `_capture_item_view` calls `.value` on *all three* enums identically; all wire fields typed `str` uniformly; `DiskState` already has the *tighter* FE union. Rests on a misreading. |
| consistency-05 | filename casing drifts camelCase vs kebab-case | `design-tokens.ts` is named by ADR-0012 + has zero importers (nobody hand-types it). The two genuine `api/` outliers are auto-imported by symbol — finding self-rates "weakest, marginal". |
| domain-03 | `BrokerTrajectoryTable` uses bare "broker trajectory" vs sanctioned compound | Accurate but pure rename nit; the data/type layer already uses "Broker Day-Trajectory" where scope ambiguity would bite; component props/SVG byte-identical. Churn. |
| domain-04 | `replay.*` keys retained post-`/replay`-removal, undocumented | False: `CONTEXT.md:260` *already* documents "key name retained for backward compatibility after `/replay` removal" almost verbatim. Keys are test-pinned (frozen, not stale). |
| domain-06 | `stagnation_abort`/`abort_reason` has no CONTEXT term | False: `CONTEXT.md:45` already documents the stagnation guard with ADR-0017 cross-ref + exact condition. Residual gap minor; proposed Disk-State mapping is itself unverified. |
| contract-02 | RangeBundle single-read-path is convention-only; `/api/candles` is a parallel read model | The proposed annotation *already exists* at `routes.py:61-63` (3-line NOTE citing ADR-0013, "NOT the chart read path… retained for notebook/debug only"). Author missed the line they cited. |

---

---

## 9. Appendix C — confirmed-finding coverage ledger

All **21** confirmed findings are surfaced — **none dropped in synthesis**
(10 headline slots covering 11 findings · 8 in Appendix A · 2 in §6).

| Confirmed id | Lands in |
|--------------|----------|
| `be-ingest-03` | QW-1 |
| `be-live-01` | QW-2 |
| `be-capture-04` | QW-3 |
| `contract-03` | QW-4 |
| `fe-chart-01` | QW-5 |
| `contract-01` | SR-1 |
| `fe-live-02` | SR-1b (sequenced FE half of SR-1) |
| `be-ingest-01` | SR-2 |
| `fe-live-01` | SR-3 |
| `fe-capture-01` | SR-4 |
| `fe-chart-02` | SR-5 |
| `be-capture-03` | Appendix A |
| `be-live-05` | Appendix A |
| `be-ingest-04` | Appendix A |
| `fe-capture-02` | Appendix A |
| `fe-capture-04` | Appendix A |
| `fe-chart-04` | Appendix A |
| `fe-shared-02` | Appendix A (⇄ swap for SR-5) |
| `fe-shared-04` | Appendix A |
| `domain-01` | §6 DD-1 |
| `domain-02` | §6 DD-2 |

---

*Generated by the `codebase-architecture-review` workflow. Findings are
analysis, not edits — apply via normal review. The dropped-findings table is
retained deliberately: it records where the codebase is already well-defended,
so future reviews don't re-raise the same 26.*
