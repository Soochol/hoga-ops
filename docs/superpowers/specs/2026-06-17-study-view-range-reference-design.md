# Study View Range Reference — Design

**Date**: 2026-06-17
**Status**: Approved
**Scope**: `hoga/api/models.py`, `hoga/api/study_views.py`, `hoga/api/study_view_routes.py`, `hoga/api/bundle.py`, `hoga/tables/{trades,fills,snapshots,brokers}.py`, `frontend/src/studyViews/*`, `frontend/src/live/*`, `frontend/src/api/*`

## Problem

`현재 뷰 저장` currently saves a JSON snapshot of the chart data that was visible
at save time. That makes `/study` a frozen snapshot viewer: it can restore minute
candles and a few saved indicator values, but it cannot inspect the underlying
tick-level parquet data, switch into second-level buckets, or show the same
10-level orderbook and broker detail that the user expects from `/live`.

The desired behavior is different: saving should not copy market data. It should
save the visible time range, then reopen that range from parquet. A saved view is
a durable range bookmark over local parquet data, not a market-data archive.

This spec supersedes the snapshot-storage portion of
`2026-06-16-saved-chart-views-design.md`. The right-rail saved-view UX remains,
but new saves use range-reference semantics.

## Invariants

- **Saved market data is not duplicated**: New study saves persist metadata and
  a visible time range only; candles, hoga series, fills, and broker rows remain
  in the parquet corpus. 근거: user decision in this spec.
- **Visible range fidelity**: The saved range is the candle range currently
  visible on screen, from the first visible candle start to the last visible
  candle end. 근거: user decision, "현재 화면에 보이는 캔들 범위 그대로".
- **Parquet is the source of truth on restore**: Opening a study view reads the
  saved range from parquet as it exists at restore time. If today promotion was
  incomplete at save time but parquet appears later, the same study view may show
  more data after refresh. 근거: user selected "parquet 기준으로만 저장".
- **Live indicator parity target**: `/study` aims to expose every `/live`
  indicator where the required parquet source exists. 근거:
  `frontend/src/live/indicators/IndicatorPanel.tsx`.
- **Explicit degradation on source resolution limits**: When a requested
  second bucket cannot be computed exactly from the available parquet source,
  the response surfaces a warning and the UI disables or annotates only that
  incomplete series.

## Invariant Impact

| Invariant | Impact | Notes |
|-----------|--------|-------|
| Saved market data is not duplicated | intentionally breaks previous snapshot behavior | New saves no longer contain display data. Legacy snapshots remain readable. |
| Visible range fidelity | preserves | Save flow derives `visible_from_ms` and `visible_to_ms` from the active chart viewport. |
| Parquet is the source of truth on restore | preserves | `/study` does not depend on live SSE buffers or saved chart-data JSON for new saves. |
| Live indicator parity target | conditionally preserves | Preserved when source parquet contains the required raw resolution; otherwise warnings explain the missing series. |
| Explicit degradation on source resolution limits | preserves | Backend response includes range/data warnings; frontend renders disabled states or inline warnings. |

The intentional break from frozen snapshots is acceptable because it matches the
new product meaning: saved views are analysis range bookmarks. Legacy snapshots
are kept only for compatibility and can be upgraded by re-saving.

## Goals

- Make `현재 뷰 저장` store a range reference instead of a chart-data snapshot.
- Restore `/study` by reading parquet for the saved range at open time.
- Support second buckets: `1s`, `5s`, `10s`, and `30s`.
- Keep existing minute buckets: `1m`, `3m`, `5m`, `10m`, `15m`, and `30m`.
- Provide `/live` indicator parity in `/study` where parquet inputs support it.
- Show 10-level orderbook and broker detail for the cursor time in the saved
  range.
- Keep legacy snapshot saves loadable while new saves use the range-reference
  model.

## Non-Goals

- No true tick-by-tick chart mode in this iteration. Second buckets are the
  interactive chart resolution.
- No live-buffer sidecar snapshot for unpromoted today data.
- No automatic KIS fetch or hogaplay capture when a saved range points at sparse
  parquet.
- No cross-machine sync beyond the existing local `data_dir`.
- No redesign of the right rail or saved-view list beyond labels/warnings needed
  for range-reference saves.

