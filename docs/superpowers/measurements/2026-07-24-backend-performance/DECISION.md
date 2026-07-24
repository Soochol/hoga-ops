# Backend Performance Baseline Decision

`GO` and `NO-GO` are reserved for workstreams with the required measured gate
evidence. `NEEDS_*` and `SKIPPED_*` are collection states, not performance or
user-impact conclusions.

| Workstream | Evidence | Gate | Decision | Next action |
|---|---|---|---|---|
| Past candles | [Unit/mock tests passed](./README.md#unitmock-result); [cold/warm timing was not run](./http.log#L1) | Approved three-day cold p95 and KIS-quota evidence | `NEEDS_APPROVED_EXTERNAL_MEASUREMENT` | Obtain explicit approval for an isolated development-account measurement, then apply the gate below |
| LiveBuffer | [Synthetic 1/50/200/800-code results table](./README.md#resource-guard-and-results) and [raw JSONL](./live-buffer.jsonl); [20-minute real-mix soak unavailable](./http.log#L2) | growth, >30%, or >50ms | `NEEDS_RECORDED_TICK_FIXTURE` | Provide a recorded tick fixture, run the isolated 20-minute soak, then display-plane spec or close |
| Range sidecar | [No isolated fixture; no range measurement run](./range.jsonl#L1) | >1000ms or >5MB and slice >=35% | `NEEDS_ISOLATED_FIXTURE` | Provide fixed isolated fixture values, then slice-specific plan or close |

### LiveBuffer decision

`NEEDS_RECORDED_TICK_FIXTURE` is the terminal pending decision. The required
recorded-tick replay does not exist, so neither `GO` nor `NO-GO` can be
determined. No display-plane design, implementation plan, or production-code
change is authorized by this state.

The completed 1/50/200/800-code runs are short, deterministic synthetic
benchmarks: each separate process generated 1,000 identical-shaped ticks per
code with `retention_ms=1000000000`. The 800-code result's `13046259712` peak
RSS bytes is therefore not a 20-minute real-mix RSS plateau, a LiveBuffer
memory attribution, an event-loop-lag measurement, a first-view coverage
measurement, or a host/container-limit assessment. It is insufficient to apply
the gate and is not, by itself, a conclusion about a leak or user impact.

Once an isolated recorded tick fixture is available, replay the same fixture in
a fresh process for 20 minutes at both 200- and 800-code scale, without a
WebSocket or external-system connection. Record all of the following:

1. Process RSS over the full replay and after `retention_ms + 120 seconds`, to
   determine whether RSS is still rising after that point.
2. The estimated or attributed LiveBuffer memory and its percentage of process
   RSS, using a recorded attribution method.
3. Event-loop lag p99 while publish load is active.
4. First-view coverage against the fixture for codes first viewed during the
   replay, including any unavailable tail.
5. The applicable host or container memory limit, current available/headroom
   information, and RSS relative to that limit during each 200/800-code soak.

Apply `GO` only if any replay shows continued RSS growth after
`retention_ms + 120 seconds`, LiveBuffer memory above 30% of process RSS,
event-loop lag p99 above 50ms during active publishing, or the process
approaching its host/container memory limit. Otherwise decide `NO-GO` and
retain the current per-deque cap, retention, and `drop_codes_except` for that
measured workload.

Task 3 observability remains in either outcome: `published_total`,
`subscriber_drops`, `total_entries`, and `high_water_entries` stay exposed so
later scale changes remain visible.

### Past-candle decision

`NEEDS_APPROVED_EXTERNAL_MEASUREMENT` is the terminal pending decision. No approved
real KIS measurement exists, so this workstream stops before a `GO`/`NO-GO`
determination or any ADR reversal. ADR-0095 memory-only caching and ADR-0103
on-demand behavior remain unchanged; no implementation plan is warranted.

The missing evidence is a current-head, three-day cold and warm p50/p95 result,
KIS quota/capacity evidence, and restart duplicate-fetch evidence: the share of
past-minute calls attributable to restart duplicates across three measured sessions.
An explicitly approved, isolated development-account KIS measurement is required
before collecting it.

After approval and collection, apply this order exactly:

1. If no approved real KIS measurement is available, retain
   `NEEDS_APPROVED_EXTERNAL_MEASUREMENT` and stop.
2. If three-day cold p95 is at most 1,000ms, decide `NO-GO` and retain ADR-0095
   and ADR-0103 unchanged.
3. If three-day cold p95 exceeds 1,000ms but restart duplicate fetches are not a
   quota problem, consider only prior-span read-ahead; disk caching remains rejected.
4. Only if restart duplicate fetches consume at least 20% of past-minute calls in
   three separate measured sessions, or development quota is materially constrained,
   may an ADR-0095 disk-cache reversal be proposed.

### Range-sidecar decision

`NEEDS_ISOLATED_FIXTURE` remains the terminal pending decision. The range record
contains no isolated 60 Stock-Date cold-run p95, raw or gzip response-byte, or
function-level dominant-slice evidence, so neither `GO`, `NO-GO`, nor
`NEEDS_MORE_BREAKDOWN` can be assigned. No range performance spec, implementation
plan, endpoint, cache, or production-code change is authorized by this state.
Pending isolated evidence, preserve the existing `frontend/src/api/range.ts`
delta merge and current caches unchanged.

Once an isolated fixed fixture is available, collect three cold runs for the same
60 Stock-Date corpus. Record the cold p95, raw and gzip response bytes, and each
run's function-level share of total time. Apply the future gate in this order:

1. If the isolated fixture or any required measurement is absent, retain
   `NEEDS_ISOLATED_FIXTURE` and stop.
2. If cold p95 is at most 1,000ms and the raw response is at most 5MB, decide
   `NO-GO`; preserve the current `frontend/src/api/range.ts` delta merge and
   current caches.
3. If either threshold is exceeded and one profiled function accounts for at
   least 35% of total time in at least two of the three cold runs, decide `GO`
   and plan only that dominant slice.
4. If either threshold is exceeded but no profiled function reaches the 35%
   threshold in at least two cold runs, decide `NEEDS_MORE_BREAKDOWN`; add
   nested timing only for the unmeasured internal stages, rerun the same corpus,
   and do not pursue a broad optimization.
