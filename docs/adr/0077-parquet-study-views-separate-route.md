# Parquet Study Views Use a Separate `/study` Route

Parquet Study Views are opened in a dedicated `/study` route instead of being implemented as normal `/live` tab bookmarks. The study route is deliberately a saved-snapshot route: it does not call KIS past-candle endpoints, does not apply source fallback, does not refetch parquet detail, and does not patch with live SSE buffers.

The saved snapshot uses `source_policy: "fixed"`. Each saved segment keeps the source selected at save time (`hogaplay` or `kis_live`), and `/study` renders the persisted JSON artifact rather than re-resolving source availability later. This separates reproducible study contexts from the live/KIS-aware workspace, even though it costs a second chart route, because the user's core requirement is to reopen the same stored historical context without silently changing the data source.

Detail enrichment is best-effort at save/update time. Missing parquet files, missing continuous orderbook representatives, or broker detail gaps do not reject the save; they are recorded in `bundle.detail_warnings` and represented by unavailable dense detail buckets.
