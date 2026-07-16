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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import kiwoom_runtime
from .buffer import LiveBuffer
from .coverage import partition_kiwoom
from .kiwoom_ws_client import KiwoomWsClient

_log = logging.getLogger(__name__)


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
        _build_conn: Callable[[int, list[str]], _KiwoomConn] | None = None,
    ) -> None:
        self._buffer = buffer
        self._data_dir = data_dir
        self._date_fn = date_fn
        self._gate_fn = gate_fn
        self._build = _build_conn or self._default_build_conn
        self._conns: dict[int, _KiwoomConn] = {}

    async def sync(self, kiwoom_targets: tuple[str, ...], *, n_accounts: int) -> None:
        """kiwoom_targets를 계정에 분배하고 conn을 정합화. n_accounts=0 또는 빈 타깃이면
        전체 teardown(휴면). 200×n 초과분은 partition_kiwoom이 자연 드롭(경고)."""
        codes = list(dict.fromkeys(kiwoom_targets))
        if not codes or n_accounts <= 0:
            await self.stop()
            return
        parts = partition_kiwoom(codes, n_accounts)
        dropped = len(codes) - sum(len(p) for p in parts)
        if dropped > 0:
            _log.warning("live.kiwoom.targets_over_capacity dropped=%d cap=%d",
                         dropped, n_accounts * 200)
        wanted = {k: part for k, part in enumerate(parts) if part}
        # teardown: 더는 필요 없는 계정(빈 파티션 포함).
        for account_id in list(self._conns):
            if account_id not in wanted:
                await self._teardown(account_id)
        # build/update.
        for account_id, part in wanted.items():
            conn = self._conns.get(account_id)
            if conn is None:
                built = self._build(account_id, part)
                if built is not None:
                    self._conns[account_id] = built
            elif set(conn.codes) != set(part):
                await conn.client.update_codes(part)
                _set_active(conn.stream, set(part))
                self._conns[account_id] = _replace_codes(conn, tuple(part))

    def active_codes(self) -> list[str]:
        """전 계정 구독 종목 합집합(승격 루프용)."""
        seen: dict[str, None] = {}
        for conn in self._conns.values():
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
        return {
            "enabled": True,
            "accounts_configured": len(self._conns),
            "connected_accounts": self.connected_accounts,
            "subscribed_count": len(self.active_codes()),
            "last_tick_ms": last_tick,
            "accounts": accounts,
        }

    async def stop(self) -> None:
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
        stream.set_active_codes(set(codes))

        async def token_fn() -> str:
            return await asyncio.to_thread(prov.get_token)

        client = KiwoomWsClient(
            token_fn=token_fn,
            on_tick=stream.on_tick,
            date_fn=self._date_fn,
            gate_fn=self._gate_fn,
        )
        return _KiwoomConn(
            account_id=account_id,
            stream=stream,
            client=client,
            ws_task=asyncio.create_task(client.run(codes), name=f"kiwoom-ws-{account_id}"),
            flush_task=asyncio.create_task(
                stream.run_flush_loop(), name=f"kiwoom-flush-{account_id}"
            ),
            codes=tuple(codes),
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
