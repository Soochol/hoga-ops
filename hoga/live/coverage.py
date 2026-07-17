"""Live Coverage planning for WS capture and Viewed-Code Poll exclusion."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from hoga.api.models import WatchlistDocument
from hoga.api.watchlist_projection import capture_ordered_codes, display_ordered_codes

from .ws_fields import TRS

_log = logging.getLogger(__name__)

# 연결당 등록 상한은 실측 41(OPSP0008, 2026-07-10; ADR-0101). ADR-0111에서 거래원 TR을
# 빼 종목당 2 TR이 되어 39 = 19종목×2TR + 여유 1(상한 41 아래 여유 2). 스왑 점유도
# unregister-first라 종목당 2를 넘지 않는다(ADR-0101/0111).
KIS_WS_MAX_REGISTRATIONS = 39
TRS_PER_CODE = len(TRS)
_PER_ACCOUNT_MAX = KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE  # = 19
LIVE_SET_MAX_CODES = _PER_ACCOUNT_MAX

# 키움 WS 연결당 등록 상한 = 총 200종목, **타입 무관**(실측 2026-07-16, ADR-0116).
# KIS와 달리 종목당 1건(0B+0D 쌍도 200종목)이라 TR 수로 나누지 않는다. 4앱키=800종목.
KIWOOM_WS_MAX_REGISTRATIONS = 200
KIWOOM_PER_ACCOUNT_MAX = KIWOOM_WS_MAX_REGISTRATIONS


@dataclass(frozen=True)
class LiveCoveragePlan:
    live_set: tuple[str, ...]
    partitions: tuple[tuple[str, ...], ...]
    poller_excluded: frozenset[str]


@dataclass(frozen=True)
class LiveStorageTargets:
    ws_targets: tuple[str, ...]
    capture_candidates: tuple[str, ...]
    # 키움 WS 수집 대상(ADR-0116). REST 30s 캡처 제거(2026-07-17 정책: api 폴백 없음)
    # 후 히트맵의 유일한 저장 경로. kiwoom off/무자격(capacity 0)이면 () — 미수집.
    kiwoom_targets: tuple[str, ...] = ()


def partition_live_set(codes: list[str], n: int) -> list[list[str]]:
    """display-order contiguous allocation: account k = codes[k*W:(k+1)*W]."""
    return [codes[k * _PER_ACCOUNT_MAX:(k + 1) * _PER_ACCOUNT_MAX] for k in range(n)]


def partition_kiwoom(codes: list[str], n: int) -> list[list[str]]:
    """키움 계정별 disjoint 분할 — 계정 k = codes[k*200:(k+1)*200]. partition_live_set의
    키움판(앱키당 200). 초과분(200×n 넘는 종목)은 어느 계정에도 안 담긴다(호출자 책임)."""
    return [codes[k * KIWOOM_PER_ACCOUNT_MAX:(k + 1) * KIWOOM_PER_ACCOUNT_MAX] for k in range(n)]


def plan_live_coverage(
    ordered_codes: list[str],
    *,
    n_configured: int,
    per_account_max: int | None = None,
) -> LiveCoveragePlan:
    if per_account_max is None:
        per_account_max = _PER_ACCOUNT_MAX
    max_codes = per_account_max * n_configured
    live_set = tuple(ordered_codes[:max_codes])
    partitions = tuple(
        tuple(live_set[k * per_account_max:(k + 1) * per_account_max])
        for k in range(n_configured)
    )
    return LiveCoveragePlan(
        live_set=live_set,
        partitions=partitions,
        poller_excluded=frozenset(live_set),
    )


def select_live_set(
    ordered_codes: list[str],
    *,
    known_codes: set[str],
    max_codes: int,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Apply Symbol Master filter then truncate. Empty known set means cold-cache fallback."""
    if not known_codes:
        return tuple(ordered_codes[:max_codes]), ()
    dropped = tuple(code for code in ordered_codes if code not in known_codes)
    selected = tuple(code for code in ordered_codes if code in known_codes)
    return selected[:max_codes], dropped


