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

- **Watchlist group opt-in owns capture candidates**: watchlist folders own
  ordered `member_codes`, but only folders with capture enabled contribute
  live-storage candidates. Entries are still pruned when no folder references
  them. 근거: `WatchlistFolder.member_codes`, `save_document`, ADR-0079.
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
| Watchlist group opt-in owns capture candidates | intentionally changes | Capture is no longer "all watchlist entries"; only capture-enabled groups contribute candidates. |
| WS capture remains code-disjoint per account | preserves | WS lifecycle and partitioning remain unchanged except when the storage policy disables WS entirely. |
| Current viewed-code REST poller remains display-only | preserves | Persistent REST 30s capture is a new recorder, not an extension of `LiveRestPoller`. |
| Source preference is read policy, not write policy | preserves | Storage policy and display priority are separate settings. |
| Missing or invalid preferred data falls back | preserves | Three-source fallback order is explicit for every display policy. |

This intentionally changes the old implicit capture model. The new user-facing
rule is simpler: a group must be enabled before any member in that group is
stored by either WS or KIS API. Storage policy then decides whether enabled
symbols are written through WS, KIS API, or both.

## Goals

- Add a storage policy that controls whether live data is stored through WS,
  REST API, or both.
- Add group-level capture toggles in the watchlist editor.
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
| `kis_live` | KIS WebSocket persisted data | high-frequency WS live capture, labeled "KIS WS" in UI |
| `kis_api` | KIS REST API persisted data | 30-second sampled REST capture |

Keep the existing internal source id `kis_live`. Do not migrate on-disk source
directories, API literals, or existing tests to `kis_ws` in this change. The UI
label becomes "KIS WS" so users understand the source is WebSocket-based, while
the wire/source id remains the boring compatibility-preserving `kis_live`.

### Storage policy

Add a storage policy setting with three modes:

| Mode | WS runtime | REST 30s recorder | WS target set | REST target set |
|------|------------|-------------------|---------------|-----------------|
| `ws_only` | on | off | capture candidates, capped by WS capacity | none |
| `ws_plus_rest` | on | on | capture candidates, capped by WS capacity | capture candidates not in WS `live_set` |
| `rest_only` | off | on | none | all capture candidates |

UI labels:

- `WS만 저장`
- `WS 우선 + 나머지 REST 저장`
- `REST만 저장`

`ws_plus_rest` is the recommended default for broad enabled-group coverage
without duplicating REST work for symbols already covered by WS.

`rest_only` disables WS connections. If the user later switches back to
`ws_only` or `ws_plus_rest`, lifecycle reconnects WS according to the current
capture candidates and configured accounts.

Storage target decision tree:

```text
Watchlist folders
  └─ filter capture_enabled=true
      └─ flatten by Watchlist display order + dedupe + symbol-master filter
          └─ Capture Candidates
              ├─ ws_only
              │   ├─ WS: first N candidates
              │   └─ KIS API: none
              ├─ ws_plus_rest
              │   ├─ WS: first N candidates
              │   └─ KIS API: remaining candidates
              └─ rest_only
                  ├─ WS: none
                  └─ KIS API: all candidates
```

Persist this policy on the backend, not only in browser localStorage, because
the recorder runs without a browser tab. Use a small data-dir scoped settings
document, for example:

```text
<data_dir>/live_settings.json
{
  "schema_version": 1,
  "storage_policy": "ws_plus_rest"
}
```

`ws_plus_rest` is the migration/default value so existing users keep WS capture
behavior after upgrade once their folders are migrated to capture-enabled.

### Group capture toggles

Add a boolean folder setting:

```json
{
  "id": "f_12345678",
  "name": "스윙1",
  "order": 0,
  "member_codes": ["005930"],
  "capture_enabled": true
}
```

The watchlist wire model includes the same boolean on each folder. The
watchlist editor renders a toggle on every group row. A symbol present in
multiple enabled groups is recorded once.

Migration/defaults:

- Existing folders created before this field existed are migrated with
  `capture_enabled: true` to preserve current unattended live capture behavior.
- New folders created after this change default to `capture_enabled: false`, so
  "checked groups are saved" remains the explicit user model.
- If the Watchlist is empty, no capture candidates exist regardless of storage
  policy.

Candidate set:

```text
capture_candidates = union(member_codes for capture-enabled folders)
  -> filtered to known symbol-master Codes
  -> deduped by first appearance in Watchlist display order
```

Runtime target set:

```text
ws_only:
  ws_targets = first N capture_candidates by watchlist display order
  kis_api_targets = empty

ws_plus_rest:
  ws_targets = first N capture_candidates by watchlist display order
  kis_api_targets = capture_candidates - current_ws_live_set

rest_only:
  ws_targets = empty
  kis_api_targets = capture_candidates
```

`N` is the current WS capacity from configured KIS accounts. The existing
display-order allocation still applies, but it runs over `capture_candidates`
instead of every watchlist entry.

This makes the group toggle the single "should this group be saved?" control.
Storage policy then chooses how enabled candidates are split between WS and KIS
API. In REST-only mode the user has explicitly chosen REST as the storage
method, so WS is off and all enabled-group candidates are REST targets.

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
- a group capture toggle changes,
- storage policy changes,
- configured account count changes,
- WS live set changes,
- server startup initializes live capture.

Do not silently cap KIS API targets. A silent cap would make a checked group
look saved while some members are absent. Instead, expose target count and
estimated REST load in status/UI. The recorder should back off on upstream
rate-limit/token errors and surface degraded status rather than dropping
targets without telling the user.

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

