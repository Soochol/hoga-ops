"""BE↔FE wire-mirror drift guard for the SSE event models (ADR-0004).

ADR-0004 ships the Pydantic wire models verbatim and has `frontend/src/api/
types.ts` mirror them BY HAND — there is no codegen, so the TypeScript
compiler has zero visibility into `hoga/api/models.py`. A backend field
rename/addition therefore compiles clean on both sides and surfaces only as
runtime `undefined` in the browser (a blank indicator, no error). The parquet
column contract got a guard after the 2026-05-28 incident
(`test_source_schema_contract.py`); the HTTP/SSE wire mirror had none.

This is that guard for the SSE push-channel event models — the worst-case
drift surface, because unlike a 404 a dropped event field fails silently in
the UI. It is intentionally a TRIPWIRE: any field rename/add/remove on these
models fails here, telling the author to (1) update `types.ts` to match and
(2) update the snapshot below. That turns "did the reviewer remember to edit
two files" into a checkable property.

Scope note: this pins the SSE event models only (the set whose drift is
invisible to both compilers). It is additive — it does NOT re-litigate
ADR-0004's by-hand, no-codegen choice; it makes that choice safe.

When a change here is intentional: update the matching block in
`frontend/src/api/types.ts` AND the expected field set below, in the same
commit.
"""
from __future__ import annotations

from hoga.api import models as m

# Snapshot of each SSE event model's field-name set, extracted from the models
# themselves (sorted(cls.model_fields)) — NOT hand-typed. Regenerate with:
#   uv run --extra dev python -c "from hoga.api import models as m; \
#     print(sorted(m.CaptureFinishedEvent.model_fields))"
EXPECTED_SSE_EVENT_FIELDS: dict[str, frozenset[str]] = {
    "CaptureProgressEvent": frozenset(
        {"code", "date", "item_id", "phase", "progress", "type"}
    ),
    "CapturePhaseEvent": frozenset(
        {"code", "date", "item_id", "phase", "type"}
    ),
    "CaptureFinishedEvent": frozenset(
        {
            "code", "date", "error", "item_id", "phase", "result",
            "skip_reason", "type", "warnings",
        }
    ),
    "CaptureQueuedEvent": frozenset({"items", "type"}),
    "CaptureQueuePausedEvent": frozenset({"message", "reason", "type"}),
    "CaptureQueueResumedEvent": frozenset({"reason", "type"}),
    "CaptureQueueDrainedEvent": frozenset(
        {"total_cancelled", "total_done", "total_failed", "total_skipped", "type"}
    ),
    "CaptureDismissedEvent": frozenset({"item_ids", "type"}),
    "CaptureTimingEvent": frozenset({"id", "summary", "type"}),
}


def test_sse_event_models_match_frontend_mirror_snapshot() -> None:
    """Each SSE event model's field set must match the checked-in snapshot.

    A mismatch means a backend field drifted. Update frontend/src/api/types.ts
    to match (no compiler will catch this for you — ADR-0004), then update
    EXPECTED_SSE_EVENT_FIELDS above, in the same commit.
    """
    for name, expected in EXPECTED_SSE_EVENT_FIELDS.items():
        cls = getattr(m, name)
        actual = frozenset(cls.model_fields.keys())
        added = actual - expected
        removed = expected - actual
        assert actual == expected, (
            f"{name} wire fields drifted from the frontend mirror snapshot. "
            f"added={sorted(added)} removed={sorted(removed)}. "
            f"Update frontend/src/api/types.ts to match (ADR-0004: hand-mirrored, "
            f"no codegen — the TS compiler will NOT catch this), then update "
            f"EXPECTED_SSE_EVENT_FIELDS in this file, in the same commit."
        )


def _sse_event_models() -> set[str]:
    """Every concrete model whose `type` field defaults to a 'capture_*' literal
    — i.e. an SSE push-channel event the frontend subscribes to and mirrors."""
    found: set[str] = set()
    for name, obj in vars(m).items():
        if not (isinstance(obj, type) and issubclass(obj, m.BaseModel)):
            continue
        type_field = obj.model_fields.get("type")
        if type_field is None:
            continue
        default = type_field.default
        if isinstance(default, str) and default.startswith("capture_"):
            found.add(name)
    return found


def test_snapshot_covers_every_sse_event_model() -> None:
    """The snapshot must not silently fall behind a NEW SSE event model.

    Any model whose `type` defaults to a 'capture_*' literal must appear in
    EXPECTED_SSE_EVENT_FIELDS — so adding a new push-channel event without a
    mirror entry fails here rather than shipping unguarded.
    """
    discovered = _sse_event_models()
    missing = discovered - set(EXPECTED_SSE_EVENT_FIELDS)
    assert not missing, (
        f"SSE event model(s) {sorted(missing)} have no snapshot entry. Add them "
        f"to EXPECTED_SSE_EVENT_FIELDS and mirror them in frontend/src/api/types.ts."
    )
