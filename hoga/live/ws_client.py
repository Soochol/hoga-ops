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
        # 구독 확인 추적(spec 2026-06-08 §2.1): 이번 연결의 초기 구독 ACK.
        # 헬스 술어가 '기대 ACK의 부재'(sub_acked < sub_expected)로 구독
        # 거부/상실을 감지한다. update_codes diff는 범위 밖(초기 구독만).
        self.sub_expected: int = 0
        self.sub_acked: int = 0
        self.sub_rejected: int = 0

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
                        # 연결별 구독 확인 카운터 리셋(spec §2.1) — 초기 구독 수가 기대치.
                        self.sub_expected = len(codes_now) * len(trs_now)
                        self.sub_acked = 0
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
        register-first면 스왑 찰나 종목당 KRX2+NXT2=4 TR을 동시 점유해(19종목=76)
        41을 초과, 신 venue 등록 일부가 조용히 거부된다(재시도 없음 → KRX 재등록분이
        거부되면 정규장 캡처 구멍). 해제-먼저면 종목당 2를 넘지 않아 안전하다(ADR-0111에서
        거래원 TR 제외 후 KRX·NXT 둘 다 2 TR). 스왑 시각(08:50·15:31)은 저장창
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
            # sub_acked/expected/rejected는 **리셋하지 않는다** — update_codes(동일한 구독
            # diff 연산)와 동일한 선례. 리셋하면 ① ACK 도착 전 acked<expected 창이 status의
            # _capture_health에 순간적 거짓 'sub_failed'로 잡히고, ② 표시 전용 NXT 구독이
            # 거부되면 그 비성역 실패로 watchdog이 conn 전체를 재시작(에스컬레이션)한다.
            # 스왑 ACK는 recv 루프가 계속 카운트(재연결 시 sub_expected가 현재 venue로
            # 재계산되므로 stale하지 않다). NXT 거부는 sub_rejected 경고 로그로 가시화된다.
            ws, approval = self._ws, self._approval
            if ws is None or approval is None:
                return  # 미연결 — 다음 (재)연결이 self._trs로 초기 구독
            # unregister-before-register: 구 venue 먼저 해제해 슬롯을 비우고(등록 상한
            # 41 준수), 신 venue 등록. 찰나 공백은 저장창 밖이라 무해(docstring·ADR-0101).
            await self._send_subscriptions(ws, approval, self._codes, tr_type="2", trs=old_trs)
            await self._send_subscriptions(ws, approval, self._codes, tr_type="1", trs=trs)
            _log.info("live.ws.venue_swapped venue=%s codes=%d", venue, len(self._codes))

    async def _send_subscriptions(
        self, ws, approval_key: str, codes: list[str], *, tr_type: str,
        trs: tuple[str, ...] | None = None,
    ) -> None:
        for code in codes:
            for tr in (trs if trs is not None else self._trs):
                await ws.send(build_request(approval_key, tr_type, tr, code))

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
                tr_id = msg.get("header", {}).get("tr_id")
                if tr_id == "PINGPONG":
                    await ws.send(raw)  # 공식 규약: 받은 메시지 그대로 echo
                else:
                    # 구독 ACK 카운트(spec §2.1): rt_cd=="0" 성공, 그 외 거부.
                    # 거부 형태는 미관측이라 '0이 아닌 모든 control'을 거부로 본다.
                    body = msg.get("body", {})
                    rt_cd = body.get("rt_cd")
                    if rt_cd == "0":
                        self.sub_acked += 1
                        _log.info("live.ws.subscribed tr_id=%s", tr_id)
                    else:
                        self.sub_rejected += 1
                        _log.warning("live.ws.sub_rejected tr_id=%s msg=%s",
                                     tr_id, str(body)[:200])
                        if body.get("msg_cd") == "OPSP8996":
                            msg1 = str(body.get("msg1", ""))
                            raise DuplicateAppKeyInUse(msg1 or "ALREADY IN USE appkey")
