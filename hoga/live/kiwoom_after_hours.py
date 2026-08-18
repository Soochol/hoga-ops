"""키움 ka10087 시간외단일가 fetcher — 16:00~18:00 구간의 **유일한** 호가 소스.

## 왜 REST 인가 — WS 로는 이 구간에 아무것도 오지 않는다

실측(2026-08-14, 표시 링 버퍼 GET ×4 — `docs/research/2026-08-14-kiwoom-after-hours-
orderbook-sources.md`): KRX-only 종목은 `0D`(호가)가 15:30:2x 에, `0B`(체결)가 15:59:5x 에
끊긴다. 16:00 이후 현재 구독(`0B`/`0D`/`0E`/`0F`/`0w`)으로 들어오는 신호는 **0개**다.
시간외 전용 WS 타입 `0E` 는 총잔량 두 개뿐이라 사다리를 못 채운다.

## 5단이 상한이다 — 10단은 원리적으로 불가능

`ovt_sigpric_{sel,buy}_bid_[1-5]` 로 **5차선까지만** 온다. 그래서 10호가 창은 이 구간에
중앙 쪽 5행만 차고 바깥 5행은 빈다(사용자 결정 2026-08-14). 빈 행은 "데이터 결손"이
아니라 **그 시장에 존재하지 않는 단계**다 — 소비자는 라벨로 그 사실을 말해야 한다.

## ⚠ 총잔량 필드가 **세 쌍**이다 — 고르는 것을 틀리면 조용히 어긋난다

    ovt_sigpric_sel_bid_tot_req / ovt_sigpric_buy_bid_tot_req   ← 시간외 **단일가** (이걸 쓴다)
    sel_bid_tot_req             / buy_bid_tot_req               ← 정규장 총잔량
    ovt_sel_bid_tot_req         / ovt_buy_bid_tot_req           ← 시간외(종가매매) 총잔량

셋 다 같은 응답에 실려 오고 이름이 접두만 다르다. 공식 Response Example 에는 **가운데
쌍만** 찍혀 있어(`sel_bid_tot_req: "24028"`) 예제를 보고 짜면 정규장 값을 시간외로
표시하게 된다. 파서는 예제가 아니라 **필드표**를 따른다(ka10001 모듈이 세운 규율과 동일).

## 실호출 미검증

2026-08-14 시점에 디스크 토큰 캐시가 전부 만료(최신 8/5)였고, 새로 발급하면 사용자
dev 서버의 토큰이 죽는다(#1088 — 벤더가 이전 토큰을 무효화한다). 그래서 이 모듈은
**필드표 기준이며 실응답으로 검증되지 않았다**. ka10001 이 docstring 에 "실호출 검증
(2026-07-21)" 을 박아 둔 것과 대비되는 상태다.

첫 실행 시 확인할 것: 응답에 `ovt_sigpric_*` 5단 키가 실제로 실리는가(위 Example 에는
없다 — 장외 시각에 뜬 샘플로 보이나 확증 없음), 빈 단계가 `"0"` 인가 `"-0"` 인가.

파싱 규약(키움 REST 공통): 전 필드 String + 부호 prefix. 부호는 등락방향이라 가격은
크기만 취한다(`kiwoom_stock_info._abs_price` · WS `_price` 와 동형).
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import httpx

from .kiwoom_token_provider import KiwoomTokenProvider
from .single_flight import SingleFlight

log = logging.getLogger(__name__)

_BASE_REAL = "https://api.kiwoom.com"
_MRKCOND_PATH = "/api/dostk/mrkcond"
_API_ID = "ka10087"

#: 벤더가 주는 호가 단계 수. 10 이 아니다 — 모듈 docstring 참조.
LEVELS = 5

#: 캐시 TTL. ka10001(날짜 단위)과 달리 **변동값**이라 짧게 잡는다. 시간외 단일가는
#: 10분 주기로 체결되지만 호가 자체는 계속 접수되므로 초 단위 신선도가 의미 있다.
#: single-flight 와 함께라 동시 요청 N 개가 콜 1개로 접힌다.
_TTL_MS = 3_000


class KiwoomAfterHoursError(RuntimeError):
    """ka10087 호출/응답 실패 (HTTP 오류 또는 return_code != 0)."""


@dataclass(frozen=True)
class AfterHoursLevel:
    """시간외 단일가 호가 한 단계. 빈 단계는 price=0, qty=0."""

    price: int
    qty: int


@dataclass(frozen=True)
class AfterHoursBook:
    """ka10087 중 10호가 창이 소비하는 부분집합.

    `ask`/`bid` 는 **항상 길이 5**다 — 벤더가 덜 주면 빈 단계로 채운다. 소비자가
    길이를 분기하지 않아도 되게(0D 파서가 10단을 항상 채우는 것과 같은 규약).
    index 0 이 최우선호가다(`ovt_sigpric_sel_bid_1` = 매도 최우선).
    """

    code: str
    #: 호가잔량기준시간 HHMMSS. 벤더가 안 주면 None.
    base_tm: str | None
    ask: tuple[AfterHoursLevel, ...]
    bid: tuple[AfterHoursLevel, ...]
    #: 시간외 **단일가** 총잔량 — 위 docstring 의 세 쌍 중 첫 번째.
    total_ask_qty: int
    total_bid_qty: int
    cur_price: int | None
    change_pct: float | None
    acc_volume: int
    #: 당일 **종가**(전일종가가 아니다). 이 구간 등락률의 분모다 — `_close_price` 주석.
    close_price: int | None

    @property
    def has_quotes(self) -> bool:
        """호가가 한 단계라도 있는가. 창 밖·미거래 종목은 전 단계가 0 으로 온다.

        소비자(라우트)가 "벤더는 답했지만 볼 것이 없다" 를 구분하는 술어다 — 빈
        호가창을 그리는 대신 정규장 스냅샷을 유지하도록.
        """
        return any(lv.qty > 0 for lv in (*self.ask, *self.bid))


_EMPTY_LEVEL = AfterHoursLevel(price=0, qty=0)


def _abs_int(raw: object) -> int:
    """부호 prefix 숫자 문자열 → 양수 int. 빈 값·비숫자는 0.

    `"-0"`(빈 단계의 관용 표기 — 0D 애프터마켓 실측에서 확인된 형태)도 0 이 된다.
    """
    if not isinstance(raw, str):
        return 0
    s = raw.strip().lstrip("+-")
    return int(s) if s.isdigit() else 0


def _opt_price(raw: object) -> int | None:
    v = _abs_int(raw)
    return v if v > 0 else None


def _signed_int(raw: object) -> int | None:
    """부호를 **유지하는** 정수 파서. 빈 값·비숫자는 None.

    `_abs_int` 와 갈라지는 이유는 같은 응답 안에 부호 규칙이 **둘** 이기 때문이다:
    `ovt_sigpric_cur_prc` 의 부호는 등락 **방향 표시**라 절댓값이 가격이고,
    `ovt_sigpric_pred_pre` 의 부호는 **값의 일부**다. 둘을 같은 파서로 읽으면
    종가 역산이 조용히 틀린다(`-47700 − (−200)` = −47,500 같은 값이 나온다).
    """
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    neg = s.startswith("-")
    digits = s.lstrip("+-")
    if not digits.isdigit():
        return None
    v = int(digits)
    return -v if neg else v


def _close_price(body: dict) -> int | None:
    """당일 **종가** 역산 — `|현재가| − 종가대비`. 둘 중 하나라도 없으면 None.

    ⚠ **필드명이 거짓말을 한다.** `ovt_sigpric_pred_pre` 는 이름이 "전일대비" 인데
    시간외 단일가 맥락에서는 **당일 종가 대비**다. 실측(2026-08-18 16:20, 028050):

        ovt_sigpric_cur_prc   -47700   → 가격 47,700 (부호는 방향)
        ovt_sigpric_pred_pre    -200
        ovt_sigpric_flu_rt     -0.42
        전일 종가              49,800   (ka10007 `flu_rt` -3.82 의 분모)
        당일 종가              47,900   ← 47,700 − (−200)

    −200/47,900 = −0.42% 로 벤더 `flu_rt` 와 일치한다. 전일종가(49,800)로 읽으면
    같은 −200 이 −0.40% 가 아니라 등락률 자체가 −3.8% 대여야 하므로, 이 구간의
    분모가 **종가**라는 것이 값으로 증명된다.

    왜 역산인가: 응답에 종가 필드가 따로 없다. 별도 TR(ka10007 `cur_prc`)로도 얻을
    수 있지만 콜이 하나 늘고 두 응답의 시점이 갈린다 — 같은 응답 안에서 닫는 것이
    싸고 일관된다.
    """
    cur = _opt_price(body.get("ovt_sigpric_cur_prc"))
    delta = _signed_int(body.get("ovt_sigpric_pred_pre"))
    if cur is None or delta is None:
        return None
    close = cur - delta
    return close if close > 0 else None


def _opt_rate(raw: object) -> float | None:
    """등락률 문자열 → float. 부호가 **유의미**해서 abs 를 취하지 않는다.

    벤더가 이미 소수 2자리로 반올림해 보낸 값을 그대로 쓴다 — 0B FID 12 는 우리가
    10/11 에서 직접 계산했지만(정밀도 통제) 여기는 원자료(전일종가)가 응답에 없어
    재계산 경로가 없다. 출처가 벤더라는 사실만 명시한다.
    """
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _levels(body: dict, prefix: str) -> tuple[AfterHoursLevel, ...]:
    """`ovt_sigpric_{sel,buy}_bid_N` + `_qty_N` 5쌍 → 고정 길이 5 배열.

    `_jub_pre_N`(직전대비)은 **싣지 않는다** — 소비처가 없다. 0E 에서 132/136 을
    뺀 것과 같은 규율(소비처 없는 필드는 부채).
    """
    out: list[AfterHoursLevel] = []
    for i in range(1, LEVELS + 1):
        price = _abs_int(body.get(f"ovt_sigpric_{prefix}_bid_{i}"))
        qty = _abs_int(body.get(f"ovt_sigpric_{prefix}_bid_qty_{i}"))
        out.append(AfterHoursLevel(price=price, qty=qty) if price or qty else _EMPTY_LEVEL)
    return tuple(out)


def parse_ka10087(code: str, body: dict) -> AfterHoursBook:
    """ka10087 응답 body → AfterHoursBook. **필드표 기준**(예제 아님 — 모듈 docstring)."""
    base_tm = body.get("bid_req_base_tm")
    return AfterHoursBook(
        code=code,
        base_tm=base_tm.strip() if isinstance(base_tm, str) and base_tm.strip() else None,
        ask=_levels(body, "sel"),
        bid=_levels(body, "buy"),
        # ⚠ `sel_bid_tot_req`(정규장)·`ovt_sel_bid_tot_req`(시간외 종가매매)가 아니다.
        total_ask_qty=_abs_int(body.get("ovt_sigpric_sel_bid_tot_req")),
        total_bid_qty=_abs_int(body.get("ovt_sigpric_buy_bid_tot_req")),
        cur_price=_opt_price(body.get("ovt_sigpric_cur_prc")),
        change_pct=_opt_rate(body.get("ovt_sigpric_flu_rt")),
        acc_volume=_abs_int(body.get("ovt_sigpric_acc_trde_qty")),
        close_price=_close_price(body),
    )


class KiwoomAfterHoursFetcher:
    """종목별 AfterHoursBook 의 짧은 TTL 캐시 + single-flight fetcher.

    골격은 `KiwoomStockInfoFetcher`(ka10001) 미러다 — 동기 httpx 를 `to_thread` 로
    돌리고, 실패는 캐시하지 않는다(다음 요청이 재시도). 다른 점은 캐시 축뿐이다:
    저쪽은 KST 날짜(고정값), 이쪽은 초 단위 TTL(변동값).

    **시간 게이트는 여기 없다.** 창 판정은 호출자(라우트)가 `session_gate` 술어로
    하고, 이 클래스는 "물으면 답한다" 만 한다 — 게이트를 fetcher 에 넣으면 테스트가
    시계를 조작해야 하고, 게이트 술어의 SSOT 도 둘로 갈린다.
    """

    def __init__(
        self,
        token_provider: KiwoomTokenProvider,
        *,
        base_url: str = _BASE_REAL,
        ttl_ms: int = _TTL_MS,
        _transport: httpx.BaseTransport | None = None,
    ):
        self._provider = token_provider
        self._client = httpx.Client(base_url=base_url, transport=_transport, timeout=10.0)
        self._ttl_ms = ttl_ms
        # code → (fetched_at_ms, book)
        self._cache: dict[str, tuple[int, AfterHoursBook]] = {}
        self._flight = SingleFlight()

    def close(self) -> None:
        self._client.close()

    async def get(self, code: str) -> tuple[AfterHoursBook, int]:
        now_ms = int(time.time() * 1000)
        hit = self._cache.get(code)
        if hit is not None and now_ms - hit[0] < self._ttl_ms:
            return hit[1], hit[0]
        async with self._flight.acquire(code):
            hit = self._cache.get(code)  # 대기 중 선행자가 채웠으면 재사용
            now_ms = int(time.time() * 1000)
            if hit is not None and now_ms - hit[0] < self._ttl_ms:
                return hit[1], hit[0]
            book = await asyncio.to_thread(self._fetch_sync, code)
            fetched_at_ms = int(time.time() * 1000)
            self._cache[code] = (fetched_at_ms, book)
            return book, fetched_at_ms

    def _fetch_sync(self, code: str) -> AfterHoursBook:
        token = self._provider.get_token()
        resp = self._client.post(
            _MRKCOND_PATH,
            json={"stk_cd": code},
            headers={
                "Content-Type": "application/json;charset=UTF-8",
                "authorization": f"Bearer {token}",
                "api-id": _API_ID,
            },
        )
        if resp.status_code != 200:  # noqa: PLR2004
            raise KiwoomAfterHoursError(
                f"ka10087 HTTP {resp.status_code} {resp.text[:200]}"
            )
        body = resp.json()
        if body.get("return_code") != 0:
            raise KiwoomAfterHoursError(
                f"ka10087 return_code={body.get('return_code')} {body.get('return_msg')}"
            )
        return parse_ka10087(code, body)
