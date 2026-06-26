# /live 신규 거래원 호가비 마커 — Design

**Date**: 2026-06-26
**Status**: Approved for implementation planning
**Scope**: `hoga/tables/brokers.py`, `hoga/api/routes.py`, `hoga/api/models.py`, `frontend/src/api/types.ts`, `frontend/src/state/liveIndicatorsPersistence.ts`, `frontend/src/state/livePage.ts`, `frontend/src/live/LivePage.tsx`, `frontend/src/live/useLiveBundle.ts`, `frontend/src/live/indicators/IndicatorPanel.tsx`, `frontend/src/chart/projectors/ratio.ts`, `frontend/src/chart/RangeSeriesPane.tsx`, `frontend/src/sidebar/BrokerTrajectoryTable.tsx`, `frontend/src/live/liveSidebarAdapters.ts`

## Problem

The `/live` broker sidebar and broker day-series API currently cap displayed brokers at 10. The user wants every recorded broker to be visible, not only the top 10.

The user also wants a new broker-related indicator: brokers that were not recorded before a configurable time, default `09:30`, and first appear after that time should be shown directly on the existing `호가비` (ask/bid ratio) chart indicator. The marker should appear at the first appearance time, with a dot and the broker name as a label.

## Invariants

- **Broker parquet scope**: broker storage only records top-5 buy plus top-5 sell brokers per snapshot; the system cannot infer brokers outside those recorded snapshots. 근거: `hoga/tables/brokers.py`.
- **Broker series ordering**: broker series are sorted by `abs(final_net)` descending, with signed `final_net` preserved. 근거: `hoga/tables/brokers.py::query_day_series`.
- **Observed-points only**: broker series points are observed snapshots only; gaps are not forward-filled. 근거: `BrokerTrajectoryTable.tsx` gap rendering and ADR-0023 design.
- **Ratio pane ownership**: the `ratio` pane is mounted by `paneSpecsForTimeframe` and uses `RATIO_SPEC`; indicator overlays on that pane must not create a new chart pane.
- **Minute-frame hoga gate**: hoga panes, including `ratio`, are minute-frame indicators unless snapshot restore explicitly forces hoga panes. 근거: `frontend/src/live/paneSpecsForTimeframe.ts`.
- **Indicator persistence single source**: `/live` indicator fields are persisted through `PersistedIndicators` and `live.indicators.v1`. 근거: `frontend/src/state/liveIndicatorsPersistence.ts`.

## Invariant Impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Broker parquet scope | preserves | "모든 거래원" means all brokers recorded in top-5/top-5 snapshots, not all exchange participants. |
| Broker series ordering | preserves | The top-10 slice is removed, but sort order remains unchanged. |
| Observed-points only | preserves | Late-entry detection uses first observed point; it does not synthesize missing broker states. |
| Ratio pane ownership | preserves | Markers attach to the existing ratio pane/series. No new pane is added. |
| Minute-frame hoga gate | preserves | The new marker only renders when ratio pane data exists. |
| Indicator persistence single source | preserves | New enabled/time fields are added to the existing persistence slice and merge validator. |

## Goals

- Remove the broker identity cap so `/api/brokers/series`, the `/live` latest broker sidebar, and `BrokerTrajectoryTable` show every recorded broker.
- Add a `지표` modal item under the existing `거래원 지표` section, labelled `신규 거래원 등장`.
- Add a configurable 기준 시각 parameter in HHMM format. Default: `930`.
- Detect brokers whose first observed point is at or after the 기준 시각 and who have no observed point before that time on the same trading day.
- Render those first-appearance events as dots plus broker labels on the existing `호가비` pane.
- Keep marker rendering optional via the new indicator toggle.

## Non-Goals

- Do not create a separate chart pane for this indicator.
- Do not infer unrecorded brokers outside the captured top-5 buy/top-5 sell feed.
- Do not add per-broker filtering, pinning, or custom colors in this version.
- Do not change the meaning or formula of the existing ask/bid ratio line.
- Do not add the marker to daily/weekly/monthly charts where the ratio pane is not available.

## Design

### Data Model

Extend the `/api/range` response with a compact late-entry event list, for example:

```ts
type BrokerLateEntryEvent = {
  t_ms: number;
  broker: string;
  net: number;
};
```

The backend builds events from `brokers.parquet` after canonical broker-name collapse:

1. Build each broker's observed points for the day using the same signed net logic as `query_day_series`.
2. Convert the configured 기준 시각 HHMM into the day's KST Unix-ms threshold.
3. A broker qualifies when its first observed point has `ts_ms >= threshold`.
4. The event time is that first observed `ts_ms`; `net` is the signed net at that point.

The route layer should convert broker timestamps from the parquet HHMMSSmmm encoding to Unix ms before the frontend sees them, matching the existing broker series behavior.

`/api/range` accepts a new query parameter:

```text
broker_late_entry_start_hhmm=930
```

When the indicator is disabled, the frontend may omit this parameter and the backend may return an empty `broker_late_entries` array. When enabled, `LivePage` / `useLiveBundle` threads the persisted `brokerLateEntryStartHHMM` value into the range request so the server emits events using the user-selected threshold.

### Config and Persistence

Add fields to the `/live` indicator slice:

```ts
brokerLateEntryEnabled: boolean; // default false
brokerLateEntryStartHHMM: number; // default 930
```

