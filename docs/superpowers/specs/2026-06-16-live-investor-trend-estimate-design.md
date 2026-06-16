# /live 거래원 하단 외인·기관 추정 수급 카드 — Design

**Date**: 2026-06-16  
**Status**: Approved for implementation planning  
**User-approved decisions**:
- Scope: current `activeCode` single-stock display only.
- Fetch policy: immediate fetch on `activeCode` change, then 60-second React Query polling during the regular KRX session.
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
- Show every KIS estimate row returned for the current active stock, with the latest row highlighted.
- Fetch through the existing KIS REST infrastructure and account-role routing.
- Keep the feature independent from WS ticks, `LiveBuffer`, and chart bundle rebuilds.
- Avoid duplicate KIS calls by using React Query polling plus a backend TTL cache.
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

Place the normalized KIS row model in `hoga/live/kis_models.py`. Keep API response models in `hoga/live/api.py`, following the existing split between KIS-normalized models (`KisBrokers`, `InvestorNetPoint`) and `/api/live/*` wire models (`LiveQuote`, `LiveQuotesResponse`).

### API route

Add `GET /api/live/investor-trend-estimate?code=005930`.

Route behavior:

- Validate `code` as a six-digit stock code.
- Resolve KIS client with `kis_access.kis_for_role("background", data_dir)`.
- Return HTTP 200 with `status: 'error'` when no KIS credentials/client are available. This keeps the failure local to the card.
- Convert KIS errors into a local degraded response. Validation errors are the only caller-facing HTTP errors.
- Include `fetched_at_ms` when the backend successfully contacts KIS.
- Only request validation should produce an HTTP error. Credential, rate-limit, API, and transport failures return HTTP 200 with `status: 'error'` and `data_warning`, optionally carrying the previous successful rows.

Wire shape:

