# Live REST Error Policy Design

## Context

Live KIS REST failures are currently handled inconsistently across supervisors.
`KisClient` already normalizes low-level `httpx` failures into typed domain
exceptions such as `KisTransportError`, `KisRateLimitError`, `KisAuthError`, and
`KisApiError`. That taxonomy is not consistently consumed by the higher-level
polling loops.

The visible production symptom is that a KIS network/connectivity failure in
`LiveRestPoller` is logged as a full traceback through
`live.rest_poller.code_failed`, making an expected upstream/operational outage
look like an internal application bug. `Rest30sRecorder` already has a partial
pattern that logs KIS API failures as a single warning without traceback, but
the policy is local to that file and not reusable.

## Goal

Introduce one shared live error policy that classifies exceptions by operational
meaning, then migrate the primary KIS REST supervisors to consume that policy
for logging, degraded status, and backoff decisions.

## Non-Goals

- Do not change `KisClient` request semantics, URL selection, token issuance, or
  KIS response parsing.
- Do not add new retry attempts inside `KisClient`; existing retry behavior stays
  the transport/API adapter's responsibility.
- Do not redesign frontend status UI in this change. Additive backend status
  fields are introduced so UI work can follow separately.
- Do not hide internal bugs. Parser, model conversion, invariant, and unexpected
  application errors must still preserve traceback logs.

## Architecture

Add `hoga/live/error_policy.py` as the single source of truth for converting an
exception into supervisor-facing operational policy.

The policy module owns classification only. It does not log, sleep, mutate
supervisor state, or know about poller target sets. Supervisors remain
responsible for applying the returned policy to their own loop state.

Data flow:

```text
KIS/httpx
  -> KisClient exception normalization
  -> scheduler/proxy layer
  -> supervisor catches per-code/per-job exception
  -> hoga.live.error_policy.classify_live_error(exc)
  -> supervisor applies log/status/backoff policy
```

## Error Classification

`classify_live_error(exc)` returns a frozen `LiveErrorPolicy` value with:

- `kind`: stable category for status and tests.
- `reason`: human-readable reason suitable for operator-facing status.
- `code`: compact machine-readable code, using KIS `msg_cd` where available.
- `message`: compact status message.
- `log_level`: logging level name or integer.
- `include_traceback`: whether the supervisor should pass `exc_info=True`.
- `degraded`: whether this error means the supervisor is currently degraded.
- `backoff_cycles`: suggested number of future cycles to skip.

Initial categories:

| kind | Source | Log | Degraded | Backoff |
| --- | --- | --- | --- | --- |
| `transport` | `KisTransportError` | warning, no traceback | yes | yes |
| `rate_limit` | `KisRateLimitError` | warning, no traceback | yes | no by default |
| `auth` | `KisAuthError` | warning, no traceback | yes | yes |
| `kis_api` | other `KisApiError` | warning, no traceback | yes | no by default |
| `internal` | supervisor-marked local conversion/model errors | error, traceback | yes | no |
| `unexpected` | any other exception | error, traceback | yes | no |

`KisTransportError` must be classified before generic `KisApiError` because it
subclasses `KisApiError`.

## Supervisor Migration

### LiveRestPoller

`LiveRestPoller` should become the first full consumer of the shared policy.

Changes:

- Add a status model, `LiveRestPollerStatus`.
- Expose `status()` with:
  - `running`
  - `target_count`
  - `targets`
  - `last_cycle_ms`
  - `last_error`
  - `last_error_kind`
  - `last_error_code`
  - `last_error_count`
  - `degraded`
  - `backoff_remaining`
- Preserve `alive` and `last_cycle_ms` for current callers.
- In per-code exception handling, call `classify_live_error`.
- Log KIS/operational errors as one-line warnings without traceback.
- Log unexpected/internal errors with traceback.
- Apply suggested backoff by skipping future cycles while updating
  `last_cycle_ms`.
- Clear degraded status after a cycle completes with zero target errors.
- Expose the display-only poller state through additive `/api/live/status` fields
  prefixed with `rest_poller_`.

### Rest30sRecorder

`Rest30sRecorder` already has similar behavior. Migrate it to the shared policy
without changing its existing public semantics.

Changes:

- Preserve existing `Rest30sStatus` fields.
- Add compatible fields:
  - `last_error_kind`
  - `last_error_code`
  - `backoff_remaining`
- Replace local `isinstance` branches with `classify_live_error`.
- Preserve current behavior that KIS API errors log warning without traceback.
- Preserve auth-style supervisor backoff while letting KIS rate-limit throttling
  stay owned by `KisClient` retry and **KIS Capacity Scheduler** cooldown.

### ProgramTradeCollector

`ProgramTradeCollector` is in the first implementation scope because it already
has a narrow per-code catch boundary.

Changes:

