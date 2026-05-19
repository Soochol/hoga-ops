# Hogaplay TSV Schema Notes

Captured from `hogaplay.com/player/*.php` endpoints. All responses are tab-separated text. Authentication via cookies (`k_`, `n_`).

## Endpoints

| Endpoint | Query | Returns |
|---|---|---|
| `info.php` | `date, code` | Single line, 22 fields — stock metadata |
| `first.php` | `date, code, time` | Multi-line, mixed event types — orderbook + trade stream from `time` onward (paginated, ~500–1000 events per call) |
| `chart.php` | `date, code, time, bong, gap` | Multi-line, 11 fields per row — candles ending at or before `time` |

**Pagination model (first.php)**: each call returns one **Page** — events with `event_time >= time` capped at a fixed-size response cap. To advance, re-call with a later `time` value (see `Page Step` in CONTEXT.md). Confirmed: `time=90000000` returned 502 events ending at `90248675`; `time=90300000` returned 665 more events.

**Time encoding**: `HHMMSSmmm` as integer. E.g., `90008618` = 09:00:08.618. `153000000` = 15:30:00.000.

## info.tsv (22 fields)

```
1  005930  삼성전자  0  90000000  153000000  520235  83000216  160000326  30186229  8264833  274000  281500  266000  275500  365000  197000  281000  269500  271000  267000  267500
```

