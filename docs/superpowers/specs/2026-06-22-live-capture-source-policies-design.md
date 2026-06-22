# Live Capture Source Policies — Design

**Date**: 2026-06-22
**Status**: Draft
**Scope**: `hoga/live/*`, `hoga/api/watchlist*.py`, `hoga/api/sources.py`, `hoga/api/bundle.py`, `hoga/api/routes.py`, `frontend/src/watchlist/*`, `frontend/src/state/sourcePreference.ts`, `frontend/src/live/*`, `frontend/src/api/watchlist.ts`

## Problem

Live capture currently has two distinct behaviors:

- KIS WebSocket captures the active `live_set` and persists it as the `kis_live`
  source.
- KIS REST polling displays the currently viewed non-WS symbol, but it is
  intentionally display-only and does not persist data.

This leaves watchlist symbols outside the WS live set without persistent
intraday evidence. The user wants group-level control in the watchlist editor so
selected groups can be recorded through KIS REST every 30 seconds, including
orderbook, trades, and brokers. The system also needs clearer terminology
because "which data gets saved" and "which saved data gets displayed" are
separate decisions.

## Invariants

- **Watchlist membership owns capture candidates**: watchlist folders own
  ordered `member_codes`; entries are pruned when no folder references them.
  근거: `WatchlistFolder.member_codes`, `save_document`.
- **WS capture remains code-disjoint per account**: a code is written by at most
  one WS stream at a time, using live-set partitioning and active-code filters.
  근거: `LiveSession.refresh`, `LiveStream.set_active_codes`.
- **Current viewed-code REST poller remains display-only**: the existing
  `LiveRestPoller` must not persist data. 근거: `rest_poller.py` module contract.
- **Source preference is read policy, not write policy**: UI source preference
  chooses which existing source to display first; it does not decide what the
  runtime records. 근거: `sourcePreference.ts`, `/api/range?source_pref=...`.
- **Missing or invalid preferred data falls back**: choosing a source preference
  does not force blank charts when lower-priority sources are available. 근거:
  `resolve_source`, bundle source fallback semantics.

## Invariant impact

| Invariant | Impact | Notes |
|-----------|--------|-------|
| Watchlist membership owns capture candidates | preserves | REST 30s group toggles are folder metadata; candidate codes still come from folder membership. |
| WS capture remains code-disjoint per account | preserves | WS lifecycle and partitioning remain unchanged except when the storage policy disables WS entirely. |
| Current viewed-code REST poller remains display-only | preserves | Persistent REST 30s capture is a new recorder, not an extension of `LiveRestPoller`. |
| Source preference is read policy, not write policy | preserves | Storage policy and display priority are separate settings. |
| Missing or invalid preferred data falls back | preserves | Three-source fallback order is explicit for every display policy. |

## Goals

- Add a storage policy that controls whether live data is stored through WS,
  REST API, or both.
- Add group-level REST 30s capture toggles in the watchlist editor.
- Persist REST API data every 30 seconds for selected targets, including
  orderbook, trades, and brokers.
- Add `kis_api` as a first-class source for display selection and fallback.
- Keep the existing viewed-code REST poller display-only.
- Make UI language distinguish "storage method" from "display priority".

## Non-Goals

- Do not replace hogaplay capture.
- Do not make REST 30s data equal in resolution to hogaplay or WS data.
- Do not hand-roll a new chart source picker separate from existing source
  preference plumbing.
- Do not require the user to keep `/live` open for group REST recording.
- Do not change heatmap storage behavior in this spec.

## Design

### Data source names

Use three source names throughout the backend and frontend:

| Source | Meaning | Resolution / origin |
|--------|---------|---------------------|
| `hogaplay` | hogaplay downloaded data | high-detail downloaded source |
| `kis_ws` | KIS WebSocket persisted data | high-frequency WS live capture, currently equivalent to the existing `kis_live` concept |
| `kis_api` | KIS REST API persisted data | 30-second sampled REST capture |

Implementation may migrate the existing internal `kis_live` name to `kis_ws`, or
keep `kis_live` as a compatibility alias while presenting `kis_ws` in UI. The
spec requires the user-facing concept to be KIS WS, because it is clearer than
"live" once KIS API capture also exists.

