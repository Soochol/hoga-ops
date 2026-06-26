# /live 신규 거래원 호가비 마커 — Design

**Date**: 2026-06-26
**Status**: Grilled + engineering-reviewed for implementation planning
**Scope**: `hoga/tables/brokers.py`, `hoga/api/routes.py`, `hoga/api/models.py`, `frontend/src/api/types.ts`, `frontend/src/state/liveIndicatorsPersistence.ts`, `frontend/src/state/livePage.ts`, `frontend/src/live/LivePage.tsx`, `frontend/src/live/useLiveBundle.ts`, `frontend/src/live/indicators/IndicatorPanel.tsx`, `frontend/src/chart/projectors/ratio.ts`, `frontend/src/chart/RangeSeriesPane.tsx`, `frontend/src/sidebar/BrokerTrajectoryTable.tsx`, `frontend/src/live/liveSidebarAdapters.ts`

## Problem

The `/live` broker sidebar and broker day-series API currently cap displayed brokers at 10. The user wants every recorded broker to be visible, not only the top 10. "Recorded broker" means a broker present in the stored top-5 buy plus top-5 sell broker snapshots; the system cannot infer brokers outside those recorded snapshots.

The user also wants a new broker-related indicator: **기록상 신규 거래원**. Starting from a configurable time, default `09:30`, the indicator should show brokers whose first recorded appearance is at or after that time and who were not recorded before that time. This deliberately treats "present in the first recorded broker snapshot at or after 09:30" and "newly appearing later after 09:30" as one user-facing concept: **기준시각 이후 첫 등장 거래원**. Each broker should be shown once, directly on the existing `호가비` (ask/bid ratio) chart indicator, at that broker's first observed appearance time, with a dot and the broker name as a label.

## Invariants

- **Broker parquet scope**: broker storage only records top-5 buy plus top-5 sell brokers per snapshot; the system cannot infer brokers outside those recorded snapshots. 근거: `hoga/tables/brokers.py`.
- **Broker series ordering**: broker series are sorted by `abs(final_net)` descending, with signed `final_net` preserved. 근거: `hoga/tables/brokers.py::query_day_series`.
- **Observed-points only**: broker series points are observed snapshots only; gaps are not forward-filled. 근거: `BrokerTrajectoryTable.tsx` gap rendering and ADR-0023 design.
- **Ratio pane ownership**: the `ratio` pane is mounted by `paneSpecsForTimeframe` and uses `RATIO_SPEC`; indicator overlays on that pane must not create a new chart pane.
- **Ratio display-coordinate truth**: markers on the `호가비` pane must sit on the displayed ratio value, after the same intra-bar basis and mask rules that the line uses. 근거: `frontend/src/chart/projectors/ratio.ts`, ADR-0026, ADR-0029.
- **Minute-frame hoga gate**: hoga panes, including `ratio`, are minute-frame indicators unless snapshot restore explicitly forces hoga panes. 근거: `frontend/src/live/paneSpecsForTimeframe.ts`.
- **Source preference per Stock-Date**: `/api/range` resolves a Source per Stock-Date according to `source_pref`; derived range fields should use that segment's resolved source, not a separate fallback policy. 근거: ADR-0039 and `hoga/api/bundle.py::build_range_bundle`.
- **Indicator persistence single source**: `/live` indicator fields are persisted through `PersistedIndicators` and `live.indicators.v1`. 근거: `frontend/src/state/liveIndicatorsPersistence.ts`.

## Invariant Impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Broker parquet scope | preserves | "모든 거래원" means all brokers recorded in top-5/top-5 snapshots, not all exchange participants. |
| Broker series ordering | preserves | The top-10 slice is removed, but sort order remains unchanged. |
| Observed-points only | preserves | Late-entry detection uses first observed point; it does not synthesize missing broker states. |
| Ratio pane ownership | preserves | Markers attach to the existing ratio pane/series. No new pane is added. |
| Ratio display-coordinate truth | preserves | Marker y-values are derived from the same projected ratio data that the line renders; auction-hidden points produce no marker. |
| Minute-frame hoga gate | preserves | The new marker only renders when ratio pane data exists. |
| Source preference per Stock-Date | preserves | Late-entry events are computed from the same resolved source directory as the segment's other range data. |
| Indicator persistence single source | preserves | New enabled/time fields are added to the existing persistence slice and merge validator. |

## Goals

