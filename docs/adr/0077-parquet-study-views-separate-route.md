# Parquet Study Views Use a Separate `/study` Route

Parquet Study Views are opened in a dedicated `/study` route instead of being implemented as normal `/live` tab bookmarks. The study route is deliberately hogaplay-parquet-only: it does not call KIS past-candle endpoints, does not read `kis_live` parquet, and does not patch with live SSE buffers. This separates reproducible study contexts from the live/KIS-aware workspace, even though it costs a second chart route, because the user's core requirement is to reopen the same stored historical context without silently changing the data source.
