# /live Representative Index Instruments

Date: 2026-06-22
Status: Approved for implementation planning

## Goal

Add representative Korean market indices to `/live` so the user can search and
open an index the same way they open a stock, then view an index chart in the
existing live chart workspace.

Indices must not pretend to be normal six-digit stock Codes. They use KIS index
APIs, have different supported indicators, and must never flow into stock
orderbook, stock investor, stock quote, or `/api/range` hoga paths.

## Scope

The initial index universe is deliberately small:

- KOSPI
- KOSDAQ
- KOSPI200
- KOSDAQ150
- KRX100 and/or KRX300, only if KIS returns usable data for the index

The KRX family entry is runtime-verified. If neither KRX100 nor KRX300 is
supported by the KIS index endpoint in this environment, neither is shown in
the `/live` search results.

Out of scope:

- Full index/sector search.
- Watchlist capture membership for indices.
- Hoga-derived indicators for indices.
- Proxying investor data from a broader market onto a narrower index.

## References

KIS official API portal lists index APIs separately from stock quote APIs under
`[국내주식] 업종/기타`, including domestic index current values, date values,
time-series values, minute index lookup, index period chart prices, and domestic
index realtime WebSocket feeds:

- https://apiportal.koreainvestment.com/apiservice
- https://apiportal.koreainvestment.com/apiservice-apiservice?%2Fuapi%2Fdomestic-stock%2Fv1%2Fquotations%2Finquire-daily-indexchartprice=

## Domain Model

Introduce a `LiveInstrument` concept at the `/live` boundary.

```ts
type LiveInstrument =
  | { kind: 'stock'; code: string; label: string }
  | { kind: 'index'; id: string; label: string; kisIndexCode: string };
```

`stock.code` remains the existing six-digit KRX Code. `index.id` is an internal
stable identifier such as `KOSPI` or `KOSDAQ150`; `kisIndexCode` is the KIS
index/industry code used for REST calls.

The existing `activeCode` contract should remain available for stock consumers
while implementation migrates:

- `activeInstrument` is the canonical `/live` view identity.
- `activeCode` is projected only when `activeInstrument.kind === 'stock'`.
- Stock-only hooks continue to accept `activeCode` and remain disabled for
  index instruments.

Live tabs persist the instrument, not just a code string. Migration from the
current `live.tabs.v1` shape converts each persisted tab into a stock
instrument.

## Search UX

`LiveSymbolSearch` includes fixed index entries alongside symbol master hits.
Index rows render with an explicit `지수` badge. Selecting an index replaces the
current Live Tab's instrument in place, matching the current stock navigation
model.

Search ordering:

1. Exact/prefix matches among indices.
2. Existing stock symbol search results.
3. Substring matches among indices if no exact/prefix index matched.

This keeps common typed queries like `kos`, `kosdaq`, and `150` useful without
making the index list dominate normal stock search.

## Backend API

Add index-specific live endpoints:

```http
GET /api/live/indices
GET /api/live/index-candles?index=KOSPI&from=YYYYMMDD&to=YYYYMMDD&timeframe=1m|3m|5m|10m|15m|30m|D|W|M
GET /api/live/index-investor-net?index=KOSPI&from=YYYYMMDD&to=YYYYMMDD
```

`/api/live/indices` returns the representative index catalog and support flags.
It performs or reads a cached KIS capability check for KRX100/KRX300. Failures
do not break `/live`; unsupported or unverified KRX entries are simply absent.

`/api/live/index-candles` returns the same candle row shape used by live stock
past-candle hooks:

```ts
type LiveIndexCandle = {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
```

The handler maps `1m` through `30m` to KIS index minute/time APIs, with client or
server aggregation following the existing stock minute-frame policy. It maps
`D`, `W`, and `M` to the KIS index period chart endpoint.

`/api/live/index-investor-net` is optional per index. It returns market/index
investor rows only when KIS provides a matching market or index-level investor
API. Empty unsupported responses are normal and should hide the investor panes.

## KIS Client

Add methods on `KisClient` instead of overloading stock candle methods:

- `fetch_index_minute_candles(index_code, date_yyyymmdd, *, foreground=False)`
- `fetch_index_daily_candles(index_code, from_yyyymmdd, to_yyyymmdd, *, period='D', foreground=False)`
- `fetch_market_or_index_investor_net(index_id, from_yyyymmdd, to_yyyymmdd)`

