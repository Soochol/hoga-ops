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
import datetime as dt
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

#: 야간 스파크라인 봉 간격(분). 주간 REST 분봉과 같은 5분이라 두 모양이 같은 축으로 읽힌다.
#: 18:00–05:00 = 660분이므로 최대 132봉 — 스파크라인 폭(110px)에 충분히 들어간다.
NIGHT_BUCKET_MIN = 5

#: 야간 세션 시작(분). 버킷 키의 원점이다 — 아래 `_bucket_of` 참조.
_NIGHT_START_MIN = 18 * 60
_DAY_MIN = 24 * 60
#: `bsop_hour` 에서 실제로 읽는 앞자리 수(HHMM). 뒤 초 단위는 버킷에 무관하다.
_HHMM_LEN = 4

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


@dataclass(frozen=True)
class NightCoverage:
    """야간 봉을 **어느 구간에서 관측했는지**. 봉 유무와 별개다.

    **왜 봉 간격으로 갭을 못 세는가** — 거래가 없는 5분 구간에는 애초에 봉이 없다
    (VKOSPI 는 주간에도 하루 2봉이다). 봉 간격을 갭으로 읽으면 저유동성 종목은
    대부분이 "누락" 으로 찍히고 그 경고는 즉시 무의미해진다.

    구분 가능한 것은 **WS 가 연결돼 있었는가** 다. 연결 중인데 봉이 없으면 거래가
    없었던 것(정상)이고, 연결이 없던 구간이 진짜 누락이다. 재시작·유휴 정지가 여기
    드러난다 — 스파크라인엔 축이 없어서 짧아진 선을 화면만 보고는 구별할 수 없다.
    """
    #: 관측을 시작한 버킷. 0 이면 야간 개장(18:00)부터 온전히 봤다는 뜻이다.
    first_bucket: int
    last_bucket: int
    #: 관측한 버킷 수(구간 길이의 합). 실제 봉 수보다 크거나 같다.
    observed_buckets: int
    #: 관측이 끊긴 횟수. 재시작·유휴 정지마다 1 늘어난다.
    gap_count: int

    @property
    def first_hhmm(self) -> str:
        """관측 시작 시각 `HHMM`. 버킷 원점이 18:00 이라 되돌릴 때 자정을 감아야 한다."""
        minute = (_NIGHT_START_MIN + self.first_bucket * NIGHT_BUCKET_MIN) % _DAY_MIN
        return f"{minute // 60:02d}{minute % 60:02d}"


def _merge_ranges(ranges: list[list[int]]) -> list[tuple[int, int]]:
    """[start, end] 목록을 정렬·병합. 재연결이 잦으면 인접 구간이 쪼개져 들어온다."""
    out: list[tuple[int, int]] = []
    for start, end in sorted((r[0], r[1]) for r in ranges):
        if out and start <= out[-1][1] + 1:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out


def _bucket_of(bsop_hour: str) -> int | None:
    """벤더 시각 `HHMMSS` → **야간 세션 시작(18:00) 기준** 버킷 인덱스.

    **자정을 넘기 때문에 시계 그대로 정렬하면 안 된다.** 18:00 은 `180000`, 02:00 은
    `020000` 이라 문자열로도 분(minute)으로도 새벽이 저녁보다 **앞**에 온다. 그대로
    쓰면 스파크라인이 좌우 반전되는데, 우상향이 우하향으로 보일 뿐 **에러가 아니라서**
    눈으로만 잡힌다. 그래서 원점을 18:00 으로 옮겨 단조 증가하게 만든다.

        18:00 → 0 · 23:50 → 70 · 02:00 → 96 · 04:59 → 131   (5분 버킷)
    """
    if len(bsop_hour) < _HHMM_LEN or not bsop_hour[:_HHMM_LEN].isdigit():
        return None
    minute = int(bsop_hour[:2]) * 60 + int(bsop_hour[2:4])
    return ((minute - _NIGHT_START_MIN) % _DAY_MIN) // NIGHT_BUCKET_MIN