- Remove the broker identity cap so `/api/brokers/series`, the `/live` latest broker sidebar, and `BrokerTrajectoryTable` show every recorded broker.
- Add a `지표` modal item under the existing `거래원 지표` section, labelled `신규 거래원 등장`.
- Add a configurable 기준 시각 parameter in HHMM format. Default: `930`.
- Detect **기록상 신규 거래원** with one unified rule: brokers with no observed point before the 기준 시각 and a first observed point at or after the 기준 시각.
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
3. Build `pre_seen = brokers with any observed point ts_ms < threshold`.
4. For each broker, find its first observed point where `ts_ms >= threshold`. This intentionally treats exactly `09:30:00.000` as included because Korean "이후" is inclusive in this UI.
5. Emit one event if the broker is not in `pre_seen` and such a first at-or-after-threshold point exists.
6. The event time is that first observed `ts_ms`; `net` is the signed net at that point.

This simpler model is the intended product behavior: the user is not asking to distinguish "already visible in the first 09:30+ snapshot" from "appeared later"; they want to notice brokers that were not recorded before the 기준 시각 and then first show up from that point onward.

The route layer should convert broker timestamps from the parquet HHMMSSmmm encoding to Unix ms before the frontend sees them, matching the existing broker series behavior.

`/api/range` accepts a new query parameter:

```text
broker_late_entry_start_hhmm=930
```

When the indicator is disabled, the frontend may omit this parameter and the backend may return an empty `broker_late_entries` array. When enabled, `LivePage` / `useLiveBundle` threads the persisted `brokerLateEntryStartHHMM` value into the range request so the server emits events using the user-selected threshold.

Each date's events are computed from the same source directory that `build_range_bundle` resolved for that Stock-Date. If the resolved source has candles/orderbook data but no `brokers.parquet`, the backend emits no late-entry events for that date and does not exclude the segment. That keeps this optional marker from making an otherwise valid chart disappear.

Data-flow target:

```text
IndicatorPanel
  └─ brokerLateEntryEnabled + brokerLateEntryStartHHMM
       └─ useLiveBundle / useRange query key
            └─ GET /api/range?...&broker_late_entry_start_hhmm=930
                 └─ build_range_bundle
                      ├─ resolve_source_result(date, code, source_pref)
                      ├─ quote_ratio / fill_strength from resolved source
                      └─ broker_late_entries from same resolved source's brokers.parquet
                           └─ RangeBundle.broker_late_entries
                                └─ RATIO_SPEC label marker primitive
```

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

- Extend `RangeSeriesPane` with a narrow labelled-marker primitive path, parallel to the existing `markers` support used by `SurgeMarkersPrimitive`. Do not introduce a broad arbitrary plugin registry for this single marker family.
- Create a broker late-entry marker primitive, similar in spirit to `SurgeMarkersPrimitive`, because lightweight-charts built-in series markers do not provide enough control over y-position and label stacking.
- The marker x-position comes from `axis.toVirtual(event.t_ms)`.
- The marker y-position uses the displayed ratio value at the same bucket/time: same close-vs-intra-max basis, same Outlier Mask behavior (`value = 0` when clamped), and same Auction Mask behavior (skip marker when the ratio point is emitted as hidden/whitespace). If the exact ratio point is absent, use the nearest earlier displayed ratio point in the same session. If no displayed ratio value exists, skip the marker.
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

### Engineering Review Decisions

These are the grilled decisions after applying the `plan-eng-review` lens:

| Question | Decision | Why |
|----------|----------|-----|
| What does "new broker" mean? | Use **기록상 신규 거래원** in docs/tests; keep UI label `신규 거래원 등장`. | Prevents the false claim that the broker was absent from the market; we only know it was absent from recorded top-5/top-5 snapshots. |
| Does `09:30 이후` include exactly 09:30? | Yes. A broker whose first observed point is exactly at the threshold is included. | Keeps the UI inclusive and intuitive: 기준시각부터 새롭게 보인 거래원을 표시한다. |
| Should the UI distinguish "present at first 09:30+ snapshot" from "appeared later"? | No. Use one marker concept and one event type. | The user's goal is discovery of brokers newly visible after the 기준 시각, not cohort analysis. A single rule is easier to trust and explain. |
| Where should event data live? | `/api/range` / `RangeBundle`, not a separate per-date frontend fetch fan-out. | Preserves ADR-0013 single read-path and keeps the marker aligned with the same Stock-Date/source segments as the ratio line. |
| Which source should broker events use? | The segment's resolved source from `source_pref`. | Avoids source mixing where the ratio line is KIS but broker markers are hogaplay, or vice versa. |
| What y-value should markers use? | The displayed ratio value after ratio projector policy. | Users see a marker on the line they are actually looking at; hidden auction points do not get floating labels. |
| How generic should marker plumbing be? | Add a narrow labelled-marker primitive path. | More complete than hacking DOM labels outside the chart, less overbuilt than a full primitive plugin registry. |
| Should missing broker parquet exclude a date? | No. Emit no marker events for that date. | The marker is optional annotation; missing it must not blank otherwise valid hoga charts. |

