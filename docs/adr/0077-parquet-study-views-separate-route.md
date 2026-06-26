# Study Views Use a Separate `/study` Route

Study Views are opened in a dedicated `/study` route instead of being implemented as normal `/live` tab bookmarks. The route remains separate, but saved-view semantics are now split by schema version.

V2 **복기뷰 (Reference Study View)** rows are not self-contained chart snapshots. A v2 row stores the stock, timeframe, saved period, viewport, memo, and tags. `/study` reloads that period through the range/candle APIs and renders it with the current `/live` indicator preferences. Reproducibility for v2 means "same saved period", not "same frozen indicator output"; this intentionally favors re-analysis with today's tools over exact screen reproduction.

Legacy v1 **스냅샷 학습뷰 (Legacy Parquet Study Snapshot)** rows remain readable during migration. These rows keep `source_policy: "fixed"` and render the persisted JSON artifact rather than re-resolving source availability later. V1 loading must not use parquet as a repair path: legacy snapshots without detail arrays reopen as their persisted JSON artifact with unavailable detail.

Detail enrichment is a legacy v1 property. Missing parquet files, missing continuous orderbook representatives, or broker detail gaps do not reject v1 saves; they are recorded in `bundle.detail_warnings` and represented by unavailable dense detail buckets. V2 detail parity should be added later through on-demand cursor queries, such as `/api/orderbook` and `/api/brokers/series`, rather than by storing dense detail buckets in the saved view.