def _now_bucket() -> int:
    """현재 KST 시각의 버킷. 관측 구간을 늘릴 때 쓴다(틱 시각이 아니라 **벽시계**다 —
    무음이어도 관측은 진행되기 때문이다)."""
    from hoga.util.timeenc import KST  # noqa: PLC0415 — 순환 import 회피

    now = dt.datetime.now(KST)
    minute = now.hour * 60 + now.minute
    return ((minute - _NIGHT_START_MIN) % _DAY_MIN) // NIGHT_BUCKET_MIN


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
        #: 종목 → {버킷 인덱스: 그 버킷의 마지막 체결가}. dict 라 같은 버킷에 여러 틱이
        #: 와도 마지막이 이긴다(= 봉의 종가). 최대 132봉 × 3종목이라 메모리는 무시할 수준.
        self._bars: dict[str, dict[int, float]] = {}
        #: 이 버킷들이 속한 야간 세션의 기준 거래일. 바뀌면 통째로 비운다 —
        #: 안 그러면 어제 저녁 봉과 오늘 저녁 봉이 같은 선에 이어 붙는다.
        self._session_day: str | None = None
        #: 관측 구간 `[[시작 버킷, 끝 버킷], …]`. **종목별이 아니라 세션 공통**이다 —
        #: 한 소켓으로 전 종목을 구독하므로 연결 여부는 종목과 무관하다.
        self._observed: list[list[int]] = []
        self._codes: tuple[str, ...] = ()
        self._last_request = 0.0
        self._unavailable: str | None = None

    @property
    def unavailable(self) -> str | None:
        return self._unavailable

    def latest(self, code: str) -> NightTick | None:
        return self._ticks.get(code)

    def night_series(self, code: str) -> tuple[float, ...]:
        """이 종목의 야간 5분봉 종가 — **시간순**. 틱이 없었으면 빈 튜플.

        키가 18:00 원점이라 정수 정렬이 곧 시간순이다(`_bucket_of` 참조).
        """
        bars = self._bars.get(code)
        if not bars:
            return ()
        return tuple(bars[k] for k in sorted(bars))

    def night_coverage(self) -> NightCoverage | None:
        """관측 구간 요약. 아직 아무것도 못 봤으면 None.

        종목 인자가 없는 것이 의도다 — 연결은 소켓 단위라 전 종목이 같은 구간을 공유한다.
        """
        merged = _merge_ranges(self._observed)
        if not merged:
            return None
        return NightCoverage(
            first_bucket=merged[0][0],
            last_bucket=merged[-1][1],
            observed_buckets=sum(end - start + 1 for start, end in merged),
            gap_count=len(merged) - 1,
        )

    def _mark_observed(self) -> None:
        """지금 이 순간을 관측한 것으로 기록한다.

        **틱 시각이 아니라 벽시계로 늘린다** — 무음이어도 연결돼 있으면 관측은 진행된
        것이고, 그게 "거래 없음" 과 "우리가 못 봄" 을 가르는 유일한 근거다.
        """
        b = _now_bucket()
        if self._observed and b >= self._observed[-1][1]:
            self._observed[-1][1] = b
        else:
            # 새 연결이거나 세션이 감긴 뒤 — 새 구간을 시작한다.
            self._observed.append([b, b])

    async def ensure_running(self, codes: tuple[str, ...], *, session_day: str) -> None:
        """세션이 돌고 있게 만든다.

        구독 종목이 바뀌면(롤오버) 재연결하고, 야간 세션이 바뀌면 봉을 비운다.
        """
        self._last_request = time.monotonic()
        async with self._lock:
            if self._session_day != session_day:
                # 새 야간 세션 — 어제 봉을 이어 붙이면 자정에 없던 갭이 생긴다.
                self._session_day = session_day
                self._bars.clear()
                self._ticks.clear()
                self._observed.clear()
            if self._codes != codes:
                # 롤오버로 근월물이 바뀌었다 — 옛 구독은 영원히 무음이 되므로 다시 연다.
                self._codes = codes
                await self._stop_locked()
                self._ticks.clear()
                self._bars.clear()
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
            # 구독이 끝난 순간부터 관측이 시작된다 — 새 구간을 여는 지점이다.
            self._observed.append([_now_bucket()] * 2)
            log.info("야간 WS 구독 %d종목: %s", len(self._codes), ",".join(self._codes))

            while time.monotonic() - self._last_request < _IDLE_STOP_S:
                # 무음이 정상인 표면이라 recv 타임아웃을 죽음으로 보면 안 된다 —
                # 벤더 PINGPONG 이 오지 않을 때만 죽은 소켓으로 판정한다.
                raw = await asyncio.wait_for(ws.recv(), timeout=_RECV_IDLE_TIMEOUT_S)
                self._mark_observed()
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
            bsop_hour = row.get("bsop_hour", "")
            self._ticks[code] = NightTick(
                code=code,
                price=price,
                change=_f(row, "futs_prdy_vrss") or 0.0,
                change_rate=_f(row, "futs_prdy_ctrt") or 0.0,
                volume=int(_f(row, "acml_vol") or 0),
                open_interest=int(_f(row, "hts_otst_stpl_qty") or 0),
                oi_change=int(_f(row, "otst_stpl_qty_icdc") or 0),
                market_basis=_f(row, "mrkt_basis"),
                bsop_hour=bsop_hour,
                t_ms=int(time.time() * 1000),
            )
            # 스파크라인용 5분 버킷. **벤더 시각으로 담는다** — 수신 시각을 쓰면
            # 재연결 직후 몰려 들어오는 밀린 틱이 전부 같은 버킷에 뭉친다.
            bucket = _bucket_of(bsop_hour)
            if bucket is not None:
                self._bars.setdefault(code, {})[bucket] = price