They should reuse the existing token, rate-limit, transport-error, and defensive
parse conventions from stock KIS methods. Index OHLC rows still enforce:

- positive close
- `high >= max(open, close)`
- `low <= min(open, close)`
- monotonic `t_ms` after sorting

Invalid rows are dropped and surfaced as `data_warnings`, not thrown into the
chart path.

## Frontend Data Flow

Create index hooks parallel to the stock hooks:

- `useLiveIndices()`
- `useLiveIndexCandles(indexId, from, to, timeframe)`
- `useLiveIndexInvestorNet(indexId, from, to)`

Wrap the stock/index split in a new orchestration hook:

```ts
function useLiveInstrumentBundle(
  instrument: LiveInstrument | null,
  timeframe: LiveTimeframe,
  todayKstYyyymmdd: string,
  liveStockSeries: LiveSeriesData,
  options: UseLiveBundleOptions,
): UseLiveBundleResult
```

For stock instruments, it delegates to the existing `useLiveBundle`.

For index instruments, it builds a `RangeBundle`-compatible chart bundle from
index candles and optional investor points, with empty hoga series:

- `quote_ratio.points = []`
- `fill_strength.points = []`
- `ask_peaks = []`
- `bid_peaks = []`

Index mode never calls:

- `useLiveSeries`
- `useRange`
- `useLivePastCandles`
- `useLivePastDailyCandles`
- `useDayAskPeaks`
- `useDayBidPeaks`

Those remain stock-only.

## Indicator Policy

Always hidden for index instruments:

- 총잔량
- 호가비
- 체결강도
- 당일 매도 최대벽
- 당일 매수 최대벽

Allowed for index instruments:

- candle pane
- volume pane
- current-timeframe moving average
- daily moving average
- high/low extreme labels
- drawings and viewport behavior

Investor panes:

- KOSPI uses market-level investor data for the KOSPI market if KIS supports it.
- KOSDAQ uses market-level investor data for the KOSDAQ market if KIS supports it.
- KOSPI200, KOSDAQ150, KRX100, and KRX300 show investor panes only if KIS has a
  directly matching investor feed for that index.
- No broader-market proxy is shown for narrower indices.

In index mode, the indicator panel hides unavailable groups instead of showing
disabled controls. This keeps the panel honest: unsupported hoga indicators are
not user-configurable for indices.

## Status Bar And Title

The `/live` status bar and browser title should use the active instrument label.
Stock quote fields still come from the existing live quote path. Index current
price/change should come from the index candle right edge or index current-value
endpoint, not from stock `intstock-multprice`.

If index current quote data is unavailable, show the index label and latest
candle close where available.

## Caching And Failure Behavior

Index historical candles can use a memory cache like daily stock candles for v1.
Disk persistence is not required until data volume or repeated cold-start cost
proves it worthwhile.

KIS credentials missing:

- Stock behavior stays unchanged.
- Index search can still show static entries only if the app chooses to expose
  them, but opening an index should render the normal KIS credentials banner and
  no chart data.

KIS rate-limit or API errors:

- Return partial/empty data with `data_warnings`.
- Keep the chart mounted.
- Do not fall back to stock paths.

## Testing

Backend:

- representative index catalog filters unsupported KRX100/KRX300 entries
- index candle route validates parameters and rejects unknown index ids
- KIS index daily/minute parsers drop malformed rows and surface warnings
- unsupported investor data returns empty rows without 500

Frontend:

- search shows stock and index hits and selecting an index sets a live tab
  instrument
- stock tabs migrate from old persisted tab snapshots
- index bundle does not call stock-only hooks
- hoga indicator categories are hidden for index instruments
- investor panes show only when index investor data exists
- switching stock -> index -> stock does not leak prior stock hoga series

Browser QA:

- open KOSPI and KOSDAQ from search
- verify minute and daily timeframes render nonblank candles
- verify hoga indicator group is absent on index tabs
- verify stock tab behavior is unchanged after switching back

## Open Implementation Notes

`activeInstrument` lands in `useLivePageStore` as an adjacent canonical field
while `activeCode` remains the stock-only compatibility projection. The
implementation should then move `/live` readers to instrument-aware selectors
incrementally. This keeps existing stock behavior stable while the index path is
introduced.

No implementation should begin until the written implementation plan resolves
the exact KIS index code table for the representative catalog and records the
observed KIS responses for KRX100/KRX300.
