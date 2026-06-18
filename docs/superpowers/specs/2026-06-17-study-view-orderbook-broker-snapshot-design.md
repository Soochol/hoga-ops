# Study View Orderbook and Broker Snapshot — Design

**Date**: 2026-06-17
**Status**: Approved
**Scope**: `hoga/api/models.py`, `hoga/api/study_views.py`, `hoga/api/study_view_routes.py`, `hoga/api/routes.py`, `hoga/tables/{snapshots,brokers}.py`, `frontend/src/studyViews/*`, `frontend/src/live/*`, `frontend/src/api/*`

## Problem

`현재 뷰 저장` restores the visible candle and indicator snapshot, but it does
not restore the 10-level orderbook or broker detail that the user uses while
studying the chart. After opening a saved study view, hovering a candle cannot
show the matching orderbook and broker state for that saved visible range.

The scope is intentionally smaller than the earlier range-reference idea. The
existing saved study-view snapshot model remains: saving still persists a frozen
chart snapshot. This change adds bucket-representative 10-level orderbook and
broker data for the whole visible candle range.

## Invariants

- **Snapshot restore remains frozen**: A saved study view restores the same data
  captured at save time. It does not refetch parquet to reconstruct the main
  chart.
- **Visible bucket coverage**: The added orderbook and broker payloads cover the
  same visible candle buckets saved in the snapshot bundle.
- **Bucket representative convention**: For each saved candle bucket, orderbook
  and broker detail use the last representative state inside
  `[bucket_start, bucket_start + bucket_ms)`, aligned with existing
  `/api/orderbook?bucket_ms=` semantics.
- **Detail source matches snapshot source**: Orderbook and broker enrichment uses
  the same Source as the saved snapshot segment whenever that source is known.
- **Broker list is bounded**: Broker detail is capped at the top 10 brokers per
  bucket using the same ordering policy as the current Cursor Sidebar broker
  card.
- **No raw tick archival**: This feature does not store every `snapshots.parquet`
  or `brokers.parquet` row in the visible range.

## Invariant Impact

| Invariant | Impact | Notes |
|-----------|--------|-------|
| Snapshot restore remains frozen | preserves | Existing snapshot save/restore remains the core model. |
| Visible bucket coverage | preserves | New payloads are derived from the same visible candle window used by the snapshot builder. |
| Bucket representative convention | preserves | Reuses the existing candle-close representative rule already used by orderbook hover. |
| Detail source matches snapshot source | preserves | Bucket enrichment resolves Source from the saved segment containing each candle. |
| Broker list is bounded | preserves | Each bucket stores at most 10 broker entries, ordered like the Cursor Sidebar broker card. |
| No raw tick archival | preserves | Only per-bucket representatives are saved. |

## Goals

- Add saved 10-level orderbook data for every visible candle bucket.
- Add saved broker detail for every visible candle bucket.
- Keep the current snapshot-based saved view model.
- Let `/study` hover/cursor detail read from the saved snapshot without live or
  parquet refetches.
- Keep saved JSON size bounded by storing one representative per visible bucket,
  not raw tick rows.

## Non-Goals

- No range-reference saved views in this iteration.
- No second-level timeframe support.
- No `/live` realtime second-bucket support.
- No tick-by-tick replay.
- No saving raw `snapshots.parquet` or `brokers.parquet` rows.
- No automatic parquet refresh when a saved view is reopened.

## Design

### Snapshot Model Extension

Extend `StudySnapshotBundle` with two optional arrays:

```ts
type StudyOrderbookBucket = {
  t: number;              // bucket start Unix ms, matching candle `t`
  snapshot: OrderbookSnapshot | null;
  available: boolean;
};

type StudyBrokerBucket = {
  t: number;              // bucket start Unix ms, matching candle `t`
  brokers: StudyBrokerDetail[]; // top 10 at this bucket
  available: boolean;
};

type StudyBrokerDetail = {
  broker: string;
  net: number; // day-to-date cumulative net at the representative time
  dominant_side: "buy" | "sell";
};

type StudyDetailWarning = {
  kind: "orderbook" | "broker";
  t: number | null;
  code: string;
  date: string | null;
  message: string;
};

type StudySnapshotBundle = {
  // existing fields...
  orderbook_buckets: StudyOrderbookBucket[];
  broker_buckets: StudyBrokerBucket[];
  detail_warnings: StudyDetailWarning[];
};
```

The fields are optional/default-empty in backend validators so older saved
snapshots still load.

Validation rules:

- Empty `orderbook_buckets` and `broker_buckets` are allowed for legacy
  snapshots.
- If either detail array is non-empty, its length must equal `candles.length`.
- For each index, `detail_bucket.t` must equal the corresponding saved
  candle's `t`.
- Detail arrays must be sorted by `t`, matching the saved candle order.

### Save Flow

The existing save flow already computes the visible candle window and persists
the visible candles plus indicator values. Keep that behavior.

If the visible candle count is large, the save dialog shows a soft warning that
10-level orderbook and broker detail will increase the saved snapshot size. The
first warning threshold is 500 visible candles. This is not a hard cap: the user
can still save the full visible range.

For each saved candle bucket:

1. Compute `bucket_start = candle.t`.
2. Compute `bucket_end = bucket_start + bucket_ms`.
3. Load the representative 10-level orderbook snapshot using the same rule as
   `/api/orderbook?bucket_ms=...`: the last continuous-trading representative
   inside `[bucket_start, bucket_end)`.
4. Load broker state for the bucket using the same representative timestamp
   convention.
5. Store only the bucket representative, not the raw rows inside the bucket.

If an orderbook or broker representative is missing for a bucket, store
`snapshot: null` or `brokers: []` with `available: false`. Missing detail should
not block saving the chart snapshot.

Enrichment attempts every saved candle bucket, including buckets outside
continuous trading. The arrays remain dense and aligned with saved candles.
Orderbook buckets use the continuous-trading representative rule, so Auction
Window or after-hours buckets may legitimately store `snapshot: null` /
`available: false`. Broker buckets may still store the day-to-date cumulative
state when broker parquet has a valid representative for that time.

If enrichment itself fails for a subset of buckets or a parquet file is missing,
the save still succeeds. The backend stores the chart snapshot and records a
structured `detail_warnings` entry so `/study` can show that some 10-level
orderbook or broker detail was unavailable. The UI may render only `message`,
but tests and diagnostics should assert `kind`, `date`, and `t` where available.

### Backend API

The save request should not trust the browser to send orderbook and broker
payloads assembled from ad hoc client calls. Instead, the backend should enrich
the snapshot during create/update:

- request body sends the current snapshot bundle and its candle bucket list;
- backend validates the snapshot as it does today;
- backend resolves each bucket's Stock-Date and Source from the saved snapshot
  segment containing that candle. If a legacy segment has no source, fall back to
  the request's source preference, then the existing hogaplay-preferred behavior;
- backend also converts the candle timestamp to a KST YYYYMMDD Stock-Date and
  verifies that it agrees with the matched segment. If segment matching and KST
  date conversion disagree, the bucket detail is marked missing and a
  `detail_warnings` entry is recorded;
- backend queries `snapshots.parquet` and `brokers.parquet`;
- backend writes the enriched snapshot JSON atomically.

This keeps parquet schema knowledge on the server and avoids racing N client
requests while the save dialog is open.

Enrichment should be batched from the first implementation. Group visible
buckets by `(Stock-Date, Source)`, read each relevant `snapshots.parquet` and
`brokers.parquet` once, and build representative maps for the buckets in that
group. Avoid one orderbook query plus one broker query per candle bucket; that
would make save latency scale poorly with zoomed-out views.

A backend enrichment helper can be called inside `study_views.create_save_sync`
and `update_save_sync` after pydantic validation but before the snapshot file
write.

### Orderbook Representative

Orderbook buckets mirror `/api/orderbook` with `bucket_ms`:

- convert the bucket start/end Unix-ms values to native HHMMSSmmm for the
  Stock-Date;
- query the last continuous-trading snapshot in the bucket;
- apply the same closing-auction 3-level exclusion already used by
  `query_bucket_representative`;
- convert the returned snapshot timestamp back to Unix ms before storing.

The stored object uses the existing `OrderbookSnapshot` wire shape:

```ts
type OrderbookSnapshot = {
  ts_ms: number;
  seq: number;
  ask: { price: number; qty: number }[];
  bid: { price: number; qty: number }[];
  tot_ask: number;
  tot_bid: number;
};
```

### Broker Representative

Broker buckets store the top 10 broker states for the bucket. The value is the
day-to-date cumulative net state at the bucket representative time, not the
within-bucket delta. This mirrors the existing broker day trajectory semantics:
hover detail answers "what was each broker's cumulative net at this point in the
day?" The top-10 ordering follows the existing Cursor Sidebar broker card /
`/api/brokers/series` policy rather than introducing a study-only sort.

