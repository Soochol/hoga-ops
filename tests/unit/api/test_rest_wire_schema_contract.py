"""BE↔FE REST wire-mirror drift guards for hand-mirrored API types.

ADR-0004 intentionally ships Pydantic wire models verbatim while the frontend
mirrors TypeScript types by hand. These snapshots make Watchlist/Heatmap REST
field changes loud, especially where the two domains look similar but differ
in capture/scheduler fields.

두 층을 지킨다:

1. **필드 이름** — ``EXPECTED_REST_WIRE_FIELDS`` 스냅샷.
2. **enum 값** — ``WIRE_ENUM_MIRRORS`` 가 백엔드 ``Literal`` 멤버를 프론트 union
   **소스 파일과 직접 대조**한다.

2번이 왜 따로 필요한가: 손 미러에서 값 드리프트는 **타입이 원리적으로 못 잡는다**.
#1183 이 그 사고였다 — 백엔드가 ``capture_reason`` 값 4개를 뺐는데 프론트 라벨 표는
1년 가까이 그대로였고, 정작 새로 생긴 값은 매핑이 없어 영문 원문으로 노출됐다.
프론트 안에서 union↔테이블을 exhaustive 로 묶어도 그건 **프론트 내부** lockstep 일
뿐이라, 백엔드만 늘어나는 방향은 여전히 무증상이다. 이 대조가 그 방향을 막는다.

ADR-0004 가 기각한 codegen 이 아니다 — 손 미러를 유지하고 어긋남만 검출한다.
같은 ADR 의 "both must be updated in the same PR" 이 이 테스트가 강제하는 규칙이다.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

from hoga.api import models as m
from hoga.live.lifecycle import LiveStatus

_REPO_ROOT = Path(__file__).resolve().parents[3]

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


# ── enum 값 미러 (BE Literal ↔ FE union) ──────────────────────────────────────

# 등록된 쌍: 프론트 타입명 → (백엔드 Literal 멤버, 프론트 소스 파일).
#
# **등록된 쌍만 보호된다.** 새 BE Literal ↔ FE union 쌍을 만들면 여기 추가해야 한다 —
# 자동 발견은 하지 않는다(이름 규칙 매칭은 오탐·누락이 둘 다 조용하다). 백엔드
# ``Literal`` 116개 중 대부분은 ``type: Literal["capture_progress"]`` 같은 단일값
# 판별자라 드리프트 여지가 없어서, 여러 값을 갖고 프론트가 그 값으로 분기·라벨링하는
# 것만 고른다. 숫자 Literal(``pct: Literal[10, 20, 30]``)은 대상이 아니다.
#
# 양쪽 타입명이 우연히 같아서 키 하나로 쓴다. 갈리면 쌍을 (be_name, fe_name)으로
# 넓히면 된다.
WIRE_ENUM_MIRRORS: dict[str, tuple[frozenset[str], str]] = {
    "CaptureReason": (
        frozenset(get_args(LiveStatus.model_fields["capture_reason"].annotation)),
        "frontend/src/api/liveStatus.ts",
    ),
    "CapturePhase": (frozenset(get_args(m.CapturePhase)), "frontend/src/api/types.ts"),
    "SkipReason": (frozenset(get_args(m.SkipReason)), "frontend/src/api/types.ts"),
    "CalendarStatus": (frozenset(get_args(m.CalendarStatus)), "frontend/src/api/types.ts"),
    "SignalAlertSource": (
        frozenset(get_args(m.SignalAlertSource)),
        "frontend/src/api/signalAlerts.ts",
    ),
}


def _ts_union_members(ts_path: Path, type_name: str) -> frozenset[str]:
    """``export type X = 'a' | 'b';`` 의 문자열 리터럴 집합.

    한 줄·여러 줄 정의를 모두 받는다 — 줄 단위 정규식이면 여러 줄 union(``CapturePhase``)
    을 조용히 덜 읽는다.

    **주석을 잘라내기 전에 지운다.** 순서를 뒤집으면 주석 속 세미콜론에서 정의가
    조기 종료된다 — ``CalendarStatus`` 의 ``// ADR-0020 — mirrors backend; was
    missing…`` 이 실제로 그랬고, 멤버 16개 중 5개만 읽혔다. 그 상태로도 위 대조
    테스트는 "프론트에 없는 값" 을 무더기로 보고할 뿐 파서 탓임을 말해 주지 않는다.
    """
    src = ts_path.read_text(encoding="utf-8")
    head = re.search(rf"^export type {re.escape(type_name)}\s*=", src, re.M)
    assert head is not None, (
        f"{ts_path.relative_to(_REPO_ROOT)} 에 `export type {type_name}` 이 없다. "
        "프론트에서 타입을 지웠거나 이름을 바꿨다면 WIRE_ENUM_MIRRORS 도 같이 고칠 것."
    )
    # 선언 이후 전체에서 주석을 걷어낸 뒤 첫 세미콜론까지가 union 본문이다. 뒤쪽까지
    # 주석이 지워지지만 어차피 잘라 버리는 구간이라 무해하다(wire enum 값에 `//` 를
    # 품은 리터럴은 없다 — 있으면 이 파서를 고쳐야 한다).
    rest = re.sub(r"/\*.*?\*/", "", src[head.end():], flags=re.S)
    body = re.sub(r"//[^\n]*", "", rest).split(";", 1)[0]
    return frozenset(re.findall(r"'([^']*)'", body))


def test_wire_enum_members_match_frontend_union() -> None:
    for type_name, (backend_members, ts_relpath) in WIRE_ENUM_MIRRORS.items():
        ts_path = _REPO_ROOT / ts_relpath
        frontend_members = _ts_union_members(ts_path, type_name)
        missing_in_frontend = backend_members - frontend_members
        stale_in_frontend = frontend_members - backend_members
        assert frontend_members == backend_members, (
            f"{type_name} 의 BE Literal 과 FE union 이 갈렸다. "
            f"프론트에 없는 값={sorted(missing_in_frontend)} "
            f"프론트에만 남은 값={sorted(stale_in_frontend)}. "
            f"{ts_relpath} 의 union 과 그 값을 소비하는 라벨·분기 표를 같은 PR 에서 "
            "함께 고칠 것(ADR-0004)."
        )


def test_wire_enum_mirror_parser_reads_multiline_unions() -> None:
    """파서 자체의 회귀 — 여러 줄 + 줄 주석이 섞인 union 을 온전히 읽는가.

    이 검사가 없으면 파서가 조용히 덜 읽어도 위 테스트가 통과해 버린다(백엔드에만
    있는 값을 "프론트에 없다" 가 아니라 아예 비교 대상에서 빠뜨리는 식이 아니라,
    빈 집합끼리 맞아떨어지는 경우가 문제다).
    """
    members = _ts_union_members(_REPO_ROOT / "frontend/src/api/types.ts", "CalendarStatus")

    assert "complete" in members  # 첫 줄
    assert "partial_live" in members  # 마지막 줄
    assert "source_partial_confirmed" in members  # 주석 바로 다음 줄
    assert len(members) > 10  # 여러 줄을 실제로 다 읽었다는 하한