- Keep existing status field names intact.
- Add `last_error_kind` and `last_error_code` to `ProgramTradeCollectorStatus`.
- Use policy logging rules so KIS operational failures do not emit traceback,
  while unexpected local errors still do.
- Do not introduce supervisor backoff, scheduler changes, retry changes, or store
  behavior changes for program trade collection.

### Backfill/Route Orchestrators

Backfill and route orchestrators are explicitly out of first implementation
scope. They often combine cache fallback, API response modeling, and warning
projection, so moving them to the shared policy should be handled after the
supervisor loop migration proves stable. Do not change cache, fallback, or
route response behavior in this implementation.

### Lifecycle Status

Expose `LiveRestPoller.status()` through `/api/live/status` using additive fields:

- `rest_poller_degraded`
- `rest_poller_last_error`
- `rest_poller_last_error_kind`
- `rest_poller_last_error_code`
- `rest_poller_last_error_count`
- `rest_poller_backoff_remaining`

Use the `rest_poller_` prefix deliberately. Do not reuse the existing
`kis_api_*` fields because those describe the persistent `Rest30sRecorder`
capture path, while `LiveRestPoller` is display-only. These fields must not
affect `capture_healthy`, `capture_reason`, or `degraded_accounts`.

## Logging Contract

Supervisors should use a common log shape:

```text
<component>.<operation>_failed code=<stock-code> kind=<kind> error=<code>
```

Examples:

```text
live.rest_poller.code_failed code=247540 kind=transport error=TRANSPORT/ConnectError
live.rest30.api_code_failed code=005930 kind=rate_limit error=EGW00201
program_trade.collector.code_failed code=005930 kind=kis_api error=HTTP_500
```

For `include_traceback=False`, log with `warning(...)` and no `exc_info`.
For `include_traceback=True`, log with `exception(...)` or `error(...,
exc_info=True)`.

## Status Contract

Status fields are append-only for compatibility. Existing fields must not be
removed or renamed.

`last_error` remains a compatibility string close to the current
`f"{type(exc).__name__}: {exc}"` shape. It is displayable but not stable for
machine decisions. `last_error_kind` and `last_error_code` are the stable
machine-readable fields for API/UI logic. `degraded` is true when the last
completed or skipped cycle still has an active error condition.

Backoff skips are observable: a supervisor in backoff updates `last_cycle_ms`,
retains the last error fields, and reports `backoff_remaining > 0`.
Supervisor backoff is only a loop-noise/load guard for failures that are unlikely
to recover on the next immediate cycle. It must not duplicate **KIS Capacity
Scheduler** cooldown ownership for exhausted KIS rate-limit errors.
`ProgramTradeCollector` adopts shared classification/logging/status fields only;
it does not gain a new backoff loop in this implementation.

`/api/live/status` gains only additive `rest_poller_*` fields. Their meaning is
limited to the display-only **LiveRestPoller** and must not be interpreted as
global capture health or account health.

## Testing Strategy

Use TDD.

Add focused unit tests for `hoga.live.error_policy`:

- `KisTransportError` maps to `transport`, no traceback, degraded, with backoff.
- `KisRateLimitError` maps to `rate_limit`, no traceback, degraded, without
  supervisor backoff.
- `KisAuthError` maps to `auth`, no traceback, degraded, with backoff.
- Generic `KisApiError` maps to `kis_api`, no traceback, degraded.
- Generic `RuntimeError` maps to `unexpected`, traceback enabled.

Add supervisor tests:

- `LiveRestPoller` logs `KisTransportError` as one warning without traceback.
- `LiveRestPoller` logs unexpected local errors with traceback.
- `LiveRestPoller.status()` reports kind/code/count/degraded/backoff.
- `/api/live/status` exposes `rest_poller_*` fields from `LiveRestPoller.status()`
  without changing `capture_healthy`, `capture_reason`, or `degraded_accounts`.
- A successful `LiveRestPoller` cycle clears degraded fields.
- `Rest30sRecorder` preserves current transport warning behavior via shared
  policy.
- `ProgramTradeCollector` preserves current status count behavior while adopting
  compact KIS failure logs and the new kind/code fields, without changing its
  collection cadence.

Run targeted tests first, then the relevant live unit test subset.

## Rollout

Implement in small commits:

1. Add policy module and tests.
2. Migrate `LiveRestPoller`.
3. Migrate `Rest30sRecorder`.
4. Migrate `ProgramTradeCollector`.
5. Run targeted live tests.

Backfill and route orchestrators remain follow-up work.

## Backoff Defaults

Use conservative initial backoff defaults:

- transport: 3 cycles
- rate_limit: 0 cycles
- auth: 3 cycles
- generic kis_api: 0 cycles
- unexpected: 0 cycles

These values match the current `Rest30sRecorder` style and can be tuned later
with production evidence.
