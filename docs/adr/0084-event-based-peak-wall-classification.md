# 0084 - Peak wall classification is event-based, not price-membership based

**Status:** accepted (2026-07-05)

`당일 매도 최대벽` and `당일 매수 최대벽` classify wall events by whether continuous-trading ticks touch or cross the wall after the wall event is observed, not by whether that price traded at any point during the Stock-Date. This lets two same-price walls classify differently: an earlier wall can be **사후터치 최대벽** after a later tick reaches it, while a later larger wall at the same price can remain **사후미터치 최대벽** if no subsequent tick reaches it. Historical data should use `(ts_ms, seq)` ordering for the "after" relation; live buffers may fall back to inclusive `t_ms` when source sequence is unavailable.

We keep legacy wire names such as `traded_*` and `untraded_*` to avoid API/cache migration churn, but the domain terms are **사후터치 최대벽** and **사후미터치 최대벽**. The two families rank independently, because the user wants separate 1-3 rank controls for touched and untouched walls; the old "show the untraded line only when larger than the traded baseline" rule is superseded by independent post-touch/post-untouched ranking.
