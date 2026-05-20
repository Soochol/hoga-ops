# 0004 — Wire Model JSON shape is the consumer shape; no adapter at the API boundary

**Status:** accepted (2026-05-20)

## Decision

Each table module's **Wire Model** (the pydantic class returned by API
endpoints) is shipped to consumers — frontend, notebook clients, future
analytical tools — **verbatim**. There is no translation adapter between
"backend wire shape" and "frontend display shape". When a Wire Model needs
a structural change to fit a consumer better, the backend model changes;
the consumer never reshapes.

This applies to **shape** (field names, nesting, list-vs-scalar). It does
**not** apply to **encoding**: time encoding still goes through the
`hoga.api.timeenc` / `hoga.api.cursor` seams per ADR-0003.

## Why

The first version of the orderbook surface shipped a flat layout
(`ask_p: list[int]`, `ask_q: list[int]`, `ask_d: list[int]`, plus the
`bid_*` counterparts and totals) and the frontend reshaped it into
`{levels: OrderbookLevel[]}` via `frontend/src/api/adapters.ts::reshapeOrderbook`.
The adapter:

1. **Hid a contract.** "Ten entries per side, parallel ask_p/ask_q same
   length, no nulls" lived only in `snapshots.py::query_at` — invisible
   to anyone reading the consumer. The `/browse` dogfooding session caught
   the frontend assuming the wrong shape (`ask_p1, ask_p2…` individual
   fields rather than arrays) because nothing at the seam declared the
   actual contract.
2. **Created two shapes for one concept.** Adding a field (or renaming
   one) required edits on both sides; the adapter mediated but did not
   prevent drift. Forensic columns leaked into the wire because nothing
   said "Wire Model = what consumers actually use."
3. **Was a pass-through, by the deletion test.** Removing the adapter
   would not concentrate complexity anywhere — the reshape was glue
   covering a structural mismatch the producer could just emit correctly.

Shipping the Wire Model verbatim makes the producer responsible for one
shape: the one consumers consume. The shape lives in one place
(`hoga/tables/*.py::Api*`). The consumer's TypeScript type is a
straight mirror of the producer's pydantic model — drift is caught by
TypeScript and by runtime JSON-shape mismatches surfacing immediately
rather than being silently smoothed.

## Considered alternatives

- **Keep the adapter, document the shape in an ADR.** Rejected because
  the adapter would still exist as a pass-through layer. The ADR would
  record the contract, but the structural duplication — two shapes for
  one concept — would persist.

- **Generate frontend types from backend pydantic schemas.** Rejected as
  premature. The shape duplication is small (one type per Wire Model),
  hand-mirrored types stay readable, and adding a codegen step
  introduces a second moving part — also has its own drift modes when
  generated code is committed vs regenerated. Revisit if Wire Models
  grow past ~10 types or recursive nesting.

- **Move the adapter into the backend (still ship "flat" wire, with a
  Python-side `to_display` helper).** Rejected because it moves the
  problem rather than removing it: there are still two shapes, only one
  side now thinks of itself as canonical. Consumers from other languages
  (a Jupyter notebook in Python, a Rust analyzer) would either reuse
  this helper (coupling) or re-implement (drift).

## Consequences worth flagging for future readers

- **JSON volume:** ascending nominally — for orderbook, the new shape
  `{ts_ms, seq, ask: [{price, qty}]×10, bid: [...], tot_ask, tot_bid}`
  is ~30 % larger as JSON bytes than the flat `{ask_p, ask_q, ask_d,
  bid_p, bid_q, bid_d, tot_*}` form. Single-snapshot payloads stay
  under 1 KB so the absolute cost is irrelevant; the larger
  `depth_intensity` slice was already list-of-list and unaffected.
  If a future Wire Model justifies wire-size optimization, revisit per
  case — don't reintroduce a general adapter layer.

- **Forensic columns stay on the Entity, drop from the Wire Model.**
  ADR-0001's CONTEXT.md vocabulary already distinguishes Entity (carries
  every field including forensic `unknown_*` columns and intermediate
  values) from Wire Model (what the API returns). Apply that split
  literally. The orderbook delta columns (`ask_d`/`bid_d`) remain on
  the `Orderbook` dataclass and in Parquet — only the wire shape drops
  them. If a future client needs deltas, add them back to the Wire
  Model deliberately, not as a leftover.

- **Side/rank encoding by structure, not field.** Where ergonomic, prefer
  structural encoding (which array, which index) over explicit `side`
  and `rank` fields. Saves bytes, removes the "what if side='ask' and
  the array is `bid`?" inconsistency mode. Applied for orderbook
  (`ask` vs `bid` arrays); not applied for brokers (which uses a flat
  list with per-row `side: 'buy' | 'sell'` because the row count is
  variable and side is read independently of position).

- **Frontend types must mirror exactly.** `frontend/src/api/types.ts`
  hand-mirrors the backend Wire Models. When a Wire Model changes,
  both must be updated in the same PR — the cross-language mirror is
  the documented contract surface.

- **The `cursor_to_native` seam (ADR-0003) is the encoding boundary;
  ADR-0004 is the shape boundary.** They compose: routes call
  `cursor_to_native` to translate the Cursor's encoding (Unix-ms → HHMMSSmmm),
  but the Wire Model returned to the caller is what the consumer
  receives unchanged.

- **What this does not allow.** Per-client reshaping inside a backend
  route (e.g. branching on `User-Agent` to emit a different shape) —
  reject. Versioned API (`/v1/...` vs `/v2/...`) — also reject for now;
  hoga-ops is single-user and the cost of a coordinated shape change
  is one commit touching both sides.
