# 0013 — RangeBundle is the single read-path Wire Model; SessionBundle retired

**Status:** proposed (2026-05-22)

## Decision

The replay viewer's read path collapses to **one Wire Model: `RangeBundle`**.
Single-**Stock-Date** queries are the N=1 degenerate case of a
**Stock-Date Range** query; they go through the same `GET /api/range` endpoint
as multi-Stock-Date queries.

The prior `SessionBundle` Wire Model, `useSession` frontend hook, and
`GET /api/session` endpoint are removed in the same PR that introduces
`RangeBundle`. There is no transitional deprecation window — the two
representations do not coexist.

## Why

When the **Stock-Date Range** concept was introduced for the multi-day
Replay Viewer (CONTEXT.md, 2026-05-22), a single-day Range Selection
(`fromDate == toDate`) became structurally identical to what `SessionBundle`
represented. Two Wire Models began describing the same domain object —
"the pre-aggregated series for one or more captured Stock-Dates" — at
different cardinalities.

Keeping both meant every read-path caller had to choose: "is this a
SessionBundle situation or a RangeBundle situation?" The boundary
(N=1 vs N>1) is a cardinality detail, not a domain distinction.
ADR-0004 ("each table → one Wire Model") generalises to "each read-path
domain object → one Wire Model"; two wires for the same object violates
that principle's spirit.

We also considered transitional deprecation ("keep SessionBundle one round,
remove next PR"). Deprecation-with-future-removal in this codebase has
a poor track record — the deprecated path becomes load-bearing for tests
or call sites that drift in during the window, and the removal PR is
never prioritised. The cost of the retirement work (one Workarea call
site, one route, one test file, one frontend type) is small enough that
doing it now avoids a future audit.

## Trade-offs and what we considered

- **(chosen) Retire SessionBundle immediately.** Domain single-axis.
  Forces the cleanup work into this PR. Workarea, `useSession`,
  `/api/session`, frontend `SessionBundle` type, and direct test fixtures
  all deleted together.
- **(rejected) Keep SessionBundle as a single-day fast path.** Server
  optimisation argument — single-day queries skip the per-segment loop
  and concat logic. Rejected because (a) the per-segment work for N=1 is
  trivially small (one builder call, no concat), (b) the "fast path
  boundary" is an arbitrary domain seam ("at what N does it become a
  Range?"), and (c) the dual-wire cost is permanent.
- **(rejected) Transitional deprecation, remove in a follow-up PR.**
  Rejected because (a) deprecation windows in this codebase have a track
  record of becoming permanent, (b) coexistence forces every reader to
  judge "which wire?" until removal lands, and (c) the retirement is
  small enough to bundle into the introducing PR.

## Consequences

- `hoga/api/routes.py::api_session` is removed in the same PR that adds
  `api_range`. Any future single-day caller hits `/api/range` with
  `from == to`.
- `frontend/src/api/session.ts` (`useSession`) is deleted; all callers
  (currently just `Workarea`) switch to `useRange`.
- The frontend `SessionBundle` type is deleted; `RangeBundle` is the
  sole type. Pane components (`CandlePane`, `VolumePane`, ...) typed
  to `bundle: SessionBundle` change to `bundle: RangeBundle`.
- Pane components that read `bundle.session_open_ms` directly (currently
  `CandlePane` only) switch to `findSegmentByReal(segments, ts_ms)` and
  read the relevant segment's `session_open_ms`. See ADR-0004 — the
  cardinality change forces the consumer-side adjustment, consistent
  with that ADR's "consumer never reshapes" rule (the segments structure
  IS the wire shape; consumers index into it without reshaping).
- ADR-0004's "each table → one Wire Model" remains the operative
  principle. `RangeBundle` is not a table-derived Wire Model (it
  composes five table-derived ones plus the segments array), but the
  read-path domain object it represents has exactly one wire.

## Out of scope

- The capture / write path Wire Models are unaffected — this ADR
  governs only the replay viewer's read path.
- `Symbol Master` endpoints (`/api/symbols*`) are independent and
  unaffected.
- Future endpoints for analytical clients (notebook integration, etc.)
  will use `RangeBundle` directly per ADR-0004; no analytics-specific
  adapter is anticipated.
