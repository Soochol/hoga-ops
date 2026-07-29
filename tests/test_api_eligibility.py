"""Capture eligibility — a single home for "is this Stock-Date capturable?"

Composes disk_state.check_disk_state with the today_too_early Clock policy.
Replaces the previously-split logic between captures.enqueue_items (Q14 guard)
and captures._run_item (Q15/Q16 disk-state branching).
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from hoga.api import eligibility
from hoga.api.eligibility import CaptureDecision

KST = dt.timezone(dt.timedelta(hours=9))


def _write_meta(path: Path, *, collection_complete: bool, is_partial: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "collection_complete": collection_complete,
        "is_partial": is_partial,
        "regular_session_open_ms": 90_000_000,     # 09:00 HHMMSSmmm
        "regular_session_close_ms": 153_100_000,   # 15:31 HHMMSSmmm
    }))


def test_decide_capture_complete_skips_with_already_complete_reason(tmp_path: Path) -> None:
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=False)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason="already_complete", resume=False)


def test_decide_capture_complete_skips_even_with_force_retry_per_adr_0035(tmp_path: Path) -> None:
    """ADR-0035 relaxes the enqueue dedupe to let done+force_retry through.
    decide_capture must remain the last gate against accidental overwrite of
    a COMPLETE Stock-Date — without this gate, the relaxed enqueue branch
    would destroy good data.
    """
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=False)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=True,
    )
    assert decision == CaptureDecision(skip_reason="already_complete", resume=False)


def test_decide_capture_source_partial_retries_without_force_concept(tmp_path: Path) -> None:
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=True, is_partial=True)
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=False)


def _write_meta_with_gap(path: Path, *, gap_ranges: list[dict]) -> None:
    """A source_partial meta carrying ADR-0126 gap_ranges (no identical count)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "collection_complete": True,
        "is_partial": True,
        "gap_ranges": gap_ranges,
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_100_000,
    }))


def test_decide_capture_edge_gap_skips_upstream_without_identical(tmp_path: Path) -> None:
    """ADR-0126: source_partial + leading gap → upstream_gap skip, no identical
    corroboration needed (the AM loss is an upstream-boundary loss up front)."""
    _write_meta_with_gap(
        tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
        gap_ranges=[{"start_ms": 90_000_000, "end_ms": 144_318_939}],
    )
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason="upstream_gap", resume=False)


def test_decide_capture_interior_gap_still_proceeds(tmp_path: Path) -> None:
    """ADR-0126: an interior gap alone stays retryable — decide_capture proceeds."""
    _write_meta_with_gap(
        tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
        gap_ranges=[{"start_ms": 122_850_000, "end_ms": 123_550_010}],
    )
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=False)


