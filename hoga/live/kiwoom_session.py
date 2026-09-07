"""키움 WS 수집 세션 매니저 — 계정별 conn(LiveStream+KiwoomWsClient) 소유 (ADR-0116).

KIS lifecycle._build_conn 패턴의 키움판. lifecycle _state.streams(KIS 상태 경로)와
**별개로 자체 관리** — KIS 오케스트레이션/상태 표면에 간섭하지 않는다(그래서 stream.py
디커플링 불필요: 키움 LiveStream의 .ws는 None으로 두고 KiwoomWsClient는 여기 보관).

저장 루트는 live_kiwoom(KIS live와 분리) → promote_kiwoom_today가 kiwoom_live parquet로
승격. 앱키 부재/타깃 비면 sync가 conn 0 — 완전 휴면(생성 비용 없음).
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
from .coverage import (
    KIWOOM_PER_ACCOUNT_MAX,
    KIWOOM_SECTOR_RESERVE,
    partition_kiwoom,
    subscription_venues,
    venue_weight,
)
from .kiwoom_fields import apply_venue
from .kiwoom_sector_frames import merge_tick, parse_sector_row
from .kiwoom_vi_capture import KiwoomViCapture, replay_today as replay_vi_today
from .kiwoom_vi_state import KiwoomViState
from .kiwoom_ws_client import KiwoomWsClient
from .sector_registry import SECTOR_CODES
from .snapshot import LiveSnapshot
from .ticks import WsTick

_log = logging.getLogger(__name__)


def _nxt_map() -> dict[str, bool | None] | None:
    """마스터의 NXT 상장 표 — 구독 파생·슬롯 회계의 입력(ADR-0140 §2).

    지연 import 로 순환(api.symbols → live)을 끊는다. 마스터 미로드면 ``None`` =
    "전부 모름"이고, `subscription_venues` 가 fail-open 으로 세 venue 를 다 구독한다.
    커밋된 시드가 있어 자격증명 없이도 로드되므로 실제로 None 이 되는 창은 부팅 1회뿐이다.
    """
    from hoga.api import symbols as _symbols  # noqa: PLC0415 — 순환 절단(지연)

    try:
        return _symbols.nxt_enabled_by_code()
    except Exception:  # noqa: BLE001 — 마스터 조회 실패는 "모름"이지 세션 정지가 아니다
        _log.warning("live.kiwoom.nxt_map_unavailable — 전 종목 fail-open 구독", exc_info=True)
        return None


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
        sector_reserve: int | None = None,
        _build_conn: Callable[[int, list[str]], _KiwoomConn] | None = None,
    ) -> None:
        self._buffer = buffer
        self._data_dir = data_dir
        self._date_fn = date_fn
        self._gate_fn = gate_fn
        # 표시 장부 유예·재배정의 시각원(테스트 주입). 실경로는 벽시계.
        # venue 파생은 더는 시각을 안 본다(ADR-0140 §2 — 시분할 폐지).
        self._now_fn = now_fn or _default_now_ms
        # 연결당 등록 상한(실측 200). 슬롯 산술·만석 판정의 SSOT(테스트 주입).
        self._per_account_max = per_account_max or KIWOOM_PER_ACCOUNT_MAX
        # 업종 구독 예약. 주입 가능한 이유는 테스트가 작은 상한(3)을 쓰기 때문이다 —
        # 상수 66 을 그대로 빼면 저장셋이 통째로 드롭된다.
        self._sector_reserve = (
            KIWOOM_SECTOR_RESERVE if sector_reserve is None else sector_reserve
        )
        self._build = _build_conn or self._default_build_conn
        # 1h VI — 계정 0 conn 에만 배선한다(시장 전체 스트림이라 계정마다 받으면
        # 같은 이벤트가 중복). raw 채록(capture)과 표시용 상태(state)로 팬아웃.
        self._vi_capture = KiwoomViCapture(data_dir)
        self._vi_state = KiwoomViState()
        # 0J/0U 업종·지수 — 시장 전체 스트림이라 **한 계정에만** 배선한다. 저장 축이 없어
        # 웜스타트 리플레이도 없다: 재시작하면 다음 틱까지 비고, 그동안 화면은 폴링
        # baseline 으로 그려진다(그래서 비어도 결손이 아니다).
        self._sector_snapshots: dict[str, dict] = {}
        self._sector_tick_count = 0
        self._sector_last_ms: int | None = None
        # 업종 구독을 태우는 계정. **마지막 계정**이다 — 파티셔너가 앞에서부터 채우므로
        # 뒤쪽이 한가하고, `coverage._account_cap` 이 거기에만 예약을 건다. 계정 0 에
        # 걸었다가 저장셋 199/200 에 부딪혀 `rc=105115` 로 조용히 죽었다(2026-08-07).
        self._sector_account: int = 0
        # 재시작(dev 핫리로드 포함) 시 인메모리 상태가 비면 /api/live/vi-status가 다음
        # 이벤트까지 null — 당일 채록 파일을 리플레이해 웜스타트(없으면 조용히 0건).
        replayed = replay_vi_today(data_dir, self._now_fn(), self._vi_state.on_row)
        if replayed:
            _log.info("live.kiwoom.vi_state_warm_start rows=%d", replayed)
        self._conns: dict[int, _KiwoomConn] = {}
        # sync(멤버십)·watchdog_pass(venue/재빌드)·stop의 _conns/구독 변이 직렬화 —
        # update_codes의 다중 await(배치 REG 페이싱)가 서로 인터리브하지 않게 한다.
        self._lock = asyncio.Lock()
        # 저장셋 등록 미완이면 True(status 진단 표면화). 창 특례 없이 상시 감시(PR-F).
        self._registration_incomplete = False
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
        # 분할 단위는 종목이 아니라 **wire 등록 수**다(PR-F) — NXT 상장 종목은 3개를 쓴다.
        nxt_map = _nxt_map()
        parts = partition_kiwoom(
            codes, n_accounts,
            weight=lambda c: venue_weight(c, nxt_map),
            last_account_reserve=self._sector_reserve,
        )
        dropped = len(codes) - sum(len(p) for p in parts)
        if dropped > 0:
            _log.warning(
                "live.kiwoom.targets_over_capacity dropped=%d cap=%d regs=%d — "
                "venue 동시 구독은 NXT 상장 종목당 등록 3개를 쓴다(앱키 추가로 대응)",
                dropped, n_accounts * KIWOOM_PER_ACCOUNT_MAX,
                sum(venue_weight(c, nxt_map) for c in codes),
            )
        # 업종 구독은 **마지막 계정**이 태운다(빈 파티션이어도 그 계정은 살아 있어야
        # 하므로 아래 wanted 에 강제로 넣는다 — 저장셋이 적은 날 그 conn 이 안 만들어지면
        # 업종 스트림이 통째로 없어진다).
        self._sector_account = n_accounts - 1
        wanted = {k: part for k, part in enumerate(parts) if part}
        wanted.setdefault(self._sector_account, [])
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
        self._reassign_display()
        for account_id in wanted:
            conn = self._conns.get(account_id)
            if conn is not None:
                await self._reconcile(conn)

    async def watchdog_pass(self, now_ms: int) -> None:
        """워치독 1패스(ADR-0118 §5, KIS live-stream-watchdog 후계). 실행 순서(괄호는
        ADR 단계 번호 — 실행 순서와 다름):
        1) 죽은 conn 재빌드(저장셋 멤버십 보존; ADR ①)
        2) 시간대 venue 스왑 reconcile(ADR ②)
        3) 미확인 구독 표적 재구독(ADR ④)
        4) 저장셋 등록 완결 술어(ADR ③, 상시) — 재구독 뒤에 둬야 잔여 미확인 판정이
           정확하다(방금 재송신한 건은 이미 반영).
        표시(온디맨드) 장부도 여기 합류(PR-C): 유예 만료 sweep + 커버 전이 재배정을
        reconcile 전에 수행해 킥 복구·venue 스왑이 표시 구독까지 재파생 재등록한다.
        자가 감독(한 패스 실패는 로그 후 계속)은 호출 루프(start_kiwoom_session_watchdog)가
        담당한다. sync와 _lock으로 직렬화."""
        async with self._lock:
            await self._rebuild_dead_locked()
            self._sweep_display(now_ms)     # 유예 만료 표시키 회수
            self._reassign_display()  # 커버 전이(저장셋 변화·연결 재빌드) 재배정
            for conn in list(self._conns.values()):
                await self._reconcile(conn)
            await self._resubscribe_missing_locked()
            self._check_registration_locked()

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

    async def _reconcile(self, conn: _KiwoomConn) -> None:
        """conn 구독을 파생 집합으로 정합(ADR-0140 §2 — 시분할 폐지, 동시 구독).

        기대 wire = (저장셋 bare × 그 종목의 venue 전부) ∪ (이 연결에 배정된 표시키 중
        저장 미커버분). 종목의 venue 는 `subscription_venues` 가 정한다 — NXT 상장이면
        {KRX,NXT,UN}, 미상장이면 {KRX}.

        **시각 인자를 안 쓴다.** 예전엔 `target_ws_venue(now)` 로 창마다 venue 를 갈아
        끼웠고, 그래서 08:50·15:31 스왑 경계에 구독이 통째로 교체됐다. 이제 파생이 시각과
        무관하므로 정합화는 멤버십 변화에만 반응한다.

        클라이언트 현재 wire와 다를 때만 update_codes diff(remove-before-add: 키당 200
        상한). bare 저장 멤버십(conn.codes)은 불변 — 표시는 별도 장부(레이어드)."""
        nxt_map = _nxt_map()
        desired = {
            apply_venue(c, v) for c in conn.codes for v in subscription_venues(c, nxt_map)
        }
        for (code, v), entry in self._display.items():
            if entry.owner == conn.account_id and not self._covered_by_storage(code, v, nxt_map=nxt_map):
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

    def _check_registration_locked(self) -> None:
        """저장셋 등록 완결을 매 패스 확인. 미완이면 플래그 + 경고(재시도는 ④가 이미 수행).

        **08:50–09:00 창 특례에서 연결 창 전체로 넓혔다**(ADR-0140 §2). 그 창은 KRX
        venue 스왑이 개장 직전에 일어난다는 사실에서 나온 것이었다 — 스왑이 없어졌으니
        "개장 전 10분"이 특별할 이유도 없다. 반대로 NXT·UN 은 08:00–20:00 내내 열려
        있어 등록 미완의 대가를 아무 때나 치른다. 그래서 상시 감시로 바꾼다.

        워치독은 연결이 살아 있을 때만 돌므로 창 판정을 따로 하지 않는다 — 연결이
        없으면 `self._conns` 가 비어 pending 도 비고, 플래그는 자연히 내려간다.

        ⚠ **ACK 는 유효성을 보증하지 못한다.** 키움은 미상장 코드에도 `rc=0` 을 준다
        (#1127 실측) — 잘못 파생된 구독은 여기서 "완결"로 보이고 틱만 안 온다. 그래서
        이 술어는 **전송 유실**만 잡는다. 파생 정확성은 `subscription_venues` 가 책임진다.
        """
        pending = {
            conn.account_id: conn.client.sub_missing()
            for conn in self._conns.values()
            if conn.client.sub_missing()
        }
        self._registration_incomplete = bool(pending)
        if pending:
            total = sum(len(m) for m in pending.values())
            _log.warning(
                "live.kiwoom.registration_incomplete accounts=%s missing=%d — 저장셋 "
                "등록 미완, 재구독 재시도 중", sorted(pending), total,
            )

    # ── 표시(온디맨드) 참조 카운트 장부 API (ADR-0118 PR-C, #685) ──────────

    async def on_view_subscribe(self, code: str, venues: set[str], *, ref: str) -> bool:
        """열람 시작 — (code, v) 각 venue에 참조 ref를 더한다(뷰 와이어가 위임).

        전역 1회 등록: (code,venue)가 저장셋에 이미 커버되면 슬롯 불요(틱은 저장 경로),
        아니면 잔여 슬롯 최다 연결에 표시 슬롯 배정. 두 탭이 같은 (code,venue)를 봐도
        참조만 늘고 등록은 1회. 만석(전 연결 슬롯 소진)이면 등록을 **보류**한다 —
        미배정(owner=None) 참조로 장부에 남겨 watchdog의 _reassign_display가 슬롯 반환
        시 자동 배정한다. 하나라도 보류되면 False 반환 — ws.py가 요청 탭에 만석 이벤트
        (토스트)를 보낸다. _lock으로 sync·watchdog와 직렬화."""
        async with self._lock:
            rejected = False
            touched: set[int] = set()
            nxt_map = _nxt_map()
            for v in venues:
                key = (code, v)
                entry = self._display.setdefault(key, _DisplayEntry())
                entry.refs.add(ref)
                entry.released_at = None  # 유예 취소
                if self._covered_by_storage(code, v, nxt_map=nxt_map):
                    continue  # 이미 저장 구독 — 슬롯 불요
                if entry.owner is not None and entry.owner in self._conns:
                    continue  # 이미 등록됨(다른 탭)
                account = self._pick_account()
                if account is None:
                    # 만석 — 등록은 못 하지만 **참조는 남긴다**(owner=None = 미배정).
                    # 참조를 롤백하고 항목을 지우면 _reassign_display 가 재배정할 근거가
                    # 사라져, 슬롯이 반환돼도 사용자가 종목을 다시 전환할 때까지 그 탭은
                    # 영구히 실시간을 못 받는다(멈춘 차트만 보인다).
                    # 미배정 항목은 슬롯을 소모하지 않고(_free_slots·_reconcile 은 owner
                    # 일치만 센다), 탭이 닫히면 on_view_unsubscribe → sweep 이 회수한다.
                    rejected = True
                    continue
                entry.owner = account
                touched.add(account)
            for account in touched:
                conn = self._conns.get(account)
                if conn is not None:
                    await self._reconcile(conn)
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

    def _covered_by_storage(
        self, code: str, venue: str, *, nxt_map: dict[str, bool | None] | None,
    ) -> bool:
        """(code,venue)가 이미 저장 구독에 커버되나 — 커버되면 표시 슬롯 불요(틱=저장 경로).

        **시각 무관이 됐다**(ADR-0140 §2). 예전 판은 `eff == target_ws_venue(now)` 였는데,
        AUTO 를 해석하고 나면 양변이 같은 함수 호출이라 사실상 **`code ∈ 저장셋` 만 보는
        항등식**이었다. 시분할이 사라진 지금은 진짜 venue 비교를 한다 — 저장셋 종목이라도
        NXT 미상장이면 (code,"NXT") 는 커버되지 않는다(그리고 그런 표시 요청은 애초에
        틱이 없으므로 슬롯만 태운다 — 파생이 막는다).

        **시각 인자가 통째로 사라진 것**이 이 변경의 파급이다 — `_free_slots` ·
        `_pick_account` · `_reassign_display` · `_reconcile` 까지 연쇄로 시각과 무관해졌다.
        표시 장부에서 시각이 남은 곳은 유예 클록(`_sweep_display`) 하나뿐이다."""
        return code in self._storage_members and venue in subscription_venues(code, nxt_map)

    def _storage_free(self, conn: _KiwoomConn) -> int:
        """저장분만 제외한 잔여 슬롯(표시 미차감) — _free_slots·status 용량 공용 SSOT.

        **등록 수 기준**이다(PR-F) — 저장셋 종목 1개가 NXT 상장이면 등록 3개를 쓴다.
        종목 수로 세면 계정당 최대 600 등록을 시도하고 키움이 200 에서 거부한다."""
        nxt_map = _nxt_map()
        used = sum(venue_weight(c, nxt_map) for c in conn.codes)
        # 업종 구독분은 `conn.codes` 밖에 등록되므로 여기서 빼 주지 않으면 표시(온디맨드)
        # 배정이 그 자리를 먹는다 — 파티셔너 예약만으로는 반쪽이다(양쪽에 걸어야 한다).
        reserve = self._sector_reserve if conn.account_id == self._sector_account else 0
        return max(0, self._per_account_max - used - reserve)

    def _free_slots(self, account_id: int) -> int:
        conn = self._conns.get(account_id)
        if conn is None:
            return 0
        nxt_map = _nxt_map()
        display_used = sum(
            1 for (c, v), e in self._display.items()
            if e.owner == account_id and not self._covered_by_storage(c, v, nxt_map=nxt_map)
        )
        return max(0, self._storage_free(conn) - display_used)

    def _pick_account(self) -> int | None:
        """표시 슬롯 배정 연결 = 잔여 슬롯 최다(만석이면 None)."""
        best: int | None = None
        best_free = 0
        for account_id in self._conns:
            free = self._free_slots(account_id)
            if free > best_free:
                best, best_free = account_id, free
        return best

    def _reassign_display(self) -> None:
        """표시키의 저장 커버 전이(venue 스왑·저장셋 변화·연결 재빌드)를 재평가한다.
        커버되면 slot 반납, 미커버·미소유면 잔여 슬롯 최다 연결에 재배정(만석이면 다음
        패스 재시도). 참조 0(유예) 키는 sweep에 위임."""
        # One master snapshot per pass, not a full rebuild per display key.
        nxt_map = _nxt_map()
        for (code, venue), entry in list(self._display.items()):
            if not entry.refs:
                continue  # 참조 0(유예) — sweep 위임
            if self._covered_by_storage(code, venue, nxt_map=nxt_map):
                entry.owner = None  # 저장 커버 → 표시 슬롯 반납
                continue
            if entry.owner is None or entry.owner not in self._conns:
                account = self._pick_account()
                if account is not None:
                    entry.owner = account

    def _sweep_display(self, now_ms: int) -> None:
        """참조 0이 유예 지난 표시키 회수. 만석 임계 근처면 유예 0(즉시)."""
        grace = 0 if self._total_free_slots() <= _NEAR_FULL_SLACK else _DISPLAY_GRACE_MS
        for key, entry in list(self._display.items()):
            if entry.refs:
                entry.released_at = None  # 재구독됨 — 유예 취소
                continue
            if entry.released_at is not None and now_ms - entry.released_at >= grace:
                del self._display[key]

    def _total_free_slots(self) -> int:
        return sum(self._free_slots(a) for a in self._conns)

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

    def _on_vi_row(self, row: dict, now_ms: int) -> None:
        """계정 0 클라이언트의 1h 훅 — raw 채록과 표시용 상태로 팬아웃.
        양쪽 다 자체적으로 예외를 삼키므로 여기선 순서만 보장한다."""
        self._vi_capture.record(row, now_ms)
        self._vi_state.on_row(row, now_ms)

    def vi_status(self, code: str) -> dict | None:
        """종목의 최신 VI 이벤트 상태(없으면 None) — /api/live/vi-status 소스."""
        return self._vi_state.get(code)

    def _on_sector_row(self, row: dict, now_ms: int) -> None:
        """계정 0 클라이언트의 0J/0U 훅 — 업종코드별 최신 스냅샷을 병합해 얹는다.

        **저장하지 않는다.** 이 표면은 표시 전용이고(`/market` 오버레이) 폴링
        baseline(`ka20003`, 30s)이 항상 아래에 깔려 있어, 프로세스가 죽어도 화면은
        폴링으로 되돌아갈 뿐 결손이 남지 않는다.

        병합이 필드 단위인 이유는 `merge_tick` 주석 참조 — 0J 와 0U 가 서로 다른
        축을 주므로 통째로 교체하면 상대의 값을 지운다.
        """
        tick = parse_sector_row(row)
        if tick is None:
            return
        self._sector_snapshots[tick.code] = merge_tick(
            self._sector_snapshots.get(tick.code), tick
        )
        self._sector_tick_count += 1
        self._sector_last_ms = now_ms

    def sector_snapshot(self) -> dict[str, dict]:
        """업종코드 → 최신 병합 스냅샷. `/market` 오버레이 소스.

        **얕은 사본을 준다** — 호출자가 직렬화하는 동안 recv 루프가 같은 dict 를
        갱신하면 "dictionary changed size during iteration" 이 난다.
        """
        return dict(self._sector_snapshots)

    def sector_health(self) -> dict:
        """실시간이 실제로 흐르는가 — 조용한 0틱을 드러내는 관측 창구.

        REG ACK 는 코드 유효성을 검사하지 않으므로(쓰레기 코드도 rc=0) "구독했다" 는
        아무것도 보장하지 않는다. 오버레이 구조상 틱이 0 이면 화면은 조용히 30초
        폴링으로 강등되는데, 그게 **무증상**이라 이 카운터가 유일한 신호다.
        """
        return {
            "subscribed_codes": len(SECTOR_CODES),
            "codes_with_data": len(self._sector_snapshots),
            "tick_count": self._sector_tick_count,
            "last_tick_ms": self._sector_last_ms,
        }

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

    def capture_streams(self) -> list[object]:
        """살아있는 conn의 LiveStream 목록 — peak 스냅샷 조회(lifecycle
        get_today_ask/bid_peak)의 fan-out 대상. 코드-disjoint 파티션이라 소유
        stream 1개만 non-None을 반환한다. 킥·태스크 사망 conn은 제외
        (active_codes 규율과 동일 — 재빌드 중 유령 저장 방지).

        (구명 broker_dispatch_streams — REST 거래원 합성 틱(ADR-0111)의
        브로드캐스트 대상이었으나 그 경로가 키움 0F 로 컷오버(PR-F2)되며
        용도가 조회 fan-out 만 남아 개명.)"""
        return [conn.stream for conn in self._conns.values() if not _conn_dead(conn)]

    def status(self) -> dict:
        """관측 스냅샷 — LiveStatus.kiwoom로 노출(PR-6 커버리지 칩·진단). 프론트는
        connected_accounts/subscribed_count을 칩에, accounts를 진단에 쓴다."""
        accounts = []
        last_tick: int | None = None
        last_recv: int | None = None
        for account_id, conn in sorted(self._conns.items()):
            c = conn.client
            if c.last_tick_ms is not None:
                last_tick = max(last_tick or 0, c.last_tick_ms)
            if c.last_recv_ms is not None:
                last_recv = max(last_recv or 0, c.last_recv_ms)
            accounts.append({
                "account_id": account_id,
                "connected": c.connected,
                "sub_expected": c.sub_expected,
                "sub_acked": c.sub_acked,
                "kicked_by_peer": c.kicked_by_peer,
                "last_tick_ms": c.last_tick_ms,
                # PING 포함 전 수신 — connected/sub_acked가 못 보는 좀비 구간의 유일한
                # 증거다(2026-07-21: 둘 다 정상인데 last_recv만 2h20m 정체였다).
                # last_tick과 함께 봐야 "상류 침묵"과 "조용한 시간대"를 구분할 수 있다.
                "last_recv_ms": c.last_recv_ms,
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
            "last_recv_ms": last_recv,
            # 08:50–09:00 워밍 창 저장셋 등록 미완 여부(ADR-0118 §5 진단 표면).
            "registration_incomplete": self._registration_incomplete,
            # 표시(온디맨드) 등록 수(PR-C 진단·프론트 배지). 저장 커버분 제외한 실등록.
            "on_demand_count": sum(1 for e in self._display.values() if e.owner is not None),
            # 표시 슬롯 총 용량(전 연결 잔여 = Σ(상한−저장)) — 프론트 만석 배지 "count/cap".
            "on_demand_capacity": sum(self._storage_free(c) for c in self._conns.values()),
            "accounts": accounts,
            # 0J/0U 오버레이가 실제로 흐르는가. **화면만 봐서는 알 수 없다** —
            # 틱이 0 이어도 폴링 baseline 이 그려 주므로 무증상으로 강등된다.
            "sector": self.sector_health(),
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
        from .stream import LiveStream  # noqa: PLC0415 — 순환 import 회피
        from .writer import LiveWriter  # noqa: PLC0415

        prov = kiwoom_runtime.ensure_token_provider_for_account(account_id, self._data_dir)
        if prov is None:  # 키움 자격증명 부재 — 조용히 스킵(계좌는 설정됐으나 키 없음)
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
            # VI 는 계정 0 전용(시장 전체 스트림 중복 방지 — __init__ 주석).
            on_vi_row=self._on_vi_row if account_id == 0 else None,
            # 0J/0U 는 **마지막 계정** 하나만 태운다. 계정마다 걸면 같은 틱을 4번 받고,
            # 무엇보다 **슬롯을 4배로 먹는다**(코드당 1개 — 2026-08-07 실측).
            on_sector_row=(
                self._on_sector_row if account_id == self._sector_account else None
            ),
        )
        # 초기 구독 wire = 저장셋 × 종목별 venue(ADR-0140 §2 파생 집합). 시각 무관 —
        # 예전엔 `target_ws_venue(now)` 로 현재 창 venue 하나를 골랐고 스왑을 watchdog
        # reconcile 이 따라갔다. 이제 갈아 끼울 것이 없어 초기 wire 가 곧 최종 wire 다.
        nxt_map = _nxt_map()
        wire = [apply_venue(c, v) for c in codes for v in subscription_venues(c, nxt_map)]
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
