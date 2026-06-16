# /live 거래원 하단 외인·기관 추정 수급 카드 — Design

**Date**: 2026-06-16  
**Status**: Approved for implementation planning  
**User-approved decisions**:
- Scope: current `activeCode` single-stock display only.
- Fetch policy: KIS scheduled input windows, not continuous polling.
- Account role: `background` only.
- UI placement: separate mini card below the 거래원 card.

## Problem

`/live` currently shows orderbook-derived indicators and broker trajectory data, but it does not show the intraday KIS estimated foreign/institution flow for the currently viewed stock. KIS provides this through:

- API: `/uapi/domestic-stock/v1/quotations/investor-trend-estimate`
- TR ID: `HHPTJ04160200`
- Parameter: `MKSC_SHRN_ISCD`
- Fields: `bsop_hour_gb`, `frgn_fake_ntby_qty`, `orgn_fake_ntby_qty`, `sum_fake_ntby_qty`

This data is not tick-realtime. It is a low-frequency intraday estimate entered/aggregated around known KIS input times, and its values are quantity-based. Treating it like WS/live-buffer data would waste REST quota and blur its meaning.

## Goals

- Add a compact `/live` sidebar card below 거래원 for the current active stock.
- Show the latest estimated foreign, institution, and combined net quantities.
- Fetch through the existing KIS REST infrastructure and account-role routing.
- Keep the feature independent from WS ticks, `LiveBuffer`, and chart bundle rebuilds.
- Avoid needless KIS calls by using scheduled refetch windows and a backend TTL cache.
- Degrade locally: this card may fail or be stale without affecting live chart rendering.

## Non-Goals

- No multi-stock ranking or screener behavior.
- No chart pane or time-series plotting for this data.
- No storage in live JSONL/parquet capture output.
- No mixing with daily confirmed investor net-buy data from `/past-investor-net`.
- No amount-based display from `foreign_institution_total`; this feature uses quantity fields from `investor_trend_estimate`.

## Architecture

Add a narrow REST path that sits beside existing live REST endpoints.

```text
LiveSidebar(activeCode)
  -> useLiveInvestorTrendEstimate(code)
  -> GET /api/live/investor-trend-estimate?code=005930
  -> kis_access.kis_for_role("background", data_dir)
  -> KisClient.fetch_investor_trend_estimate(code)
  -> KIS /investor-trend-estimate
```

Do not publish this data through SSE or `LiveBuffer`. The data cadence and provenance differ from orderbook, trade, and broker snapshots. A separate query keeps update scheduling, errors, and copy honest.

## Backend Design

### KIS client method

Add `KisClient.fetch_investor_trend_estimate(code: str)`.

Request:

- path: `/uapi/domestic-stock/v1/quotations/investor-trend-estimate`
- TR ID: `HHPTJ04160200`
- params: `{ "MKSC_SHRN_ISCD": code }`

The method should call existing `_get()`, so token, app headers, `EGW00201` retry/backoff, transport retry, and auth invalidation remain centralized.

Parse KIS rows into a small domain model:

```python
InvestorTrendEstimateRow(
    slot: str,
    foreign_qty: int | None,
    institution_qty: int | None,
    sum_qty: int | None,
)
```

Empty strings and unparsable numeric values become `None`, not `0`, because `0` is a meaningful quantity.

### API route

Add `GET /api/live/investor-trend-estimate?code=005930`.

Route behavior:

- Validate `code` as a six-digit stock code.
- Resolve KIS client with `kis_access.kis_for_role("background", data_dir)`.
- Return HTTP 200 with `status: 'error'` when no KIS credentials/client are available. This keeps the failure local to the card.
- Convert KIS errors into a local degraded response. Validation errors are the only caller-facing HTTP errors.
- Include `fetched_at_ms` when the backend successfully contacts KIS.

Wire shape:

```ts
type LiveInvestorTrendEstimateResponse = {
  code: string;
  fetched_at_ms: number | null;
  rows: Array<{
    slot: string;
    foreign_qty: number | null;
    institution_qty: number | null;
    sum_qty: number | null;
  }>;
  latest: {
    slot: string;
    foreign_qty: number | null;
    institution_qty: number | null;
    sum_qty: number | null;
  } | null;
  source: 'kis';
  status: 'ok' | 'empty' | 'error';
  data_warning: {
    reason: 'kis_credentials_missing' | 'kis_rate_limit' | 'kis_api_error' | 'parse_error';
    msg: string;
  } | null;
};
```

`latest` is computed server-side as the last row with at least one non-null quantity. The frontend should not know KIS row ordering or parse KIS strings.

### Backend TTL cache