| # | Field | Example | Notes |
|---|---|---|---|
| 1 | status | `1` | always 1 in samples |
| 2 | code | `005930` | KRX ticker, 6 digits |
| 3 | name | 삼성전자 | Korean name |
| 4 | ? | `0` | unknown |
| 5 | session_open | `90000000` | 09:00:00.000 (hogaplay's field name; parser renames to `regular_session_open_ms` per CONTEXT.md) |
| 6 | session_close | `153000000` | 15:30:00.000 (hogaplay's field name; parser renames to `regular_session_close_ms` per CONTEXT.md) |
| 7 | total_events_for_day | `520235` | total tick count for day (TBC) |
| 8–9 | relative_open / relative_close | `83000216 / 160000326` | time-base offsets |
| 10 | total_volume | `30186229` | day volume (shares) |
| 11 | total_trades_or_value | `8264833` | TBC |
| 12 | prev_close | `274000` | yesterday's close |
| 13 | upper_limit | `281500` | upper price limit (+30%) |
| 14 | lower_limit | `266000` | lower price limit (-30%) — wait, should be -30%. Verify |
| 15 | today_open | `275500` | |
| 16 | high_52w | `365000` | TBC |
| 17 | low_52w | `197000` | TBC |
| 18 | today_high | `281000` | |
| 19 | today_low | `269500` | |
| 20 | today_close | `271000` | latest price |
| 21–22 | ? | `267000, 267500` | unknown — VWAP? prev high/low? |

## first.tsv — union of event types

Each row's `(field1, field2)` determines event type and field count.

| Section | Type | Count | Fields | Meaning |
|---|---|---|---|---|
| 1 | 1 | 19 | trade schema | **History trades** — trades that occurred before the requested `time` |
| 1 | 2 | 71 | orderbook schema | **Initial orderbook snapshot** at `time` |
| 1 | 3 | 11 | special | **Pre-market summary** (single row, ~08:40) |
| 2 | 1 | 19 | trade schema | **Streaming trade** (체결) |
| 2 | 2 | 71 | orderbook schema | **Streaming orderbook update** |
| 2 | 4 | 43 | broker schema | **상위 거래원** (top 5 buy/sell brokers) |

Section 1 = preamble (state up to request time). Section 2 = events after request time.

### Trade schema (19 fields) — `(*, 1)`

```
2  1  24  2122  90008618  32408618  274000  -2.49  +4  789300  216275  274000  274500  274000  -32765914  2.35  0.01  500.00
```

| # | Field | Example | Notes |
|---|---|---|---|
| 1 | section | `2` | 1=history, 2=live |
| 2 | event_type | `1` | trade marker |
| 3 | trade_seq | `24` | per-stock trade counter |
| 4 | global_seq | `2122` | event counter across all types |
| 5 | event_time | `90008618` | HHMMSSmmm |
| 6 | rel_time | `32408618` | relative offset |
| 7 | trade_price | `274000` | won |
| 8 | change_pct | `-2.49` | percent vs prev_close |
| 9 | qty_signed | `+4` / `-3` / `788290` | **CRITICAL**: signed trade quantity. `+` = buy-aggressor (매수체결), `-` = sell-aggressor (매도체결). Unsigned values (e.g., `788290`) mark **Auction Cross** trades — call-auction matchings at the open, close, and pre-market single-price periods. `cum_volume` (field 10) always increases by `\|qty_signed\|`. Parser stores `qty = abs(field9)` and `side = +1 / -1 / 0` (0 for auction cross). |
| 10 | cum_volume | `789300` | day cumulative shares traded |
| 11 | cum_trade_count | `216275` | day cumulative number of trades |
| 12 | low_so_far | `274000` | Regular Session low up to this point |
| 13 | high_so_far | `274500` | Regular Session high up to this point |
| 14 | ? | `274000` | maybe VWAP or prev_trade_price |
| 15 | net_pressure | `-32765914` | signed cumulative — net buy minus sell volume (negative = sell-heavy) |
| 16 | ? | `2.35` | ratio |
| 17 | ? | `0.01` | ratio |
| 18 | ? | `500.00` | ratio — often 500 exactly, suspicious (possibly avg trade size?) |

TODO: confirm fields 14, 16–18 by sampling more.

### Orderbook schema (71 fields) — `(*, 2)`

Korean 10-level bid/ask board.

```
2  2  835  847  90000435  32400435  [ask price 1..10] [ask qty 1..10] [ask qty delta 1..10] [bid price 1..10] [bid qty 1..10] [bid qty delta 1..10] [tot_ask_qty] [tot_ask_delta] [tot_bid_qty] [tot_bid_delta]  <trailing tab>
```

| # range | Field | Notes |
|---|---|---|
| 1 | section | 1 or 2 |
| 2 | event_type | 2 |
| 3 | ob_seq | per-stock orderbook counter |
| 4 | global_seq | global counter |
| 5 | event_time | HHMMSSmmm |
| 6 | rel_time | offset |
| 7–16 | ask_price[1..10] | best ask at index 7, increasing (1호가 = best) |
| 17–26 | ask_qty[1..10] | |
| 27–36 | ask_qty_delta[1..10] | change since last snapshot (signed) |
| 37–46 | bid_price[1..10] | best bid at index 37, decreasing (1호가 = best) |
| 47–56 | bid_qty[1..10] | |
| 57–66 | bid_qty_delta[1..10] | signed |
| 67 | total_ask_qty | sum of asks |
| 68 | total_ask_delta | signed |
| 69 | total_bid_qty | sum of bids |
| 70 | total_bid_delta | signed |
| 71 | (trailing) | empty after final tab |

### Broker schema (43 fields) — `(2, 4)`

```
2  4  0  912  90019919  32419919  [5 sell broker names] [5 sell qty today] [5 sell qty delta] [5 buy broker names] [5 buy qty today] [5 buy qty delta] [7 misc totals]
```

The first 5-qty group seems to be today's cumulative; the second 5-qty group is delta since last broker update (TBC by checking multiple events).

TODO: nail down the last 7 fields.

### Pre-market schema (11 fields) — `(1, 3)`

```
1  3  10  11  84000352  31200352  0  0  501  0
```

Single row, ~08:40 timestamp. Likely 시간외/장전 single-shot summary. Last 4 fields meaning unclear — possibly `(open_qty, ?, last_qty, ?)`.

## chart.tsv (11 fields per candle)

```
30600000  08:30:00  281000  281000  281000  281000  119  0  0  43  5
```

| # | Field | Notes |
|---|---|---|
| 1 | rel_time | candle-end relative time (ms) |
| 2 | wallclock | HH:MM:SS string |
| 3 | open | won |
| 4 | close | won |
| 5 | high | won |
| 6 | low | won |
| 7 | vol_a | buy market volume? TBC |
| 8 | vol_b | sell market volume? TBC |
| 9 | ? | always 0 in samples so far |
| 10 | cum_vol_a | running total (matches column 7 cumulative) |
| 11 | cum_vol_b | running total |

Sort order: **descending by time** (latest candle first). Need to reverse for chart libraries.

`bong` controls candle type, `gap` is interval in ms (60000 = 1m). Other gaps to probe: 300000 (5m), 600000 (10m), 1800000 (30m).

## Open questions (not blocking design)

1. Exact meaning of info fields 11, 16–17, 21–22.
2. Trade schema fields 14, 16–18.
3. Broker schema final 7 totals.
4. ~~First-trade `qty_signed` has no `+`/`-` sign~~ — **resolved**: unsigned values mark **Auction Cross** trades (call-auction matchings, no aggressor). Stored as `side = 0`.
5. Does first.php enforce a hard cap (count) or a time-window cap (event_time horizon)?
6. Is there a separate endpoint for upticks/downticks per price level (체결강도)?

## Capture strategy implications

- **Idempotent collection**: store one **Stock-Date** worth of raw TSVs; re-runs overwrite identically. Pagination loop keeps calling `first.php` until the **Data Window** end is reached (or response is empty).
- **No WebSocket needed** for historical replay. All data accessible via plain GET + cookie.
- **Estimated volume**: Samsung produced 526 events in ~169 sec of data. A 6.5h Regular Session would be ~70K events; large caps with active hoga changes could hit ~500K events. Storage as Parquet with proper typing fits in ~1–10 MB per Stock-Date.
