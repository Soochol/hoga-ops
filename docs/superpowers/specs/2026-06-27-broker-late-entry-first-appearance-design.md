# 신규 거래원 등장 기준 변경 — Design

**Date**: 2026-06-27
**Status**: Draft for user review
**Scope**: `hoga/tables/brokers.py`, `hoga/api/bundle.py`, `hoga/api/routes.py`, `frontend/src/api/rangeRequest.ts`, `frontend/src/state/liveIndicatorsPersistence.ts`, `frontend/src/state/livePage.ts`, `frontend/src/live/indicators/BrokerLateEntryConfig.tsx`, and related tests.

## Problem

The current `신규 거래원 등장` indicator uses a rolling absence window. A broker-side pair can be detected when it appears after being absent for the configured number of minutes. The user wants to replace that rule.

New rule:

- In `매수만` mode, look only at the buy broker list after the 기준 시각. Detect a broker when it appears on the buy side after having never appeared on the buy side since that 기준 시각.
- In `매도만` mode, look only at the sell broker list after the 기준 시각. Detect a broker when it appears on the sell side after having never appeared on the sell side since that 기준 시각.
- In `둘다` mode, apply the same side-specific rule independently to `(broker, buy)` and `(broker, sell)`.

The existing `부재 시간 (분)` setting no longer matches the product behavior and should be removed.

## Goals

- Remove the `부재 시간 (분)` UI, persisted setting, frontend query option, API query parameter, and backend absence-window argument.
- Treat `broker + side` as the identity. A broker first appearing on buy and first appearing on sell are separate events.
- Start the seen set at the 기준 시각, not before it. Brokers observed before the 기준 시각 do not suppress a post-threshold event unless they are also observed after the 기준 시각 before the event time.
- Emit at most one event per `(broker, side)` per Stock-Date after the 기준 시각.
- Preserve the existing chart rendering, colors, and side-mode display filtering.

## Non-Goals

- Do not change how broker names are canonicalized.
- Do not infer brokers outside the recorded top-5 buy and top-5 sell snapshots.
- Do not add a new pane, tooltip, or label behavior.
- Do not change `기준 시각 (HHMM)` validation except as needed to keep the existing range safe.

## Behavior

For each Stock-Date, the backend reads broker snapshots in timestamp order. It ignores snapshots before the configured 기준 시각. Starting at the first snapshot at or after that time, it tracks seen `(broker, side)` pairs. The threshold is inclusive, so 기준 시각 `930` includes `09:30:00.000`.

For each timestamp at or after the 기준 시각:

1. Build the current buy-side broker set and sell-side broker set from recorded broker rows.
2. Canonicalize broker names before comparing identity.
3. For every current `(broker, side)` not in `seen`, emit one `BrokerLateEntryEvent`.
4. Add all current `(broker, side)` pairs to `seen`.

This means a broker present in the first post-threshold snapshot is detected at that first post-threshold timestamp. If the same broker disappears and later returns on the same side, it is not detected again. If the same broker appears on the other side for the first time, that other-side event is still detected.

## Data Flow

The wire model stays the same:

```ts
type BrokerLateEntryEvent = {
  t_ms: number;
  broker: string;
  side: 'buy' | 'sell';
  net: number;
};
```

The range request only needs:

```text
broker_late_entry_start_hhmm=930
```

Remove:

```text
broker_late_entry_window_minutes
```

Frontend side-mode remains a display filter. The backend may return both buy and sell events whenever the indicator is enabled; switching `둘다`, `매수만`, or `매도만` should not require a refetch.

## UI and Persistence

`BrokerLateEntryConfig` should keep:

- `기준 시각 (HHMM)`
- `표시 방향`
- `매수 색상`
- `매도 색상`

It should remove:

- `부재 시간 (분)`

Persistence should keep:

- `brokerLateEntryEnabled`
- `brokerLateEntryStartHHMM`
- `brokerLateEntrySideMode`
- `brokerLateEntryBuyColor`
- `brokerLateEntrySellColor`

Persistence should remove:

- `brokerLateEntryWindowMinutes`

Old persisted `brokerLateEntryWindowMinutes` values can be ignored during hydration. No migration UI is needed.

## Backend Changes

`query_late_entry_events` should no longer accept `absence_window_ms`. Its implementation should be a first-appearance scan over post-threshold rows:

- Collapse raw broker aliases into canonical broker names before identity comparison.
- Use `(broker, side, ts_ms)` as the collapsed row key.
- Group by timestamp and scan ascending.
- Emit only when `(broker, side)` is not yet in the post-threshold `seen` set.
- Keep `net` as the signed row total at the event timestamp.

The helper `_hhmmssms_to_midnight_ms` is no longer needed for absence-window arithmetic unless another caller uses it.

`build_broker_late_entries_slice`, `build_range_bundle`, and the route handler should stop accepting or threading `broker_late_entry_window_minutes`.

## Tests

Update or add tests around these cases:

- A broker present before 기준 시각 and present in the first post-threshold buy snapshot is emitted as a buy event, because post-threshold seen history starts at the 기준 시각.
- A broker emitted once on buy is not emitted again after disappearing and reappearing on buy.
- The same broker can emit once on buy and once on sell.
- Frontend range requests no longer include a `broker_late_entry_window_minutes` query parameter or query-key field.
- The indicator config no longer renders `부재 시간 (분)`.
- Persisted indicator normalization no longer exposes `brokerLateEntryWindowMinutes`.

## Acceptance Criteria

- The settings panel for `신규 거래원 등장` has no `부재 시간 (분)` field.
- With `매수만`, only first post-threshold buy-side appearances render.
- With `매도만`, only first post-threshold sell-side appearances render.
- With `둘다`, buy and sell first appearances are independent.
- The same `(broker, side)` does not render twice on the same Stock-Date.
- Range requests no longer include `broker_late_entry_window_minutes`.
