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

## 실호출 검증 (2026-08-19)

거래일 16:00–18:00 에 실응답을 받았다(`docs/research/2026-08-19-after-hours-single-
price-fills-and-expected.md`). `ovt_sigpric_*` 5단 키가 실제로 실리고, 빈 단계는
`price=0,qty=0` 으로 파싱된다. 총잔량은 **5단 합과 정확히 일치**했다
(953 = 500+38+415) — 5단 위 단계가 없다는 간접 증거다.

## 이 모듈은 TR 을 **둘** 친다

`ka10087`(호가)에 더해 **`ka10001`(예상체결)** 을 같은 TTL 축에서 친다. 예상체결이
ka10087 에 없기 때문이고, 별도 폴링으로 빼지 않는 이유는 **두 값의 시점이 갈리면
안 되기** 때문이다(같은 화면의 사다리와 예상체결이 다른 순간을 가리키게 된다).
실패는 격리된다 — `AfterHoursView` 의 표 참조.

그리고 벤더가 주지 않는 **개별 체결을 합성**한다(`_FillLedger`). 그 판단의 근거는
"안 주는 것을 확인했다" 이다: `ka10003`·`ka10084`·WS `0B` 셋 다 15:59:50 에서 멈춘다.

파싱 규약(키움 REST 공통): 전 필드 String + 부호 prefix. 부호는 등락방향이라 가격은
크기만 취한다(`kiwoom_stock_info._abs_price` · WS `_price` 와 동형).
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import httpx

from . import kiwoom_http
from .kiwoom_token_provider import KiwoomTokenProvider
from .single_flight import SingleFlight

log = logging.getLogger(__name__)

_BASE_REAL = "https://api.kiwoom.com"
_MRKCOND_PATH = "/api/dostk/mrkcond"
_API_ID = "ka10087"
#: 예상체결 전용 — **다른 TR 이고 다른 path 다**(`/stkinfo`). 왜 ka10087 이 아니라
#: 여기서 오는지는 `ExpectedFill` docstring.
_STKINFO_PATH = "/api/dostk/stkinfo"
_EXPECTED_API_ID = "ka10001"

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


@dataclass(frozen=True)
class ExpectedFill:
    """시간외 단일가 예상체결 — 출처는 **ka10001** 이다(ka10087 이 아니다).

    2026-08-19 실측(`docs/research/2026-08-19-after-hours-single-price-fills-and-
    expected.md`): 이 구간에 예상체결을 주는 소스는 ka10001 하나다. 같은 이름 필드를
    가진 `ka10007`·`ka10095` 는 **정규장 잔상**이고, WS `0H` 는 **오지 않는다**
    (구독 중·체결 3주기·버퍼 0건). 즉 **필드명은 계약이 아니고 TR 이 계약**이다.

    값의 성격: 주기 안에서 단조 증가하다 체결 직후 리셋되고, 예상량이 실제 체결량을
    맞춘다(3,478 → 실제 3,484). ⚠ 다만 **체결 직전 30초에는 요동친다**(006360 최종
    표본 400 vs 실제 899) — 확정이 아니라 접수 상황의 스냅샷이라, 화면은 "예상" 이라고
    말해야 한다.
    """

    price: int
    qty: int


@dataclass(frozen=True)
class AfterHoursFill:
    """시간외 단일가 체결 한 건 — **벤더가 준 것이 아니라 우리가 만든 것**이다.

    개별 체결 내역을 주는 소스가 없다(2026-08-19 실측: `ka10003`·`ka10084`·WS `0B`
    셋 다 15:59:50 에서 멈춘다). 체결은 일어나는데(Δ3,484주) 노출되지 않으므로,
    ka10087 의 누적 체결량이 뛰는 것을 보고 역산한다.

    그래서 두 가지가 **원리적으로 부정확**하고, 소비자는 그것을 알고 써야 한다:

    - **`t_ms` 는 관측 시각이지 체결 시각이 아니다.** 체결은 10분 경계(16:30:00)에
      일어나고 우리는 폴링 주기만큼 늦게 본다(실측 27초). 벤더가 체결 시각을 어느
      필드로도 주지 않아 좁힐 방법이 없다 — **정렬용으로만 쓸 것**.
    - **`side` 가 없다.** 단일가 매매는 한 가격에 일괄 체결이라 매수/매도 방향이라는
      개념 자체가 성립하지 않는다. 중립으로 그린다.
    """

    #: 관측 시각(체결 시각 아님 — 위 docstring). 정렬 전용.
    t_ms: int
    price: int
    qty: int


