"""Capture eligibility — single home for the decision "is this Stock-Date
ready to capture, and how?"

Two entry points, both pure:

- :func:`find_ineligible_dates` — enqueue-time gate. Returns the YYYYMMDD
  dates from the request that fail policy checks (currently only the
  18-KST `today_too_early` rule from spec §11 Q14). Caller raises 400.

- :func:`decide_capture` — worker-time deciding-phase. Composes
  :func:`disk_state.check_disk_state` with the `force_retry` toggle into
  a :class:`CaptureDecision` describing whether to skip (and why) or
  proceed (with `resume` flag for CLIENT_INCOMPLETE).

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
from typing import Literal

from hoga.api.disk_state import DiskState, check_disk_state
from hoga.collector.orchestrator import is_today_too_early


SkipReason = Literal["already_complete", "source_partial"]


@dataclass(frozen=True)
class CaptureDecision:
    """Decision output for one (Stock-Date, force_retry) tuple.

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
) -> CaptureDecision:
    """Worker deciding-phase decision.

    Branches:
      - DiskState.COMPLETE        → skip with reason "already_complete"
      - DiskState.SOURCE_PARTIAL  → skip with "source_partial" unless force_retry
                                    (when force_retry, fall through to fresh)
      - DiskState.INVALID         → proceed with resume=False (don't trust
                                    corrupt artifacts; fresh capture)
      - DiskState.CLIENT_INCOMPLETE → proceed with resume=True
      - DiskState.NONE            → proceed with resume=False
    """
    disk = check_disk_state(data_dir, code, date)
    if disk == DiskState.COMPLETE:
        return CaptureDecision(skip_reason="already_complete", resume=False)
    if disk == DiskState.SOURCE_PARTIAL and not force_retry:
        return CaptureDecision(skip_reason="source_partial", resume=False)
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

    Currently the only gate is the 18-KST :func:`is_today_too_early` policy.
    Future gates (holiday filter beyond the trading-day list, code-level
    blacklists, quota checks) add their own predicates here so the route
    handler stays a thin "reject if non-empty" wrapper.
    """
    return [d for d in candidate_dates if is_today_too_early(d, now)]
