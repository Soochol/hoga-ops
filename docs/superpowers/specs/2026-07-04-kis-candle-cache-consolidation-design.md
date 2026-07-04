# KIS Candle Cache Consolidation Design

**Date**: 2026-07-04
**Status**: Draft
**Scope**: `hoga/live/past_candles_cache.py`, `hoga/live/past_daily_candles_cache.py`, KIS candle routes, live/study fallback behavior

## Problem

KIS candle data currently sits in two ad hoc cache models:

- KIS minute candles are persisted as JSON under `<data_dir>/kis-past-candles/...`.
- KIS daily candles are process-memory only.

That split makes the storage story hard to reason about. It is tempting to move KIS candles into:

```text
<data_dir>/parquet/<YYYYMMDD>/<CODE>/kis_api/candles.parquet
```

But that path already means "official chart source" in hoga-ops. Putting cache-only KIS candle artifacts there would create a misleading hybrid:

```text
path says: official /api/range source
role says: KIS refetch-prevention cache
```

The goal of this follow-up is not to redesign `/api/range` or promote KIS candles into a full source. The goal is to make KIS candle caching explicit, durable, and less scattered.

## Decision

KIS candles remain a **KIS Candle Cache**, not an official `parquet/<date>/<code>/<source>/` chart source.

The cache may use Parquet as its on-disk file format, but it must live outside the official source tree.

Recommended namespace:

```text
<data_dir>/cache/kis-candles/minute/<venue>/<code>/<YYYYMMDD>.parquet
<data_dir>/cache/kis-candles/daily/<venue>/<code>/<from>-<to>.parquet
```

`KRX` may either be stored explicitly as `minute/KRX/...` or normalized through a compatibility reader from the old KRX path. New writes should use the explicit venue path to avoid hidden special cases.

## Design Principles

### File Location States Role

The official source tree remains reserved for chart sources:

```text
<data_dir>/parquet/<date>/<code>/<source>/
```

If data appears under that path, code and operators may expect:

- `meta.json` source classification.
- participation in Source Preference and fallback rules.
- eligibility for inventory/disk-state validation.
- readability through `/api/range`.

KIS candle cache artifacts do not satisfy that contract. They are fetched KIS candle responses retained to avoid repeated KIS REST calls and to survive restarts where appropriate.

### `/api/range` Stays a Stored Source Read Path

This design does not make `/api/range` read KIS candle cache files. `/api/range` continues to read official stored sources such as `hogaplay`, `kis_live`, and existing `kis_api` promoted REST captures.

KIS candle endpoints continue to own KIS candle behavior:

```text
GET /api/live/past-candles
GET /api/live/past-daily-candles
```

They read the KIS Candle Cache, fetch missing data only when KIS REST is allowed, and return cache-only warnings when KIS REST Bypass is ON.

### Cache Is Not Source Preference

KIS Candle Cache does not participate in Source Preference. Source Preference remains about official chart sources:

```text
hogaplay -> kis_live -> kis_api
```

KIS Candle Cache is a route-local optimization and resilience layer for KIS candle endpoints.

### Bypass Semantics Remain Simple

When `kis_rest_bypass_enabled=true`:

```text
KIS candle endpoint -> read cache only
cache hit -> return candles
cache miss -> return no candles + kis_rest_bypassed warning
never call KIS REST
```

When bypass is OFF:

```text
KIS candle endpoint -> read cache first
cache hit -> return candles
cache miss -> fetch KIS -> write cache -> return candles
```

## Storage Format

Use Parquet for new durable cache writes.

### Minute Cache

One file per `(venue, code, date)`:

```text
cache/kis-candles/minute/<venue>/<code>/<YYYYMMDD>.parquet
```

Schema:

```text
t_ms: int64
open: float64
high: float64
low: float64
close: float64
volume: int64
fetched_at_ms: int64
kis_tr_id: string
venue: string
```

The logical candle fields mirror the existing JSON cache. Metadata columns may be repeated per row for simplicity, or stored in a sidecar metadata file if the writer utilities make that cleaner. The first implementation should prefer the simplest reader/writer that preserves atomic writes and schema validation.

