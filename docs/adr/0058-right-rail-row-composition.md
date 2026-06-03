# Right-rail row composition: shared static QuoteRow, drag isolated in SortableQuoteRow, row-lists not unified

The shared `rightrail/QuoteRow` renders one right-rail row (이름 / **Live Quote** / optional trailing action) for the **Watchlist Panel**, the **Screener Panel**, and the Watchlist toggle button. Draggability is a **Watchlist Panel**-only concern, isolated in the `watchlist/SortableQuoteRow` adapter — it calls `useSortable` and injects optional drag passthrough props (`sortableRef`/`sortableStyle`/`dragListeners`/`dragAttributes`/`dragging`) into `QuoteRow`. `QuoteRow` itself stays a **static** row and does **not** grow a "draggable mode": the Screener Panel passes no drag props (`{...undefined}` is a no-op spread) and is byte-identical. We also deliberately do **not** unify the three right-rail row-lists — the Watchlist drawer (`QuoteRow` list + DnD), the Screener drawer (`QuoteRow` list + Watchlist-heart trailing action), and the full-page `WatchlistPanel` (table grid, different columns, add+remove) — into one component.

## Considered options

- **A `variant: 'draggable' | 'static'` discriminator or a separate `DraggableQuoteRow`** — rejected: either duplicates the row body or grows a mode on the shared row. The adapter (`SortableQuoteRow`) already concentrates the drag wiring without touching the static row's interface for non-drag callers.
- **A generic `RightRailRowList` presenter** owning the `<ul>` + row click→jump + quote overlay + trailing-action injection — rejected: the three sites differ materially (drag vs heart-toggle vs none; `QuoteRow` list vs table grid; different columns and data sources). A shared abstraction would be a union type that *moves* complexity rather than *concentrating* it (deletion test: extracting it shrinks each caller by ~15 lines but leaves the panel-specific DnD/heart wiring in place).

## Consequences

- A future architecture review should not re-suggest a `QuoteRow` drag-variant split or a unified right-rail row-list; the seams are intentionally where they are (shared static row + per-panel wiring).
- Optional, non-required tidy-up: bundle `QuoteRow`'s five drag passthrough props into one optional `sortable?: {...}` object so the two call modes read as one discriminated prop. Deferred to avoid re-churning a freshly-reviewed interface.