Keep a process-local in-memory cache keyed by `code`.

- TTL: 60 seconds.
- If the same code is requested within TTL, return cached data and do not call KIS.
- Cache successful `ok` and `empty` responses.
- Do not cache credential-missing errors for long; credentials can be fixed without restart in some paths.

The cache protects KIS from duplicate calls caused by React remounts, tab changes, and multiple UI consumers.

## Account and Rate-Limit Policy

Use `background` role only.

- With two or more configured accounts, `kis_access` routes background work to account 1..N-1, round-robin when applicable.
- If background REST is degraded, existing fallback routes to account 0.
- The route must not use `foreground`, because this card is auxiliary and should not compete with user-visible chart backfill.

Frontend refetch policy:

- On `activeCode` change: fetch immediately.
- During regular KRX session: refetch only in KIS scheduled input windows.
- Scheduled input anchors: `09:30`, `10:00`, `11:20`, `13:20`, `14:30` KST.
- Window: from anchor time through 12 minutes after anchor.
- Interval inside a window: 60 seconds.
- Outside a window: show cached query data, no automatic refetch.
- Outside regular session: no repeating refetch.

This bounds a single active stock to at most 65 automatic calls per trading day before active-code changes, far below the existing 2-second rest-poller cadence. KIS `EGW00201` remains handled by `KisClient._get()` first; final failure degrades this card only.

## Frontend Design

Add `frontend/src/api/liveInvestorTrendEstimate.ts` with a React Query hook:

```ts
useLiveInvestorTrendEstimate(code: string | null)
```

The hook owns the scheduled-window refetch policy. It should use an ordinary query key such as:

```ts
['live', 'investor-trend-estimate', code]
```

Add a sidebar component named `InvestorTrendEstimateCard`, rendered in `LiveSidebar` below the 거래원 card.

Card content:

- Title: `외인·기관 추정`
- Rows: `외국인`, `기관`, `합산`
- Value format: compact signed quantity with `주` suffix when space allows.
- Positive: buy/up color.
- Negative: sell/down color.
- `0` or `null`: dim neutral.
- Footer: `KIS 장중 가집계 · 수량 기준`.

Use a separate card, not a section inside 거래원. Broker data and KIS investor estimates have different source, cadence, and reliability. Separate presentation avoids implying they are one dataset.

States:

- `loading`: first fetch for a new code.
- `stale`: cached value shown while outside scheduled windows.
- `empty`: no KIS rows.
- `error`: card-level failure. If previous successful data exists, keep showing it with degraded styling; otherwise show `조회 실패`.

No long instruction text in the live UI. Detailed KIS input times belong in docs/tests/tooltips, not visible screen copy.

## Error Handling

- Missing credentials: route returns HTTP 200 with `status: 'error'`, `fetched_at_ms: null`, and `data_warning.reason: 'kis_credentials_missing'`; the card shows unavailable state.
- KIS rate limit: `_get()` retries; final `KisRateLimitError` becomes card-level warning.
- KIS API/transport errors: degrade the card only.
- Parse errors: bad row fields become `None`; if all rows are malformed, return `empty` or `error` with a warning.

No error from this feature may block candles, hoga indicators, broker sidebar, or live status.

## Testing

Backend:

- `KisClient.fetch_investor_trend_estimate` sends the correct path, TR ID, and `MKSC_SHRN_ISCD`.
- Numeric parsing handles positive, negative, zero, empty string, and malformed values.
- Route validates six-digit codes.
- Route uses `kis_access.kis_for_role("background")`; with N=2, fake account 1 receives the call and account 0 does not.
- TTL cache coalesces repeated same-code requests inside 60 seconds.
- KIS rate/API errors produce the expected degraded response.

Frontend:

- Hook fetches immediately on code change.
- Hook enables 60-second refetch only inside scheduled KST windows.
- Hook disables interval outside session/window.
- Sidebar renders the card below 거래원.
- Card formats signed quantities and null/empty/error states correctly.

Integration risk checks:

- The feature does not alter `LiveBuffer`, websocket frame parsing, capture writer, or chart bundle construction.
- The feature does not change daily investor net-buy panes or `/past-investor-net`.

## Open Decisions Resolved

- **Why not WebSocket/live buffer?** The data is low-frequency, manually aggregated KIS estimate data, not tick-state data.
- **Why not `foreign_institution_total`?** That API has amount fields but is list/ranking-oriented. This feature is for active single-stock quantity display.
- **Why not chart pane?** The selected scope is a latest-value card under 거래원. Time-series plotting can be reconsidered later with a separate data model.
- **Why background role?** It is auxiliary, and existing role routing already protects foreground chart backfill.
