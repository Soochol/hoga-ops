# 0009 — `UpstreamCode` is a separate enum from `CaptureErrorCode`

**Status:** proposed (2026-05-22) — pending implementation of `hoga/api/error_codes.py::UpstreamCode` per `docs/superpowers/specs/2026-05-22-krx-env-symbol-design.md`
**Related:**
- `hoga/api/error_codes.py` — host module
- `docs/superpowers/specs/2026-05-22-krx-env-symbol-design.md` §5.4, §5.7 — usage sites
- ADR-0004 — "wire model has no adapter" / mirror discipline; both `CaptureErrorCode` and `UpstreamCode` are mirrored verbatim to `frontend/src/api/types.ts`

## Decision

A new `StrEnum` named `UpstreamCode` is added to `hoga/api/error_codes.py`, sibling to a trimmed `CaptureErrorCode`. `UpstreamCode` enumerates **upstream-dependency availability conditions** — KRX login state, pykrx fetch outcomes, hogaplay cookie state, hogaplay HTTP errors, and (future) similar dependency signals.

The same `UpstreamCode` value appears in three wire-contract surfaces, distinguished by the field name:

- **Cache envelope (HTTP 200) `reason: UpstreamCode | None`** — e.g. `SymbolsAllResponse`, `CalendarResponse`. The endpoint returned data (possibly empty or stale) AND wants to tell the client what upstream condition was observed most recently.
- **HTTP error envelope (5xx) `detail.code: UpstreamCode`** — e.g. enqueue's HTTP 503 when KRX trading-day data cannot be obtained. The request could not proceed.
- **SSE per-item failure `capture_finished.error.code: CaptureErrorCode | UpstreamCode`** — the captured item failed because of an upstream condition (cookie expired, hogaplay HTTP error). The wire field type widens; the values remain stable strings.

The previously co-located codes `COOKIE_EXPIRED`, `COOKIE_MISSING`, and `HOGAPLAY_HTTP_ERROR` **migrate from `CaptureErrorCode` to `UpstreamCode`** as part of the same change. After the migration:

- `CaptureErrorCode` retains only captures-domain non-upstream codes: `TODAY_TOO_EARLY`, `MISSING_RANGE`, `TERMINAL`, `NOT_FOUND`, `INTERNAL_ERROR`.
- `UpstreamCode` holds all upstream-availability codes: `KRX_CREDENTIALS_MISSING`, `KRX_FETCH_FAILED`, `COOKIE_EXPIRED`, `COOKIE_MISSING`, `HOGAPLAY_HTTP_ERROR`.

## Context

The spec that motivates this ADR introduces a fourth wire-contract category alongside the three already implicit in the codebase. The four categories:

| # | Category | Example | Channel | Field |
|---|---|---|---|---|
| 1 | Request-level rejection | `TODAY_TOO_EARLY`, `MISSING_RANGE` | HTTP 4xx | `detail.code` |
| 2 | Background per-item failure | `COOKIE_EXPIRED`, `HOGAPLAY_HTTP_ERROR` | SSE `capture_finished.error.code` | `code` |
| 3 | Cache freshness flag | `"fresh" \| "stale" \| "unavailable"` | HTTP 200 envelope | `status` |
| 4 | Upstream-dependency availability | `KRX_CREDENTIALS_MISSING`, `KRX_FETCH_FAILED` | Both envelope `reason` AND HTTP 5xx `code` | dual |

Categories 1 and 2 currently share `CaptureErrorCode`. The enum docstring acknowledges these as "informal categories." Category 3 is its own typed status field. Category 4 — the new one — needs a home.

Two paths were possible:

1. Add the new values to `CaptureErrorCode`, growing the enum further.
2. Introduce a separate enum specifically for upstream-availability codes.

This ADR chose (2).

## Alternatives considered

### A. Extend `CaptureErrorCode`

Add `KRX_CREDENTIALS_MISSING` and `KRX_FETCH_FAILED` to the existing enum. Smallest patch.

Rejected because the enum is already mixing two categories, and the spec adds a third. Three of the eight existing values (`COOKIE_EXPIRED`, `COOKIE_MISSING`, `HOGAPLAY_HTTP_ERROR`) are conceptually upstream-availability codes that happened to land in the captures-domain enum because that's where they were first surfaced. Adding more upstream codes would make the conceptual mixing harder to untangle later.

### B. (Chosen) Separate `UpstreamCode` enum, AND migrate the existing cookie/hogaplay codes into it

