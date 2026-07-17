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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import kiwoom_runtime
from .buffer import LiveBuffer
from .coverage import partition_kiwoom
from .kiwoom_fields import apply_venue
from .kiwoom_ws_client import KiwoomWsClient

_log = logging.getLogger(__name__)


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
        _build_conn: Callable[[int, list[str]], _KiwoomConn] | None = None,
    ) -> None:
        self._buffer = buffer
        self._data_dir = data_dir
        self._date_fn = date_fn
        self._gate_fn = gate_fn
        # venue 파생·warmup 술어의 시각원(테스트 주입). 실경로는 벽시계.
        self._now_fn = now_fn or _default_now_ms
        self._build = _build_conn or self._default_build_conn
        self._conns: dict[int, _KiwoomConn] = {}
        # sync(멤버십)·watchdog_pass(venue/재빌드)·stop의 _conns/구독 변이 직렬화 —
        # update_codes의 다중 await(배치 REG 페이싱)가 서로 인터리브하지 않게 한다.
        self._lock = asyncio.Lock()
        # 08:50–09:00 워밍 창에 저장셋 등록 미완이면 True(status 진단 표면화).
        self._warmup_incomplete = False

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
        # build(신규) / 멤버십 갱신 → 현재 창 venue로 reconcile(파생 집합).
        for account_id, part in wanted.items():
            conn = self._conns.get(account_id)
            if conn is None:
                built = self._build(account_id, part)
                if built is None:
                    continue
                self._conns[account_id] = conn = built
            elif set(conn.codes) != set(part):
                _set_active(conn.stream, set(part))
                self._conns[account_id] = conn = _replace_codes(conn, tuple(part))
            await self._reconcile(conn, now_ms)

    async def watchdog_pass(self, now_ms: int) -> None:
        """워치독 1패스(ADR-0118 §5, KIS live-stream-watchdog 후계). 실행 순서(괄호는
        ADR 단계 번호 — 실행 순서와 다름):
        1) 죽은 conn 재빌드(저장셋 멤버십 보존; ADR ①)
        2) 시간대 venue 스왑 reconcile(ADR ②)
        3) 미확인 구독 표적 재구독(ADR ④)
        4) 08:50–09:00 저장셋 등록 완결 술어(ADR ③) — 재구독 뒤에 둬야 잔여 미확인 판정이
           정확하다(방금 재송신한 건은 이미 반영).
        자가 감독(한 패스 실패는 로그 후 계속)은 호출 루프(start_kiwoom_session_watchdog)가
        담당한다. sync와 _lock으로 직렬화."""
        async with self._lock:
            await self._rebuild_dead_locked()
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

        기대 wire = 저장셋(bare) × venue(target_ws_venue(now)). 클라이언트 현재 wire와
        다를 때만 update_codes diff(remove-before-add: 키당 200 상한 준수). 이미 목표면
        no-op이라 매 주기·매 sync 호출이 값싸다. bare 멤버십(conn.codes)은 불변."""
        from .session_gate import target_ws_venue  # noqa: PLC0415 — 순환/kis import 회피(lazy)

        venue = target_ws_venue(now_ms)
        desired = [apply_venue(c, venue) for c in conn.codes]
        if set(desired) != conn.client.expected_codes:
            await conn.client.update_codes(desired)

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
            "accounts": accounts,
        }

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        for account_id in list(self._conns):
            await self._teardown(account_id)

    async def _teardown(self, account_id: int) -> None:
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

        client = KiwoomWsClient(
            token_fn=token_fn,
            on_tick=stream.on_tick,
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