### Storage policy

Add a storage policy setting with three modes:

| Mode | WS runtime | REST 30s recorder | REST target set |
|------|------------|-------------------|-----------------|
| `ws_only` | on | off | none |
| `ws_plus_rest` | on | on | watchlist candidates not in WS `live_set` |
| `rest_only` | off | on | all watchlist candidates |

UI labels:

- `WS만 저장`
- `WS 우선 + 나머지 REST 저장`
- `REST만 저장`

`ws_plus_rest` is the recommended default for broad watchlist coverage without
duplicating REST work for symbols already covered by WS.

`rest_only` disables WS connections. If the user later switches back to
`ws_only` or `ws_plus_rest`, lifecycle reconnects WS according to the current
watchlist and configured accounts.

### REST 30s group toggles

Add a boolean folder setting:

```json
{
  "id": "f_12345678",
  "name": "스윙1",
  "order": 0,
  "member_codes": ["005930"],
  "kis_api_30s_enabled": true
}
```

The watchlist wire model includes the same boolean on each folder. The
watchlist editor renders a toggle on every group row. A symbol present in
multiple enabled groups is recorded once.

Candidate set:

```text
kis_api_candidates = union(member_codes for enabled folders)
```

Runtime target set:

```text
ws_only:
  kis_api_targets = empty

ws_plus_rest:
  kis_api_targets = kis_api_candidates - current_ws_live_set

rest_only:
  kis_api_targets = kis_api_candidates
```

This keeps automatic WS exclusion only in the mixed storage mode. In REST-only
mode the user has explicitly chosen REST as the storage method, so WS is off and
all enabled-group candidates are REST targets.

### REST 30s recorder

Add a new backend component, tentatively `Rest30sRecorder`. It is separate from
`LiveRestPoller`.

Responsibilities:

- Own an asyncio task that wakes every 30 seconds while active.
- Resolve the current KIS background client each cycle.
- Fetch `orderbook`, `trades`, and `brokers` for each target symbol.
- Write sampled rows to disk.
- Publish snapshots to `LiveBuffer` when helpful for the current UI, without
  relying on UI subscriptions to perform recording.
- Isolate per-symbol failures so one failed symbol does not stop the recorder.
- Stop or reduce polling when the market phase is closed; if a closing snapshot
  policy is needed, fetch at most one post-close snapshot per symbol.

The recorder refreshes targets when:

- watchlist folder membership changes,
- a group REST toggle changes,
- storage policy changes,
- configured account count changes,
- WS live set changes,
- server startup initializes live capture.

### Disk layout

Persist REST 30s data as a first-class source so display selection can choose it:

```text
<data_dir>/parquet/YYYYMMDD/{code}/kis_api/
```

The source may be produced directly as parquet or staged through JSONL and
promoted, mirroring the WS path. The important contract is that API readers see
`kis_api` as a source with explicit 30-second resolution metadata.

Minimum per-source metadata:

- `source`: `kis_api`
- `sampling_ms`: `30000`
- `created_from`: `kis_rest`
- `regular_session_open_ms`
- `regular_session_close_ms`
- completeness / health markers sufficient for source fallback decisions

The source must never masquerade as `hogaplay` or `kis_ws`.

### Display priority

Rename the UI concept from "default data source" to "data display priority" or
"표현 기준". Add `kis_api` as a first-class option.

Policies:

| UI label | Priority order |
|----------|----------------|
| `hogaplay 우선` | `hogaplay` -> `kis_ws` -> `kis_api` |
| `KIS WS 우선` | `kis_ws` -> `kis_api` -> `hogaplay` |
| `KIS API 우선` | `kis_api` -> `kis_ws` -> `hogaplay` |

Definitions:

- `hogaplay 우선`: Use downloaded hogaplay data when present and healthy. During
  the current trading day, hogaplay may be absent, so fallback will usually
  choose KIS WS or KIS API.
- `KIS WS 우선`: Use persisted WebSocket data when present and healthy, including
  today and past days. If absent, prefer KIS API before hogaplay.
- `KIS API 우선`: Use persisted REST 30s data when present and healthy, including
  today and past days. If absent, prefer KIS WS before hogaplay.

