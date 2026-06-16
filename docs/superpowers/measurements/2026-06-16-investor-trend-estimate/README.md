# KIS Investor Trend Estimate Probe

Date: 2026-06-16
Code: 005930
API: /uapi/domestic-stock/v1/quotations/investor-trend-estimate
TR ID: HHPTJ04160200

This directory stores redacted shape-only output for the Live Investor Estimate implementation.
The fixture must not contain credentials, headers, tokens, account IDs, or raw HTTP metadata.

Observed shape:

- `full_history`: KIS returned more than one estimate slot in a single response.
- `latest_only_or_empty`: KIS returned one or zero rows; runtime code still keeps the backend same-day accumulator fallback.