### Test Coverage Diagram

```text
CODE PATHS                                                   USER FLOWS
[+] hoga/tables/brokers.py                                   [+] Enable marker from 지표 modal
  ├── [GAP] query_day_series returns all sorted brokers         ├── [GAP] toggle on/off persists
  ├── [GAP] canonical alias collapse before first-ts check      ├── [GAP] HHMM edit refetches /api/range
  ├── [GAP] baseline-before-threshold exclusion                 └── [GAP] invalid HHMM falls back to 930
  ├── [GAP] first at-or-after-threshold appearance emits once
  └── [GAP] missing brokers.parquet -> [] events

[+] hoga/api/routes.py / bundle.py                           [+] Read marker on 호가비 pane
  ├── [GAP] broker_late_entry_start_hhmm validation             ├── [GAP] dot + short label at first appearance
  ├── [GAP] source_pref-resolved source per segment             ├── [GAP] same-bucket labels stack visibly
  └── [GAP] no source mixing across segments                    └── [GAP] no marker during Auction Mask whitespace

[+] frontend/src/chart/projectors/ratio.ts                   [+] Sidebar long broker list
  ├── [GAP] displayed-value marker projection                   ├── [GAP] >10 recorded brokers visible
  ├── [GAP] Outlier Mask marker sits at displayed 0             └── [GAP] latest mode >10 brokers visible
  └── [GAP] nearest-earlier same-session fallback

[+] frontend/src/chart/RangeSeriesPane.tsx
  ├── [GAP] labelled primitive attach/update/detach lifecycle
  └── [GAP] teardown safe when chart already removed
```

## Testing

### Unit Tests

| Case | Setup | Expected |
|------|-------|----------|
| API returns all brokers | broker parquet with more than 10 canonical brokers | `/api/brokers/series` returns all sorted brokers, not 10 |
| Sidebar renders all brokers | `BrokerTrajectoryTable` receives 12 series entries | 12 broker rows render |
| Live aggregator returns all brokers | live broker buffer contains 12 broker identities | `aggregateBrokerSeries` returns 12 entries |
| Late-entry detection excludes pre-seen brokers | broker A before `09:30`, then again at `10:00` | A emits no event |
| Late-entry detection includes exact threshold | broker B first appears at `09:30:00.000`, threshold `930` | B emits one event at `09:30:00.000` |
| Late-entry detection includes later first appearance | broker C first appears later than `09:30` | C emits one event at that first observed point |
| Late-entry detection emits once per broker | broker D first appears at `09:45`, then appears again at `10:10` | D emits only the `09:45` event |
| Late-entry detection uses resolved source | same date has `hogaplay` and `kis_live` with different broker first times | events match selected/fallback source segment |
| Missing broker parquet is non-fatal | valid candles/snapshots but no `brokers.parquet` | range response succeeds with no broker late-entry events for that date |
| HHMM persistence sanitizes invalid values | persisted `brokerLateEntryStartHHMM: 800` | store uses `930` |
| Indicator modal row | render `IndicatorPanel` | `신규 거래원 등장` appears under `거래원 지표` and toggles store state |
| Ratio marker projection | bundle has ratio point and late-entry event at same bucket | marker uses ratio value and broker label |
| Ratio marker follows Outlier Mask | ratio point is clamped by outlier threshold | marker y-value is displayed `0` |
| Ratio marker respects Auction Mask | ratio point falls in hidden closing auction window | no marker emitted |
| Label stacking | two events share one bucket | labels have distinct vertical offsets |

### Manual Verification

- Open `/live` on a minute timeframe with `호가비` enabled.
- Open `지표`, find `거래원 지표`, enable `신규 거래원 등장`.
- Set 기준 시각 to `930`.
- Confirm brokers first observed at or after `09:30` appear as dots and labels on the `호가비` pane.
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
