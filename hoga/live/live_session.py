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
    from collections.abc import Awaitable, Callable

    from hoga.api.models import WatchlistDocument

    _BuildConn = Callable[[int, list[str], Path], "_StreamConn"]
    _TeardownConn = Callable[["_StreamConn"], Awaitable[None]]

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


# ── Live Session (WS 연결집합 상태기계) ─────────────────────────────────────────

class LiveSession:
    """KIS WS 연결집합(dynamic-N)의 상태 — streams + 세션 스코프 불변식 소유.

    streams 키 ∈ [0, n_configured). lifecycle의 _state.session이 보유. 전이는 메서드:
    start(빈 streams 전제로 파티션별 conn 빌드) / refresh(원자 활성집합 스왑 + WS 재구독
    diff) / restart(죽은 conn 1개 격리 복구) / stop(전체 teardown).

    의존성 주입: conn 빌드/teardown은 lifecycle이 _buffer·_now_ms·_today_kst 등 프로세스
    리소스로 만드는 I/O 프리미티브라, 메서드 파라미터로 주입한다(build_conn/teardown_conn).
    이로써 LiveSession은 lifecycle 전역에 의존하지 않는다(순환·모듈 로드 순서 회피).

    exclude-then-subscribe 순서(ADR-0067 §5.5)는 poller가 lifecycle 소유라 lifecycle의
    락 메서드가 _sync_exclusion(poller) 후 start/refresh를 호출해 봉인한다(C3 설계 ①).
    step 3(이 커밋): start/refresh/restart/stop 이전. degraded_set/status_fields는 step 4.
    """

    def __init__(self) -> None:
        self.streams: dict[int, _StreamConn] = {}
        self.started_at_ms: int | None = None
        self.n_configured: int = 0
        self.live_set: tuple[str, ...] = ()
        self.watchlist_codes: tuple[str, ...] = ()

    async def stop(self, teardown_conn: _TeardownConn) -> None:
        """현재 conn들만 teardown(R1: KisClient는 보존). streams 비움."""
        for conn in list(self.streams.values()):
            await teardown_conn(conn)
        self.streams.clear()

    async def start(
        self,
        *,
        codes: list[str],
        n_configured: int,
        data_dir: Path,
        now_ms: int,
        build_conn: _BuildConn,
    ) -> None:
        """코드 있는 파티션만 conn 생성(dynamic-N; 빈 part=연결 없음 → C4).

        호출 전 stop()으로 streams가 비어 있어야 한다 — lifecycle이 exclude-then-
        subscribe 순서(stop → ensure_poller → _sync_exclusion → start)로 보장한다.
        """
        parts = partition_live_set(list(codes), n_configured)
        streams: dict[int, _StreamConn] = {}
        for account_id, part in enumerate(parts):
            if part:
                streams[account_id] = build_conn(account_id, part, data_dir)
        self.streams = streams
        self.started_at_ms = now_ms
        self.n_configured = n_configured
        self.live_set = tuple(codes)
        self.watchlist_codes = tuple(codes)

    async def refresh(
        self,
        *,
        codes: list[str],
        data_dir: Path,
        build_conn: _BuildConn,
        teardown_conn: _TeardownConn,
    ) -> None:
        """watchlist 변경 후 dynamic-N create/update/teardown (스펙 §5.5).

        Pass 0(동기, await 없음): 기존 conn들의 on_tick 활성집합을 새 파티션으로 **원자
        스왑**. cross-boundary 이동(코드가 13-경계를 넘어 conn↔conn 이동) 시, 옛 conn
        활성집합에서 빠진 뒤 새 conn에 들어가야 두 writer가 같은 {date}/{code}.jsonl에
        동시 append하는 이중-write 창이 안 생긴다. set_active_codes는 동기라 이 루프 중엔
        틱이 처리되지 않아 스왑이 원자적. (Pass 1의 async WS 재구독에서 코드가 잠시 양쪽
        WS에 구독돼도 on_tick 활성 필터가 이미 정확하므로 write는 한 conn으로만 간다.)
        """
        parts = partition_live_set(list(codes), self.n_configured)

        # Pass 0 (동기): 활성집합 원자 스왑
        for account_id, part in enumerate(parts):
            conn = self.streams.get(account_id)
            if conn is not None:
                conn.stream_obj.set_active_codes(set(part))   # type: ignore[attr-defined]

        # Pass 1 (async): WS 구독 diff + build/teardown
        for account_id, part in enumerate(parts):
            conn = self.streams.get(account_id)
            if part and conn is not None:
                await conn.stream_obj.ws.update_codes(part)      # type: ignore[attr-defined]
                self.streams[account_id] = _StreamConn(
                    account_id=account_id, stream_obj=conn.stream_obj,
                    ws_task=conn.ws_task, flush_task=conn.flush_task,
                    codes=tuple(part),
                )
            elif part and conn is None:
                self.streams[account_id] = build_conn(account_id, part, data_dir)
            elif not part and conn is not None:
                await teardown_conn(conn)
                self.streams.pop(account_id, None)

        live_set = tuple(codes)
        self.live_set = live_set
        self.watchlist_codes = live_set

    async def restart(
        self,
        account_id: int,
        *,
        data_dir: Path,
        build_conn: _BuildConn,
        teardown_conn: _TeardownConn,
    ) -> None:
        """죽은 conn 하나만 격리 복구(스펙 §5.6, Q6). R1: KisClient 보존. 현재 파티션으로
        재계산해 그 사이 watchlist 변화 흡수(축소됐으면 conn을 rebuild 대신 pop)."""
        conn = self.streams.get(account_id)
        if conn is None:
            return
        n = self.n_configured
        parts = partition_live_set(_compute_live_set(data_dir, n), n)
        codes = parts[account_id] if account_id < len(parts) else []
        await teardown_conn(conn)
        if codes:
            self.streams[account_id] = build_conn(account_id, codes, data_dir)
        else:
            self.streams.pop(account_id, None)   # 그 사이 watchlist 축소됨