```ts
type LiveInvestorTrendEstimateResponse = {
  code: string;
  trading_day: string;
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

`latest` is computed server-side only to identify the row the UI should highlight. It is not the only value shown. The card renders the full `rows` history supplied by the backend so the user can see how the intraday estimate changed across input slots.

Latest-row selection:

- Prefer the valid row with the largest numeric `slot` (`bsop_hour_gb` parsed as an integer).
- If no row has a numeric slot, use the last row with at least one non-null quantity.
- Do not translate `slot` to a wall-clock time. KIS describes `bsop_hour_gb` as an input classification, while actual input times can vary.

### Backend TTL cache

Keep a process-local in-memory cache keyed by `(trading_day, code)`.

- TTL: 60 seconds.
- If the same `(trading_day, code)` is requested within TTL, return cached data and do not call KIS.
- Cache successful `ok` and `empty` responses.
- Do not cache credential-missing errors for long; credentials can be fixed without restart in some paths.

The cache protects KIS from duplicate calls caused by React remounts, tab changes, and multiple UI consumers.

### History ownership

KIS owns the estimate history when it returns multiple input slots. The app only accumulates as a fallback if KIS returns a latest-only shape.

- Before implementation locks the fallback behavior, run a live characterization probe against `005930` during a regular KRX session after at least the 11:20 KST input window. Record whether KIS returns multiple input slots or only one latest slot. Save the redacted result under `docs/superpowers/measurements/2026-06-16-investor-trend-estimate/` as a JSON fixture plus a short note. Do not store credentials, headers, tokens, or account identifiers; keep only non-sensitive output row fields and timing metadata. This probe informs tests and UI copy, but runtime code must still keep the fallback below because KIS behavior can vary by time, stock, and upstream conditions.
- If a successful KIS response contains the full row history for the current day, replace cached `rows` with that response. Do not app-accumulate, because KIS may revise an earlier slot and the UI should match KIS.
- If KIS returns only the latest row, maintain a backend process-local same-trading-day in-memory accumulator keyed by `(trading_day, code, slot)`. Merge the new row into the accumulator and return the accumulated rows.
- Reset the accumulator at the KST trading-day boundary.
- If a later response switches from latest-only to full-history shape, the full KIS response wins and replaces the accumulator for that code/day.
- Deduplicate by `slot` within `(trading_day, code)`; a repeated slot overwrites the previous observed row.
- Do not persist this accumulator to disk. It is a display fallback, not captured data.
- Do not accumulate in the frontend. The API response is the single contract for "best available history".

This keeps the frontend contract stable: `rows` means "the best available intraday estimate history", regardless of whether KIS supplied the complete history or only the newest estimate.

## Account and Rate-Limit Policy

Use `background` role only.

- With two or more configured accounts, `kis_access` routes background work to account 1..N-1, round-robin when applicable.
- If background REST is degraded, existing fallback routes to account 0.
- The route must not use `foreground`, because this card is auxiliary and should not compete with user-visible chart backfill.

Frontend refetch policy:

- On `activeCode` change: fetch immediately.
- During the regular KRX session: refetch every 60 seconds with React Query `refetchInterval`.
- Outside regular session: no repeating refetch.
- Backend TTL remains 60 seconds, so duplicate mounts or tabs do not create duplicate KIS calls inside the same minute.
- The frontend uses the existing `isKrxRegularSessionNow()` clock-based helper for this gate, matching `useLivePastInvestorNet` and `useLivePastCandles`. Do not add a new backend phase endpoint for this card.

This bounds a single active stock to about 390 automatic attempts across a full 09:00-15:30 regular session before active-code changes. That is low relative to the existing KIS client 15 calls/sec bucket, and backend TTL coalesces duplicate UI requests. KIS `EGW00201` remains handled by `KisClient._get()` first; final failure degrades this card only.

## Frontend Design

Add `frontend/src/api/liveInvestorTrendEstimate.ts` with a React Query hook:

```ts
useLiveInvestorTrendEstimate(code: string | null)
```

The hook owns the 60-second regular-session polling policy. It should mirror the existing `useLivePastInvestorNet` / `useLivePastCandles` React Query pattern rather than introducing a new scheduler:

```ts
['live', 'investor-trend-estimate', code]
```

Add a sidebar component named `InvestorTrendEstimateCard`, rendered by `LiveSidebar` below the `CursorSidebar` shell. It is a **Live Investor Estimate Card**, not a Cursor Sidebar card: it does not consume `cursorMs`, does not enter spot mode, and does not change when the user hovers historical candles.

Card content:

- Title: `외인·기관 추정`
- Compact table columns: `입력`, `외국인`, `기관`, `합산`
- Table rows: every row in the backend-normalized estimate history
- Latest row: visually highlighted but not separated from the table
- Value format: compact signed quantity with `주` suffix when space allows.
- Positive: buy/up color.
- Negative: sell/down color.
- `0` or `null`: dim neutral.
- Footer: `KIS 장중 가집계 · 수량 기준`.

Use a separate card, not a section inside 거래원. Broker data and KIS investor estimates have different source, cadence, and reliability. Separate presentation avoids implying they are one dataset. Keeping it outside the `CursorSidebar` shell also preserves the existing two-card Cursor Sidebar domain boundary.

States:

- `loading`: first fetch for a new code.
- `ok`: rows are available from the latest successful fetch/cache hit.
- `empty`: no KIS rows.
- `error_with_previous`: card-level failure, but previous same `(trading_day, code)` rows are available. Keep the table visible and show `조회 지연`.
- `error_empty`: card-level failure and no previous same `(trading_day, code)` rows exist. Show `조회 실패`.

Wire `status` stays coarse: `ok | empty | error`. The frontend derives `error_with_previous` vs `error_empty` from `status === 'error'` plus `rows.length > 0`.

No long instruction text in the live UI. Detailed KIS input times belong in docs/tests/tooltips, not visible screen copy. Do not use `stale` as visible copy; show `최근 조회 HH:MM`, `조회 지연`, `조회 실패`, or `추정 수급 없음`.

## Error Handling

- Missing credentials: route returns HTTP 200 with `status: 'error'`, `fetched_at_ms: null`, and `data_warning.reason: 'kis_credentials_missing'`; the card shows unavailable state.
- KIS rate limit: `_get()` retries; final `KisRateLimitError` becomes card-level warning.
- KIS API/transport errors: degrade the card only.
- Parse errors: bad row fields become `None`; if all rows are malformed, return `empty` or `error` with a warning.
- React Query should not see KIS/credential failures as network errors; the response body carries the degraded state so previous data remains stable.
- Previous successful rows may be returned only for the same `(trading_day, code)`. Never show another Code's rows or a prior trading day's rows as today's estimate.

No error from this feature may block candles, hoga indicators, broker sidebar, or live status.

## Testing

Backend:

- Live characterization: during a regular KRX session after the 11:20 KST input window, probe `005930`, store a redacted fixture under `docs/superpowers/measurements/2026-06-16-investor-trend-estimate/`, and record whether KIS returns multiple rows or latest-only data.
- The live characterization probe is not part of CI or the ordinary pytest suite. It depends on credentials, market hours, network, and upstream state.
- Unit tests use redacted/synthetic fixtures derived from the probe shape to cover full-history, latest-only, empty, malformed, and error cases.
- `KisClient.fetch_investor_trend_estimate` sends the correct path, TR ID, and `MKSC_SHRN_ISCD`.
- Numeric parsing handles positive, negative, zero, empty string, and malformed values.
- Route validates six-digit codes.
- Route uses `kis_access.kis_for_role("background")`; with N=2, fake account 1 receives the call and account 0 does not.
- TTL cache coalesces repeated same-code requests inside 60 seconds.
- Full-history KIS responses replace cached rows.
- Latest-only KIS responses merge into a same-day `(trading_day, code, slot)` accumulator, with repeated slots overwritten.
- KIS rate/API errors produce the expected degraded response.

Frontend:

- Hook fetches immediately on code change.
- Hook enables 60-second refetch during the regular KRX session.
- Hook disables interval outside the regular session.
- Sidebar renders the card below 거래원.
- Card renders all backend-normalized history rows, highlights `latest`, and formats signed quantities plus null/empty/error states correctly.

Integration risk checks:

- The feature does not alter `LiveBuffer`, websocket frame parsing, capture writer, or chart bundle construction.
- The feature does not change daily investor net-buy panes or `/past-investor-net`.

## Open Decisions Resolved

- **Why not WebSocket/live buffer?** The data is low-frequency, manually aggregated KIS estimate data, not tick-state data.
- **Why not `foreign_institution_total`?** That API has amount fields but is list/ranking-oriented. This feature is for active single-stock quantity display.
- **Why not chart pane?** The selected scope is a compact history table under 거래원. Time-series plotting can be reconsidered later with a separate data model.
- **Why background role?** It is auxiliary, and existing role routing already protects foreground chart backfill.
