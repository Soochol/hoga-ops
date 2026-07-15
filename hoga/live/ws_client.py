"""KIS WebSocket 클라이언트 — 연결·구독·PINGPONG·백오프 재연결 (spec §7).

순수 파싱은 ws_frames에 위임. 이 모듈은 소켓 수명만 책임진다.
재연결: (1,2,4,8,16,32,60)s 백오프 + 성공 시 전 종목 재구독.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable

import websockets

from . import ws_fields as F
from .kis_client import KisAuthError
from .ws_frames import WsTick, parse_message

_log = logging.getLogger(__name__)

WS_URL_REAL = "ws://ops.koreainvestment.com:21000"
_TRS = F.TRS  # 종목당 구독 TR — ws_fields 단일진실원(사이징=구독수, 드리프트 불가)
_BACKOFF_S = (1, 2, 4, 8, 16, 32, 60)
_APPKEY_IN_USE_BACKOFF_S = 60
# 구독 ACK 유예 — 송신 후 이 시간 안에는 미확인 키를 'missing'으로 치지 않는다.
# venue 스왑·update_codes diff 직후 ACK 도착 전 순간을 sub_failed로 오판하지 않게 함.
_SUB_ACK_GRACE_MS = 10_000


class DuplicateAppKeyInUse(RuntimeError):
    """KIS rejected this WS subscription because the appkey is already active."""


def build_request(approval_key: str, tr_type: str, tr_id: str, tr_key: str) -> str:
    return json.dumps({
        "header": {"approval_key": approval_key, "custtype": "P",
                   "tr_type": tr_type, "content-type": "utf-8"},
        "body": {"input": {"tr_id": tr_id, "tr_key": tr_key}},
    })


class KisWsClient:
    def __init__(
        self,
        *,
        approval_key_fn: Callable[[], Awaitable[str]],
        on_tick: Callable[[WsTick], Awaitable[None]] | None,
        date_fn: Callable[[], str],
        url: str = WS_URL_REAL,
        gate_fn: Callable[[], bool] | None = None,
        trs: tuple[str, ...] = _TRS,
    ) -> None:
        self._approval_key_fn = approval_key_fn
        self._on_tick = on_tick
        self._date_fn = date_fn
        self._url = url
        self._gate_fn = gate_fn   # advisor B: 게이트 밖에선 (재)연결 시도 안 함
        # 구독 TR세트(#524 시분할) — venue별로 스왑. 초기값은 생성 시 지정(기본 KRX).
        # run()의 초기 구독·update_codes·ensure_venue가 모두 self._trs를 단일 소스로 쓴다.
        self._trs: tuple[str, ...] = trs
        self._codes: list[str] = []
        self._ws: object | None = None
        self._approval: str | None = None  # 연결 시 발급분 캐시 — update_codes가 재사용
        self._sub_lock = asyncio.Lock()    # 구독 전송 직렬화 — wire ≠ _codes 발산 방지
        # 의미 분리(리뷰 Important 1): last_tick_ms = 데이터 프레임 전용(표시용,
        # get_status), last_recv_ms = 모든 수신 프레임(PINGPONG·컨트롤 포함) —
        # watchdog liveness 신호. PINGPONG은 KIS가 주기 송신하므로 시장 활동과
        # 무관하게 도착한다 → half-open TCP(silent stall)에서만 끊긴다.
        self.last_tick_ms: int | None = None
        self.last_recv_ms: int | None = None
        self.connected: bool = False
        # 구독 확인 추적(spec 2026-06-08 §2.1) — (tr_id, code) 단위 상태.
        # 기대 집합은 저장하지 않고 self._codes × self._trs로 파생하므로 venue
        # 스왑·update_codes diff에 자동으로 현재 venue 기준이 된다(스칼라 카운터가
        # 스왑 시 stale해지던 문제를 구조적으로 제거 — 2026-07-15 인시던트 근본수정).
        # _acked_keys: ACK 받은 (tr, code). _sub_sent_ms: 각 키 마지막 구독 송신 시각
        # (ACK 유예 기준). 헬스 술어는 sub_missing()으로 '유예 지난 미확인 키'를 본다.
        self._acked_keys: set[tuple[str, str]] = set()
        self._sub_sent_ms: dict[tuple[str, str], int] = {}
        self.sub_rejected: int = 0

    @property
    def expected_keys(self) -> set[tuple[str, str]]:
        """현재 (venue, 종목) 구독 기대 집합 — 파생값(저장 안 함)."""
        return {(tr, code) for code in self._codes for tr in self._trs}

    @property
    def sub_expected(self) -> int:
        return len(self._codes) * len(self._trs)

    @property
    def sub_acked(self) -> int:
        return len(self._acked_keys & self.expected_keys)

    def sub_missing(self, now_ms: int) -> list[tuple[str, str]]:
        """유예(_SUB_ACK_GRACE_MS)를 지났는데도 ACK 미확인인 기대 키 정렬 목록.

        송신 기록(_sub_sent_ms)이 없는 키는 제외(보수적 — 아직 송신 전이라 판단
        불가). 스왑/디프 직후 갓 (재)송신된 키는 유예 안이라 missing이 아니다."""
        missing = []
        for key in self.expected_keys - self._acked_keys:
            sent = self._sub_sent_ms.get(key)
            if sent is not None and (now_ms - sent) > _SUB_ACK_GRACE_MS:
                missing.append(key)
        return sorted(missing)

    async def run(self, codes: list[str]) -> None:
        """끊겨도 살아남는 메인 루프 — 호출자(stream)가 task로 돌리고 cancel로 끝낸다."""
        self._codes = list(codes)
        attempt = 0
        while True:
            # 게이트는 "새 연결 수립"만 막는다 — 이미 살아있는 연결은 게이트가
            # 닫혀도 서버 drop까지 의도적으로 유지(쓰기는 flush 게이트가 차단).
            # to_thread 격리(리뷰 #2): 캘린더 게이트의 동기 KIS HTTP가 이벤트
            # 루프를 동결시키지 않도록 — 구 poller의 to_thread 가드 승계.
            if self._gate_fn is not None and not await asyncio.to_thread(self._gate_fn):
                self.connected = False
                await asyncio.sleep(30)   # 장외/15:30 이후 — 연결 시도 보류
                continue
            try:
                approval = await self._approval_key_fn()
                async with websockets.connect(self._url, ping_interval=None) as ws:
                    async with self._sub_lock:
                        # lock 안에서 ws 공개 + _codes 스냅샷 — update_codes와
                        # 직렬화되어 초기 구독과 diff 전송이 interleave하지 않는다.
                        self._ws = ws
                        self._approval = approval
                        self.connected = True
                        attempt = 0
                        codes_now = list(self._codes)
                        trs_now = self._trs
                        # 연결별 구독 확인 상태 리셋(spec §2.1) — 새 소켓엔 이전 ACK 무효.
                        self._acked_keys.clear()
                        self._sub_sent_ms.clear()
                        self.sub_rejected = 0
                        await self._send_subscriptions(
                            ws, approval, codes_now, tr_type="1"
                        )
                    _log.info("live.ws.connected codes=%d regs=%d venue=%s",
                              len(codes_now), len(codes_now) * len(trs_now),
                              self.venue)
                    await self._recv_loop(ws)
            except asyncio.CancelledError:
                self.connected = False
                raise
            except Exception as e:  # noqa: BLE001 — 연결 오류는 전부 재시도 대상
                self.connected = False
                self._ws = None
                self._approval = None
                if isinstance(e, DuplicateAppKeyInUse):
                    delay = _APPKEY_IN_USE_BACKOFF_S
                    attempt += 1
                    _log.warning(
                        "live.ws.appkey_in_use attempt=%d delay=%ds err=%r",
                        attempt, delay, e,
                    )
                else:
                    delay = _BACKOFF_S[min(attempt, len(_BACKOFF_S) - 1)]
                    attempt += 1
                    # 인증 오류는 영구성(키 폐기 등) 가능성 — error로 승격해 가시화.
                    log = _log.error if isinstance(e, KisAuthError) else _log.warning
                    log("live.ws.reconnect attempt=%d delay=%ds err=%r", attempt, delay, e)
                await asyncio.sleep(delay)

    async def update_codes(self, codes: list[str]) -> None:
        """Live Set 변경(watchlist reorder) — diff만 구독/해제."""
        async with self._sub_lock:
            new, old = set(codes), set(self._codes)
            added = [c for c in codes if c not in old]
            removed = [c for c in old if c not in new]
            self._codes = list(codes)
            if not added and not removed:
                return
            ws, approval = self._ws, self._approval
            if ws is None or approval is None:
                return  # 다음 (재)연결 때 전체 구독
            if removed:
                await self._send_subscriptions(ws, approval, removed, tr_type="2")
            if added:
                await self._send_subscriptions(ws, approval, added, tr_type="1")

    @property
    def venue(self) -> str:
        """현재 구독 중인 venue("KRX"/"NXT") — status 표면화·로그용."""
        return "NXT" if self._trs == F.TRS_NXT else "KRX"

    async def ensure_venue(self, venue: str) -> None:
        """구독 TR세트를 목표 venue로 맞춘다(#524 시분할 스왑). 이미 그 venue면 no-op.

        해제 먼저·등록 나중(unregister-before-register) — 연결당 등록 상한 41
        (OPSP0008 MAX SUBSCRIBE OVER, 2026-07-10 실측)을 지키기 위함이다.
        register-first면 스왑 찰나 종목당 KRX3+NXT2=5 TR을 동시 점유해(13종목=65,
        10종목=50) 41을 초과, 신 venue 등록 일부가 조용히 거부된다(재시도 없음 →
        KRX 재등록분이 거부되면 정규장 캡처 구멍). 스왑 시각(08:50·15:31)은 저장창
        (정규장 09:00-15:30) 밖이라 해제-후-등록의 찰나 공백은 캡처 무손실이다(ADR-0101).
        update_codes의 remove-before-add와 동일 패턴. 미연결이면 self._trs만 갱신해
        다음 (재)연결이 새 venue로 초기 구독한다. sub_lock으로 update_codes·초기
        구독과 직렬화(wire≠상태 발산 방지)."""
        trs = F.trs_for_venue(venue)
        async with self._sub_lock:
            if trs == self._trs:
                return
            old_trs = self._trs
            self._trs = trs
            # 기대 집합(expected_keys)은 self._trs 파생이라 이 대입 한 줄로 즉시 새 venue
            # 기준이 된다. _send_subscriptions(tr_type="2")가 구 venue 키의 ACK를 폐기하고
            # (tr_type="1")가 새 키를 송신 시각 스탬프와 함께 등록 → sub_missing은 유예
            # (_SUB_ACK_GRACE_MS) 안에는 새 키를 missing으로 치지 않아 순간적 거짓
            # 'sub_failed'가 없다(구 스칼라 카운터의 '스왑 시 미리셋' 우회가 불필요해짐).
            # NXT 표시 구독의 부분 거부는 watchdog의 NXT-무재시작 분기가 흡수한다(lifecycle).
            ws, approval = self._ws, self._approval
            if ws is None or approval is None:
                return  # 미연결 — 다음 (재)연결이 self._trs로 초기 구독
            # unregister-before-register: 구 venue 먼저 해제해 슬롯을 비우고(등록 상한
            # 41 준수), 신 venue 등록. 찰나 공백은 저장창 밖이라 무해(docstring·ADR-0101).
            await self._send_subscriptions(ws, approval, self._codes, tr_type="2", trs=old_trs)
            await self._send_subscriptions(ws, approval, self._codes, tr_type="1", trs=trs)
            _log.info("live.ws.venue_swapped venue=%s codes=%d", venue, len(self._codes))

    async def resubscribe_missing(self, now_ms: int) -> int:
        """유예 지난 미확인 키(sub_missing)만 골라 재구독 송신. 재송신 건수 반환.

        watchdog이 sub_failed 감지 시 conn 전체 재시작 전에 먼저 부르는 값싼 표적
        복구다(2026-07-15 인시던트: 스왑 시 일부 KRX 등록이 조용히 유실됐는데 재시도가
        없어 87분 공백). missing ⊆ expected ⊆ 41 상한이라 과잉 등록 불가. ACK가 유실됐을
        뿐 서버엔 구독이 살아있으면 재송신에 OPSP0002(ALREADY IN SUBSCRIBE)로 응답 →
        _recv_loop이 acked로 수렴시킨다. 미연결이면 no-op(0). sub_lock으로 직렬화."""
        async with self._sub_lock:
            ws, approval = self._ws, self._approval
            if ws is None or approval is None:
                return 0
            missing = self.sub_missing(now_ms)
            if not missing:
                return 0
            await self._send_keys(ws, approval, missing, now_ms)
            _log.warning("live.ws.resubscribe_missing count=%d keys=%r",
                         len(missing), missing[:10])
            return len(missing)

    async def _send_keys(
        self, ws, approval_key: str, keys: list[tuple[str, str]], now_ms: int,
    ) -> None:
        """지정 (tr, code) 키만 재구독 송신 + 송신 시각 스탬프(표적 복구용)."""
        for tr, code in keys:
            await ws.send(build_request(approval_key, "1", tr, code))
            self._sub_sent_ms[(tr, code)] = now_ms

    async def _send_subscriptions(
        self, ws, approval_key: str, codes: list[str], *, tr_type: str,
        trs: tuple[str, ...] | None = None,
    ) -> None:
        now_ms = int(time.time() * 1000)
        for code in codes:
            for tr in (trs if trs is not None else self._trs):
                key = (tr, code)
                await ws.send(build_request(approval_key, tr_type, tr, code))
                if tr_type == "1":
                    self._sub_sent_ms[key] = now_ms  # ACK 유예 기준 스탬프
                else:
                    # 해제(tr_type="2"): 기대 이탈 → 송신 기록·ACK 폐기(스왑 시 구 venue).
                    self._sub_sent_ms.pop(key, None)
                    self._acked_keys.discard(key)

    async def _recv_loop(self, ws) -> None:
        while True:
            raw = await ws.recv()
            now_ms = int(time.time() * 1000)
            # liveness 스탬프 — 모든 수신 프레임(데이터+PINGPONG+기타 컨트롤,
            # 파싱 실패분 포함): 바이트 수신 자체가 소켓 생존의 증거다.
            # ADR-0064 watchdog이 이 값으로 silent stall을 감지한다.
            self.last_recv_ms = now_ms
            # BINARY 프레임 방어(ship 리뷰): websockets는 binary를 bytes로
            # 전달한다 — str 가정이면 raw[0]이 int라 데이터 분기가 매칭되지
            # 않고 json 분기에서 무로그 드롭된다(침묵 캡처 정지). 녹화
            # 스크립트(record_kis_ws_frames.py)와 동일하게 디코드.
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            if raw and raw[0] in ("0", "1"):
                # 메시지마다 조회 — 자정을 넘긴 연결에서 어제 날짜 스탬프 방지.
                date = self._date_fn()
                for tick in parse_message(raw, date=date, now_ms=now_ms):
                    self.last_tick_ms = now_ms  # 데이터 프레임 전용(표시용)
                    if self._on_tick is not None:
                        await self._on_tick(tick)
            else:
                try:
                    msg = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                header = msg.get("header", {})
                if header.get("tr_id") == "PINGPONG":
                    await ws.send(raw)  # 공식 규약: 받은 메시지 그대로 echo
                else:
                    self._handle_control_frame(header, msg.get("body", {}))

    def _handle_control_frame(self, header: dict, body: dict) -> None:
        """구독 ACK/거부 처리(spec §2.1). rt_cd=="0" 성공. OPSP0002(ALREADY IN
        SUBSCRIBE)는 서버에 구독이 이미 있다는 뜻이라 성공으로 본다(resubscribe_missing
        재송신의 정상 수렴 경로). 그 외 비-0은 거부. OPSP8996은 DuplicateAppKeyInUse."""
        tr_id = header.get("tr_id")
        tr_key = header.get("tr_key")
        rt_cd = body.get("rt_cd")
        msg_cd = body.get("msg_cd")
        if rt_cd == "0" or msg_cd == "OPSP0002":
            if tr_id is not None and tr_key is not None:
                self._acked_keys.add((tr_id, tr_key))
            _log.info("live.ws.subscribed tr_id=%s tr_key=%s", tr_id, tr_key)
            return
        self.sub_rejected += 1
        _log.warning("live.ws.sub_rejected tr_id=%s tr_key=%s msg=%s",
                     tr_id, tr_key, str(body)[:200])
        if msg_cd == "OPSP8996":
            msg1 = str(body.get("msg1", ""))
            raise DuplicateAppKeyInUse(msg1 or "ALREADY IN USE appkey")