#: 시간외 단일가 체결 주기(10분). **갭 판정의 단위**다 — `_FillLedger` 참조.
#: epoch 를 이 값으로 나눈 몫이 곧 주기 번호다(KST 오프셋 9시간이 10분의 배수라
#: 시간대 변환 없이 슬롯 경계가 일치한다).
_CYCLE_MS = 600_000


@dataclass(frozen=True)
class AfterHoursView:
    """라우트가 소비하는 한 벌. **출처가 셋이고 성격이 다 달라** 타입에서 갈라 둔다.

    | 필드 | 출처 | 실패하면 |
    |---|---|---|
    | `book` | 벤더 `ka10087` | 이 구간의 유일한 호가 소스 — **없으면 화면이 없다** |
    | `expected` | 벤더 `ka10001` | 부가 정보 — None 이 되고 사다리는 그대로 산다 |
    | `fills` | **우리가 합성** | 벤더 미제공. 관측이 없으면 빈다(거짓 행을 만들지 않는다) |

    이 표가 곧 실패 격리 규칙이다: ka10001 이 죽어도 ka10087 이 살아 있으면 응답한다.
    예상체결은 **있으면 좋은 것**이지, 호가창을 끌어내릴 근거가 아니다.
    """

    book: AfterHoursBook
    expected: ExpectedFill | None
    fills: tuple[AfterHoursFill, ...]
    fetched_at_ms: int


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


def parse_ka10001_expected(body: dict) -> ExpectedFill | None:
    """ka10001 응답 → 예상체결. 가격·수량 중 하나라도 0이면 None.

    ka10001 은 이 두 필드를 **날짜 단위 상수**(상하한가·250일 최고/최저)와 **한
    응답에 섞어서** 준다. 그래서 `kiwoom_stock_info` 의 파서를 재사용하지 않는다 —
    저쪽은 KST 날짜로 캐시하는 것이 옳고, 여기는 초 단위 변동값이라 그 캐시에 얹으면
    하루 종일 첫 값이 고정된다. **우리가 방금 ka10007 에서 판별해 낸 잔상 버그를 우리
    손으로 재생산하는 셈**이라, 같은 TR 이어도 캐시 축이 다르면 경로를 나눈다.

    부호는 **당일 종가 대비 방향**이라 크기만 취한다(실측: 종가 34,950 과 같을 때
    `"34950"`, 35,000 일 때 `"+35000"`). 부호 없는 변종이 실제로 오므로 `_abs_int`
    의 `lstrip("+-")` 가 load-bearing 하다 — 픽스처가 그 케이스를 고정한다.
    """
    price = _abs_int(body.get("exp_cntr_pric"))
    qty = _abs_int(body.get("exp_cntr_qty"))
    if price <= 0 or qty <= 0:
        return None
    return ExpectedFill(price=price, qty=qty)


def _kst_day(t_ms: int) -> int:
    """epoch ms → KST 날짜 일련번호. 장 경계가 아니라 **원장 리셋** 판정용이다."""
    return (t_ms + 9 * 3_600_000) // 86_400_000


