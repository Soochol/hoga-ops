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


def is_past_upstream_retention(date: str, now: dt.datetime) -> bool:
    """이 거래일이 hogaplay 보유 창 **밖**인가 — 즉 재캡처가 원리적으로 무의미한가.

    두 만료 판정(close_ms=0 스텁, 미확정 갭)이 공유하는 술어다. 한쪽만 고치면
    "재캡처는 멈췄는데 진단 보고는 여전히 대기중" 같은 어긋난 상태가 조용히
    생긴다 — prune 쪽 라벨도 이 함수를 부른다.

    날짜 형식이 이상하면 False(막지 않는다). 판정 불가는 "만료 아님" 쪽으로
    틀리는 것이 안전하다 — 반대로 틀리면 아직 받을 수 있는 캡처를 막는다.
    """
    try:
        captured = dt.datetime.strptime(date, "%Y%m%d").date()
    except ValueError:
        return False
    return (now.date() - captured).days > _UPSTREAM_RETENTION_DAYS


def is_expired_unconfirmed_gap(
    classification: Classification, date: str, now: dt.datetime
) -> bool:
    """이 SOURCE_PARTIAL 의 "갭 미확정" 이 **영원히** 확정될 수 없는 상태인가?

    ADR-0093/0126 의 확정 경로는 둘뿐이다(disk_state.py 의 upstream_gap_confirmed):
    재캡처가 **동일한 갭을 재현**하거나(identical >= 2), 갭이 **세션 경계에 접하거나**.
    후자는 파싱 시점에 이미 판정되므로, 아직 미확정인 것은 오직 전자 — 재캡처 —
    로만 확정될 수 있다.

    그런데 그 재캡처를 hogaplay 가 못 준다. 보유 창이 ~18시간이기 때문이다.
    결과적으로 보유 창 밖 날짜의 미확정 갭은 **구조적 막다른 길**이다:
    decide_capture 가 계속 재캡처 대상으로 넘기고, 업스트림은 데이터를 못 주고,
    상태는 그대로 미확정으로 남는다.

    2026-07-30 전수 실측이 이를 확인한다 — 미확정 1,344건 중 보유 창 안은 **2건**
    (0.15%)뿐이고, 가장 오래된 것은 2025-05-02 로 15개월째 같은 자리다.

    이것은 ADR-0130 이 close_ms=0 스텁에 적용한 것과 **같은 형태의 논증**이다:
    "재시도로 고칠 수 있는 상태" 와 "재시도가 원리적으로 무의미한 상태" 를 나이로
    가른다. 다른 점은 그쪽이 INVALID 였고 이쪽은 SOURCE_PARTIAL 이라는 것뿐이다.

    **이 술어는 삭제 권한을 주지 않는다.** prune 의 게이트는 그대로다(1단계).
    여기서 하는 일은 무의미한 재캡처를 멈추고, 진단 보고에서 이 부분집합을
    보이게 만드는 것뿐이다.
    """
    return (
        classification.state == DiskState.SOURCE_PARTIAL
        and not classification.upstream_gap_confirmed
        and is_past_upstream_retention(date, now)
    )


def is_terminal_partial(
    classification: Classification, date: str, now: dt.datetime
) -> bool:
    """이 SOURCE_PARTIAL 이 **재캡처로 나아지지 않는** 부분 결손인가.

    ``decide_capture`` 가 SOURCE_PARTIAL 을 ``upstream_gap`` 으로 건너뛰는 두
    경로의 합집합이다:

      1. :attr:`Classification.upstream_gap_confirmed` — 재캡처가 동일 갭을
         재현했거나(ADR-0093) 갭이 세션 경계에 접한다(ADR-0126).
      2. :func:`is_expired_unconfirmed_gap` — 아직 미확정이지만 보유 창 밖이라
         (1)의 확정 경로가 **원리적으로 닫혀 있다**(ADR-0131).

    표시 계층이 이걸 직접 조립하면 안 되는 이유가 여기 있다. 보관함의 결손
    패널은 오래도록 ``identical_capture_count >= 2`` 만 봤는데 그건 (1)의 절반일
    뿐이라, 세션 경계·보유 창 만료로 확정된 행은 "확정" 문구도 강제 재캡처
    버튼도 못 받았다 — 워커는 그 행들을 이미 건너뛰고 있었는데도. 술어를 한 곳에
    두고 소비자 셋(워커 결정·달력 셀·보관함 배지)이 같은 답을 읽는다.

    INVALID 쪽 ``upstream_gap`` 경로(close_ms=0 스텁, ADR-0130)는 여기 없다.
    그건 SOURCE_PARTIAL 이 아니라 별도 상태로 그려지는 다른 클래스다.
    """
    return (
        classification.state == DiskState.SOURCE_PARTIAL
        and (
            classification.upstream_gap_confirmed
            or is_expired_unconfirmed_gap(classification, date, now)
        )
    )


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
    return is_past_upstream_retention(date, now)


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
    # 미확정 갭도 보유 창 밖이면 같은 자리에 선다. ADR-0093 은 "재캡처가 갭을
    # 재현하면 확정" 이라는 경로를 만들었는데, 업스트림이 그 재캡처를 못 주면
    # 그 경로는 영원히 닫혀 있다. 2026-07-30 실측 미확정 1,344건 중 창 안은 2건.
    # 막지 않으면 백필이 돌 때마다 없는 데이터를 다시 받으러 간다.
    if (
        not force_retry
        and is_expired_unconfirmed_gap(classification, date, now or now_kst())
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
