# 0078 — Live KIS Candle Venue Routing

**Status:** accepted (2026-06-18)

**Related:**
- ADR-0039 — Source Preference + fallback
- ADR-0040 — Live Candle Backfill separate cache + wire
- ADR-0048 — /live D-direct daily backfill
- ADR-0061 — Source resolvers stay separate
- ADR-0067 — Live Capture WS/rest display division

## Decision

`/live` exposes a KIS candle venue setting with four UI labels:

- `KRX`: KIS `FID_COND_MRKT_DIV_CODE=J`
- `NXT`: KIS `FID_COND_MRKT_DIV_CODE=NX`
- `통합`: KIS `FID_COND_MRKT_DIV_CODE=UN`
- `자동`: minute candles use KRX during `09:00:00~15:30:00` KST and NXT outside that window; daily candles use KIS integrated (`UN`) bars.

The canonical domain term is **KIS Venue**, not `market`. `market` already means KOSPI/KOSDAQ in the Symbol Master/Screener corpus. This setting is also not **Source Preference**; Source remains the captured artifact label (`hogaplay` / `kis_live`) and keeps Stock-Date-level preference+fallback semantics.

## Why

KIS candle endpoints directly support KRX, NXT, and integrated venue selection. Users need to inspect the same `/live` candle and volume chart under those venue interpretations without changing `/replay`, `/api/range`, or promoted Parquet.

`자동` is intentionally intraday-only for minute candles. A daily bar cannot preserve an intraday venue split, so `AUTO` daily uses KIS `UN` and surfaces `auto_daily_uses_integrated` in `data_warnings`.

## Consequences

- Live Candle Backfill cache keys include the concrete KIS Venue so KRX, NXT, and UN bars never share stale data.
- Minute `AUTO` merges KRX and NXT bars by timestamp with deterministic precedence: KRX owns the Regular Session, NXT owns extended minutes.
- NXT/UN/AUTO minute display bounds expand to `08:00~20:00` KST.
- Existing hoga panes, quote-derived indicators, and WS live data remain KRX/Parquet based. The status bar labels non-KRX candle modes as `호가 KRX` to avoid implying NXT WS support.
- KIS `UN` is treated as authoritative integrated OHLCV; the app does not manually sum KRX and NXT volume.

## Revisit

Revisit this ADR if:

- NXT websocket/orderbook support is added.
- KIS changes `UN` semantics or returns evidence that manual KRX+NXT reconciliation is required.
- `/replay` or `/api/range` adopts KIS candle backfill as promoted Parquet.