### Daily Cache

Daily cache becomes durable instead of memory-only.

One file per fetched `(venue, code, from, to)` batch is acceptable for the first implementation:

```text
cache/kis-candles/daily/<venue>/<code>/<from>-<to>.parquet
```

Schema:

```text
t_ms: int64
open: float64
high: float64
low: float64
close: float64
volume: int64
fetched_at_ms: int64
kis_tr_id: string
venue: string
batch_from: string
batch_to: string
```

The route may keep an in-memory index of durable batches for speed, but disk remains the durable source of cache truth.

### Today Cache

Today's cache stays memory-first in the first implementation because it is intentionally short-lived. If persisted later, it must be separated from past immutable cache files and carry a TTL or fetched date in metadata.

The first implementation should keep today's existing memory TTL unless there is a concrete restart-resilience requirement. That keeps the change focused on past minute JSON replacement and daily durability.

## Legacy Migration

Existing files under:

```text
<data_dir>/kis-past-candles/...
```

remain readable during migration.

Recommended migration policy:

1. New writes go to `cache/kis-candles/minute/...parquet`.
2. Reads check the new Parquet cache first.
3. If missing, reads may check the legacy JSON cache.
4. On a valid legacy JSON hit, optionally write-through to the new Parquet cache.
5. After a stabilization period, remove the legacy JSON reader.

No eager migration job is required for the first implementation. Lazy migration avoids a broad disk rewrite and keeps failure scope small.

## Endpoint Behavior

### `/api/live/past-candles`

The route keeps its current public contract.

Internally:

```text
read minute parquet cache
fallback to legacy JSON during migration
if allowed and still missing, fetch KIS
write parquet cache
return existing response shape
```

Under bypass:

```text
read cache only
do not fetch KIS
return kis_rest_bypassed warnings for misses
```

### `/api/live/past-daily-candles`

The route keeps its current public contract.

Internally:

```text
read daily parquet batch cache
read today memory cache for today only
if allowed and gaps remain, fetch KIS
write durable daily cache for fetched past batches
return existing response shape
```

Under bypass:

```text
read durable daily cache + today memory cache only
do not fetch KIS
return kis_rest_bypassed warnings for missing gaps
```

## Live and Study Fallback

This design does not force `/live` or `/study` to stop using the KIS candle endpoints. The recent bypass work already keeps stored-data fallbacks alive:

- minute fallback can use `/api/range?mode=full`.
- daily fallback can use screener daily where appropriate.
- KIS candle endpoints can return cache-only data during bypass.

The cache consolidation makes those endpoint responses durable and less scattered; it does not attempt to make `/api/range` read the KIS candle cache.

## Non-Goals

- Do not put KIS candle cache files under `parquet/<date>/<code>/kis_api/`.
- Do not make KIS candle cache a Source Preference participant.
- Do not make `/api/range` read KIS candle cache files.
- Do not remove `/api/live/past-candles` or `/api/live/past-daily-candles`.
- Do not redesign screener daily storage.
- Do not eagerly migrate every legacy JSON cache file in one job.
- Do not persist today's short-lived KIS candle cache in the first implementation.

## Success Criteria

- KIS minute past candles are written to the new cache namespace as Parquet for new fetches.
- KIS daily past candles survive process restart through durable cache files.
- Existing legacy minute JSON cache remains readable during migration.
- KIS REST Bypass still causes cache-only reads with no KIS REST calls.
- `/api/range` behavior is unchanged.
- Source Preference behavior is unchanged.
- Focused tests cover:
  - minute cache write/read in new namespace.
  - legacy JSON fallback and optional lazy write-through.
  - daily durable cache read after new cache instance construction.
  - bypass cache-hit and cache-miss behavior with no KIS call.
  - corrupt cache handling as miss without crashing.

## Open Implementation Choices

These should be answered in the implementation plan:

- Whether to store cache metadata as repeated Parquet columns or a small sidecar JSON file.
- Whether daily cache should use one file per fetched batch or one normalized file per `(venue, code)`.
- Whether lazy migration writes are enabled by default or only after a successful legacy read in non-bypass mode.