class _FillLedger:
    """종목별 합성 체결 원장 — **언제 행을 만들지 않는가가 전부**인 클래스.

    누적 체결량이 늘면 그 증가분을 한 행으로 만든다. 그런데 증가분을 **무조건** 행으로
    바꾸면 관측 공백이 곧바로 위조가 된다: 16:05 에 보다가(누적 1,590) 다른 종목으로
    옮기고 16:45 에 돌아오면(누적 7,228), 순진한 델타는 **5,638주 @ 16:45 가격** 한
    줄을 만든다. 그 물량은 네 주기에 걸쳐 서로 다른 가격에 체결된 것이라 **어느 주기의
    사실도 아니다**.

    그래서 행을 만드는 조건이 둘이다:

    1. **직전 관측과 지금이 10분 경계를 최대 하나만 사이에 둔다.** 정상 폴링(3초 TTL)
       이면 항상 0 또는 1 이고, 공백이 있었다면 2 이상이라 걸러진다.
    2. 누적이 **늘었다**. 줄었으면(날짜 전환·벤더 리셋) 값을 다시 잡는다.

    조건을 못 채우면 **조용히 기준만 다시 잡는다**(re-baseline). 첫 관측도 같다 —
    그때까지의 누적은 여러 주기의 합이라 한 줄로 만들 수 없다. 화면이 한 주기 동안
    비는 대신 거짓 행이 뜨지 않는다.

    ⚠ **아무도 그 종목을 보지 않는 주기는 원리적으로 못 잡는다.** 이 원장은 폴링이
    있을 때만 채워지고, 서버가 재시작하면 사라진다. 벤더가 개별 체결을 주지 않는 이상
    피할 수 없는 한계라, 소비자에게 "완전한 체결 목록"으로 제시하면 안 된다.
    """

    #: 종목당 보관 상한. 16:00–18:00 을 10분으로 나누면 12주기라 그 이상은 나올 수 없다.
    #: 상한을 두는 것은 이론상 초과분이 아니라 **관측 이상(벤더 누적이 요동치는 경우)**
    #: 에 메모리가 무한히 자라지 않게 하기 위해서다.
    _MAX_ROWS = 16

    def __init__(self) -> None:
        # code → (kst_day, last_t_ms, last_acc_volume)
        self._mark: dict[str, tuple[int, int, int]] = {}
        self._rows: dict[str, list[AfterHoursFill]] = {}

    def observe(self, code: str, *, t_ms: int, acc_volume: int, price: int | None) -> None:
        """관측 1건 반영. 위 두 조건을 만족할 때만 행이 는다."""
        day = _kst_day(t_ms)
        prev = self._mark.get(code)
        self._mark[code] = (day, t_ms, acc_volume)

        if prev is None:
            return  # 첫 관측 = 기준선. 그때까지의 누적은 여러 주기의 합이라 행이 못 된다.
        prev_day, prev_t_ms, prev_acc = prev
        if prev_day != day:
            self._rows.pop(code, None)  # 날짜가 바뀌면 어제 행은 오늘 것이 아니다
            return
        delta = acc_volume - prev_acc
        if delta <= 0:
            return  # 증가가 없거나 벤더가 되감았다 — 기준만 새로 잡힌다
        if t_ms // _CYCLE_MS - prev_t_ms // _CYCLE_MS > 1:
            return  # 관측 공백. 이 델타는 여러 주기의 합이라 한 줄로 만들 수 없다
        if price is None or price <= 0:
            return  # 가격을 모르면 행의 절반이 비어 표시할 수 없다
        rows = self._rows.setdefault(code, [])
        rows.append(AfterHoursFill(t_ms=t_ms, price=price, qty=delta))
        if len(rows) > self._MAX_ROWS:
            del rows[: len(rows) - self._MAX_ROWS]

    def rows(self, code: str, *, t_ms: int) -> tuple[AfterHoursFill, ...]:
        """**최신이 먼저**. 오늘 것이 아니면 빈 튜플(자정을 넘겨 열어 둔 탭 방어)."""
        mark = self._mark.get(code)
        if mark is None or mark[0] != _kst_day(t_ms):
            return ()
        return tuple(reversed(self._rows.get(code, [])))


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
        self._client = httpx.Client(
            base_url=base_url,
            # 주입이 이긴다(테스트 MockTransport). 기본은 연결 재사용 + 연결 단계
            # 재시도 — 근거·함정은 `kiwoom_http` 도크스트링.
            transport=_transport or kiwoom_http.sync_transport(),
            timeout=10.0,
        )
        self._ttl_ms = ttl_ms
        # code → (fetched_at_ms, book, expected)
        self._cache: dict[str, tuple[int, AfterHoursBook, ExpectedFill | None]] = {}
        self._flight = SingleFlight()
        self._ledger = _FillLedger()

    def close(self) -> None:
        self._client.close()

    async def get(self, code: str) -> AfterHoursView:
        now_ms = int(time.time() * 1000)
        hit = self._cache.get(code)
        if hit is not None and now_ms - hit[0] < self._ttl_ms:
            return self._view(code, hit)
        async with self._flight.acquire(code):
            hit = self._cache.get(code)  # 대기 중 선행자가 채웠으면 재사용
            now_ms = int(time.time() * 1000)
            if hit is not None and now_ms - hit[0] < self._ttl_ms:
                return self._view(code, hit)
            book, expected = await asyncio.to_thread(self._fetch_sync, code)
            fetched_at_ms = int(time.time() * 1000)
            self._cache[code] = (fetched_at_ms, book, expected)
            # **실제 벤더 호출에서만** 원장을 갱신한다 — 캐시 히트는 새 관측이 아니다.
            # 히트에도 세면 관측 시각만 앞당겨져 `_FillLedger` 의 갭 판정이 무뎌진다.
            self._ledger.observe(
                code, t_ms=fetched_at_ms, acc_volume=book.acc_volume, price=book.cur_price
            )
            return self._view(code, self._cache[code])

    def _view(
        self, code: str, entry: tuple[int, AfterHoursBook, ExpectedFill | None]
    ) -> AfterHoursView:
        fetched_at_ms, book, expected = entry
        return AfterHoursView(
            book=book,
            expected=expected,
            fills=self._ledger.rows(code, t_ms=fetched_at_ms),
            fetched_at_ms=fetched_at_ms,
        )

    def _fetch_sync(self, code: str) -> tuple[AfterHoursBook, ExpectedFill | None]:
        token = self._provider.get_token()
        book = parse_ka10087(code, self._post(code, _API_ID, token))
        return book, self._fetch_expected(code, token)

    def _fetch_expected(self, code: str, token: str) -> ExpectedFill | None:
        """ka10001 예상체결. **실패를 삼킨다** — 이유는 `AfterHoursView` 의 표.

        이 값이 없어서 사다리까지 못 그리는 것은 손익이 맞지 않는다: 이 구간에
        ka10087 은 **유일한** 호가 소스이고 예상체결은 그 위의 부가 정보다. 그래서
        여기서만 `except` 가 넓고, ka10087 쪽은 종전대로 예외가 라우트까지 올라간다.
        """
        try:
            return parse_ka10001_expected(self._post(code, _EXPECTED_API_ID, token))
        except (KiwoomAfterHoursError, httpx.HTTPError, ValueError):
            log.warning("ka10001 expected-fill fetch failed code=%s", code, exc_info=True)
            return None

    def _post(self, code: str, api_id: str, token: str) -> dict:
        resp = self._client.post(
            _MRKCOND_PATH if api_id == _API_ID else _STKINFO_PATH,
            json={"stk_cd": code},
            headers={
                "Content-Type": "application/json;charset=UTF-8",
                "authorization": f"Bearer {token}",
                "api-id": api_id,
            },
        )
        if resp.status_code != 200:  # noqa: PLR2004
            raise KiwoomAfterHoursError(f"{api_id} HTTP {resp.status_code} {resp.text[:200]}")
        body = resp.json()
        if body.get("return_code") != 0:
            raise KiwoomAfterHoursError(
                f"{api_id} return_code={body.get('return_code')} {body.get('return_msg')}"
            )
        return body
