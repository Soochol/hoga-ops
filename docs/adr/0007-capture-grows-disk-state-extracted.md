# 0007 — Capture module grows to queue + workers; `disk_state` extracted as horizontal seam

**Status:** accepted (2026-05-21) — amends ADR-0006; Plan B landed 2026-05-22 confirming the queue/worker/pause growth
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

## Postscript — Plan B landing notes (2026-05-22)

Plan B (`docs/superpowers/plans/2026-05-22-capture-queue-backend.md`)
implemented the queue + worker pool + cookie pause + sibling endpoints
(`symbols.py`, `calendar.py`). `hoga/api/captures.py` reached ~920 lines
and stays single-module per the decision above. Two new sibling modules
appeared exactly where the spec said they would; no further seams
emerged in the process.

Plan B's eng-review surfaced six pre-execution gaps that would have
broken the implementation as written — most notably (a) `pykrx`
was missing from project deps, (b) `HogaplayHTTPError` had no
`status_code` attribute so the 429 backoff couldn't dispatch, and
(c) the planned `hoga/inventory/trading_days.py` helper module did
not exist. Each fix landed inline before any subagent dispatched
code. Reinforces the lesson that **plan-eng-review's real work is
plan-↔-code reconciliation**, not abstract architecture review.

`disk_state.check_disk_state` now has three confirmed consumers
(worker `deciding` phase, `symbols._build_all_captured_breakdowns`,
`calendar._cell_status_for`) — the horizontal-seam rationale stands.

## Postscript — Plan C landing notes (2026-05-23)

Plan C (`docs/superpowers/plans/2026-05-23-capture-queue-frontend.md`)
shipped the redesigned `/capture` UI on top of Plan B's queue backend.
Notable additions: `@tanstack/react-virtual` for queue rows past 200,
and a `HOGA_ENABLE_TEST_ENDPOINTS`-gated `POST /api/test/cookie_expire_at`
hook on top of FakeHogaplayClient so the Playwright `cookie-pause`
spec can deterministically exercise the pause/resume path. Frontend
`api/types.ts` mirrors the backend wire shapes verbatim per
ADR-0004; no adapter layer was introduced.

Two plan-vs-impl reconciliations were needed during execution:
1. `CaptureQueue.tsx` as written in the plan called `useMemo` after
   an early-return — would have crashed React's rules-of-hooks on the
   first loading render. Hoisted the memo above the early-return.
2. `SymbolSearch.tsx` initialised its displayed `text` only on mount,
   so the form-reset flow (parent flips `value` back to null) left the
   input populated. Added a `useEffect` that syncs `text` whenever the
   external `value` prop changes.

Both fixes were inline (no follow-up issue). Reinforces Plan B's lesson:
plan-vs-impl reconciliation is the work, not abstract review.