def _write_meta_with_identical(path: Path, *, identical_capture_count: int) -> None:
    """A source_partial meta carrying ADR-0093's identical_capture_count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "collection_complete": True,
        "is_partial": True,
        "identical_capture_count": identical_capture_count,
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_100_000,
    }))


def test_decide_capture_confirmed_upstream_gap_skips(tmp_path: Path) -> None:
    """ADR-0093: source_partial + identical_capture_count>=2 → skip upstream_gap."""
    _write_meta_with_identical(
        tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
        identical_capture_count=2,
    )
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason="upstream_gap", resume=False)


def test_decide_capture_confirmed_upstream_gap_bypassed_by_force_retry(tmp_path: Path) -> None:
    """force_retry lets the user re-verify a confirmed gap (proceed, no skip)."""
    _write_meta_with_identical(
        tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
        identical_capture_count=3,
    )
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=True,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=False)


def test_decide_capture_unconfirmed_source_partial_still_proceeds(tmp_path: Path) -> None:
    """identical_capture_count=1 (only one capture so far) is NOT confirmed →
    proceed fresh, same as the pre-ADR-0093 behavior."""
    _write_meta_with_identical(
        tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
        identical_capture_count=1,
    )
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=False)


def test_decide_capture_client_incomplete_resumes(tmp_path: Path) -> None:
    # Raw pages present but no meta — disk_state returns CLIENT_INCOMPLETE.
    raw = tmp_path / "raw" / "20260518" / "005930"
    raw.mkdir(parents=True)
    (raw / "first_0001.tsv").write_text("")
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=True)


def test_decide_capture_none_fresh(tmp_path: Path) -> None:
    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
    )
    assert decision == CaptureDecision(skip_reason=None, resume=False)


def test_find_ineligible_dates_flags_today_before_1630_kst() -> None:
    now = dt.datetime(2026, 5, 22, 16, 29, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260520", "20260522"], now=now,
    )
    assert rejected == ["20260522"]


def test_find_ineligible_dates_empty_when_no_match() -> None:
    now = dt.datetime(2026, 5, 22, 16, 59, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260518", "20260519", "20260520"], now=now,
    )
    assert rejected == []


def test_find_ineligible_dates_today_at_1630_passes() -> None:
    """16:30 KST is the boundary — at-or-after-16:30 is admissible."""
    now = dt.datetime(2026, 5, 22, 16, 30, 0, tzinfo=KST)
    rejected = eligibility.find_ineligible_dates(
        candidate_dates=["20260522"], now=now,
    )
    assert rejected == []


def test_decide_capture_invalid_proceeds_as_fresh(tmp_path: Path) -> None:
    """INVALID disk state → fresh capture (no resume from corrupt artifacts)."""
    from hoga.api.disk_state import DiskState
    from hoga.api.eligibility import decide_capture

    # Build a meta.json that classify_from_meta will rate as INVALID:
    # collection_complete=True so it passes the CLIENT_INCOMPLETE gate,
    # but close_ms=0 trips meta.close_after_open (error).
    pq_dir = tmp_path / "parquet" / "20260518" / "003490"
    pq_dir.mkdir(parents=True)
    meta = {
        "regular_session_open_ms": 90_000_000,    # 09:00 HHMMSSmmm
        "regular_session_close_ms": 0,            # invariant breach
        "collection_complete": True,
        "is_partial": False,
    }
    (pq_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    # now 를 명시해 캡처 날짜를 업스트림 보유 창 **안**에 둔다. 창 밖이면
    # _is_expired_upstream_stub 가 upstream_gap 으로 스킵하는데(2026-07-29 추가),
    # 이 테스트가 지키는 계약은 그쪽이 아니라 "아직 받을 수 있는 INVALID 는
    # 손상 아티팩트를 믿지 말고 fresh capture 한다" 쪽이다.
    decision = decide_capture(
        data_dir=tmp_path, code="003490", date="20260518", force_retry=False,
        now=dt.datetime(2026, 5, 19),
    )

    # Sanity: precondition holds (classify is INVALID)
    from hoga.api.disk_state import check_disk_state
    assert check_disk_state(tmp_path, "003490", "20260518").state == DiskState.INVALID

    # Proceeds (no skip), resume=False (fresh capture, don't trust corrupt artifacts)
    assert decision.skip_reason is None
    assert decision.resume is False


def test_decide_capture_no_upstream_data_retries_without_force_concept(tmp_path: Path) -> None:
    """A sentinel-only directory should be retried on the next user request.

    The old force_retry distinction is gone: the sentinel is just the previous
    outcome marker, not a permanent skip gate.
    """
    from hoga.api.eligibility import decide_capture

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    sentinel = raw_dir / ".no_upstream_data"
    sentinel.touch()

    decision = decide_capture(
        data_dir=tmp_path, code="003490", date="20260319", force_retry=False
    )
    assert decision.skip_reason is None
    assert decision.resume is False
    assert not sentinel.exists()


def test_decide_capture_no_sentinel_no_change_in_existing_paths(tmp_path: Path) -> None:
    """A fresh (NONE) Stock-Date is unaffected by the new branches."""
    from hoga.api.eligibility import decide_capture

    decision = decide_capture(
        data_dir=tmp_path, code="003490", date="20260319", force_retry=False
    )
    assert decision.skip_reason is None
    assert decision.resume is False


def test_skip_reason_wire_type_includes_no_upstream_data() -> None:
    """models.py SkipReason and eligibility.py SkipReason must agree on the
    full value set — the worker writes the eligibility value into
    state.skip_reason which pydantic then serialises through the models.py
    Literal. Set equality catches the full class of divergence (e.g., a
    future PR adds a value to one module but forgets the other), which a
    presence check would silently miss."""
    from typing import get_args

    from hoga.api import eligibility as elig_module, models as models_module
    assert set(get_args(elig_module.SkipReason)) == set(get_args(models_module.SkipReason))
    assert "no_upstream_data" in get_args(elig_module.SkipReason)


# ---------------------------------------------------------------------------
# 만료된 업스트림 스텁 스킵 (2026-07-29)
#
# hogaplay 는 보유 창(~18h) 밖 거래일을 요청하면 실패하는 대신 스텁을 준다:
# info.tsv 의 close 필드가 0 이고 이벤트도 정상의 10% 미만. 파서가 그 0 을
# 기록하고 → error invariant → INVALID 로 분류된다. 전 구간이 올바른 동작이다.
#
# 문제는 ADR-0093 의 upstream_gap 스킵이 SOURCE_PARTIAL 전용이라, 이 클래스만
# 재시도 차단 없이 남았다는 것이다. 날짜 범위 백필이 같은 날짜를 반복해 훑으며
# INVALID 를 재생산했다 — ADR-0063 이 129건으로 적은 것이 573건이 됐고 그중
# 537건이 최근 14일 내 작성분이었다.
#
# 경계가 이 묶음의 핵심이다: **보유 창 안의 close_ms=0 은 막으면 안 된다**
# (장중 캡처는 세션이 안 끝나 0 인 게 정상이고 마감 후 재캡처하면 채워진다).
# ---------------------------------------------------------------------------


def _write_close_zero_meta(data_dir: Path, code: str, date: str, **extra: object) -> None:
    """close_ms=0 스텁 meta. 실제 573건의 형태(collection_complete=False)를 따른다."""
    p = data_dir / "parquet" / date / code
    p.mkdir(parents=True)
    (p / "meta.json").write_text(json.dumps({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,
        "collection_complete": False,
        "is_partial": True,
        **extra,
    }), encoding="utf-8")


def test_expired_close_zero_stub_is_skipped(tmp_path: Path) -> None:
    """보유 창 밖 close_ms=0 → upstream_gap 스킵(백필 재생산 중단)."""
    _write_close_zero_meta(tmp_path, "003490", "20260518")

    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="003490", date="20260518", force_retry=False,
        now=dt.datetime(2026, 7, 29),
    )
    assert decision.skip_reason == "upstream_gap"
    assert decision.resume is False


def test_recent_close_zero_still_proceeds(tmp_path: Path) -> None:
    """보유 창 **안**이면 재캡처가 채울 수 있다 — 막지 않는다.

    이게 없으면 장중에 잡힌 close_ms=0(세션 미종료라 정상)까지 영구 차단된다.
    """
    _write_close_zero_meta(tmp_path, "003490", "20260518")

    for day in (18, 19, 20):  # 당일 · +1 · +2 = 보유 창 안
        decision = eligibility.decide_capture(
            data_dir=tmp_path, code="003490", date="20260518", force_retry=False,
            now=dt.datetime(2026, 5, day),
        )
        assert decision.skip_reason is None, f"2026-05-{day} 에 막히면 안 된다"


def test_expired_stub_skip_is_bypassed_by_force_retry(tmp_path: Path) -> None:
    """force_retry 는 ADR-0093 과 같은 탈출구를 준다 — 사용자가 직접 재확인 가능."""
    _write_close_zero_meta(tmp_path, "003490", "20260518")

    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="003490", date="20260518", force_retry=True,
        now=dt.datetime(2026, 7, 29),
    )
    assert decision.skip_reason is None


def test_invalid_with_other_errors_still_proceeds(tmp_path: Path) -> None:
    """원인이 close_ms 하나가 아니면 스킵하지 않는다.

    다른 error 가 섞여 있으면 아티팩트가 다른 이유로도 깨진 것이라, "업스트림이
    못 준다" 로 단정할 수 없다 — fresh capture 가 여전히 맞다. open_ms 는
    normalize 가 09:00 으로 복원하므로, 여기서는 세션 범위를 벗어난 close 로
    close_in_kst_range 만 남기고 close_after_open 은 통과시킨다.
    """
    p = tmp_path / "parquet" / "20260518" / "003490"
    p.mkdir(parents=True)
    (p / "meta.json").write_text(json.dumps({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 200_000_000,  # 20:00 — open 보다 크지만 장 마감 범위 밖
        "collection_complete": False,
        "is_partial": True,
    }), encoding="utf-8")

    from hoga.api.disk_state import check_disk_state
    cls = check_disk_state(tmp_path, "003490", "20260518")
    ids = {v.invariant_id for v in cls.errors}
    # 전제: close_ms=0 쌍과 다른 조합이어야 이 테스트가 의미를 갖는다.
    assert ids != {"meta.close_after_open", "meta.close_in_kst_range"}

    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="003490", date="20260518", force_retry=False,
        now=dt.datetime(2026, 7, 29),
    )
    assert decision.skip_reason is None


def test_expired_stub_guard_ignores_non_invalid_states(tmp_path: Path) -> None:
    """정상 CLIENT_INCOMPLETE 는 계속 resume 된다 — 가드가 넘치지 않는다."""
    _write_meta(tmp_path / "parquet" / "20260518" / "005930" / "meta.json",
                collection_complete=False, is_partial=True)

    decision = eligibility.decide_capture(
        data_dir=tmp_path, code="005930", date="20260518", force_retry=False,
        now=dt.datetime(2026, 7, 29),
    )
    assert decision.skip_reason is None
    assert decision.resume is True