Fallback is per source availability and health, not per global date. A preferred
source may win on one date and fall back on another.

### Settings structure

Separate write policy from read policy in the UI:

```text
데이터 저장 방식
- WS만 저장
- WS 우선 + 나머지 REST 저장
- REST만 저장

데이터 표현 기준
- hogaplay 우선
- KIS WS 우선
- KIS API 우선
```

The watchlist edit modal remains the place for group-level REST enablement,
because the setting is tied to watchlist groups rather than chart rendering.

### Status visibility

Expose enough live status for the UI to explain what is happening:

- storage policy,
- WS connected / disconnected,
- WS live set,
- KIS API recorder running / stopped,
- KIS API target count,
- last KIS API recorder cycle time,
- per-cycle error count or last error summary.

Watchlist rows can derive status as:

- `KIS WS 저장 중` when code is in WS live set,
- `KIS API 30초 저장 중` when code is in REST targets,
- `대기` when code is in an enabled group but not currently recordable,
- existing disconnected / reconnecting variants for WS failures.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| folder toggle persists | Enable `kis_api_30s_enabled` on a folder and reload watchlist | Folder response includes `true`; member entries are unchanged |
| candidate dedupe | Same code appears in two enabled folders | Recorder target contains the code once |
| `ws_only` targets | Enabled groups exist and WS live set has codes | REST target set is empty |
| `ws_plus_rest` targets | Enabled groups contain A/B/C and WS live set contains A | REST targets are B/C |
| `rest_only` targets | Enabled groups contain A/B/C and WS is disabled | REST targets are A/B/C |
| `rest_only` lifecycle | Switch from `ws_plus_rest` to `rest_only` | WS tasks stop; REST recorder remains active |
| reconnect lifecycle | Switch from `rest_only` to `ws_plus_rest` | WS live set is rebuilt; REST targets exclude WS codes |
| display priority: hogaplay | All three sources exist | resolver chooses `hogaplay` |
| display priority: KIS WS | All three sources exist | resolver chooses `kis_ws` |
| display priority: KIS API | All three sources exist | resolver chooses `kis_api` |
| fallback skips missing source | Preferred source missing, second source present | resolver chooses second source |
| recorder writes three kinds | Fake KIS returns orderbook/trades/brokers | one 30s sample writes all three payload kinds |
| recorder isolates failure | One symbol fetch raises | other symbols still write; cycle completes with error count |
| existing viewed poller remains display-only | Viewed-code poller receives a symbol | no `kis_api` file is written by `LiveRestPoller` |

**Invariant regression tests**:

- Source preference tests verify it only changes display priority, not storage
  policy.
- Live lifecycle tests verify `rest_only` stops WS and later reconnects WS when
  the policy changes back.
- REST poller tests verify no writer/promotion function is called from
  `LiveRestPoller`.

### Manual verification

- In the watchlist editor, enable REST 30s on one group and confirm the group row
  shows the toggle state after closing and reopening.
- With `WS 우선 + 나머지 REST 저장`, confirm WS live-set symbols show WS status
  and non-WS enabled symbols show KIS API 30s status.
- With `REST만 저장`, confirm WS disconnects and enabled-group symbols are
  recorded through KIS API.
- Switch back to `WS만 저장` and confirm REST recording stops and WS reconnects.
- Change display priority among the three policies and confirm the source chip
  and chart data follow the expected fallback.

## Risks / Open questions

- KIS REST quota must be measured with realistic group sizes because each target
  uses three REST calls every 30 seconds.
- Direct parquet writing versus JSONL staging should be chosen during
  implementation planning. JSONL staging is closer to the WS path and easier to
  make crash-tolerant.
- The exact health criteria for "normal" `kis_api` source files need to align
  with existing disk-state classification.
- Existing code and tests use `kis_live`; migration to user-facing `kis_ws`
  should be staged carefully or handled with an alias.

## Out of Scope (Backlog)

- Alerting rules based on KIS API 30s samples.
- Automatic promotion or deletion policy for old low-resolution KIS API data.
- Per-group custom polling intervals.
- Per-source visual overlays that compare WS and REST samples on the same chart.
