"""Capture eligibility — single home for the decision "is this Stock-Date
ready to capture, and how?"

Two entry points, both pure:

- :func:`find_ineligible_dates` — enqueue-time gate. Returns the YYYYMMDD
  dates from the request that fail policy checks (currently only the
  16:30-KST `today_too_early` rule from spec §11 Q14). Caller raises 400.

- :func:`decide_capture` — worker-time deciding-phase. Composes
  :func:`disk_state.check_disk_state` into a :class:`CaptureDecision`
  describing whether to skip (and why) or proceed (with `resume` flag for
  CLIENT_INCOMPLETE).

This module is the second concrete payoff of the horizontal-seam pattern
ADR-0007 established for ``disk_state.py``: two callers (enqueue route and
worker deciding phase) needed the same eligibility contract, so the seam
earned its keep ("two adapters = real seam"). Extending the contract
(holiday gate, code blacklist, capture quotas) adds branches HERE rather
than scattering across captures.py.

ADRs respected:
- ADR-0001 (table-as-module) — not affected; this module owns no tables.
- ADR-0005 (capture state on event loop) — these functions are pure; no
  shared state, no async, no SSE.
- ADR-0006 (captures.py stays single module) — does NOT split queue/worker
  state out; only the eligibility decision moves here. ADR-0007's seam
  rationale ("two-adapters rule") applies cleanly.
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from hoga.api.disk_state import Classification, DiskState, check_disk_state
from hoga.api.models import SkipReason
from hoga.collector.orchestrator import is_today_too_early, now_kst

# hogaplay 가 과거 거래일을 서빙하는 창. 실측 ~18시간(다음날 아침이면 전일
# 오전분이 이미 사라져 있다). 달력일 2일로 넉넉히 잡는다 — 좁게 잡아 아직 받을
# 수 있는 캡처를 막는 쪽이, 넓게 잡아 무의미한 재시도를 몇 번 더 하는 쪽보다
# 훨씬 나쁘다. 오늘·어제는 항상 재시도 가능하다.
_UPSTREAM_RETENTION_DAYS = 2

# `regular_session_close_ms == 0` 스텁이 만드는 error 위반 집합.
#
# 0 은 **반드시 둘 다** 발화시킨다: open 보다 작고(close_after_open), 12–18시
# 범위 밖이다(close_in_kst_range). normalize_session_bounds 가 open 을 09:00 으로
# 복원한 뒤 검사하므로 open 쪽이 0 이어서 비교가 흐려질 일도 없다.
# 2026-07-29 전수 스캔이 이를 확인한다 — 573개 소스 × 정확히 이 둘(1,146건).
#
# 판정은 **정확히 일치**여야 한다. 부분집합으로 느슨하게 잡으면 close_ms 가 0 이
# 아닌 다른 이상값(예: 20:00 — open 보다 크지만 장 마감 범위 밖)까지 걸려든다.
# 그건 만료 스텁이 아니라 별개 결함이고, 재캡처가 고칠 수 있으므로 막으면 안 된다.
_CLOSE_MS_ZERO_ERRORS = frozenset({
    "meta.close_after_open",
    "meta.close_in_kst_range",
})


def _is_expired_upstream_stub(
    classification: Classification, date: str, now: dt.datetime
) -> bool:
    """이 INVALID 가 "업스트림이 이미 못 주는 날짜" 스텁인가?

    hogaplay 는 보유 창을 벗어난 거래일을 요청하면 실패하는 대신 **스텁**을
    돌려준다: `info.tsv` 의 close 필드가 0 이고 이벤트도 정상의 10% 미만이다
    (2026-07-29 실측 total_unique_events 중앙값 3,003 vs 정상 33,884). 파서는 그
    0 을 정확히 기록하고, invariant 가 error 를 내고, 분류가 INVALID 로 보낸다 —
    전 구간이 올바르게 동작한 결과다.

    문제는 그 다음이다. ADR-0093 의 `upstream_gap` 스킵은 SOURCE_PARTIAL 전용인데
    close_ms=0 은 error 라 **INVALID 로 먼저 라우팅**된다(그 순서 자체는 5/18/003490
    사고를 고친 올바른 수정이다). 결과적으로 이 클래스만 재시도 차단이 없는 상태가
    됐고, 날짜 범위 백필이 같은 6개 날짜를 반복해 훑으면서 INVALID 를 재생산했다 —
    ADR-0063 이 129건으로 기록한 것이 2026-07-29 에 573건이 되어 있었고, 그중
    537건이 최근 14일 내에 새로 쓰인 것이었다.

    판정은 두 조건을 **모두** 요구한다:

    1. error 집합이 close_ms=0 쌍과 **정확히 일치** — 원인이 그것 하나뿐이어야 한다.
    2. 캡처 날짜가 업스트림 보유 창 밖 — 이게 "재캡처가 무의미하다" 를 담보한다.
       (1)만으로 막으면 **오늘 장중에 잡힌 close_ms=0** 까지 영구 차단된다. 그건
       세션이 아직 안 끝나서 0 인 정상 상태이고, 장 마감 후 재캡처하면 채워진다.
    """
    if classification.state != DiskState.INVALID:
        return False
    if {v.invariant_id for v in classification.errors} != _CLOSE_MS_ZERO_ERRORS:
        return False
    try:
        captured = dt.datetime.strptime(date, "%Y%m%d").date()
    except ValueError:
        return False  # 날짜 형식이 이상하면 판정하지 않는다(막지 않는다)
    return (now.date() - captured).days > _UPSTREAM_RETENTION_DAYS


@dataclass(frozen=True)
class CaptureDecision:
    """Decision output for one Stock-Date.

    Invariant: exactly one of ``skip_reason`` is non-None OR ``resume`` is
    meaningful — when ``skip_reason`` is set, the caller skips and ignores
    ``resume``; when ``skip_reason`` is None, the caller proceeds with the
    given ``resume`` flag.
    """
    skip_reason: SkipReason | None
    resume: bool


def decide_capture(
    *,
    data_dir: Path,
    code: str,
    date: str,
    force_retry: bool,
    now: dt.datetime | None = None,
) -> CaptureDecision:
    """Worker deciding-phase decision.

    Branches (ADR-0021 + ADR-0007 + ADR-0093):
      - DiskState.COMPLETE         → skip with reason "already_complete"
      - DiskState.SOURCE_PARTIAL + upstream_gap_confirmed + not force_retry
                                   → skip with reason "upstream_gap"
      - DiskState.INVALID + close_ms=0 스텁 + 보유 창 밖 + not force_retry
                                   → skip with reason "upstream_gap"
      - DiskState.NO_UPSTREAM_DATA → delete sentinel, proceed resume=False
      - DiskState.SOURCE_PARTIAL   → proceed resume=False
      - DiskState.INVALID          → proceed with resume=False (don't trust
                                     corrupt artifacts; fresh capture)
      - DiskState.CLIENT_INCOMPLETE → proceed with resume=True
      - DiskState.NONE             → proceed with resume=False

    ADR-0093: a confirmed upstream gap (a full re-capture already reproduced the
    identical gappy result) is skipped so we stop hammering hogaplay for data it
    doesn't have. ``force_retry=True`` bypasses this to let the user re-verify —
    if that re-capture is still gappy, the done+not-COMPLETE fail_streak rule
    (ADR-0042) still caps runaway retries.

    ``now`` 는 보유 창 판정용이며 생략하면 ``now_kst()``. 테스트가 주입한다
    (``find_ineligible_dates`` 가 now 를 인자로 받는 것과 같은 관례).
    """
    # source="hogaplay": the worker collects hogaplay, so a COMPLETE
    # kis_live/kis_api promotion (lower-fidelity synthesized data) must NOT
    # mark this Stock-Date "already_complete" and suppress hogaplay collection.
    classification = check_disk_state(data_dir, code, date, source="hogaplay")
    disk = classification.state
    if disk == DiskState.COMPLETE:
        return CaptureDecision(skip_reason="already_complete", resume=False)
    if (
        disk == DiskState.SOURCE_PARTIAL
        and classification.upstream_gap_confirmed
        and not force_retry
    ):
        return CaptureDecision(skip_reason="upstream_gap", resume=False)
    # 같은 skip_reason 을 재사용한다. 사용자에게 뜻이 동일하고("업스트림에 없어
    # 재캡처가 무의미"), SkipReason union 을 넓히면 프론트의 미러 union
    # (frontend/src/api/types.ts) 과 표시 매핑(queueSummary/phase)까지 함께
    # 손봐야 한다. phase.ts 는 이미 upstream_gap 을 source_partial 표시로 접는데,
    # 이 클래스에도 그 표시가 맞다.
    if (
        not force_retry
        and _is_expired_upstream_stub(classification, date, now or now_kst())
    ):
        return CaptureDecision(skip_reason="upstream_gap", resume=False)
    if disk == DiskState.NO_UPSTREAM_DATA:
        (data_dir / "raw" / date / code / ".no_upstream_data").unlink(missing_ok=True)
        return CaptureDecision(skip_reason=None, resume=False)
    # INVALID and NONE both produce resume=False; only CLIENT_INCOMPLETE resumes.
    resume_flag = (disk == DiskState.CLIENT_INCOMPLETE)
    return CaptureDecision(skip_reason=None, resume=resume_flag)


def find_ineligible_dates(
    *,
    candidate_dates: Iterable[str],
    now: dt.datetime,
) -> list[str]:
    """Enqueue-time gate. Returns the dates from ``candidate_dates`` that
    fail eligibility.

    Currently the only gate is the 16:30-KST :func:`is_today_too_early` policy.
    Future gates (holiday filter beyond the trading-day list, code-level
    blacklists, quota checks) add their own predicates here so the route
    handler stays a thin "reject if non-empty" wrapper.
    """
    return [d for d in candidate_dates if is_today_too_early(d, now)]
