# Signal Alerts — Design

**Date**: 2026-07-01
**Status**: Draft
**Scope**: `hoga/live`, `hoga/api`, `frontend/src/pages/Settings.tsx`, `frontend/src/rightrail`, `frontend/src/state/rightRail.ts`, `frontend/src/api/ws.ts`

## Problem

Users want an app-level alert when a watched stock renews or revisits a high
sell-side total orderbook quantity after a configurable time.

The concrete first signal is:

- 대상: 캡처 활성 관심그룹에 포함된 관심종목 전체
- 지표: 매도 총잔량
- 기준: 기준 시각 이전의 당일 최대 매도 총잔량
- 조건: 기준 시각 이후 현재 매도 총잔량이 기준 최대값 대비 문턱 이상
- 기본 파라미터: 기준 시각 `11:00`, 문턱 `100%`, 분봉 내 최대 매도 총잔량 판정 ON

The alert must work for both live WS targets and REST 30-second storage targets.
Alert history should be visible in the app and clicking an alert should open the
stock in `/live`.

## Invariants

- **Live storage policy split**: capture-enabled watchlist codes are split by
  `storage_policy`; `ws_plus_rest` sends the first WS-capacity codes to WS and
  the rest to REST 30-second storage. 근거:
  `hoga/live/coverage.py::plan_storage_targets`.
- **Right rail exclusivity**: the right rail opens at most one panel at a time
  through `rightRail.activePanel`. 근거: `frontend/src/state/rightRail.ts`.
- **Single WebSocket event bus**: global app events are delivered as
  `{ ch: "event", data }` frames over `/api/ws`. 근거: `hoga/api/ws.py`,
  `frontend/src/api/ws.ts`.
- **Settings category pattern**: settings pages use a left-side category menu
  for configuration; right rail panels are for high-frequency work surfaces.
  근거: existing `LiveSettingsSections` and `RightRail`/`RailShell` patterns.
- **No chart-display coupling**: indicator rendering preferences do not silently
  change alert semantics. Chart `quoteTotalsIntraMax` and signal alert
  `useIntraMinuteMax` are separate preferences.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Live storage policy split | preserves | monitor observes the same WS/REST snapshots already produced by storage runtimes |
| Right rail exclusivity | preserves | adds `signalAlerts` as another mutually exclusive panel value |
| Single WebSocket event bus | preserves | adds a new `signal_alert` event type on the existing bus |
| Settings category pattern | preserves | settings edit rules only; alert history lives in the right rail panel |
| No chart-display coupling | preserves | alert intra-minute max setting is independent from chart indicator prefs |

## Goals

- Alert on sell total quantity signals across all capture-enabled watchlist
  codes, including WS and REST-backed codes.
- Persist alert settings and same-day alert history across browser refreshes.
- Surface alerts immediately as app toasts and in a right-side alert inbox.
- Let users click an alert row to open or focus that stock in `/live`.
- Let users clear today's visible alert inbox from the right rail while keeping
  the date-partitioned alert history on disk for later lookup.
- Follow existing UI structure: Settings for parameters, RightRail/RailShell for
  the alert inbox.

## Non-Goals

- Browser/OS notifications.
- Alert sounds.
- Monitoring watchlist folders whose capture toggle is off.
- Perfect tick-level accuracy for REST-backed codes. REST alerts use the
  30-second snapshots the app already fetches.
- A generic alert rule builder. This spec adds one concrete signal.

## Design

### Alert Rule

Add a first built-in signal: **신고 매도 총잔량 갱신**.

Settings:

```json
{
  "schema_version": 1,
  "sell_total_renewal": {
    "enabled": true,
    "start_hhmm": 1100,
    "threshold_pct": 100,
    "use_intra_minute_max": true
  }
}
```

Validation:

- `start_hhmm`: valid KST market HHMM from `0900` to `1520`.
- `threshold_pct`: integer percent, recommended UI range `50` to `150`, default
  `100`.
- `use_intra_minute_max`: boolean.

The alert setting is independent from the chart indicator setting named
`quoteTotalsIntraMax`. UI copy uses **분봉 내 최대 매도 총잔량으로 판정** to avoid
confusing it with chart rendering.

### Monitor

Add a backend `SignalAlertMonitor` owned by live lifecycle/runtime code.

Inputs:

- code
- stock name if available
- `t_ms`
- sell total quantity
- source: `ws` or `rest`

State is per KST trading date and code:

- pre-start baseline max sell total quantity
- current minute bucket max, when `use_intra_minute_max` is ON
- armed/disarmed state for repeat suppression
- last emitted alert id

Algorithm:

1. Reset all state when KST trading date changes.
2. Before `start_hhmm`, update the baseline max.
3. After `start_hhmm`, ignore the code if baseline is missing or zero.
4. Resolve the candidate value:
   - ON: max sell total quantity seen in the current minute bucket.
   - OFF: latest snapshot value.
5. Emit when `candidate >= baseline * threshold_pct / 100`.
6. Suppress repeats until the candidate falls below an internal rearm threshold.

The initial rearm threshold is internal, not a UI parameter. Use `85%` of the
baseline or a similarly conservative value matching the existing surge-marker
hysteresis. A later spec can expose it if users need control.

### Integration Points

WS path:

- `LiveStream` already parses orderbook ticks and publishes/stores snapshots.
- Feed eligible orderbook snapshots into `SignalAlertMonitor` from the same hot
  path, using the parsed total ask quantity.

REST path:

- `Rest30sRecorder._fetch_write_publish` already fetches orderbook, trades, and
  brokers, writes snapshots, and publishes to `LiveBuffer`.
- Feed the fetched REST orderbook total ask quantity into the same monitor with
  source `rest`.

The monitor should only evaluate capture-enabled watchlist targets. It should
sync target membership from the same storage planning path that splits WS/REST
targets, so capture-disabled folders never alert.

### Persistence and API

Add a small signal-alert settings module rather than extending
`live_settings.json`, because live storage policy and signal rules are separate
domains.

Files:

- `<data_dir>/signal_alert_settings.json`
- `<data_dir>/signal_alerts/YYYYMMDD.jsonl`
- `<data_dir>/signal_alert_inbox_state.json`

`signal_alerts/YYYYMMDD.jsonl` is the append-only alert ledger for that date.
Inbox clear actions must not delete or truncate these files, because a later
date-based history view will read the full ledger.

`signal_alert_inbox_state.json` stores the right-rail inbox projection state:

```json
{
  "schema_version": 1,
  "cleared_through_seq_by_date": {
    "20260701": 42
  }
}
```

API:

- `GET /api/signal-alerts/settings`
- `PATCH /api/signal-alerts/settings`
- `GET /api/signal-alerts/recent?date=YYYYMMDD&limit=100&scope=inbox`
- `POST /api/signal-alerts/clear-today`

`scope=inbox` returns only alerts whose `seq` is greater than that date's
`cleared_through_seq`. This is the right-rail default. A later date-history UI
can add `scope=all` to read the full date ledger without changing the storage
format.

`clear-today` clears today's visible inbox only. It must acquire the same
alert-store lock used by the persistence queue, read today's latest alert `seq`,
write that value to `signal_alert_inbox_state.json` as
`cleared_through_seq_by_date[YYYYMMDD]`, and return the cleared date plus
`cleared_through_seq`. Alerts emitted after the clear receive larger `seq`
values, remain appended to the same date ledger, and appear normally after
refresh.

Event:

```json
{
  "type": "signal_alert",
  "id": "20260701:005930:sell_total_renewal:1779851250000:ws",
  "signal": "sell_total_renewal",
  "seq": 43,
  "code": "005930",
  "name": "삼성전자",
  "t_ms": 1779851250000,
  "date": "20260701",
  "source": "ws",
  "value": 1240000,
  "baseline": 1200000,
  "ratio_pct": 103.3,
  "use_intra_minute_max": true
}
```

Backend writes the event to JSONL before publishing to the WebSocket event bus.
`seq` is monotonically increasing within each date ledger and is the stable
boundary used by inbox clear state.

### Settings UI

Add a Settings side-menu item **시그널 알림**.

This page edits only parameters for **신고 매도 총잔량 갱신**:

- `알림 사용`
- `기준 시각` (`11:00` default)
- `기준 최대값 대비 문턱 (%)` (`100` default)
- `분봉 내 최대 매도 총잔량으로 판정`

Use existing settings row primitives and density. Do not put alert history here.

### Right Rail Alert Inbox

Add a new right rail item **알림** using the existing `RailButton` and
`RailShell` patterns.

Panel id: `signalAlerts`.