def plan_storage_targets(
    capture_candidates: list[str],
    *,
    n_configured: int,
    per_account_max: int | None = None,
    heatmap_candidates: tuple[str, ...] = (),
    kiwoom_enabled: bool = False,
    kiwoom_capacity: int = 0,
) -> LiveStorageTargets:
    """저장셋 = 관심종목 + 히트맵(키움 WS 전담, ADR-0118 PR-E 칼 컷오버).

    **kiwoom 활성**(enabled + capacity>0): 관심종목+히트맵 dedup union이 kiwoom_targets
    (저장셋, 용량까지 관심종목 우선), KIS ws_targets는 빈 튜플 → KIS WS conn은 dynamic-N에
    의해 자연 소멸(빈 파티션 = 연결 없음). 용량 초과분은 미수집(경고, 계좌 추가로 대응).

    **kiwoom off/무자격**(capacity 0): 관심종목은 KIS WS 슬롯(per_account_max×계좌)까지
    유지(무회귀 폴백), 히트맵은 미수집. KIS REST 30s 캡처(ADR-0097)는 제거됨(폴백 없음).
    """
    if per_account_max is None:
        per_account_max = _PER_ACCOUNT_MAX
    candidates = tuple(capture_candidates)
    candidate_set = set(candidates)
    heatmap = tuple(
        code for code in dict.fromkeys(heatmap_candidates) if code not in candidate_set
    )
    if kiwoom_enabled and kiwoom_capacity > 0:
        # 컷오버: 관심종목 먼저(우선) + 히트맵 = 저장셋. 관심종목은 KIS 슬롯 무관 전량.
        storage_set = candidates + heatmap
        kiwoom_targets = storage_set[:kiwoom_capacity]
        dropped = len(storage_set) - len(kiwoom_targets)
        if dropped > 0:  # 초과분은 미수집 — 계좌 추가로 대응(REST 폴백 없음)
            _log.warning("live.storage.storage_set_over_kiwoom_capacity dropped=%d cap=%d",
                         dropped, kiwoom_capacity)
        ws_targets: tuple[str, ...] = ()  # 관심종목 키움 이관 → KIS WS 빈 파티션
    else:
        kiwoom_targets = ()
        ws_targets = candidates[:per_account_max * n_configured]  # 폴백: KIS WS 유지
    return LiveStorageTargets(
        ws_targets=ws_targets,
        capture_candidates=candidates,
        kiwoom_targets=kiwoom_targets,
    )


def _known_symbol_codes() -> set[str]:
    from hoga.api import symbols as _symbols  # noqa: PLC0415

    return {h.code for h in _symbols.search("", limit=10_000)}


def _compute_capture_candidates(data_dir: Path) -> list[str]:
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    known = _known_symbol_codes()
    doc = load_document(data_dir)
    candidates = capture_ordered_codes(doc, known_codes=known if known else None)
    if known:
        all_enabled = capture_ordered_codes(doc)
        dropped = tuple(code for code in all_enabled if code not in known)
        if dropped:
            _log.warning("live.capture.codes_unknown dropped=%r", list(dropped))
    return candidates


def _compute_heatmap_codes(data_dir: Path) -> tuple[str, ...]:
    """Heatmap codes for Kiwoom WS capture (ADR-0116; REST 캡처 제거 후 유일 경로).

    Document order preserved; symbol-master filter mirrors
    _compute_capture_candidates (cold cache keeps all)."""
    from hoga.api.heatmap import load_heatmap  # noqa: PLC0415

    codes = list(dict.fromkeys(entry.code for entry in load_heatmap(data_dir)))
    known = _known_symbol_codes()
    if not known:
        return tuple(codes)
    dropped = [code for code in codes if code not in known]
    if dropped:
        _log.warning("live.capture.heatmap_codes_unknown dropped=%r", dropped)
    return tuple(code for code in codes if code in known)


def _compute_ws_targets(
    data_dir: Path,
    n_configured: int = 1,
) -> list[str]:
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        n_configured=n_configured,
    )
    return list(targets.ws_targets)


def _compute_live_set(data_dir: Path, n_configured: int = 1) -> list[str]:
    """Load Watchlist and return dynamic-N WS targets."""
    return _compute_ws_targets(data_dir, n_configured)


def live_set_codes(doc: WatchlistDocument) -> list[str]:
    """Live Set compatibility helper based on capture-enabled folder order."""
    return capture_ordered_codes(doc)[:LIVE_SET_MAX_CODES]
