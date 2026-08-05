"""키움 주식 분봉 어댑터 (`ka10080`) — PR-G (#1043), ADR-0136 §3 의 구현.

KIS `FHKST03010230`(inquire-time-dailychartprice) 대체.

## KIS 와 **모양이 다르다** — 이게 이 PR 의 본질이다

KIS 분봉은 **날짜당 1콜**이었다(120행/콜, 시간 앵커 주소). 그래서 소비자가 날짜
N개를 `asyncio.gather` 로 병렬 부채질하는 것이 최적이었다.

키움은 **1콜이 900행 ≈ 2.35 거래일**을 준다. 같은 병렬 팬을 쓰면 이웃 콜끼리
같은 날짜를 중복 수신한다 — 콜당 효율이 그대로 낭비가 된다. 그래서 소비자가
**순차 walk-back** 으로 바뀐다(`live_candle_backfill`).

## 커서 규칙 — 버리는 데이터가 없다

    1. base_dt = 커서 로 1콜 (900행)
    2. 응답의 **최古 날짜**만 앞이 잘렸을 수 있다 → 적재하지 않는다
    3. 나머지 날짜는 **구조적으로 온전** → 적재
    4. 커서 = 그 최古 날짜. 다음 콜에서 온전하게 재수신된다

"반쪽을 버린다" 가 아니라 **"반쪽 날짜를 다음 커서로 쓴다"** 다. #1043 실측:

    base_dt=20260803 → 최古 20260730 이 **139봉** (잘림)
    base_dt=20260730 → 같은 날이 **382봉** (온전)

## 완결성을 **데이터로** 판정하면 안 된다

첫 실험(#1012)은 "그 날의 첫 봉이 개장 시각이면 온전" 으로 판정하려다 실패했다.
실측이 두 반례를 냈다:

  - 첫 봉이 `09:00` 이 아니라 **`09:02`** 인 날이 있다 — 첫 체결이 늦었을 뿐이다
  - 확보한 날들의 봉 수가 **최소 333 / 중앙 382** — **333봉짜리 정상 거래일**이 있다

즉 **"첫 봉 시각" 도 "봉 개수" 도 "잘린 날" 과 "원래 짧은 날" 을 구분하지 못한다.**
데이터 기반 판정을 골랐다면 333봉 정상일을 불완전으로 오판해 무한히 재요청했을
것이다 — 실제로 첫 실험이 그렇게 멈췄다.

**구조적 술어가 답이다**: 한 응답에서 앞이 잘릴 수 있는 것은 최古 날짜 하나뿐이다.
이것은 데이터의 성질이 아니라 **프로토콜의 성질**(900행 고정 페이지가 날짜 경계와
무관하게 끊긴다)이라 반례가 없다.

## 부호 규약이 일봉과 **반대**다

`ka10081`(일봉)은 가격이 무부호인데 `ka10080`(분봉)은 `'-239500'`/`'+210000'` 처럼
등락 방향을 부호로 싣는다(#1043 실측: 900행 중 439행에 부호). 같은 경로
(`/api/dostk/chart`)의 TR 인데도 다르다 — 일봉 어댑터의 규약을 복사하면 안 된다.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from hoga.live.candle_models import LiveCandle
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.kiwoom_venue import VENUE_SUFFIX
from hoga.live.venue import Venue
from hoga.util.timeenc import KST

API_ID = "ka10080"

TIC_SCOPE_1MIN = "1"
# 일봉과 같은 극성 함정을 피하려고 이름을 붙여 둔다: 1=수정주가, 0=원주가.
UPD_ADJUSTED = "1"

# 표시 버킷(ms) → `tic_scope`(분). `kiwoom_index_candles.BUCKET_SECONDS_TO_TIC_SCOPE`
# 와 대칭이지만 **단위가 ms 다** — 프론트 `TIMEFRAME_TO_MS` 가 그대로 넘어오는
# 자리라 초로 바꾸면 경계에서 한 번 더 틀릴 여지만 생긴다.
#
# 8종(1/3/5/10/15/30/45/60) 전부 900행을 준다고 실측했다(#1008, 2026-08-04). 여기
# 담은 6종은 프론트 `TIMEFRAME_LABELS` 와 1:1 이다. 45·60 을 뺀 것은 벤더 제약이
# 아니라 표시 tf 가 없어서다 — **45분을 추가하려면 격자를 먼저 확인할 것.** KST
# 오프셋 32,400,000ms 를 버킷으로 나눈 몫이 여기 6종은 전부 정수라
# `aggregateCandles` 의 epoch-floor 집계와 격자가 일치하지만, 45분(2,700,000ms)은
# 정규장 390분을 나누지 못해 마지막 봉이 15:00(30분 폭)이고 종가 단일가 봉이
# 따로 없다.
BUCKET_MS_TO_TIC_SCOPE: dict[int, str] = {
    60_000: "1",
    180_000: "3",
    300_000: "5",
    600_000: "10",
    900_000: "15",
    1_800_000: "30",
}


def tic_scope_for_bucket_ms(bucket_ms: int) -> str | None:
    """표시 버킷 → `tic_scope`. 미지원이면 None(호출자가 422 로 올린다).

    조용히 1분으로 폴백하지 않는다: 폴백해도 프론트 집계가 정확한 봉을 만들어
    **증상이 안 보이고** 콜 수만 tf 배수만큼 조용히 늘어난다. 그건 이 기능이
    없애려던 바로 그 비용이라, 틀린 값은 눈에 띄게 실패해야 한다.
    """
    return BUCKET_MS_TO_TIC_SCOPE.get(bucket_ms)

_CNTR_TM_LEN = 14   # YYYYMMDDHHMMSS
_DATE_LEN = 8


@dataclass(frozen=True)
class MinutePage:
    """`base_dt=cursor` 한 콜의 결과.

    `complete` 는 **구조적으로 온전한** 날짜들이다. `oldest` 는 앞이 잘렸을 수
    있어 제외했고, 그 값이 곧 다음 커서다.
    """

    complete: dict[str, list[LiveCandle]]
    oldest: str
    """최古 날짜 = 다음 `base_dt`. 페이지가 비면 빈 문자열."""


def venue_code(code: str, venue: Venue) -> str:
    """KIS 는 `FID_COND_MRKT_DIV_CODE` 파라미터, 키움은 **종목코드 접미**(#1008)."""
    return f"{code}{VENUE_SUFFIX[venue]}"


def _abs_int(raw: object) -> int | None:
    """부호는 등락 방향이므로 가격에서는 버린다(분봉 고유 규약)."""
    text = str(raw or "").strip().replace("+", "").replace("-", "")
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def parse_row(row: dict[str, Any]) -> tuple[str, LiveCandle] | None:
    """행 하나 → `(YYYYMMDD, 캔들)`. 못 읽으면 None — 조용히 건너뛴다.

    분봉은 위반을 표면화하지 않는다: KIS 경로도 그랬고(`log.debug` 후 skip),
    하루 수백 봉 중 한 행이 깨진 것을 날짜 단위 경고로 올리면 노이즈만 된다.
    날짜 단위 결손은 walk 가 별도로 보고한다.
    """
    stamp = str(row.get("cntr_tm") or "").strip()
    if len(stamp) != _CNTR_TM_LEN or not stamp.isdigit():
        return None
    o = _abs_int(row.get("open_pric"))
    h = _abs_int(row.get("high_pric"))
    low = _abs_int(row.get("low_pric"))
    c = _abs_int(row.get("cur_prc"))       # 분봉도 종가 전용 필드가 없다
    v = _abs_int(row.get("trde_qty")) or 0  # `acc_trde_qty` 는 누적이라 봉 거래량이 아니다
    if o is None or h is None or low is None or c is None or c <= 0:
        return None
    try:
        dt = datetime(
            int(stamp[0:4]), int(stamp[4:6]), int(stamp[6:8]),
            int(stamp[8:10]), int(stamp[10:12]), int(stamp[12:14]),
            tzinfo=KST,
        )
    except ValueError:
        # 자릿수는 맞는데 달력상 불가능한 값(`20260800`, `20260231`).
        # 잡지 않으면 **행 하나가 페이지 전체를 죽인다** — 이 어댑터의 모든
        # 방어가 행 단위 skip 인데 여기만 예외가 새어 나갔다.
        return None
    return stamp[:_DATE_LEN], LiveCandle(
        t_ms=int(dt.timestamp() * 1000),
        open=o, high=h, low=low, close=c, volume=v,
    )


def split_page(rows: list[dict[str, Any]]) -> MinutePage:
    """페이지를 날짜별로 가르고 **최古 날짜를 떼어낸다**.

    떼어낸 날짜는 버려지는 것이 아니라 다음 커서가 된다 — 그래서 이 함수는
    그 날짜의 봉을 반환하지 않는다. 온전하지 않을 수 있는 것을 캐시에 넣지
    않는 것이 이 설계의 전부다.
    """
    by_date: dict[str, list[LiveCandle]] = {}
    for row in rows:
        parsed = parse_row(row)
        if parsed is None:
            continue
        date_s, candle = parsed
        by_date.setdefault(date_s, []).append(candle)
    if not by_date:
        return MinutePage(complete={}, oldest="")
    oldest = min(by_date)
    del by_date[oldest]
    for bars in by_date.values():
        bars.sort(key=lambda c: c.t_ms)   # 응답은 최신순(DESC)
    return MinutePage(complete=by_date, oldest=oldest)


async def fetch_minute_page(
    client: KiwoomRestClient,
    code: str,
    cursor_yyyymmdd: str,
    *,
    venue: Venue = "KRX",
    tic_scope: str = TIC_SCOPE_1MIN,
) -> MinutePage:
    """`base_dt=cursor` 한 콜. 커서 날짜는 응답의 **최新** 쪽이다.

    커서를 따라가지 않는다(`call`, not `walk`) — 페이지 간 이동은 `cont-yn`
    커서가 아니라 **`base_dt` 재지정**이다. 그래야 최古 날짜를 온전하게
    재수신한다.
    """
    page = await client.call(API_ID, {
        "stk_cd": venue_code(code, venue),
        "tic_scope": tic_scope,
        "upd_stkpc_tp": UPD_ADJUSTED,
        "base_dt": cursor_yyyymmdd,
    })
    return split_page(page.rows)


PageFetcher = Callable[[str], Awaitable[MinutePage]]
"""커서(`YYYYMMDD`) 1개 → 페이지 1장. `walk_minute_days` 의 페이싱 이음매다."""


@dataclass(frozen=True)
class MinuteWalkResult:
    bars_by_date: dict[str, list[LiveCandle]]
    """요청 창 안 날짜 + 순회가 덤으로 지나친 **창보다 오래된** 온전한 날짜들.

    후자는 캐시 워밍용이다 — 호출자가 응답을 만들 때는 자기 pending 목록으로
    거르므로 창 밖 날짜가 응답에 새지 않는다.
    """
    pages: int
    exhausted: bool
    """`max_pages` 에 걸려 멈췄다 — **조용한 절단 금지**. 호출자가 경고로 올린다."""
    wedged: bool
    """커서가 전진하지 않아 멈췄다(보유 바닥). 남은 구간은 키움에 없다."""


async def walk_minute_days(
    client: KiwoomRestClient,
    code: str,
    *,
    newest_yyyymmdd: str,
    oldest_yyyymmdd: str,
    venue: Venue = "KRX",
    tic_scope: str = TIC_SCOPE_1MIN,
    max_pages: int = 40,
    fetch_page: PageFetcher | None = None,
) -> MinuteWalkResult:
    """[oldest, newest] 를 덮을 때까지 커서를 뒤로 민다.

    **진행 보장 가드가 필수다.** 보유 바닥(#1008 실측: 분봉 1년 롤링)에서는
    `base_dt=D` 가 D 하루치만 돌려주므로 최古 == 커서가 되어 커서가 멈춘다.
    가드가 없으면 같은 콜을 영원히 반복한다 — 조사 실험이 실제로 그렇게 멈췄다.

    `max_pages` 기본 40 은 `tic_scope=1`(900행/콜 ≈ 2.35일) 기준 **약 94
    거래일**이다. 넓은 스코프는 페이지당 커버리지가 배수라 실 상한이 그만큼
    커진다 — 폭주 방지 백스톱이지 커버리지 설계값이 아니다. 한 수집 호출이
    상한보다 넓은 구간을 요구하면 `exhausted` 로 알린다.

    ## `fetch_page` 는 유량 페이싱 이음매다 — 기본값으로 두면 안 된다

    이 루프는 **콜 1건이 아니라 최대 40건**이다. 거버너(`kiwoom_capacity`)는
    `run_with_capacity` **진입 전에 한 번** 버킷을 소비하므로, walk 전체를 한
    submit 으로 감싸면 그 40콜은 페이싱을 전혀 받지 않고 초당 ~25콜로 나가
    6번째에서 `1700 유량=5` 로 거절당한다(실측 2026-08-04: `ka10080` 유량 초과
    8회 → `/live` "시세 서버 연결 불가" 토스트).

    그래서 **반복은 거버너 위, 실행은 거버너 안**이다. 호출자가 페이지 1장을
    `run_with_capacity` 로 감싼 러너를 주입하면 페이지마다 대기표를 뽑는다.
    기본값(주입 없음)은 페이싱이 없는 직접 호출이라 **테스트·단발 조사용**이다.
    """
    out: dict[str, list[LiveCandle]] = {}
    fetch = fetch_page or (
        lambda cur: fetch_minute_page(
            client, code, cur, venue=venue, tic_scope=tic_scope
        )
    )
    cursor = newest_yyyymmdd
    pages = 0
    while pages < max_pages:
        page = await fetch(cursor)
        pages += 1
        for date_s, bars in page.complete.items():
            # 상한만 거른다 — base_dt 는 포함 경계라 커서 당일이 최新으로 들어오고,
            # 프로토콜상 `newest` 보다 새로운 날짜는 오지 않지만(첫 커서=newest)
            # 방어로 남긴다. 오늘이 past 캐시에 스며들면 안 되기 때문이다(오늘은
            # 1분 고정의 별도 경로다 — `fetch_day`).
            #
            # **하한 필터는 없다 — 순회분 전량 적재(ADR-0120 원인 ③).** 목표 창을
            # 지나쳐 걸어온 날짜도 이미 지불한 페이지에 실려 온 **온전한** 날이다
            # (각 페이지의 최古만 `split_page` 가 떼어냈다). 여기서 버리면 넓은
            # `tic_scope` 에서 페이지의 최대 ~83%(30분: 페이지 ~60거래일 vs 청크
            # 10거래일)가 폐기되고, 다음 팬 청크가 같은 페이지를 다시 산다. 창 밖
            # 날짜는 호출자(`_apply_walk_result`)가 캐시에만 적재하고 응답에는
            # 싣지 않는다 — 응답은 `pending` 이 정한다.
            if date_s <= newest_yyyymmdd:
                out.setdefault(date_s, bars)
        if not page.oldest:
            # 빈 페이지 = 보유 밖. 더 갈 곳이 없다.
            return MinuteWalkResult(out, pages, exhausted=False, wedged=False)
        if page.oldest < oldest_yyyymmdd:
            # **`<` 이지 `<=` 가 아니다.** 최古 날짜는 `complete` 에서 빠져 있으므로
            # `page.oldest == oldest_yyyymmdd` 에서 멈추면 목표 구간의 가장 오래된
            # 날짜를 영원히 못 받는다. 목표보다 **더** 오래된 날짜를 봐야 그 날이
            # 온전하게 들어왔다는 뜻이다 — `kiwoom_index_candles` 가 같은 자리에서
            # 같은 실수를 했던 곳이다(from 날짜가 09:52 부터 시작).
            return MinuteWalkResult(out, pages, exhausted=False, wedged=False)
        if page.oldest >= cursor:
            # 진행 보장 가드. 여기서 멈추지 않으면 무한 루프다.
            return MinuteWalkResult(out, pages, exhausted=False, wedged=True)
        cursor = page.oldest
    return MinuteWalkResult(out, pages, exhausted=True, wedged=False)


async def fetch_day(
    client: KiwoomRestClient,
    code: str,
    date_yyyymmdd: str,
    *,
    venue: Venue = "KRX",
    tic_scope: str = TIC_SCOPE_1MIN,
) -> list[LiveCandle]:
    """그 날 하루치. **한 콜이면 끝난다.**

    `base_dt=D` 를 주면 D 는 응답의 **최新** 날짜다. 앞이 잘릴 수 있는 것은 최古
    날짜뿐이므로 **D 는 언제나 온전하다** — 최古 날짜를 떼어내는 규칙은 이웃
    날짜를 덤으로 수확할 때만 필요하다.

    그래서 여기서는 `split_page` 를 쓰지 않는다: 한 페이지가 D 하루로만 채워지는
    경우(보유 바닥) `split_page` 는 D 를 최古로 보고 떼어내는데, D 를 직접 지정한
    이 자리에서는 그게 오답이다.
    """
    page = await client.call(API_ID, {
        "stk_cd": venue_code(code, venue),
        "tic_scope": tic_scope,
        "upd_stkpc_tp": UPD_ADJUSTED,
        "base_dt": date_yyyymmdd,
    })
    bars: list[LiveCandle] = []
    for row in page.rows:
        parsed = parse_row(row)
        if parsed is None or parsed[0] != date_yyyymmdd:
            continue
        bars.append(parsed[1])
    bars.sort(key=lambda c: c.t_ms)
    return bars
