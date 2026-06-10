"""Live Session — KIS WS 연결집합(dynamic-N)의 상태기계.

CONTEXT.md 'Live Session' = Live Set을 수집하는 N개 KIS WS 연결집합 + 그 생명주기.
lifecycle.py에서 strangler 추출(C3, 2026-06-10): streams dict + 전이(start/refresh/
restart/stop) + 불변식(키=account id∈[0,N), exclude-then-subscribe 순서) + WS-health
(degraded_set/status_fields)를 한 객체로 응집한다. lifecycle은 lifespan 오케스트레이션
(poller·today-promoter·watchdog 트리거·get_status 합성)만 남는다.

ADR-0038(hot path): pyarrow/polars import 금지 — promote.py(cold path)만 허용.
이 모듈은 test_adr_invariants._HOT_PATH_MODULES에 등재됨.

step 1(이 커밋): 순수 헬퍼(partition_live_set/_compute_live_set/display_ordered_codes/
live_set_codes) + 상수 + _StreamConn을 이동. LiveSession 객체·오케스트레이션은 후속 단계.
lifecycle은 이름들을 재export해 기존 호출부·테스트가 무수정으로 동작한다.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import asyncio

    from hoga.api.models import WatchlistDocument

_log = logging.getLogger(__name__)


# ── Live Set constants (spec §4·§5.1) ─────────────────────────────────────────

KIS_WS_MAX_REGISTRATIONS = 41   # appkey당, (tr_id, code) 쌍 기준 — spec §4 검증 완료
TRS_PER_CODE = 3                # 호가 + 체결 + 회원사(H0STMBC0)
_PER_ACCOUNT_MAX = KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE  # = 13 (계좌당 한도)
# 동적 상한: 13 * n_configured. start에서 n_configured를 곱해 _compute_live_set이 사용.
LIVE_SET_MAX_CODES = _PER_ACCOUNT_MAX  # 1계좌 기본(_compute_live_set이 n_configured로 동적 절단)


def partition_live_set(codes: list[str], n: int) -> list[list[str]]:
    """display-order 연속 배정: account k = codes[k*13:(k+1)*13] (스펙 §5.3, Q4).

    n개 리스트를 항상 반환(후행은 빈 리스트일 수 있음). 연속 슬라이스라
    13-경계를 안 넘는 코드는 계좌 고정 → 재정렬 churn 최소(위험 #4). 해시 배정
    대신 연속을 택한 이유: CONTEXT.md 'top-13=경계' 모델 일치 + explicit>clever.
    """
    return [codes[k * _PER_ACCOUNT_MAX:(k + 1) * _PER_ACCOUNT_MAX] for k in range(n)]


def display_ordered_codes(doc: WatchlistDocument) -> list[str]:
    """Watchlist Panel 표시 순서로 코드 평탄화 (2026-06-06 결정, watchlist v2 폴더화).

    Step 0 확인 (grouping.ts:28-43 + WatchlistDrawer.tsx:222,228):
    - folders[]를 `.order` 오름차순으로 정렬 → 각 폴더의 entry를 `.order` 오름차순
    - 미분류(folder_id=None) 그룹은 **폴더들 뒤** (groupByFolder가 push로 마지막에 추가)
    - 빈 미분류는 WatchlistDrawer가 숨기지만 코드 수집에는 영향 없음

    정렬 키: (folder rank — 미분류는 len(folders), entry.order)
    """
    sorted_folders = sorted(doc.folders, key=lambda f: f.order)
    folder_rank = {f.id: i for i, f in enumerate(sorted_folders)}
    n_folders = len(sorted_folders)

    def _key(entry):  # type: ignore[no-untyped-def]
        rank = folder_rank[entry.folder_id] if entry.folder_id is not None else n_folders
        return (rank, entry.order)

    return [e.code for e in sorted(doc.entries, key=_key)]


def _compute_live_set(data_dir: Path, n_configured: int = 1) -> list[str]:
    """Live Set 산출 파이프라인(start/refresh 공용):
    load_document → 표시 순서 평탄화 → symbol-master 필터(cold cache 무필터
    폴백) → 상위 (13 * n_configured) 절단."""
    from hoga.api import symbols as _symbols  # noqa: PLC0415
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    ordered = display_ordered_codes(load_document(data_dir))
    known = {h.code for h in _symbols.search("", limit=10_000)}
    if known:
        dropped = [c for c in ordered if c not in known]
        if dropped:
            _log.warning("live.stream.codes_unknown dropped=%r", dropped)
        ordered = [c for c in ordered if c in known]
    return ordered[: _PER_ACCOUNT_MAX * n_configured]


def live_set_codes(doc: WatchlistDocument) -> list[str]:
    """Live Set = 패널 표시 순서 상위 13 (테스트 전용 헬퍼 — 실경로는 _compute_live_set).

    CONTEXT.md 'Live Set', 그릴링 Q3 + 2026-06-06 개정.
    """
    return display_ordered_codes(doc)[:LIVE_SET_MAX_CODES]


# ── Stream connection (한 KIS 계좌의 WS 연결 묶음) ──────────────────────────────

@dataclass
class _StreamConn:
    """한 KIS 계좌의 WS 연결 묶음 (dynamic-N: codes 항상 비어있지 않음)."""
    account_id: int
    stream_obj: object            # LiveStream — 자체 writer 소유, code-disjoint
    ws_task: asyncio.Task       # type: ignore[type-arg]
    flush_task: asyncio.Task    # type: ignore[type-arg]
    codes: tuple[str, ...]
