"""KIS 야간선물 실시간 WS 세션 (`H0MFCNT0`) — ADR-0141.

**야간 시세는 REST 로 얻을 수 없다.** KIS `domestic-futureoption` 의 `quotations/`
9개 경로에 야간(`ngt`)이 0건이고, 야간장 중 REST 를 부르면 **주간 마감 스냅샷**이
온다(`aspr_acpt_hour=154500`, 2026-08-06 실측). 야간 `ngt` 표면은 전부 `trading/`
(주문·잔고·증거금)이라 시세가 아니다. 그래서 이 표면만 WS 다.

**프론트 계약은 바뀌지 않는다.** 이 세션은 최신 틱을 메모리에 얹기만 하고, 화면은
기존대로 30초 폴링으로 `/api/market/futures-quotes` 를 읽는다. 야간에 화면이 WS 를
직접 물게 하면 카드 하나 때문에 브라우저 WS 를 하나 더 여는 셈이 된다.

**무음은 정상이다.** 야간 유동성은 상품마다 크게 다르다 — 2026-08-07 00:36 실측
40초 동안 KOSPI200 48틱, 코스닥150 0틱, VKOSPI 0틱이었다(코스닥150 은 23:50 에 1틱이
왔으므로 미지원이 아니라 저유동성이다). 그래서 **틱이 없다고 값을 비우면 안 된다** —
호출자가 주간 마감본을 유지하고 종목별로 어느 세션 값인지 표시한다.

종목코드는 주간과 같은 마스터 단축코드(`A01609`)다. KIS 공식 예제의 `101W9000` 은
`SUBSCRIBE SUCCESS` 를 받고도 0틱이다 — 구독 응답만 보면 성공으로 읽히므로 주의.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
import urllib.request
from dataclasses import dataclass

log = logging.getLogger(__name__)

_WS_URL = "ws://ops.koreainvestment.com:21000"
_APPROVAL_URL = "https://openapi.koreainvestment.com:9443/oauth2/Approval"
_TR_ID = "H0MFCNT0"

#: 실시간 프레임 모양: `0|TR_ID|건수|payload`. 이보다 짧으면 우리 프레임이 아니다.
_FRAME_PARTS = 4

#: 마지막 요청 후 이만큼 조용하면 세션을 닫는다 — 아무도 안 보는 야간에 WS 슬롯을
#: 쥐고 있을 이유가 없다(옵션 심리 런타임과 같은 판단).
_IDLE_STOP_S = 600.0
#: recv 가 이만큼 조용하면 죽은 소켓으로 보고 재연결한다. 무음이 정상인 표면이라
#: **틱 부재로는 판정할 수 없어** PINGPONG 을 살아있음의 근거로 쓴다(벤더가 주기 송신).
_RECV_IDLE_TIMEOUT_S = 180.0
_RECONNECT_BACKOFF_S = (1.0, 2.0, 5.0, 10.0, 30.0)

#: `H0MFCNT0` 응답 필드 순서(KIS 공식 예제 `krx_ngt_futures_ccnl` 의 columns).
#: 인덱스 상수로 흩뿌리면 벤더가 필드를 추가할 때 조용히 어긋나므로 표로 둔다.
_COLUMNS: tuple[str, ...] = (
    "futs_shrn_iscd", "bsop_hour", "futs_prdy_vrss", "prdy_vrss_sign", "futs_prdy_ctrt",
    "futs_prpr", "futs_oprc", "futs_hgpr", "futs_lwpr", "last_cnqn", "acml_vol",
    "acml_tr_pbmn", "hts_thpr", "mrkt_basis", "dprt", "nmsc_fctn_stpl_prc",
    "fmsc_fctn_stpl_prc", "spead_prc", "hts_otst_stpl_qty", "otst_stpl_qty_icdc",
)


@dataclass(frozen=True)
class NightTick:
    """야간 체결 1틱. 카드가 쓰는 필드만 추린다."""
    code: str
    price: float
    change: float
    change_rate: float
    volume: int
    open_interest: int
    oi_change: int
    market_basis: float | None
    #: 벤더 시각 `HHMMSS`. 수신 시각이 아니라 **체결 시각**이다.
    bsop_hour: str
    t_ms: int


class KisFuturesWsUnavailable(Exception):
    """승인키 발급 실패 등 — 야간 경로만 죽고 REST 카드는 살아야 한다."""


def _f(row: dict[str, str], key: str) -> float | None:
    v = row.get(key, "")
    if v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def fetch_approval_key() -> str:
    """WS 승인키. **블로킹** — to_thread 로 부를 것.

    OAuth 토큰(`KisTokenProvider`)과 **다른 자격이다** — REST 는 Bearer 토큰,
    WS 는 approval_key 다. PR-J(#1046)에서 `get_approval_key` 가 지워져 여기서 되살린다.
    """
    app_key = os.environ.get("KIS_APP_KEY") or ""
    app_secret = os.environ.get("KIS_APP_SECRET") or ""
    if not app_key or not app_secret:
        raise KisFuturesWsUnavailable("KIS 자격증명 없음")
    body = json.dumps(
        {"grant_type": "client_credentials", "appkey": app_key, "secretkey": app_secret}
    ).encode()
    req = urllib.request.Request(  # noqa: S310 — 고정 https 상수
        _APPROVAL_URL, data=body, headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310 — 위와 같음
            key = json.loads(r.read()).get("approval_key")
    except Exception as e:  # 발급 실패를 야간 전용 신호로 번역한다(재발생하므로 BLE001 무관)
        raise KisFuturesWsUnavailable(f"approval_key 발급 실패: {e}") from e
    if not key:
        raise KisFuturesWsUnavailable("approval_key 가 응답에 없다")
    return str(key)


class KisFuturesNightWs:
    """야간 틱 캐시. `ensure_running(codes)` 가 세션을 깨우고 `latest(code)` 가 읽는다.

    프로세스 싱글턴을 전제로 한다 — WS 슬롯을 두 벌 쥐면 벤더가 한쪽을 끊는다.
    """

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._ticks: dict[str, NightTick] = {}
        self._codes: tuple[str, ...] = ()
        self._last_request = 0.0
        self._unavailable: str | None = None

    @property
    def unavailable(self) -> str | None:
        return self._unavailable

    def latest(self, code: str) -> NightTick | None:
        return self._ticks.get(code)

    async def ensure_running(self, codes: tuple[str, ...]) -> None:
        """세션이 돌고 있게 만든다. 구독 종목이 바뀌면(롤오버) 재연결한다."""
        self._last_request = time.monotonic()
        async with self._lock:
            if self._codes != codes:
                # 롤오버로 근월물이 바뀌었다 — 옛 구독은 영원히 무음이 되므로 다시 연다.
                self._codes = codes
                await self._stop_locked()
                self._ticks.clear()
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(self._loop())

    async def aclose(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _loop(self) -> None:
        attempt = 0
        while time.monotonic() - self._last_request < _IDLE_STOP_S:
            try:
                await self._session()
                attempt = 0  # 정상 종료(유휴)면 백오프를 리셋한다
            except asyncio.CancelledError:
                raise
            except KisFuturesWsUnavailable as e:
                self._unavailable = str(e)
                log.warning("야간 WS 사용 불가: %s", e)
                return  # 자격 문제는 재시도해도 같다
            except Exception as e:  # noqa: BLE001 — 전송 계층 실패는 재연결로 흡수한다
                wait = _RECONNECT_BACKOFF_S[min(attempt, len(_RECONNECT_BACKOFF_S) - 1)]
                attempt += 1
                log.warning("야간 WS 재연결 %.0fs 후: %s", wait, e)
                await asyncio.sleep(wait)

    async def _session(self) -> None:
        import websockets  # noqa: PLC0415 — 지연 import(야간에만 필요)

        key = await asyncio.to_thread(fetch_approval_key)
        async with websockets.connect(_WS_URL, ping_interval=None, max_size=None) as ws:
            for code in self._codes:
                await ws.send(
                    json.dumps(
                        {
                            "header": {
                                "approval_key": key,
                                "custtype": "P",
                                "tr_type": "1",
                                "content-type": "utf-8",
                            },
                            "body": {"input": {"tr_id": _TR_ID, "tr_key": code}},
                        }
                    )
                )
            self._unavailable = None
            log.info("야간 WS 구독 %d종목: %s", len(self._codes), ",".join(self._codes))

            while time.monotonic() - self._last_request < _IDLE_STOP_S:
                # 무음이 정상인 표면이라 recv 타임아웃을 죽음으로 보면 안 된다 —
                # 벤더 PINGPONG 이 오지 않을 때만 죽은 소켓으로 판정한다.
                raw = await asyncio.wait_for(ws.recv(), timeout=_RECV_IDLE_TIMEOUT_S)
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", "replace")
                if raw.startswith("{"):
                    msg = json.loads(raw)
                    if msg.get("header", {}).get("tr_id") == "PINGPONG":
                        await ws.send(raw)
                    continue
                self._ingest(raw)

    def _ingest(self, raw: str) -> None:
        parts = raw.split("|")
        if len(parts) < _FRAME_PARTS or parts[1] != _TR_ID:
            return
        # 한 프레임에 여러 건이 올 수 있다(parts[2] = 건수). 마지막 건이 최신이다.
        fields = parts[3].split("^")
        stride = len(_COLUMNS)
        for start in range(0, len(fields) - stride + 1, stride):
            row = dict(zip(_COLUMNS, fields[start : start + stride], strict=False))
            price = _f(row, "futs_prpr")
            code = row.get("futs_shrn_iscd", "")
            if not code or price is None or price <= 0:
                continue
            self._ticks[code] = NightTick(
                code=code,
                price=price,
                change=_f(row, "futs_prdy_vrss") or 0.0,
                change_rate=_f(row, "futs_prdy_ctrt") or 0.0,
                volume=int(_f(row, "acml_vol") or 0),
                open_interest=int(_f(row, "hts_otst_stpl_qty") or 0),
                oi_change=int(_f(row, "otst_stpl_qty_icdc") or 0),
                market_basis=_f(row, "mrkt_basis"),
                bsop_hour=row.get("bsop_hour", ""),
                t_ms=int(time.time() * 1000),
            )
