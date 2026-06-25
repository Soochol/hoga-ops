# 0081 — Retire `force_retry` as a user-facing retry concept

**Status:** accepted (2026-06-25)

`force_retry` used to mean "ignore the cached incomplete state and start fresh", but it became a confusing second retry model beside **Retry**, **fail_streak**, and inventory unblock. We now retire it as domain language and keep the boolean only as a legacy wire field so old queue rows and API clients still deserialize.

Current policy is split by responsibility:

- **Retry** is the user operation: enqueue the Stock-Date again, subject to **fail_streak >= attempt_cap** blocking.
- **Capture Eligibility** is the worker decision: `COMPLETE` skips, `CLIENT_INCOMPLETE` resumes, and `NONE` / `INVALID` / `SOURCE_PARTIAL` / `NO_UPSTREAM_DATA` start fresh. For `NO_UPSTREAM_DATA`, the `.no_upstream_data` sentinel is deleted immediately before the fresh attempt.
- The UI must not expose force retry controls, defaults, chips, or wording. Incomplete disk states should be shown as incomplete; when a later retry completes the Stock-Date, the normal complete state replaces that display.

This supersedes the force-gated branches in ADR-0021, ADR-0031, ADR-0033, ADR-0035, and the force wording in ADR-0042. The trade-off is that ordinary retries may issue one extra worker cycle for terminal `_done` rows whose disk state is already complete, but `decide_capture` remains the data-loss guard and exits as `already_complete`. That cost is preferable to asking the user to understand a separate "force" switch whose real behavior depended on hidden disk state.