The source must never masquerade as `hogaplay` or `kis_live`.

`kis_api` should follow the same "promoted source" shape the read path already
understands: `meta.json`, `snapshots.parquet`, `trades.parquet`, and
`brokers.parquet` where available. Candle data may continue to come from the
existing KIS candle backfill path, matching `kis_live` behavior, rather than
being invented from 30-second REST samples.

### Display priority

Rename the UI concept from "default data source" to "data display priority" or
"표현 기준". Add `kis_api` as a first-class option.

Policies:

| UI label | Priority order |
|----------|----------------|
| `hogaplay 우선` | `hogaplay` -> `kis_live` -> `kis_api` |
| `KIS WS 우선` | `kis_live` -> `kis_api` -> `hogaplay` |
| `KIS API 우선` | `kis_api` -> `kis_live` -> `hogaplay` |

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

Backend source resolution should move from a single `SourceName` preference to
an ordered source policy. The read path should validate the requested policy,
iterate its ordered source list, and pick the first present non-invalid source.
`source_pref=hogaplay` and `source_pref=kis_live` remain accepted for
compatibility and map to the first two policies above; new clients should send
the policy value.

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

The `/live` settings modal owns the two global policy controls:

- **데이터 저장 방식**: a radio group or segmented control for `WS만 저장`,
  `WS 우선 + 나머지 REST 저장`, and `REST만 저장`.
- **데이터 표현 기준**: the existing source preference control, renamed from
  "기본 데이터 소스" to "데이터 표현 기준" and expanded to include
  `hogaplay 우선`, `KIS WS 우선`, and `KIS API 우선`.

The watchlist edit modal owns group-level capture enablement because the setting is
tied to watchlist groups rather than chart rendering. The left group list should
show a compact toggle per folder:

- Toggle ON means the folder contributes candidates to live storage.
- Toggle OFF means the folder contributes no live-storage candidates, regardless
  of whether the current storage mode uses WS, KIS API, or both.
- If global storage mode is `WS만 저장`, enabled groups are saved through WS up
  to WS capacity; no KIS API 30s files are written.
- If global storage mode is `WS 우선 + 나머지 REST 저장`, enabled groups record
  WS-capacity members through WS and the remaining enabled members through KIS
  API.
- If global storage mode is `REST만 저장`, enabled groups record all their
  members through KIS API and WS is disconnected.

This gives the user two separate UI questions:

```text
1. 어떻게 저장할까?     -> /live 설정: 데이터 저장 방식
2. 어느 그룹을 저장 대상으로 삼을까? -> 관심종목 편집: 그룹 토글
```

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
- `저장 제외` when code is not in any capture-enabled group,
- `대기` when code is in an enabled group but not currently recordable,
- existing disconnected / reconnecting variants for WS failures.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| folder toggle persists | Enable `capture_enabled` on a folder and reload watchlist | Folder response includes `true`; member entries are unchanged |
| candidate dedupe | Same code appears in two enabled folders | Recorder target contains the code once |
| disabled folder excluded | A code appears only in disabled folders | Code is not in WS or KIS API targets |
| `ws_only` targets | Enabled groups contain A/B/C and WS capacity is 2 | WS targets are first two enabled codes; REST target set is empty |
| `ws_plus_rest` targets | Enabled groups contain A/B/C and WS live set contains A | REST targets are B/C |
| `rest_only` targets | Enabled groups contain A/B/C and WS is disabled | REST targets are A/B/C |
| `rest_only` lifecycle | Switch from `ws_plus_rest` to `rest_only` | WS tasks stop; REST recorder remains active |
| reconnect lifecycle | Switch from `rest_only` to `ws_plus_rest` | WS live set is rebuilt; REST targets exclude WS codes |
| display priority: hogaplay | All three sources exist | resolver chooses `hogaplay` |
| display priority: KIS WS | All three sources exist | resolver chooses `kis_live` |
| display priority: KIS API | All three sources exist | resolver chooses `kis_api` |
| fallback skips missing source | Preferred source missing, second source present | resolver chooses second source |
| legacy source_pref compatibility | Request sends `source_pref=kis_live` | resolver maps it to KIS WS priority order |
| folder migration default | Load v3 watchlist folders without `capture_enabled` | Existing folders validate as capture-enabled |
| new folder default | Create a new folder after the migration | New folder starts with `capture_enabled=false` |
| recorder writes three kinds | Fake KIS returns orderbook/trades/brokers | one 30s sample writes all three payload kinds |
| recorder isolates failure | One symbol fetch raises | other symbols still write; cycle completes with error count |
| recorder does not silently cap | Targets exceed practical REST comfort level | all targets remain configured and status reports load/degradation |
| existing viewed poller remains display-only | Viewed-code poller receives a symbol | no `kis_api` file is written by `LiveRestPoller` |

**Invariant regression tests**:

- Source preference tests verify it only changes display priority, not storage
  policy.
- Live lifecycle tests verify `rest_only` stops WS and later reconnects WS when
  the policy changes back.
- REST poller tests verify no writer/promotion function is called from
  `LiveRestPoller`.

### Manual verification

- In the watchlist editor, enable capture on one group and confirm the group row
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
- Existing code and tests use `kis_live`; this spec keeps the internal id and
  only changes the user-facing label to KIS WS.

## Out of Scope (Backlog)

- Alerting rules based on KIS API 30s samples.
- Automatic promotion or deletion policy for old low-resolution KIS API data.
- Per-group custom polling intervals.
- Per-source visual overlays that compare WS and REST samples on the same chart.
