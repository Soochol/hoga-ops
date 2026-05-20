# 0003 — API timestamps are Unix epoch milliseconds (UTC)

**Status:** accepted (2026-05-20)

## Decision

Every timestamp field in any API response or request — `ts_ms` on entities, `regular_session_open_ms` / `_close_ms`, the cursor `t` query parameter on spot endpoints — uses **Unix epoch milliseconds (UTC)**. The Parquet tables on disk are left untouched; conversion happens at the `Api*` model boundary.

## Why

The Parquet tables today encode time in two incompatible ways:

| Source | `ts_ms` encoding | Example for 15:30:00 |
|---|---|---|
| `trades.parquet`, `snapshots.parquet`, `brokers.parquet` | HHMMSSmmm decimal-packed | `153000000` |
| `candles.parquet` | ms-from-midnight | `55800000` |
| `info.tsv` `session_open` / `session_close` | HHMMSSmmm decimal-packed | `153000000` |

These were each chosen to match the raw bytes hogaplay emits, which is reasonable for the parser write path — Parquet is a forensic store, and round-tripping the wire format preserves auditability. But pushing both encodings across the API forces every consumer (notably the upcoming frontend, but any analytical client too) to maintain its own conversion logic and remember which table uses which encoding. That's a footgun the moment one consumer writes `cursor_t = candle.ts_ms` and silently queries the wrong moment.

Two intra-day encodings also can't be aligned on a single time axis without picking one, which the frontend's compressed multi-day virtual axis (per `docs/superpowers/specs/2026-05-20-frontend-design.md` §6.3) requires. The conversion has to happen somewhere; doing it once at the API boundary is cheaper than doing it in every consumer.

Unix epoch ms was chosen over the alternatives below because (a) every charting library, every database, every standard library handles it natively; (b) it's monotonic across day boundaries, which matters for multi-day stitching; (c) it's the same scale on the cursor `?t=` query parameter as in response payloads, so there's no encode/decode asymmetry.

## Considered alternatives

- **Normalize at the Parquet write boundary.** Convert during parse, store Unix ms in Parquet. Rejected because it loses round-trip fidelity with hogaplay's wire format and forces a one-shot migration of any existing captures. Forensic value of "Parquet matches what hogaplay sent" is non-trivial — see `CONTEXT.md`'s **Entity** definition.

- **Normalize on the frontend only.** Each API consumer writes its own `hhmmssms_to_unix_ms(date, raw_ts)` and `ms_since_midnight_to_unix_ms(date, raw_ts)` helpers, plus knowledge of which table uses which encoding. Rejected: duplicates a stateful concern across consumers; the moment we have two consumers (frontend + a notebook script, say) the helpers fork.

- **Ship both encodings in API responses.** Add `ts_unix_ms` alongside `ts_ms`. Rejected as a half-measure that doubles JSON volume and leaves the question "which one should I use?" unresolved.

- **Pick ms-from-midnight as the API encoding** (not Unix). Rejected because it doesn't survive day boundaries — multi-day stitching needs a globally monotonic timestamp, and the frontend's `Segment.virtualStart` math is cleaner with absolute time.

## Consequences worth flagging for future readers

- **Conversion lives in `hoga/api/` as a helper.** Single source of truth — every `Api*` model uses it. Don't replicate the conversion logic in individual table modules. The helper signature is roughly `to_unix_ms(date_yyyymmdd: str, intra_day_value: int, encoding: Literal["hhmmssms", "ms_from_midnight"]) -> int`.

- **Cursor `?t=` query params accept Unix ms too.** The route handlers convert back to the encoding the underlying Parquet table expects before calling `snapshots_tbl.query_at(...)`. The conversion is symmetric to the response side.

- **Field names stay `ts_ms`.** The current name is technically accurate (the value really is in milliseconds — just not the right epoch). Renaming everywhere to `ts_unix_ms` would touch every model and consumer; the type comment in the model docstring is enough disambiguation.

- **Parquet files captured under the old wire format keep working.** No data migration. Existing captures keep their original `ts_ms` encoding in Parquet; the API helper just converts them on read.

- **Time zones.** Hogaplay is a KRX-only product; all timestamps are implicitly KST (UTC+9). The conversion helper applies the fixed `+09:00` offset when building the Unix ms value. No DST in Korea. If a future market with DST gets added, the helper grows a per-market timezone parameter — not the API.