Validation:

- Accept integer HHMM values in the regular-session range, recommended `900` through `1520`.
- Invalid persisted values fall back to `930`.
- The UI label should describe this as 기준 시각, not as a fixed "09:30" rule.

### Indicator Modal

Add one item to the existing `거래원 지표` group in `IndicatorPanel`:

- Label: `신규 거래원 등장`
- Toggle: `brokerLateEntryEnabled`
- Detail pane:
  - Short title: `신규 거래원 등장`
  - Numeric input: `기준 시각 (HHMM)`
  - Default visible value: `930`

This is what "거래원 지표 그룹에 추가" means: it is a selectable/togglable row inside the existing `지표` modal group, not a new sidebar card or a new chart pane.

### Chart Rendering

The marker renders on the existing `호가비` pane.

Implementation shape:

- Extend `RangeSeriesPane` marker support or add a dedicated primitive path that can attach to the ratio pane's primary series.
- Create a broker late-entry marker primitive, similar in spirit to `SurgeMarkersPrimitive`, because lightweight-charts built-in series markers do not provide enough control over y-position and label stacking.
- The marker x-position comes from `axis.toVirtual(event.t_ms)`.
- The marker y-position should use the ratio value at the same bucket/time. If the exact ratio point is absent, use the nearest earlier ratio point in the same session. If no ratio value exists, skip the marker.
- Draw a small dot at the ratio value and a compact broker label near it.
- Use `brokerDisplayShort()` for the visible label and keep the full canonical name available in marker data for future tooltip work.

Collision handling:

- Multiple brokers at the same bucket should stack labels vertically with a small fixed offset.
- If labels would exceed the pane top, shift the stack downward.
- If labels would exceed the pane bottom, shift the stack upward.
- The first version can keep labels short and simple; no interactive tooltip is required.

### All Recorded Brokers

Remove the top-10 cap in all three places:

- `hoga/tables/brokers.py::query_day_series`: return all sorted entries instead of `entries[:10]`.
- `frontend/src/sidebar/BrokerTrajectoryTable.tsx`: do not slice the received series to `BROKER_TRAJECTORY_ROW_LIMIT`.
- `frontend/src/live/liveSidebarAdapters.ts::aggregateBrokerSeries`: do not slice the live buffer-derived entries to 10.

Keep the existing sort order. The right sidebar card already has constrained height and can scroll within its panel if the row count exceeds visible space.

### Data Flow

For persisted/cursor mode:

1. `/api/range` includes `broker_late_entries` for requested dates and the configured threshold.
2. `RangeBundle` mirrors the new field in `frontend/src/api/types.ts`.
3. `RATIO_SPEC` receives the bundle and passes late-entry marker data to the marker primitive when the indicator is enabled.

For latest/live buffer mode:

1. The live broker buffer still feeds the sidebar.
2. The chart marker should use the same range/live chart bundle path as other hoga panes. If today's promoted parquet lags the live edge, current live-buffer-only broker appearances may not show as markers until the bundle updates. That is acceptable for the first version unless a later implementation finds a clean live overlay path.

## Testing

### Unit Tests

| Case | Setup | Expected |
|------|-------|----------|
| API returns all brokers | broker parquet with more than 10 canonical brokers | `/api/brokers/series` returns all sorted brokers, not 10 |
| Sidebar renders all brokers | `BrokerTrajectoryTable` receives 12 series entries | 12 broker rows render |
| Live aggregator returns all brokers | live broker buffer contains 12 broker identities | `aggregateBrokerSeries` returns 12 entries |
| Late-entry detection includes first-after-threshold | broker first point at `09:31`, threshold `930` | event emitted |
| Late-entry detection excludes before-threshold | broker point at `09:20`, later point at `10:00` | no event emitted |
| HHMM persistence sanitizes invalid values | persisted `brokerLateEntryStartHHMM: 800` | store uses `930` |
| Indicator modal row | render `IndicatorPanel` | `신규 거래원 등장` appears under `거래원 지표` and toggles store state |
| Ratio marker projection | bundle has ratio point and late-entry event at same bucket | marker uses ratio value and broker label |
| Label stacking | two events share one bucket | labels have distinct vertical offsets |

### Manual Verification

- Open `/live` on a minute timeframe with `호가비` enabled.
- Open `지표`, find `거래원 지표`, enable `신규 거래원 등장`.
- Set 기준 시각 to `930`.
- Confirm brokers first observed after `09:30` appear as dots and labels on the `호가비` pane.
- Confirm brokers observed before `09:30` do not get late-entry markers even if they reappear later.
- Confirm the broker sidebar can show more than 10 recorded brokers.
- Switch to daily/weekly/monthly and confirm the new marker does not create an empty pane.

## Risks / Open Questions

- A very active stock may produce several brokers at the same timestamp. The first label-stacking implementation must keep labels readable without over-engineering.
- The chart bundle currently focuses on range data; adding broker-derived event data should be scoped to avoid making `/api/range` too heavy.
- Today live-edge broker appearances may lag if marker data comes only from promoted parquet/range bundle. This is acceptable for the first implementation but should be watched.

## Out of Scope (Backlog)

- Tooltip with full broker name, first time, and first net value.
- User-selectable marker color or label visibility modes.
- Per-broker include/exclude filters.
- Reusing late-entry markers in `/study` saved views.
