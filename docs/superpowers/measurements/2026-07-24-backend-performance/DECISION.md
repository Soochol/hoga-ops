# Backend Performance Baseline Decision

`GO` and `NO-GO` are reserved for workstreams with the required measured gate
evidence. `NEEDS_*` and `SKIPPED_*` are collection states, not performance or
user-impact conclusions.

| Workstream | Evidence | Gate | Decision | Next action |
|---|---|---|---|---|
| Past candles | [Unit/mock tests passed; cold/warm timing was not run](./http.log#L1) | p95 > 1000ms | `NEEDS_APPROVED_EXTERNAL_MEASUREMENT` | Approve an isolated development-account measurement, then ADR-0103 review or close |
| LiveBuffer | [Synthetic 1/50/200/800-code raw results](./live-buffer.jsonl#L1); [20-minute real-mix soak unavailable](./http.log#L2) | growth, >30%, or >50ms | `NEEDS_RECORDED_TICK_FIXTURE` | Provide a recorded tick fixture, run the isolated 20-minute soak, then display-plane spec or close |
| Range sidecar | [No isolated fixture; no range measurement run](./range.jsonl#L1) | >1000ms or >5MB and slice >=35% | `NEEDS_ISOLATED_FIXTURE` | Provide fixed isolated fixture values, then slice-specific plan or close |
