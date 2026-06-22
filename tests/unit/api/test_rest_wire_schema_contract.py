"""BE↔FE REST wire-mirror drift guards for hand-mirrored API types.

ADR-0004 intentionally ships Pydantic wire models verbatim while the frontend
mirrors TypeScript types by hand. These snapshots make Watchlist/Heatmap REST
field changes loud, especially where the two domains look similar but differ
in capture/scheduler fields.
"""
from __future__ import annotations

from hoga.api import models as m


EXPECTED_REST_WIRE_FIELDS: dict[str, frozenset[str]] = {
    "WatchlistFolderView": frozenset({"id", "name", "order", "capture_enabled"}),
    "WatchlistEntryView": frozenset(
        {
            "code",
            "folder_id",
            "last_success_date",
            "name",
            "order",
            "registered_at_kst_date",
        }
    ),
    "WatchlistResponse": frozenset({"entries", "folders", "next_run_at_ms"}),
    "HeatmapEntry": frozenset({"code", "folder_id", "name", "order"}),
    "HeatmapResponse": frozenset({"entries", "folders"}),
}


def test_rest_wire_models_match_frontend_mirror_snapshot() -> None:
    for name, expected in EXPECTED_REST_WIRE_FIELDS.items():
        cls = getattr(m, name)
        actual = frozenset(cls.model_fields.keys())
        added = actual - expected
        removed = expected - actual
        assert actual == expected, (
            f"{name} REST wire fields drifted from the frontend mirror snapshot. "
            f"added={sorted(added)} removed={sorted(removed)}. Update the matching "
            "frontend/src/api/*.ts mirror type, then update EXPECTED_REST_WIRE_FIELDS "
            "in this file in the same commit."
        )


def test_heatmap_wire_stays_capture_and_scheduler_free() -> None:
    heatmap_entry_fields = set(m.HeatmapEntry.model_fields)
    heatmap_response_fields = set(m.HeatmapResponse.model_fields)

    assert "registered_at_kst_date" not in heatmap_entry_fields
    assert "last_success_date" not in heatmap_entry_fields
    assert "next_run_at_ms" not in heatmap_response_fields
