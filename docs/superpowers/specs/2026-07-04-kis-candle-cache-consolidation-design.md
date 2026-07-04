# KIS Candle Cache Consolidation Design

Date: 2026-07-04
Status: Implemented
Owner: Codex + user

Implemented by replacing minute KIS candle disk JSON reads/writes with bounded
process memory and retaining KIS REST Bypass as the central scheduled-call gate.
Existing `kis-past-candles` files are legacy artifacts and are not read by the
runtime cache.

## Problem

When KIS REST is unavailable or the user enables KIS REST Bypass, `/live` must stop treating KIS candles as if they are durable data. The current shape is split:

- Minute candles use `GET /api/live/past-candles` and have a disk JSON cache under the old `kis-past-candles` namespace.
- Daily candles use `GET /api/live/past-daily-candles` and are memory-only.
- Official chart data for `/api/range` comes from parquet-backed sources such as `hogaplay` and `kis_live`, not from KIS candle cache.

This creates a confusing middle ground: KIS candle cache looks like stored data, but it is not part of Source Preference, Inventory, DiskState, or `/api/range` completeness. It also risks disk growth from data that the user does not want to preserve.

## Decision

KIS Candle Cache is process memory only.

Do not create a new disk cache namespace. Do not put KIS candles under the official parquet source tree. Do not make `/api/range` read KIS candle cache.

The durable-data rule becomes:

- Stored chart data remains the official source tree and screener corpus.
- KIS candles are temporary live-page fetch results.
- If KIS REST is bypassed or unavailable, only memory cache hits can satisfy KIS candle endpoints.
- If memory has no matching KIS candle data, the UI should show the existing available stored data paths or an empty/warned gap. It should not silently hit KIS.

## Scope

In scope:

- Convert minute KIS candle cache from disk-backed JSON to process memory.
- Keep daily KIS candle cache process memory only.
- Ensure KIS REST Bypass is honored before any KIS candle fetch or live quote fetch path calls KIS.
- Surface cache-miss state clearly through warnings such as `kis_rest_bypassed`.
- Stop writing new `kis-past-candles` JSON files.
- Treat existing `kis-past-candles` files as legacy artifacts, not runtime cache.

Out of scope:

- Persisting KIS candles into parquet.
- Reading KIS candle cache from `/api/range`.
- Reclassifying KIS candles as a Source.
- Changing screener daily corpus refresh semantics.
- Auto-deleting old disk cache files without an explicit cleanup command or user action.

## Target Behavior

### KIS REST Available

1. `/live` asks for a minute or daily candle range.
2. Backend checks process memory.
3. Cache hit returns immediately.
4. Cache miss fetches KIS through the centralized KIS REST policy.
5. Successful KIS response is stored in process memory and returned.

### KIS REST Bypass Enabled

1. `/live` asks for a minute or daily candle range.
2. Backend checks process memory.
3. Cache hit returns.
4. Cache miss returns no KIS candle fetch result and includes a warning.
5. No KIS REST call is attempted.

### KIS REST Transport Failure

1. Centralized KIS REST policy classifies transport failure.
2. The app may suggest or apply KIS REST Bypass depending on the existing UX policy.
3. Subsequent candle requests follow the bypass behavior above.

## Data Ownership

| Data | Durable? | Storage | Reader |
| --- | --- | --- | --- |
| Hogaplay minute/hoga data | Yes | `parquet/<date>/<code>/hogaplay/...` | `/api/range` |
| KIS live promoted snapshots/trades/brokers | Yes | `parquet/<date>/<code>/kis_live/...` | `/api/range` |
| Screener daily corpus | Yes | existing screener storage | screener/study daily paths |
| KIS minute candles | No | process memory | `/api/live/past-candles` |
| KIS daily candles | No | process memory | `/api/live/past-daily-candles` |
| Legacy `kis-past-candles` JSON | No | old disk artifact | no new runtime dependency |

## Implementation Notes

1. Replace minute disk cache writes with a bounded in-memory cache keyed by code, venue, date or requested normalized batch.
2. Reuse or align with the daily in-memory cache shape where practical.
3. Make KIS REST policy the first gate in all KIS-calling paths:
   - live quotes
   - minute candles
   - daily candles
   - investor net, if covered by the same user-facing bypass setting
4. Keep `/api/range` untouched for KIS candle cache.
5. Mark old JSON disk cache as deprecated in code/docs. Do not write through to it. Do not migrate it into parquet.
6. If cleanup is needed, add a separate explicit command or maintenance action later.

## UX Notes

The UI should explain this simply:

- KIS API 사용 중: KIS에서 새 캔들을 가져올 수 있음.
- KIS API 우회 중: 이미 메모리에 있는 KIS 캔들만 표시.
- 메모리에 없으면 저장된 데이터만 표시하거나 빈 구간으로 남김.

This matches the user preference: when KIS is unavailable, daily comes from screener-backed stored data where available, minute comes from hogaplay-backed stored data where available, and missing data is shown as missing instead of creating another storage system.

## Acceptance Criteria

- Enabling KIS REST Bypass prevents all covered KIS REST calls, including background live quote calls and candle backfill calls.
- `/api/live/past-candles` no longer writes new JSON disk cache files.
- `/api/live/past-daily-candles` remains memory-only.
- Restarting the backend clears KIS candle cache and does not count as data loss.
- `/api/range` behavior and Source Preference remain unchanged.
- Tests cover:
  - minute memory cache hit
  - minute memory cache miss with KIS available
  - minute memory cache miss with KIS bypassed
  - daily memory cache hit/miss with bypass
  - no disk write on KIS candle fetch
  - live quote/background path honoring bypass

## Open Follow-Up

KIS candles can be promoted into official parquet later only if they become a real product requirement. That should be a separate ADR-level decision because it changes Source semantics, completeness rules, and data ownership.