Cost: one new enum, one new TypeScript union mirror, ~4 call-site updates in `captures.py`, ~10 lines of TypeScript refactor (split union + add `CaptureFinishedErrorCode` alias), plus mechanical test updates that change `CaptureErrorCode.COOKIE_*` to `UpstreamCode.COOKIE_*` find/replace.

Benefit: clear semantic separation, **all** upstream codes consolidated. New upstream conditions (pykrx rate limit, hogaplay maintenance, future dependencies like a database) have an obvious home. The captures-domain enum stays focused on lifecycle and request gating.

The migration was nearly skipped during initial spec drafting (scope-discipline reflex). Reconsidered because: (1) the wire-contract string values stay stable, so the migration is mechanical; (2) leaving cookie/hogaplay codes mixed into `CaptureErrorCode` creates permanent debt that future readers will hit; (3) doing it while already touching `error_codes.py` is the cheapest moment; (4) the "lifecycle vs stateless" framing that initially seemed to justify keeping cookie codes in `CaptureErrorCode` does not survive inspection (`HOGAPLAY_HTTP_ERROR` is upstream and lifecycle-neutral, so the heterogeneity is intrinsic to the current enum). The migration is one-shot; this is the moment.

### C. Unify everything into a single `ApiCode` enum

Collapse `CaptureErrorCode` into a project-wide enum. Fewer types, but a single enum that mixes request gating, per-item background failures, AND upstream availability is the worst of every world. Rejected.

### D. Rename `CaptureErrorCode` to a broader name and keep one enum

E.g. rename to `ApiCode`. Less code churn than (C) because the enum body is preserved, but the rename touches every importer (backend + frontend + tests). Out of scope blast radius for what this spec was supposed to be — a `.env` loader plus a Symbol Master UX recovery flow.

## Consequences worth flagging for future readers

- **The same string value appears in two fields.** `"krx_credentials_missing"` may show up as `SymbolsAllResponse.reason` (HTTP 200) or as `HTTPException.detail.code` (HTTP 503). The string value is the wire contract; the field name signals the response shape. The frontend's hint-text mapping is keyed by the string and consumed by both surfaces.
- **`CaptureErrorCode` shrinks; `COOKIE_*` and `HOGAPLAY_HTTP_ERROR` migrate to `UpstreamCode`.** The on-wire string values are stable (`"cookie_expired"` etc.), so external observers (logs, dashboards) are unaffected. Backend importers update the symbol path; frontend `CaptureError.code` widens to `CaptureErrorCode | UpstreamCode` via the alias `CaptureFinishedErrorCode`. The `capture_queue_paused.reason` field is typed independently as a bare literal `'cookie_expired'` and is not affected by the migration.
- **Mirror discipline applies to both enums.** Per ADR-0004 and the docstring of `hoga/api/error_codes.py`, adding a new value to `UpstreamCode` requires updating the corresponding TypeScript union in the same commit. The new `UpstreamCode` union in `frontend/src/api/types.ts` joins the existing `CaptureErrorCode` union.
- **Two enums is the maximum.** If a fifth wire-contract category appears (e.g., "user-action-required prompts" — capture-confirmation dialogs), the analysis should start by asking whether one of the existing two enums already covers it. The default answer should be yes; introducing a third enum requires a new ADR with the same rigor as this one.
- **The pattern `code | reason` is a convention, not a rule.** Anyone introducing a new envelope shape may pick `reason`, `condition`, etc. for category-4 fields if it reads better in their context. The string values remain `UpstreamCode`. What this ADR fixes is *which enum the value comes from*, not the field name.
- **FastAPI serializes `StrEnum` to its string value automatically.** `HTTPException(detail={"code": UpstreamCode.KRX_CREDENTIALS_MISSING, ...})` produces `{"code": "krx_credentials_missing", ...}` on the wire without manual `.value` conversion. Mirrored discipline on the Python side: tests should compare against `UpstreamCode.KRX_CREDENTIALS_MISSING`, not the bare string, except when asserting the literal wire payload.

## When to revisit

- More than ~10 `UpstreamCode` values accumulate AND distinct sub-categories emerge (e.g., "credential" vs "rate-limit" vs "outage"). At that point a sub-categorization (perhaps a `(code, severity)` tuple type, or a follow-on enum) may be warranted.
- A non-captures domain (e.g., a future analytics endpoint) needs request-level error codes. Adding them to `CaptureErrorCode` would re-introduce the mixing this ADR rejected; a third domain-specific enum (or a renamed broader enum) becomes the right move.
- A bug or design surface forces re-coupling between `CaptureErrorCode` and `UpstreamCode` (e.g., a code conceptually belonging to both). Revisit; the right answer may be to introduce a small intersection type rather than merging the enums.