## Design

### Save Model

New saves store metadata and range bounds:

```ts
type StudyViewRangeReference = {
  schema_version: 2;
  id: string;
  name: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe | "1s" | "5s" | "10s" | "30s";
  visible_from_ms: number;
  visible_to_ms: number;
  viewport: {
    right_edge_ms: number;
    bar_span: number;
    at_live_edge: boolean;
  };
  indicator_state: StudyIndicatorState;
  source_pref: "hogaplay" | "kis_live";
  memo: string;
  tags: string[];
  provenance: {
    saved_from_route: "/live" | "/study";
    data_provenance: "parquet_range";
  };
  created_at_ms: number;
  updated_at_ms: number;
};
```

`visible_from_ms` and `visible_to_ms` are Unix milliseconds. The backend derives
the covering stock-date range from these timestamps during range restore. The
original `snapshot_path`, `snapshot_size_bytes`, and embedded `snapshot` payload
are legacy-only fields.

### Save Flow

The frontend save action captures the current chart viewport and computes the
visible candle window. The first visible candle start becomes
`visible_from_ms`. The last visible candle end becomes `visible_to_ms`, using the
active bucket width. If the viewport is empty, the save action is disabled.

The save dialog still asks for name and memo. It may show the visible range and
bucket count, but it no longer reports JSON snapshot size.

Saving does not force a today promotion. If a range includes data that has not
yet reached parquet, opening the save shows the parquet subset plus a warning.

### Range Restore API

Add a range restore endpoint for new saves:

```http
GET /api/study-views/saves/{save_id}/range?bucket_ms=1000
```

The endpoint:

- loads the save row;
- validates that it is a range-reference save;
- derives covering `from_date` and `to_date`;
- reads only rows whose Unix timestamp intersects
  `[visible_from_ms, visible_to_ms]`;
- returns a `RangeBundle`-compatible payload plus warnings and detail capability
  flags.

The endpoint should share builders with `/api/range` where possible, but it is
separate because `/api/range` is stock-date-range and minute-timeframe oriented.
Study restore needs Unix-ms clipping and second bucket support.

Allowed study buckets:

```text
1000, 5000, 10000, 30000,
60000, 180000, 300000, 600000, 900000, 1800000
```

### Second-Bucket Data Rules

Candles:

- Prefer `trades.parquet` for `1s`, `5s`, `10s`, and `30s` OHLCV.
- If only `fills.parquet` is available, exact OHLC is not possible because fills
  are 10-second aggregate rows. For buckets below the source resolution, return
  candles as unavailable with a warning.
- Minute and above may continue using existing `candles.parquet` when available.

Hoga indicators:

- `snapshots.parquet` can produce `총잔량` and `호가비` by selecting the last
  continuous-trading snapshot inside each bucket, with the existing intra-period
  max fields where supported.
- `당일 매도 최대벽` remains bucket-aware and uses the same continuous-trading
  exclusion rules as `/live`.

Fill strength:

- Use `trades.parquet` for exact sub-10-second buckets.
- Use `fills.parquet` for 10-second and larger buckets where summing aggregate
  intervals is exact.
- Warn and disable the fill-strength series for `1s` or `5s` when only
  `fills.parquet` exists.

Broker data:

- Read `brokers.parquet` for day-level broker trajectories.
- Clip emitted points to the saved range.
- Provide both trajectory panes/series and cursor-time broker detail where the
  data exists.

### Study Screen

`/study?view=...` first loads the save row. For range-reference saves, it calls
the study range endpoint using the active bucket. The initial active bucket is
the saved timeframe. The toolbar includes:

- `1s`
- `5s`
- `10s`
- `30s`
- existing minute buckets

Changing the bucket refetches or recomputes the same saved range. The viewport
is restored from the saved `viewport` and clamped to available data.

Legacy snapshot saves still use the existing snapshot adapter. The page can
branch on `schema_version` or a discriminant field.

### Indicator Parity

`/study` targets all `/live` indicators:

- 이동평균선
- 일봉 이동평균선
- 거래량
- 외국인 순매수량
- 기관 순매수량
- 총잔량
- 호가비
- 체결강도
- 당일 매도 최대벽
- 고저 극값 라벨