The saved shape is detail-specific rather than reusing `BrokerSeriesEntry`,
because the snapshot stores one hover state per bucket, not a time series:

```ts
type StudyBrokerBucket = {
  t: number;
  brokers: Array<{
    broker: string;
    net: number;
    dominant_side: "buy" | "sell";
  }>;
  available: boolean;
};
```

Only one point is needed per bucket for hover detail, and that point is the
cumulative net at the representative time. If the UI later needs within-bucket
broker deltas or a full broker trajectory pane inside `/study`, that should be a
separate design; this iteration restores cursor detail.

### Frontend Restore

`studySnapshotBundleToRangeBundle` continues to adapt saved candles and
indicator series for `LiveChartRoot`.

Add an adapter lookup for detail:

- `orderbookByBucketStart: Map<number, StudyOrderbookBucket>`
- `brokersByBucketStart: Map<number, StudyBrokerBucket>`

When `/study` cursor time changes:

1. resolve the cursor to the saved candle bucket start. Prefer the chart
   crosshair/logical data point's candle `t`; if only `cursorMs` is available,
   fall back to the containing bucket rule
   `bucket_start <= cursorMs < bucket_start + bucket_ms`;
2. read the matching orderbook bucket and broker bucket from the saved snapshot;
3. render them in the existing right-side detail UI or a study-specific detail
   panel.

No `/api/orderbook`, `/api/brokers/series`, live SSE, or parquet range request is
needed while hovering a restored snapshot.

### Legacy Snapshots

Older snapshot files lack `orderbook_buckets` and `broker_buckets`. They remain
valid and render the chart as before. The detail panel should show an empty
state such as "저장된 10호가/거래원 데이터가 없습니다."

When a legacy study view is overwritten, the new snapshot is enriched with
orderbook and broker buckets.

## Testing

### Unit Tests

| Case | Setup | Expected |
|------|-------|----------|
| Snapshot accepts missing detail fields | Legacy snapshot JSON without `orderbook_buckets`/`broker_buckets` | Model validates and defaults both arrays to empty. |
| Detail arrays align with candles | Snapshot contains enriched detail arrays | Validator requires equal length, sorted `t`, and index-wise `bucket.t == candle.t`. |
| Save enriches orderbook buckets | Seed `snapshots.parquet`; save two visible candles | Snapshot JSON contains two `orderbook_buckets` aligned by candle `t`. |
| Orderbook missing is non-fatal | One bucket has no representative snapshot | Save succeeds; bucket has `snapshot: null`, `available: false`. |
| Non-continuous bucket stays aligned | Save includes an auction/after-hours candle bucket | Detail arrays still include that `t`; orderbook may be invisible while broker detail can be present. |
| Enrichment read failure is non-fatal | Mock one parquet read failure during save | Save succeeds and `detail_warnings` records the failure. |
| Save enriches broker buckets | Seed `brokers.parquet`; save visible candles | Snapshot JSON contains top 10 broker entries per bucket. |
| Broker cap | Seed more than 10 brokers | Saved bucket contains at most 10 brokers ordered by the Cursor Sidebar broker-card policy. |
| Representative convention | Bucket contains multiple snapshots | Saved orderbook is the last valid representative inside the bucket. |
| Legacy overwrite | Open old snapshot and overwrite | New snapshot includes orderbook/broker bucket arrays. |

**Invariant regression tests**:

- Saved candle count and detail bucket count match for successful enrichments.
- Missing detail data never prevents chart snapshot persistence.
- Detail enrichment failures are surfaced through `detail_warnings`.
- No raw per-tick snapshot list is stored.

### Manual Verification

- Save a `/live` viewport with visible candles and known orderbook data.
- Open `/study?view=...`.
- Hover several saved candles and confirm the detail panel changes by bucket.
- Confirm old saved views still open and show a clear missing-detail empty state.
- Save a range with sparse broker data and confirm chart restore still works.

## Risks / Open Questions

- Backend enrichment still adds save latency proportional to visible candle
  count, but parquet reads must be batched by `(Stock-Date, Source)` to avoid
  per-bucket query overhead.
- Broker representative semantics may need a table-level helper if current
  broker queries only return full-day series. Keep that helper inside
  `hoga/tables/brokers.py`.
- Saved JSON size increases with visible candle count. The top-10 broker cap and
  one-orderbook-per-bucket rule keep it bounded, and the save dialog warns above
  500 visible candles.

## Out of Scope (Backlog)

- Range-reference study views.
- Second-bucket charts.
- Full broker trajectory panes in `/study`.
- Tick-by-tick orderbook replay.
