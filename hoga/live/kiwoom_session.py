"""키움 WS 수집 세션 매니저 — 계정별 conn(LiveStream+KiwoomWsClient) 소유 (ADR-0116).

KIS lifecycle._build_conn 패턴의 키움판. lifecycle _state.streams(KIS 상태 경로)와
**별개로 자체 관리** — KIS 오케스트레이션/상태 표면에 간섭하지 않는다(그래서 stream.py
디커플링 불필요: 키움 LiveStream의 .ws는 None으로 두고 KiwoomWsClient는 여기 보관).

저장 루트는 live_kiwoom(KIS live와 분리) → promote_kiwoom_today가 kiwoom_live parquet로
승격. kiwoom_enabled off면 sync가 빈 타깃을 받아 conn 0 — 완전 휴면(생성 비용 없음).
kis_* 모듈은 import하지 않는다(ADR-0116 규율 1).
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import kiwoom_runtime
from .buffer import LiveBuffer
from .coverage import KIWOOM_PER_ACCOUNT_MAX, partition_kiwoom
from .kiwoom_fields import apply_venue
from .kiwoom_ws_client import KiwoomWsClient
from .snapshot import LiveSnapshot
from .ticks import WsTick

_log = logging.getLogger(__name__)

# 표시(온디맨드) 구독 해제 유예 — 참조 0 후 이 시간 지나야 회수(탭 재열람 churn 흡수).
_DISPLAY_GRACE_MS = 60_000
# 만석 임계 근처(총 잔여 슬롯 이하)면 유예 0으로 즉시 회수(ADR-0118 §2).
_NEAR_FULL_SLACK = 8


def _default_now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class _KiwoomConn:
    account_id: int
    stream: object                 # LiveStream — on_tick/flush 소유(순환 import 회피 타입)
    client: KiwoomWsClient
    ws_task: asyncio.Task
    flush_task: asyncio.Task
    codes: tuple[str, ...]


@dataclass
class _DisplayEntry:
    """표시(온디맨드) 장부 항목 (code,venue) → 하나로 묶은 상태(PR-C, #685).

    병렬 dict 3개(refs·owner·released_at)를 한 항목으로 묶어 '한 dict에서만 키 누락'
    불변식 붕괴를 구조적으로 막는다(리뷰 Data Clumps). owner=등록 연결(전역 1회 등록,
    None=미배정/커버). released_at=참조 0이 된 시각(유예 클록, None=참조 있음)."""

    refs: set[str] = field(default_factory=set)
    owner: int | None = None
    released_at: int | None = None


class KiwoomSessionManager:
    """키움 계정별 WS conn의 생성·코드 갱신·teardown을 관장.

    sync(kiwoom_targets)를 매 스토리지 사이클 호출: partition_kiwoom으로 계정 분배 후
    신규 계정은 build, 기존은 update_codes, 빈 계정은 teardown. active_codes()는 승격
    루프(start_today_promoter의 kiwoom 루프)가 읽는다.
    """

    def __init__(
        self,
        *,
        buffer: LiveBuffer,
        data_dir: Path,
        date_fn: Callable[[], str],
        gate_fn: Callable[[], bool] | None = None,
        now_fn: Callable[[], int] | None = None,
        per_account_max: int | None = None,
        _build_conn: Callable[[int, list[str]], _KiwoomConn] | None = None,
    ) -> None:
        self._buffer = buffer
        self._data_dir = data_dir
        self._date_fn = date_fn
        self._gate_fn = gate_fn
        # venue 파생·warmup 술어의 시각원(테스트 주입). 실경로는 벽시계.
        self._now_fn = now_fn or _default_now_ms
        # 연결당 등록 상한(실측 200). 슬롯 산술·만석 판정의 SSOT(테스트 주입).
        self._per_account_max = per_account_max or KIWOOM_PER_ACCOUNT_MAX
        self._build = _build_conn or self._default_build_conn
        self._conns: dict[int, _KiwoomConn] = {}
        # sync(멤버십)·watchdog_pass(venue/재빌드)·stop의 _conns/구독 변이 직렬화 —
        # update_codes의 다중 await(배치 REG 페이싱)가 서로 인터리브하지 않게 한다.
        self._lock = asyncio.Lock()
        # 08:50–09:00 워밍 창에 저장셋 등록 미완이면 True(status 진단 표면화).
        self._warmup_incomplete = False
        # ── 표시(온디맨드) 참조 카운트 장부(ADR-0118 PR-C, #685) ──
        # (code,venue) → _DisplayEntry(refs·owner·released_at). 저장셋은 conn.codes로
        # 암묵 표현(레이어드). refs·owner·released_at을 한 항목으로 묶어 불변식 구조화.
        self._display: dict[tuple[str, str], _DisplayEntry] = {}
        # 커버 판정용 전역 저장 멤버십(union) — _covered_by_storage가 쓴다. sync in-place 갱신.
        self._storage_members: set[str] = set()
        # on_tick 라우팅용 **연결별** 저장 파티션 — 래퍼가 이 연결의 파티션만 stream으로
        # 보내야 한다(전역 아님: 다른 계정 소유 저장코드의 표시 틱은 이 연결 stream이
        # 조용히 드롭하므로 buffer로 가야 함). 래퍼가 공유 참조, sync가 in-place 갱신.
        self._conn_members: dict[int, set[str]] = {}

    async def sync(self, kiwoom_targets: tuple[str, ...], *, n_accounts: int) -> None:
        """kiwoom_targets를 계정에 분배하고 conn 멤버십을 정합화. n_accounts=0 또는 빈
        타깃이면 전체 teardown(휴면). 200×n 초과분은 partition_kiwoom이 자연 드롭(경고).

        운영 건강(죽은 conn 재빌드·시간대 venue 스왑·재구독)은 watchdog_pass(30s)로
        분리됐다(ADR-0118 §5) — sync는 저장셋 멤버십만 반영한다."""
        async with self._lock:
            await self._sync_locked(kiwoom_targets, n_accounts=n_accounts)

    async def _sync_locked(self, kiwoom_targets: tuple[str, ...], *, n_accounts: int) -> None:
        codes = list(dict.fromkeys(kiwoom_targets))
        if not codes or n_accounts <= 0:
            await self._stop_locked()
            return
        parts = partition_kiwoom(codes, n_accounts)
        dropped = len(codes) - sum(len(p) for p in parts)
        if dropped > 0:
            _log.warning("live.kiwoom.targets_over_capacity dropped=%d cap=%d",
                         dropped, n_accounts * 200)
        wanted = {k: part for k, part in enumerate(parts) if part}
        now_ms = self._now_fn()
        # teardown: 더는 필요 없는 계정(빈 파티션 포함).
        for account_id in list(self._conns):
            if account_id not in wanted:
                await self._teardown(account_id)
        # build(신규) / 저장 멤버십 갱신.
        for account_id, part in wanted.items():
            conn = self._conns.get(account_id)
            if conn is None:
                built = self._build(account_id, part)
                if built is not None:
                    self._conns[account_id] = built
            elif set(conn.codes) != set(part):
                _set_active(conn.stream, set(part))
                self._conns[account_id] = _replace_codes(conn, tuple(part))
        # 라우팅용 연결별 파티션(_conn_members) + 커버용 전역 멤버십(_storage_members)을
        # in-place 갱신(둘 다 래퍼·판정이 공유 참조라 재대입 금지).
        self._storage_members.clear()
        for account_id, part in wanted.items():
            members = self._conn_members.setdefault(account_id, set())
            members.clear()
            members.update(part)
            self._storage_members.update(part)
        # 저장 멤버십 변화로 표시 커버가 바뀔 수 있어 재배정 후 현재 창 venue로 reconcile.
        self._reassign_display(now_ms)
        for account_id in wanted:
            conn = self._conns.get(account_id)
            if conn is not None:
                await self._reconcile(conn, now_ms)

    async def watchdog_pass(self, now_ms: int) -> None:
        """워치독 1패스(ADR-0118 §5, KIS live-stream-watchdog 후계). 실행 순서(괄호는
        ADR 단계 번호 — 실행 순서와 다름):
        1) 죽은 conn 재빌드(저장셋 멤버십 보존; ADR ①)
        2) 시간대 venue 스왑 reconcile(ADR ②)
        3) 미확인 구독 표적 재구독(ADR ④)
        4) 08:50–09:00 저장셋 등록 완결 술어(ADR ③) — 재구독 뒤에 둬야 잔여 미확인 판정이
           정확하다(방금 재송신한 건은 이미 반영).
        표시(온디맨드) 장부도 여기 합류(PR-C): 유예 만료 sweep + 커버 전이 재배정을
        reconcile 전에 수행해 킥 복구·venue 스왑이 표시 구독까지 재파생 재등록한다.
        자가 감독(한 패스 실패는 로그 후 계속)은 호출 루프(start_kiwoom_session_watchdog)가
        담당한다. sync와 _lock으로 직렬화."""
        async with self._lock:
            await self._rebuild_dead_locked()
            self._sweep_display(now_ms)     # 유예 만료 표시키 회수
            self._reassign_display(now_ms)  # 커버 전이(스왑·저장변화) 재배정
            for conn in list(self._conns.values()):
                await self._reconcile(conn, now_ms)
            await self._resubscribe_missing_locked()
            self._check_warmup_locked(now_ms)

    async def _rebuild_dead_locked(self) -> None:
        """죽은 conn(킥 정지·ws/flush 태스크 사망) teardown 후 재빌드 — 저장셋 멤버십
        (bare codes)을 보존해 재파생 재등록한다. 킥 핑퐁은 클라이언트 내부
        backoff+max_consecutive_kicks가 완화(피어 점유 지속이면 새 클라이언트도 ~31s 만에
        재정지, 그동안 done 아니라 재빌드 안 함). sync에서 이관(PR-B ①: 30s 주기로 승격)."""
        for account_id, conn in list(self._conns.items()):
            if not _conn_dead(conn):
                continue
            _log.warning("live.kiwoom.conn_dead_rebuild account=%d kicked=%s",
                         account_id, conn.client.kicked_by_peer)
            bare = list(conn.codes)  # 저장셋 멤버십 보존
            await self._teardown(account_id)
            built = self._build(account_id, bare)
            if built is not None:
                self._conns[account_id] = built

    async def _reconcile(self, conn: _KiwoomConn, now_ms: int) -> None:
        """conn 구독을 현재 시각의 target venue로 재파생 정합(ADR-0118 §2 파생 집합).

        기대 wire = (저장셋 bare × 현재 venue) ∪ (이 연결에 배정된 표시키 중 저장 미커버분).
        표시키는 (code,venue) 그대로 apply_venue — 저장은 현재 창 venue 단일이지만 표시는
        열람 옵션이 요구하는 venue(UN=KRX∪NXT). 클라이언트 현재 wire와 다를 때만
        update_codes diff(remove-before-add: 키당 200 상한). bare 저장 멤버십(conn.codes)은
        불변 — 표시는 별도 장부(레이어드)."""
        from .session_gate import target_ws_venue  # noqa: PLC0415 — 순환/kis import 회피(lazy)

        venue = target_ws_venue(now_ms)
        desired = {apply_venue(c, venue) for c in conn.codes}
        for (code, v), entry in self._display.items():
            if entry.owner == conn.account_id and not self._covered_by_storage(code, v, now_ms):
                desired.add(apply_venue(code, v))
        if desired != conn.client.expected_codes:
            await conn.client.update_codes(sorted(desired))

    async def _resubscribe_missing_locked(self) -> None:
        """미확인(sub_missing) 구독을 conn별 표적 재구독(PR-B ④). conn별 예외 격리 —
        한 conn 실패가 다른 conn을 막지 않게. 30s 주기가 REG 유량을 자연 상한한다."""
        for conn in list(self._conns.values()):
            try:
                count = await conn.client.resubscribe_missing()
                if count:
                    _log.warning("live.kiwoom.resubscribe account=%d keys=%d",
                                 conn.account_id, count)
            except Exception:  # noqa: BLE001 — conn별 격리
                _log.exception("live.kiwoom.resubscribe_failed account=%d", conn.account_id)

    def _check_warmup_locked(self, now_ms: int) -> None:
        """08:50–09:00 KRX 워밍 창에 저장셋 등록 완결을 확인(ADR-0118 §5 유일한 저장
        리스크 창). 미완이면 warmup_incomplete 플래그 + 경고(재시도는 ④가 이미 수행 —
        여기선 09:00 전 미완을 가시화). 창 밖이면 플래그 해제."""
        from .session_gate import in_krx_warmup_window  # noqa: PLC0415

        if not in_krx_warmup_window(now_ms):
            self._warmup_incomplete = False
            return
        pending = {
            conn.account_id: conn.client.sub_missing()
            for conn in self._conns.values()
            if conn.client.sub_missing()
        }
        self._warmup_incomplete = bool(pending)
        if pending:
            total = sum(len(m) for m in pending.values())
            _log.warning(
                "live.kiwoom.warmup_incomplete accounts=%s missing=%d — 09:00 전 저장셋 "
                "등록 미완, 재구독 재시도 중", sorted(pending), total,
            )

    # ── 표시(온디맨드) 참조 카운트 장부 API (ADR-0118 PR-C, #685) ──────────

    async def on_view_subscribe(self, code: str, venues: set[str], *, ref: str) -> bool:
        """열람 시작 — (code, v) 각 venue에 참조 ref를 더한다(뷰 와이어가 위임).

        전역 1회 등록: (code,venue)가 저장셋에 이미 커버되면 슬롯 불요(틱은 저장 경로),
        아니면 잔여 슬롯 최다 연결에 표시 슬롯 배정. 두 탭이 같은 (code,venue)를 봐도
        참조만 늘고 등록은 1회. 만석(전 연결 슬롯 소진)이면 그 venue는 거부(참조 미기록)
        하고 경고 로그. 하나라도 거부되면 False 반환 — ws.py가 요청 탭에 만석 이벤트
        (토스트)를 보낸다. _lock으로 sync·watchdog와 직렬화."""
        async with self._lock:
            now_ms = self._now_fn()
            rejected = False
            touched: set[int] = set()
            for v in venues:
                key = (code, v)
                entry = self._display.setdefault(key, _DisplayEntry())
                entry.refs.add(ref)
                entry.released_at = None  # 유예 취소
                if self._covered_by_storage(code, v, now_ms):
                    continue  # 이미 저장 구독 — 슬롯 불요
                if entry.owner is not None and entry.owner in self._conns:
                    continue  # 이미 등록됨(다른 탭)
                account = self._pick_account(now_ms)
                if account is None:  # 만석 — 이 venue 등록 안 함(참조 롤백)
                    rejected = True
                    entry.refs.discard(ref)
                    if not entry.refs and entry.owner is None:
                        del self._display[key]
                    continue
                entry.owner = account
                touched.add(account)
            for account in touched:
                conn = self._conns.get(account)
                if conn is not None:
                    await self._reconcile(conn, now_ms)
            if rejected:
                _log.warning(
                    "live.kiwoom.on_demand_full_house code=%s venues=%s — 전 연결 슬롯 "
                    "소진, 신규 실시간 거부(ws.py가 요청 탭에 만석 이벤트)", code, sorted(venues),
                )
            return not rejected

    async def on_view_unsubscribe(self, code: str, venues: set[str], *, ref: str) -> None:
        """열람 종료 — (code, v)에서 참조 ref를 뺀다. 참조 0이면 즉시 해제하지 않고
        유예 클록만 찍는다(watchdog sweep이 유예 후 회수 — 탭 재열람 churn 흡수)."""
        async with self._lock:
            now_ms = self._now_fn()
            for v in venues:
                entry = self._display.get((code, v))
                if entry is None:
                    continue
                entry.refs.discard(ref)
                if not entry.refs:
                    entry.released_at = now_ms  # 유예 시작(sweep이 유예 후 회수)

    def _covered_by_storage(self, code: str, venue: str, now_ms: int) -> bool:
        """(code,venue)가 이미 저장 구독에 커버되나 — 저장은 현재 창 venue 단일이라
        venue==현재창 AND code∈저장셋일 때만. 커버되면 표시 슬롯 불요(틱=저장 경로)."""
        from .session_gate import target_ws_venue  # noqa: PLC0415

        return venue == target_ws_venue(now_ms) and code in self._storage_members

    def _storage_free(self, conn: _KiwoomConn) -> int:
        """저장분만 제외한 잔여 슬롯(표시 미차감) — _free_slots·status 용량 공용 SSOT."""
        return max(0, self._per_account_max - len(conn.codes))

    def _free_slots(self, account_id: int, now_ms: int) -> int:
        conn = self._conns.get(account_id)
        if conn is None:
            return 0
        display_used = sum(
            1 for (c, v), e in self._display.items()
            if e.owner == account_id and not self._covered_by_storage(c, v, now_ms)
        )
        return max(0, self._storage_free(conn) - display_used)

    def _pick_account(self, now_ms: int) -> int | None:
        """표시 슬롯 배정 연결 = 잔여 슬롯 최다(만석이면 None)."""
        best: int | None = None
        best_free = 0
        for account_id in self._conns:
            free = self._free_slots(account_id, now_ms)
            if free > best_free:
                best, best_free = account_id, free
        return best

    def _reassign_display(self, now_ms: int) -> None:
        """표시키의 저장 커버 전이(venue 스왑·저장셋 변화·연결 재빌드)를 재평가한다.
        커버되면 slot 반납, 미커버·미소유면 잔여 슬롯 최다 연결에 재배정(만석이면 다음
        패스 재시도). 참조 0(유예) 키는 sweep에 위임."""
        for (code, venue), entry in list(self._display.items()):
            if not entry.refs:
                continue  # 참조 0(유예) — sweep 위임
            if self._covered_by_storage(code, venue, now_ms):
                entry.owner = None  # 저장 커버 → 표시 슬롯 반납
                continue
            if entry.owner is None or entry.owner not in self._conns:
                account = self._pick_account(now_ms)
                if account is not None:
                    entry.owner = account

    def _sweep_display(self, now_ms: int) -> None:
        """참조 0이 유예 지난 표시키 회수. 만석 임계 근처면 유예 0(즉시)."""
        grace = 0 if self._total_free_slots(now_ms) <= _NEAR_FULL_SLACK else _DISPLAY_GRACE_MS
        for key, entry in list(self._display.items()):
            if entry.refs:
                entry.released_at = None  # 재구독됨 — 유예 취소
                continue
            if entry.released_at is not None and now_ms - entry.released_at >= grace:
                del self._display[key]

    def _total_free_slots(self, now_ms: int) -> int:
        return sum(self._free_slots(a, now_ms) for a in self._conns)

    def _make_conn_on_tick(
        self, stream: object, members: set[str]
    ) -> Callable[[WsTick], Awaitable[None]]:
        """연결별 on_tick 래퍼: 저장 멤버(bare code)면 stream.on_tick(저장 경로 — stream이
        venue 격리·다운샘플·피크), 그외(표시 전용)면 buffer.publish. members는 매니저의
        저장 멤버십 집합(공유 참조, sync가 in-place 갱신)이라 래퍼는 항상 최신을 본다."""

        async def on_tick(tick: WsTick) -> None:
            if tick.code in members:
                on = getattr(stream, "on_tick", None)
                if on is not None:
                    await on(tick)
            else:
                await self._publish_display(tick)

        return on_tick

    async def _publish_display(self, tick: WsTick) -> None:
        """표시 전용 — LiveBuffer.publish만(저장·다운샘플·피크 없음). phase/venue를 stream
        표시 경로와 동일 키로 실어 프론트 무변경(구 KiwoomOnDemandSession._on_tick 승계)."""
        from .session_gate import market_phase  # noqa: PLC0415 — lazy(kis import 회피)

        now = self._now_fn()
        snap = LiveSnapshot(
            t_ms=tick.t_ms, kind=tick.kind,
            payload={**tick.payload, "phase": market_phase(now), "venue": tick.venue},
        )
        await self._buffer.publish(tick.code, [snap], now_ms=now)

    def active_codes(self) -> list[str]:
        """수집 살아있는 계정의 구독 종목 합집합(승격 루프·화질 도트용). 킥 정지·태스크
        사망 계정은 제외(리뷰: 죽은 계정 종목이 realtime●·'저장 중'으로 오표시됐다).
        재연결 중(connected=False지만 kicked 아님)은 곧 재개되므로 포함."""
        seen: dict[str, None] = {}
        for conn in self._conns.values():
            if _conn_dead(conn):
                continue
            for code in conn.codes:
                seen.setdefault(code, None)
        return list(seen)

    @property
    def connected_accounts(self) -> int:
        return sum(1 for c in self._conns.values() if c.client.connected)

    def broker_dispatch_streams(self) -> list[object]:
        """거래원 합성 틱(ADR-0111 승계) 브로드캐스트 대상 — 살아있는 conn의 LiveStream
        목록(ADR-0118 PR-D). 각 stream 활성집합 필터가 멤버십을 흡수(비소유 코드 입구
        드롭) → 소유 stream 1개만 실수집. 킥·태스크 사망 conn은 제외(active_codes 규율과
        동일 — 재빌드 중 유령 저장 방지)."""
        return [conn.stream for conn in self._conns.values() if not _conn_dead(conn)]

    def status(self) -> dict:
        """관측 스냅샷 — LiveStatus.kiwoom로 노출(PR-6 커버리지 칩·진단). 프론트는
        connected_accounts/subscribed_count을 칩에, accounts를 진단에 쓴다."""
        accounts = []
        last_tick: int | None = None
        for account_id, conn in sorted(self._conns.items()):
            c = conn.client
            if c.last_tick_ms is not None:
                last_tick = max(last_tick or 0, c.last_tick_ms)
            accounts.append({
                "account_id": account_id,
                "connected": c.connected,
                "sub_expected": c.sub_expected,
                "sub_acked": c.sub_acked,
                "kicked_by_peer": c.kicked_by_peer,
                "last_tick_ms": c.last_tick_ms,
            })
        codes = self.active_codes()
        return {
            "enabled": True,
            "accounts_configured": len(self._conns),
            "connected_accounts": self.connected_accounts,
            "subscribed_count": len(codes),
            # 종목별 화질 도트(PR-6b)용 — 프론트 deriveCollectionStatus가 이 집합
            # 멤버십으로 키움 종목을 realtime(●)으로 판정. kis_api_targets(최대 500)와
            # 동급 페이로드라 status 폴링 규모와 정합.
            "subscribed_codes": codes,
            "last_tick_ms": last_tick,
            # 08:50–09:00 워밍 창 저장셋 등록 미완 여부(ADR-0118 §5 진단 표면).
            "warmup_incomplete": self._warmup_incomplete,
            # 표시(온디맨드) 등록 수(PR-C 진단·프론트 배지). 저장 커버분 제외한 실등록.
            "on_demand_count": sum(1 for e in self._display.values() if e.owner is not None),
            # 표시 슬롯 총 용량(전 연결 잔여 = Σ(상한−저장)) — 프론트 만석 배지 "count/cap".
            "on_demand_capacity": sum(self._storage_free(c) for c in self._conns.values()),
            "accounts": accounts,
        }

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        for account_id in list(self._conns):
            await self._teardown(account_id)
        # 전체 휴면 — 라우팅·표시 장부도 비운다(재활성 시 재파생).
        self._storage_members.clear()
        self._conn_members.clear()
        self._display.clear()

    async def _teardown(self, account_id: int) -> None:
        self._conn_members.pop(account_id, None)  # 라우팅 파티션도 회수
        conn = self._conns.pop(account_id, None)
        if conn is None:
            return
        for task in (conn.ws_task, conn.flush_task):
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    cur = asyncio.current_task()
                    if cur is not None and cur.cancelling() > 0:
                        raise
                except Exception:  # noqa: BLE001 — teardown 중 예외는 삼킴
                    _log.warning("live.kiwoom.teardown_task_err account=%d", account_id,
                                 exc_info=True)

    def _default_build_conn(self, account_id: int, codes: list[str]) -> _KiwoomConn | None:
        from .session_gate import target_ws_venue  # noqa: PLC0415 — lazy(kis import 회피)
        from .stream import LiveStream  # noqa: PLC0415 — 순환 import 회피
        from .writer import LiveWriter  # noqa: PLC0415

        prov = kiwoom_runtime.ensure_token_provider_for_account(account_id, self._data_dir)
        if prov is None:  # 키움 자격증명 부재 — 조용히 스킵(kiwoom_enabled인데 키 없음)
            _log.warning("live.kiwoom.no_creds account=%d — skip", account_id)
            return None
        stream = LiveStream(
            buffer=self._buffer,
            writer=LiveWriter(self._data_dir / "live_kiwoom"),
            date_fn=self._date_fn,
        )
        stream.set_active_codes(set(codes))  # stream 필터는 bare(WsTick.code=bare)

        async def token_fn() -> str:
            return await asyncio.to_thread(prov.get_token)

        # 연결별 라우팅 래퍼(PR-C): 이 연결 파티션 멤버→stream.on_tick, 그외(표시 전용·
        # 타 계정 저장코드)→buffer.publish. 연결별 _conn_members 공유 참조라 sync 갱신을
        # 항상 반영(전역 아님 — 리뷰: 타 계정 저장코드의 표시 틱 유실 방지).
        conn_members = self._conn_members.setdefault(account_id, set())
        client = KiwoomWsClient(
            token_fn=token_fn,
            on_tick=self._make_conn_on_tick(stream, conn_members),
            date_fn=self._date_fn,
            gate_fn=self._gate_fn,
            invalidate_fn=prov.invalidate,  # LOGIN 거부 시 캐시 토큰 무효화(리뷰 Major)
        )
        # 초기 구독 wire = 저장셋 × 현재 창 venue(파생 집합). 이후 스왑은 watchdog reconcile.
        venue = target_ws_venue(self._now_fn())
        wire = [apply_venue(c, venue) for c in codes]
        return _KiwoomConn(
            account_id=account_id,
            stream=stream,
            client=client,
            ws_task=asyncio.create_task(client.run(wire), name=f"kiwoom-ws-{account_id}"),
            flush_task=asyncio.create_task(
                stream.run_flush_loop(), name=f"kiwoom-flush-{account_id}"
            ),
            codes=tuple(codes),
        )


def _conn_dead(conn: _KiwoomConn) -> bool:
    """conn이 죽었나 — ws/flush 태스크 종료(킥 정지 포함) 또는 kicked_by_peer 플래그.
    reconnecting(태스크 살아있고 kicked 아님)은 죽은 게 아니다(자가치유)."""
    return (
        conn.ws_task.done()
        or conn.flush_task.done()
        or conn.client.kicked_by_peer
    )


def _set_active(stream: object, codes: set[str]) -> None:
    fn: Callable[[set[str]], None] | None = getattr(stream, "set_active_codes", None)
    if fn is not None:
        fn(codes)


def _replace_codes(conn: _KiwoomConn, codes: tuple[str, ...]) -> _KiwoomConn:
    return _KiwoomConn(
        account_id=conn.account_id, stream=conn.stream, client=conn.client,
        ws_task=conn.ws_task, flush_task=conn.flush_task, codes=codes,
    )
