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

**이 모듈은 도메인만 본다.** 소켓 수명·구독·PINGPONG·재연결은 `KisWsClient` 가 지고
(키움이 전송을 `KiwoomWsClient` 로, 수명을 `KiwoomSessionManager` 로 나눈 것과 같은
경계), 여기 남는 것은 프레임 필드 해석 · 틱 캐시 · 5분 버킷 · 관측 구간이다.
승인키는 `KisApprovalProvider` 가 캐시·쿨다운·실패 분류를 맡는다.
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

from hoga.live.kis_approval_provider import KisApprovalProvider
from hoga.live.kis_ws_client import KisWsClient

log = logging.getLogger(__name__)

_TR_ID = "H0MFCNT0"

#: 마지막 요청 후 이만큼 조용하면 세션을 닫는다 — 아무도 안 보는 야간에 WS 슬롯을
#: 쥐고 있을 이유가 없다(옵션 심리 런타임과 같은 판단). 전송 계층은 취소될 때까지
#: 도는 것만 알고, **유휴 판단은 이 층이 한다**(키움 SessionManager 와 같은 분담).
_IDLE_STOP_S = 600.0

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


class KisFuturesNightWs:
    """야간 선물 도메인 — 틱 캐시 · 5분 버킷 · 관측 구간.

    `ensure_running(codes, session_day=…)` 이 세션을 깨우고 `latest`/`night_series`/
    `night_coverage` 가 읽는다. **전송은 `KisWsClient` 에 위임**하고 이 층은 유휴
    정지·세션 리셋·프레임 해석만 한다(키움에서 `KiwoomSessionManager` 가 맡는 역할).

    프로세스 싱글턴을 전제로 한다 — WS 슬롯을 두 벌 쥐면 벤더가 한쪽을 끊는다.
    """

    def __init__(self, approval_factory: Callable[[], KisApprovalProvider | None]) -> None:
        # 팩토리로 받는 이유: 무자격 환경에서 provider(=httpx 클라이언트)를 만들지
        # 않고, .env 가 나중에 채워지면 다음 요청에서 정상 기동한다.
        self._approval_factory = approval_factory
        self._client: KisWsClient | None = None
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

    # ── 관측성 (전송 계층 것을 그대로 노출 — ADR-0116 규율 3) ──

    @property
    def unavailable(self) -> str | None:
        """영구 휴면 사유. 전송 계층이 세운 것을 우선한다(자격증명 부재 등)."""
        if self._client is not None and self._client.unavailable:
            return self._client.unavailable
        return self._unavailable

    @property
    def connected(self) -> bool:
        return self._client is not None and self._client.connected

    @property
    def last_tick_ms(self) -> int | None:
        return self._client.last_tick_ms if self._client else None

    @property
    def last_recv_ms(self) -> int | None:
        return self._client.last_recv_ms if self._client else None

    @property
    def sub_expected(self) -> int:
        return self._client.sub_expected if self._client else 0

    @property
    def sub_acked(self) -> int:
        return self._client.sub_acked if self._client else 0

    def sub_missing(self) -> list[str]:
        return self._client.sub_missing() if self._client else list(self._codes)

    # ── 도메인 읽기 ──

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

    # ── 수명 ──

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
        """유휴 정지까지 전송 계층을 돌린다.

        재연결·백오프·실패 분류는 `KisWsClient.run()` 안에 있다 — 이 루프는 **유휴
        판단만** 한다. 무자격이면 전송이 조용히 반환하므로 여기서 루프를 끊는다
        (안 끊으면 30초 폴링마다 헛발질한다).
        """
        approval = self._approval_factory()
        if approval is None:
            self._unavailable = "credentials_missing"
            return
        client = KisWsClient(approval, tr_id=_TR_ID, on_frame=self._on_frame)
        self._client = client
        while time.monotonic() - self._last_request < _IDLE_STOP_S:
            await client.run(self._codes)
            if client.unavailable:
                return  # 재시도해도 같다(자격증명 부재)
            # run() 이 예외 없이 돌아오는 경로는 없지만, 있더라도 뜨거운 루프는 막는다.
            await asyncio.sleep(1.0)

    def _on_frame(self, _tr_id: str, payload: str) -> None:
        """데이터 프레임 1개 — `^` 구분 필드를 도메인 값으로 읽는다.

        한 프레임에 여러 건이 올 수 있다(전송 계층은 봉투만 벗긴다).
        """
        self._mark_observed()
        fields = payload.split("^")
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