Moving averages and high/low labels are computed client-side from restored
candles. Daily moving averages keep using the existing daily-candle fetch path
and project onto the study chart axis. Hoga and fill indicators come from the
study range endpoint. Investor and broker-related series use the available
parquet-backed series; if the underlying source differs from `/live`, the UI
labels the limitation instead of silently omitting it.

Saved `indicator_state` is an initial state, not a lock. Users can change
indicator toggles while studying a saved range.

### Cursor Detail

The right detail area in `/study` should support the same inspection loop as
`/live`:

- cursor at time `t`;
- request/orderbook lookup is constrained to the saved range;
- return the representative 10-level snapshot for the active bucket;
- show broker detail at or before the cursor time, clipped to the saved range.

This can reuse `/api/orderbook` and `/api/brokers/series` initially if they are
called with the resolved date and active bucket. A later optimization can add a
single study detail endpoint that batches orderbook and broker lookup.

### Legacy Migration

Existing snapshot saves remain readable. New saves are range-reference saves.

When a legacy snapshot is open and the user saves or overwrites it, the new write
uses the range-reference model. The range is computed from the currently visible
chart, not from the old snapshot file size or serialized bundle.

Deleting a legacy save must still remove its legacy snapshot file. Deleting a
range-reference save removes only the manifest row.

## Testing

### Unit Tests

| Case | Setup | Expected |
|------|-------|----------|
| Create range-reference save | POST save body without `snapshot` and with `visible_from_ms/visible_to_ms` | Manifest row is saved; no snapshot file is created. |
| Reject invalid range | `visible_from_ms > visible_to_ms` | 422 validation error. |
| Study buckets accepted | Request `bucket_ms` for 1s, 5s, 10s, 30s, and existing minute buckets | Endpoint accepts all allowed values. |
| Unsupported bucket rejected | Request `bucket_ms=42000` | 400 validation error. |
| Trades-backed 1s candles | Seed `trades.parquet` with multiple trades in one second | Response OHLCV matches trade aggregation. |
| Fills-only 1s degradation | Seed only `fills.parquet`; request `bucket_ms=1000` | Response carries warning and omits exact candle/fill series as specified. |
| Snapshot hoga second buckets | Seed `snapshots.parquet`; request `bucket_ms=5000` | Quote totals/ratio use the bucket representative and intra-bucket fields. |
| Broker clipping | Seed `brokers.parquet` before, inside, and after saved range | Response emits only in-range points/detail. |
| Legacy snapshot load | Existing schema-version-1 snapshot save | `/study` still renders through legacy snapshot adapter. |
| Legacy overwrite upgrade | Open legacy save and overwrite | New manifest row is range-reference; legacy snapshot file is cleaned up or ignored per delete rules. |

**Invariant regression tests**:

- Saving from a viewport stores visible candle bounds and no chart-data bundle.
- Restoring the same save after adding parquet rows inside the saved range
  reflects the new parquet data.
- Each unavailable sub-series has a warning; missing source data is not silently
  rendered as zero.

### Manual Verification

- Save a historical `/live` viewport, open `/study`, and confirm it starts on
  the same stock, range, and approximate viewport.
- Switch between `1s`, `5s`, `10s`, `30s`, and `1m`; confirm the x-axis remains
  inside the saved range.
- Hover several buckets and confirm the right panel shows 10-level orderbook and
  broker detail.
- Toggle each indicator in the `/study` indicator panel and confirm pane mounts
  match `/live` behavior where data exists.
- Open an old snapshot save and confirm it still renders.

## Risks / Open Questions

- `fills.parquet` cannot produce exact 1s/5s OHLC. The spec chooses explicit
  degradation instead of synthetic precision.
- The existing `RangeBundle` model may need a small extension for range warnings
  and capability flags. Keep the wire shape close enough that `LiveChartRoot`
  can still be shared.
- Daily moving average projection in a second-bucket study view needs the same
  daily fetch coverage as minute `/live`.
- Broker terminology must be kept distinct from foreign/institution investor
  estimates in UI copy.

## Out of Scope (Backlog)

- True tick-by-tick replay with event list stepping.
- Batched study cursor-detail endpoint.
- Exporting a study view as an immutable evidence package.
- Auto-capturing missing parquet for a saved range.
