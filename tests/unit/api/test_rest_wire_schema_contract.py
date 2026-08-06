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
            "capture_candidate",
            "folder_id",
            "last_success_date",
            "name",
            "order",
            "registered_at_kst_date",
        }
    ),
    "WatchlistResponse": frozenset({"entries", "folders", "next_run_at_ms"}),
    "HeatmapEntry": frozenset({"code", "folder_id", "name", "order"}),
    "HeatmapResponse": frozenset(
        {"entries", "folders", "capture_markers", "next_run_at_ms"}
    ),
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


def test_heatmap_capture_marker_stays_off_the_entry() -> None:
    """마커는 entry 가 아니라 **코드 키 사이드 테이블**에 산다 (ADR-0142).

    ADR-0142 로 히트맵이 캡처 대상이 되면서 이 테스트의 원래 명제("캡처·스케줄러
    필드 없음")는 무효가 됐지만, 그중 **하나는 오히려 더 중요해졌다**: HeatmapEntry
    의 identity 는 ``(folder_id, code)`` 라 마커를 entry 에 얹으면 한 종목이 3개
    그룹에 있을 때 마커가 3벌로 갈라진다. 정작 그 마커가 가리키는 캡처는 ``(code,
    date)`` 하나뿐이다. 그래서 entry 에 마커 필드가 생기는 것 자체를 금지한다.
    """
    heatmap_entry_fields = set(m.HeatmapEntry.model_fields)
    heatmap_response_fields = set(m.HeatmapResponse.model_fields)

    assert "registered_at_kst_date" not in heatmap_entry_fields
    assert "last_success_date" not in heatmap_entry_fields
    # 마커는 코드 키 맵으로만 실린다.
    assert "capture_markers" in heatmap_response_fields
    assert "capture_markers" not in heatmap_entry_fields
