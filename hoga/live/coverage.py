"""Live storage-target planning (키움 WS 전담).

KIS WebSocket 계층은 ADR-0118 PR-G에서 삭제됐다 — 실시간 호가·체결 수집은 키움 WS
전담이다. 이 모듈은 저장 대상(관심종목 + 히트맵)을 키움 세션 용량에 맞춰 계획한다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from hoga.api.watchlist_projection import capture_ordered_codes

_log = logging.getLogger(__name__)

# 키움 WS 연결당 등록 상한 = 총 200종목, **타입 무관**(실측 2026-07-16, ADR-0116).
# 종목당 1건(0B+0D 쌍도 200종목)이라 TR 수로 나누지 않는다. 4앱키=800종목.
KIWOOM_WS_MAX_REGISTRATIONS = 200
KIWOOM_PER_ACCOUNT_MAX = KIWOOM_WS_MAX_REGISTRATIONS


@dataclass(frozen=True)
class LiveStorageTargets:
    ws_targets: tuple[str, ...]
    capture_candidates: tuple[str, ...]
    # 키움 WS 수집 대상(ADR-0116). kiwoom off/무자격(capacity 0)이면 () — 미수집.
    kiwoom_targets: tuple[str, ...] = ()


def partition_kiwoom(codes: list[str], n: int) -> list[list[str]]:
    """키움 계정별 disjoint 분할 — 계정 k = codes[k*200:(k+1)*200] (앱키당 200).
    초과분(200×n 넘는 종목)은 어느 계정에도 안 담긴다(호출자 책임)."""
    return [codes[k * KIWOOM_PER_ACCOUNT_MAX:(k + 1) * KIWOOM_PER_ACCOUNT_MAX] for k in range(n)]


def plan_storage_targets(
    capture_candidates: list[str],
    *,
    n_configured: int = 0,
    per_account_max: int | None = None,
    heatmap_candidates: tuple[str, ...] = (),
    kiwoom_capacity: int = 0,
) -> LiveStorageTargets:
    """저장셋 = 관심종목 + 히트맵, 키움 WS 전담(ADR-0118 PR-G 칼 컷오버).

    KIS WebSocket 계층이 삭제되어 ``ws_targets``는 **항상 빈 튜플**이다. 실시간은 키움
    WS가 유일 소스이므로 활성화 스위치가 따로 없다 — ``kiwoom_capacity``(=200×앱키수)가
    양수면(자격증명 존재) 곧 활성이다.

    **자격증명 존재**(capacity>0): 관심종목+히트맵 dedup union이 kiwoom_targets(저장셋,
    용량까지 관심종목 우선). 용량 초과분은 미수집(경고, 계좌 추가로 대응).

    **자격증명 부재**(capacity 0): 저장셋이 비어 아무것도 수집하지 않는다
    (fix-forward — KIS REST/WS 폴백 없음).

    ``n_configured``/``per_account_max``는 삭제된 KIS WS 슬롯 산식의 잔재라 더는 쓰이지
    않는다(호출부 호환을 위해 시그니처만 유지).
    """
    candidates = tuple(capture_candidates)
    candidate_set = set(candidates)
    heatmap = tuple(
        code for code in dict.fromkeys(heatmap_candidates) if code not in candidate_set
    )
    if kiwoom_capacity > 0:
        # 컷오버: 관심종목 먼저(우선) + 히트맵 = 저장셋.
        storage_set = candidates + heatmap
        kiwoom_targets = storage_set[:kiwoom_capacity]
        dropped = len(storage_set) - len(kiwoom_targets)
        if dropped > 0:  # 초과분은 미수집 — 계좌 추가로 대응(폴백 없음)
            _log.warning("live.storage.storage_set_over_kiwoom_capacity dropped=%d cap=%d",
                         dropped, kiwoom_capacity)
    else:
        kiwoom_targets = ()
    return LiveStorageTargets(
        ws_targets=(),
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
    """Heatmap codes for Kiwoom WS capture (ADR-0116; 유일 저장 경로).

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
