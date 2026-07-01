# KIS Venue Quote Consistency Design

Date: 2026-07-01
Status: draft

## Goal

Make KIS venue selection mean the same thing across quote-driven displays:
watchlist, heatmap, screener rows, active-symbol current price, and document
title. The first implementation phase fixes current price and change-rate
consistency. A later phase extends realtime hoga/trade/member streams.

## User-Facing Policy

The Data Source KIS venue setting controls quote overlays as follows:

| Setting | KIS request | Unsupported NXT symbols |
| --- | --- | --- |
| KRX | `FID_COND_MRKT_DIV_CODE=J` | Not applicable |
| NXT | `FID_COND_MRKT_DIV_CODE=NX` | Show `-`; do not silently fall back to KRX |
| Integrated | `FID_COND_MRKT_DIV_CODE=UN` | Use KIS integrated value |
| AUTO | Time-based KRX/NXT for intraday quotes | Show `-` when AUTO resolves to NXT and the symbol is unsupported |

AUTO is not the same as Integrated:

- 08:00:00-08:59:59 KST: AUTO quote venue is NXT (`NX`).
- 09:00:00-15:30:00 KST: AUTO quote venue is KRX (`J`).
- 15:30:01-20:00:00 KST: AUTO quote venue is NXT (`NX`).
- Integrated uses one KIS `UN` response as the authoritative combined-market
  value. The app does not manually sum or reconcile KRX and NXT values.
- Daily candles and day-level baselines use Integrated (`UN`) when the UI policy
  is AUTO, because a single daily candle cannot preserve an intraday KRX/NXT
  split.

## Phase 1: Quote Overlay Consistency

Phase 1 is intentionally limited to quote-derived display values:

- Backend `/api/live/quotes` resolves the selected UI policy into one concrete
  KIS venue per request.
- `KisClient.fetch_multi_price` calls KIS
  `/uapi/domestic-stock/v1/quotations/intstock-multprice` with numbered
  `FID_COND_MRKT_DIV_CODE_N` and `FID_INPUT_ISCD_N` parameters.
- Change rate and change amount are computed from the selected venue's current
  price and the adjusted previous daily baseline.
- If the selected venue returns no valid current price, the row exposes no
  change values and the frontend renders `-`.
- Watchlist, heatmap, screener rows, active-symbol current price, and document
  title all share the same quote hook/query key including venue.

This phase fixes the mixed stale/current change-rate symptom without expanding
the realtime websocket surface.

## Phase 2: Realtime Stream Venue Support

Phase 2 extends non-overlay realtime panes. KIS websocket TR IDs are venue
specific, so this is separate work from the REST quote endpoint:

| Stream | KRX | NXT | Integrated |
| --- | --- | --- | --- |
| Hoga | `H0STASP0` | `H0NXASP0` | `H0UNASP0` |
| Trade | `H0STCNT0` | `H0NXCNT0` | `H0UNCNT0` |

Until Phase 2 ships, hoga/trade/member panes remain KRX-backed and must be
labeled as KRX when the selected quote/candle venue is NXT, Integrated, or AUTO.

## Error Handling

- Invalid venue values return the existing invalid venue error.
- NXT unsupported symbols are data-unavailable, not errors.
- KIS transport and rate-limit handling stays centralized in `KisClient._get`.
- Quote cache keys include the resolved or requested venue so KRX, NXT, and
  Integrated responses cannot reuse each other's stale values.

## Tests

Phase 1 tests should cover:

- `KRX -> J`, `NXT -> NX`, `Integrated -> UN`.
- AUTO resolves to NXT before 09:00 and after 15:30, and KRX during regular
  session.
- AUTO daily policy resolves to Integrated.
- Multi-price params include the venue for every numbered symbol.
- Unsupported NXT quote rows render as unavailable rather than falling back.
- Frontend quote query keys and request URLs include venue.
- Watchlist, heatmap, screener, active-symbol price, and title pass the selected
  venue into the shared quote hook.

Phase 2 tests should cover websocket TR routing and KRX labels while Phase 2 is
not yet active.
