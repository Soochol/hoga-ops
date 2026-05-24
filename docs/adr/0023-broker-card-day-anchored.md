# 0023 — 거래원 sidebar card is day-anchored; other Cursor Sidebar cards stay cursor-anchored

**Status:** accepted (2026-05-24) — pending implementation of `docs/superpowers/specs/2026-05-24-broker-day-trajectory-design.md`

**Related:**
- ADR-0003 — API time encoding (Unix-ms on the wire).
- ADR-0004 — Wire Model no-adapter (consumer shape == producer shape).
- ADR-0013 — RangeBundle single read path (day-scope read pattern precedent).
- ADR-0022 — Cursor Sidebar width: token-as-default, user state as runtime-of-record.
- `docs/superpowers/specs/2026-05-24-broker-day-trajectory-design.md` — the spec whose decisions this ADR preserves the reasoning for.

## Decision

Within the **Cursor Sidebar**, the **거래원** card becomes **day-anchored**: the broker list identity is derived from the entire **Stock-Date**'s aggregate, not from the **Cursor**'s exact moment. The 10호가 and 체결 cards remain cursor-anchored as before.

The day-anchored card still consumes the **Cursor**: the per-row net number reflects "this broker's signed cumulative net up to `cursorMs`", and a vertical marker inside each row's sparkline tracks the cursor position. But moving the cursor never adds, removes, or reorders rows.

The wire endpoint backing this card is `GET /api/brokers/series?code=&date=` — day-keyed, no `?t=` parameter — and the frontend hook uses `@tanstack/react-query` with `staleTime: Infinity`, paralleling `useRange` ([range.ts](../../frontend/src/api/range.ts)) rather than the cursor-keyed `useSpot` ([useSpot.ts](../../frontend/src/api/useSpot.ts)) that the other two cards use.

## Context

The Cursor Sidebar's three cards (10호가, 거래원, 체결) were originally introduced as a homogeneous set: each subscribes to the active tab's `cursorMs`, each calls a `?t=`-parameterized endpoint (`/api/orderbook`, `/api/brokers`, `/api/trades`), and each renders "what was true at this exact moment". The CONTEXT.md "Cursor Sidebar" entry codified this as "three Cursor-keyed cards".

That homogeneity served two of the three cards well — an orderbook snapshot and a fill tape are intrinsically point-in-time concepts — but worked against the broker card. The brokers table records only top-5 buy + top-5 sell at each snapshot, so a broker that's in the top-5 at 09:30 with 10k accumulated may fall to rank 6 at 10:00 and disappear from the cursor-snapshot view entirely, even though they may still be holding the position. The user-visible effect: the broker row identity churns as the cursor sweeps the chart, and "JP모간's day" cannot be tracked because the JP모간 row vanishes at any cursor moment when JP모간 was outside top-5.

A second pressure: even when a broker is continuously in the top-5, the snapshot view answers "who is heavy right now" but not "who has been heavy across the session". The day-anchored question is the one users actually ask when scrubbing the chart looking for accumulation patterns.

The 2026-05-24 spec addresses both by switching the 거래원 card to a day-aggregate view with per-broker sparklines, while keeping the other two cards unchanged.

## Why not keep all three cards homogeneous

Two alternatives were considered.

**A. Keep cursor-keyed; add sparklines off a separate day-scope endpoint.**
The card would render the cursor-snapshot list (current behavior) but inject a per-row sparkline pulled from a separate day-scope query. Pro: preserves the "all cards cursor-keyed" symmetry. Con: the row identity still churns as the cursor moves, so the sparkline that just appeared has its row pulled out from under it half a second later. The information is there but illegible.

**B. Add a fourth, separate "broker trajectory" pane.**
Leave 거래원 cursor-keyed, add a new day-scoped pane (e.g., below the chart) that hosts the trajectory view. Pro: preserves the Cursor Sidebar invariant entirely. Con: doubles the surface area for "broker information" without doubling the value — the cursor-keyed list mostly duplicates information the day-anchored list already shows (current top-N is a subset of the day's heavy hitters in 95%+ of cases), and the user has been asking for one card, not two.

The chosen approach accepts the asymmetry as the design's honest shape. The 거래원 card is the only one of the three that has a meaningful day-scope reading, and giving it that reading is worth the loss of homogeneity.

## Consequences

- **CONTEXT.md** updates the "Cursor Sidebar" entry: the three cards are no longer uniformly "Cursor-keyed". A new "Broker Day-Trajectory" entry records the new domain concept (sparkline encoding, gap convention, dual-side broker handling).
- **The `useSpot` / react-query split widens**: the sidebar now mixes both patterns. Future card additions choose based on whether the data is point-in-time (`useSpot`) or day-scope (`react-query`), and the split is not accidental.
- **The `GET /api/brokers?t=` endpoint and `useBrokersAtCursor()` hook are no longer consumed** by `CursorSidebarConnected` after this change. They are not removed in the spec's scope — removal is left to a follow-up audit confirming no other caller exists.
- **Multi-day Stock-Date Range** behavior: the trajectory follows the day the cursor is currently in (`useCursor().date`). Crossing a **Day Boundary** swaps the entire series. This matches the existing `useCursor.ts` derivation rule and does not need new infrastructure.
- **`BrokerRow` entity gains a second Wire Model**: `ApiBrokerEntry` (for the cursor-keyed endpoint) and the new `BrokerSeriesEntry` (for the day-keyed endpoint). Per ADR-0001's "table-as-module" pattern and ADR-0004's "no adapter" rule, both live in `hoga/tables/brokers.py` and ship verbatim — the second model is not a translation layer, it's a different query producing different shape.

## Out of scope

- Removing the `GET /api/brokers?t=` endpoint (consumer audit + delete is a follow-up).
- Generalizing the day-anchored pattern to other cards (the 10호가 and 체결 cards don't have an obvious day-scope reading worth the asymmetry).
- A user toggle restoring the old cursor-anchored broker view.
- Surfacing `dominant_side` as a per-Stock-Date analytical metric outside the sidebar (e.g., a CSV export) — out of scope here.
