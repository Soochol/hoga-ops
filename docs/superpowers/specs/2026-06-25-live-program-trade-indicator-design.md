# /live 프로그램 순매수 시간순 지표 — Design

**Date**: 2026-06-25
**Status**: Approved for implementation planning
**User-approved decisions**:
- Scope: 관심종목 대상 KIS REST polling.
- Data source: KIS `program-trade-by-stock` REST, not WebSocket.
- Storage: continuously merge polling rows to disk so today becomes future historical data.
- Data-source policy: follow the recommended settings behavior; program-trade storage is a separate REST storage toggle that is available only when the selected storage policy allows REST storage.
- Chart: x-axis is intraday time, y-axis is cumulative program net buy.
- Accuracy target: latest cumulative value must be right; intermediate point completeness is best-effort.

## Problem

The user wants a chart indicator that shows time-ordered program net buy for both today and past days. KIS provides a stock-level program-trade REST endpoint:

- API: `/uapi/domestic-stock/v1/quotations/program-trade-by-stock`
- TR ID: `FHPPG04650101`
- Parameters: `FID_COND_MRKT_DIV_CODE=J`, `FID_INPUT_ISCD=<code>`
- Relevant fields:
  - `bsop_hour`: intraday time.
  - `whol_smtn_ntby_qty`: cumulative program net-buy quantity.
  - `whol_smtn_ntby_tr_pbmn`: cumulative program net-buy trade amount.
  - `whol_ntby_vol_icdc`: net-buy quantity delta.
  - `whol_ntby_tr_pbmn_icdc`: net-buy amount delta.

Live probing on 2026-06-25 against `005930` confirmed that the endpoint returns a rolling `output` window of 30 rows. A second call 35 seconds later produced five new `bsop_hour` rows and dropped five older rows. This means the app must persist rows during the session; otherwise historical intraday flow cannot be reconstructed reliably after the rolling window moves on.

## Goals

- Persist program-trade rows for watchlist stocks while REST storage is enabled.
- Show a time-ordered chart pane for today and saved historical days.
- Use cumulative net-buy values as the primary y-axis so the latest value remains correct even if intermediate rows are sparse.
- Avoid mixing this data with KIS WS orderbook/trade capture. Program-trade storage is a REST side-channel with a different cadence and source contract.
- Keep KIS credentials, tokens, and raw headers out of persisted program-trade files and probe artifacts.
- Provide gap-risk detection so the chart can communicate when a polling interval may have missed part of the rolling window.

## Non-Goals

- No tick-perfect guarantee for every intermediate program-trade row.
- No full-market program-trade ranking.
- No market-wide `comp-program-trade-today` indicator in this feature.
- No use of the NXT/Unified program-trade WebSocket in this first version.
- No backfill promise for days that were not captured, unless a later KIS endpoint is proven to provide historical intraday rows.
- No value-basis selector in the first version; the chart uses cumulative net amount.

## Live Probe Result

The probe called the REST endpoint twice for `005930`.

Sample 1:

- row count: 30
- oldest `bsop_hour`: `094252`
- newest `bsop_hour`: `094627`

Sample 2 after 35 seconds:

- row count: 30
- oldest `bsop_hour`: `094326`
- newest `bsop_hour`: `094703`
- new times: `094634`, `094642`, `094650`, `094656`, `094703`

Interpretation:

- KIS returns the latest 30 stock-level program-trade rows.
- The endpoint is suitable for 30-second polling when the chart only requires cumulative correctness.
- Because it is a rolling window, every row is not guaranteed unless the polling interval is short enough for that stock's intraday row cadence.

## Data-Source Settings Policy

The existing storage policy remains the source of truth for whether REST storage is allowed.

Recommended behavior:

- `WS만 저장`: program-trade REST storage is disabled.
- `WS 우선 + 나머지 REST 저장`: program-trade REST storage can be enabled.
- `REST만 저장`: program-trade REST storage can be enabled.

Add a separate program-trade storage toggle under live data-source settings:

- Label: `프로그램 순매수 저장`
- Default: off.
- Enabled only when REST storage is allowed by the selected storage policy.
- Target set: capture-enabled watchlist stocks by default, not every symbol ever searched.
- Poll interval: 30 seconds by default.

This keeps the current storage-policy semantics honest: selecting `WS만 저장` must not create hidden REST traffic.

## Collection Model

Program-trade collection is a background REST poller that scans eligible watchlist codes.

Eligibility:

- Use the watchlist display/capture-selection contract already used by live capture candidates.
- Include only capture-enabled watchlist entries.
- Deduplicate codes while preserving display order.

Polling:

- Default interval: 30 seconds.
- On each cycle, call `KisClient.fetch_program_trade_by_stock(code)` for each eligible code.
- Reuse the existing KIS REST client and account-role routing.
- Use `background` role so this auxiliary poller does not compete with foreground chart backfill.
- Respect existing KIS client rate limiting and retry behavior.

Storage:

- Persist under `data/kis-program-trade/<code>/<YYYYMMDD>.json`.
- Merge each response by `(date, code, bsop_hour)`.
- Store only normalized, non-secret row data.
- Keep rows sorted by `bsop_hour`.
- Write atomically with the existing `atomic_write_json` helper.

Suggested normalized row:

```json
{
  "date": "20260625",
  "code": "005930",
  "bsop_hour": "094703",
  "t_ms": 1782352023000,
  "price": 353750,
  "net_qty": -473414,
  "net_amount": -169039074500,
  "buy_qty": 2329414,
  "sell_qty": 2806609,
  "buy_amount": 834469276250,
  "sell_amount": 1004847058750,
  "delta_qty": -2277,
  "delta_amount": -806001750,
  "observed_at_ms": 1782352030000
}
```

`t_ms` is derived from `date + bsop_hour` in KST. If `bsop_hour` is malformed, skip the row rather than storing an ambiguous timestamp.

## Gap Detection

The row window is rolling, so the collector should detect possible missed windows.

For each `(date, code)`, keep the previous latest `bsop_hour`. On the next successful response:

- Let `new_oldest` be the minimum `bsop_hour` in the response.
- Let `previous_latest` be the last stored/latest time before the response.
- If `previous_latest < new_oldest`, mark `gap_risk=true` for this poll interval.

This does not mean the latest cumulative value is wrong. It only means intermediate points may be missing. The chart can render the segment as a normal line by default or later use a dotted connection if the UI needs stronger disclosure.

## Backend Design

### KIS Client

Add `KisClient.fetch_program_trade_by_stock(code: str)`.

Request:

- path: `/uapi/domestic-stock/v1/quotations/program-trade-by-stock`
- TR ID: `FHPPG04650101`
- params:
  - `FID_COND_MRKT_DIV_CODE`: `J`
  - `FID_INPUT_ISCD`: stock code

Normalize rows into `ProgramTradeByStockRow` in `hoga/live/kis_models.py`.

Parsing rules:

- Numeric strings become `int`.
- Empty or malformed optional numeric values become `None`.
- `bsop_hour` must be a non-empty string and should parse as `HHMMSS`.
- Sort rows by `bsop_hour` after parsing.

### Disk Store

Create a small store module, likely `hoga/live/program_trade_store.py`.

Responsibilities:

- load rows for `(code, date)`;
- merge a KIS response into a day file;
- expose sorted rows for API responses and range bundle construction;
- record gap-risk metadata per code/date.

The store owns disk paths and atomic writes. The KIS client must not write files.

### Collector

Add a lifecycle-managed background task only when:

- `data_dir` is configured;
- REST storage is allowed by live settings;
- `program_trade_storage_enabled` is true;
- KIS credentials are available;
- there is at least one eligible watchlist code.

Failures must be local:

- rate-limit/API/transport failures log a warning and skip that code for the cycle;
- one code failing must not stop the cycle;
- missing credentials disables the task until settings/restart refresh creates a client.

### API / Range Integration

Expose program-trade rows through the same chart data path used by `/live`.

Add a wire shape:

```ts
type ProgramTradePoint = {
  t: number;
  net_qty: number | null;
  net_amount: number | null;
  delta_qty: number | null;
  delta_amount: number | null;
  gap_risk?: boolean;
};

type ProgramTradeSeries = {
  points: ProgramTradePoint[];
  source: "kis_program_trade";
};
```

Add `program_trade` to `RangeBundle`. For historical range requests, load saved files for each included stock-date and concatenate time-sorted points. For today, `/live` can use the same disk store plus current polling output, because polling writes to disk continuously.

If no rows exist for a date, return an empty series. Do not call KIS synchronously from `/api/range`; range rendering should not fan out into live KIS requests.

## Frontend Design

Add a new indicator pane:

- Indicator label: `프로그램 순매수`
- Pane name: `program-trade`
- Default display: off.
- x-axis: existing chart time scale.
- y-axis: cumulative program net buy.
- Default value: `net_amount`.

Rendering:

- Use one line series for cumulative net amount.
- Positive/negative values keep the same sign color convention used by investor-net/fill indicators where applicable.
- Tooltip/legend shows current time, cumulative amount, and optional delta amount.
- When `gap_risk` exists, do not alter latest value; optionally show a subtle warning in legend/copy later.

Indicator settings:

- Add `프로그램 순매수` to `IndicatorPanel`.
- Add a master on/off toggle persisted through `livePage` indicator persistence.
- Add a config pane with:
  - fixed value basis: cumulative net amount;
  - storage dependency note should be in settings, not as visible chart instructions.

## Testing

Backend:

- KIS client parses `program-trade-by-stock` rows and sends the correct path, TR ID, and params.
- Store merge is idempotent by `(date, code, bsop_hour)`.
- Store sorts by `t_ms`.
- Gap-risk detection triggers when the previous latest time falls before the new response's oldest time.
- Collector skips failed codes without killing the loop.
- Range bundle includes stored historical program-trade points and does not call KIS during range construction.

Frontend:

- API type includes `program_trade`.
- Projector maps `program_trade.points` to a line series.
- Indicator panel shows and toggles `프로그램 순매수`.
- Pane gating respects the persisted toggle.
- Empty series renders without crashing.

Manual verification:

- Run a redacted live probe for `005930` during the KRX session.
- Start the collector with a small capture-enabled watchlist.
- Confirm the day file grows over several polling cycles.
- Confirm reloading `/live` shows saved today's points.
- Confirm the next day treats the saved file as historical data.

## Open Risks

- 30-second polling cannot guarantee every intermediate row because KIS returns a rolling 30-row window. This is acceptable for the approved goal because cumulative net value is authoritative at each observed point.
- If a highly active stock produces more than 30 new rows between poll cycles, intermediate flow is sparse. The latest cumulative value still corrects on the next observed row.
- Historical days before this feature is enabled cannot be reconstructed from this rolling endpoint unless another KIS endpoint is later proven to provide historical intraday program-trade rows.