Panel content:

- header: `시그널 알림`
- status line: today's count and last received time
- header action: clear today's inbox
- alert list, newest first
- empty state when no alerts today

Row content:

```text
11:07:30  삼성전자 005930
매도 총잔량 1,240,000 · 기준 대비 103.3% · WS
```

Row click behavior:

1. Navigate to `/live`.
2. Open or focus the code in the live tab system.
3. Preserve `t_ms` in the alert payload and history so a later follow-up can
   add timestamp viewport centering without changing the event contract.

Unread state:

- New events prepend to the list.
- The right rail alert button shows an unread dot or count while the alert
  panel is not active.
- Opening the panel marks currently loaded alerts as seen in local UI state.
- Clearing the inbox also resets unread state for the cleared date.

Clear action:

- Use the existing compact panel-header action style, with a clear icon button
  and accessible label `오늘 인박스 비우기`.
- Disable the button when today's list is empty.
- On click, show an existing confirmation modal/popover pattern with copy:
  `오늘 시그널 알림 인박스를 비울까요? 기록은 날짜별 내역에 보관됩니다.`
- On confirm, call `POST /api/signal-alerts/clear-today`.
- On success, remove rows with `seq <= cleared_through_seq` for that date from
  the panel, reset today's visible count and unread badge, and keep listening
  for new `signal_alert` events.
- On failure, leave the list unchanged and show an app-local error toast.

### Toasts

On a `signal_alert` event, show an app-local toast:

```text
삼성전자 신고 매도 총잔량 갱신
1,240,000 / 기준 대비 103.3%
```

No system notification or sound in this scope.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Default 100% threshold | baseline 1,000 before 11:00; value 999 after | no alert |
| Exact renewal | baseline 1,000; value 1,000 after | emits one alert |
| 95% custom threshold | threshold 95; baseline 1,000; value 950 | emits one alert |
| Missing baseline | first snapshot after 11:00 | no alert |
| Date reset | alert emitted on date A, then date B starts | state clears |
| Rearm suppression | value stays near baseline after emit | no duplicate alert |
| Rearm then re-alert | value falls below rearm threshold then rises | emits second alert |
| Intra-minute max ON | minute values 900 then 1,000 | alert uses 1,000 |
| Intra-minute max OFF | minute values 1,000 then 900 | latest value governs |

**Invariant regression tests**:

- `plan_storage_targets` expectations stay unchanged.
- WebSocket event parsing accepts the new `signal_alert` event without breaking
  existing capture/inventory events.
- `rightRail` store can toggle `signalAlerts` mutually exclusively with
  `watchlist`, `screener`, and `savedViews`.

### Integration / component tests

- Settings API round trip for default and patched alert settings.
- WS path and REST path both feed monitor and publish the same event shape.
- Right rail alert panel renders loaded history.
- Incoming `signal_alert` prepends a row and increments unread count.
- Clicking a row opens/focuses the live stock tab.
- Clearing today's inbox hides existing rows, resets unread state, persists
  across a reload, and does not remove the date JSONL ledger.
- Settings `시그널 알림` category renders the four controls and no history list.

### Manual verification

1. Enable capture on a small watchlist folder.
2. Set threshold to a low value, such as `80%`, during market hours.
3. Confirm WS-backed and REST-backed targets can both generate alert rows.
4. Open the right rail **알림** panel and click a row.
5. Confirm `/live` opens the expected stock.
6. Refresh the browser and confirm today's alert history still loads.
7. Clear today's inbox, refresh again, and confirm the right rail stays empty
   until a new alert arrives.
8. Inspect the date JSONL and confirm cleared alerts remain on disk.

## Risks / Open Questions

- REST-backed alerts can miss a short-lived spike between 30-second snapshots.
  This is accepted and should be visible in copy or status.
- The monitor runs on hot WS paths, so implementation must stay allocation-light
  and avoid disk I/O directly in the per-tick path. Event persistence should run
  through a small async queue before publishing to the WebSocket event bus.

## Out of Scope (Backlog)

- Browser notifications and notification permission flow.
- Sound alerts.
- Alert rule builder for additional indicators.
- User-configurable rearm threshold.
- Filtering alert inbox by folder, source, or signal type.
- Date-based full alert history browser using the preserved JSONL ledgers.
- Centering the live chart viewport around the alert timestamp.
