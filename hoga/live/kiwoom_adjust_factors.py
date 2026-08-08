"""수정계수 테이블 — 분봉을 **오늘 기준** 수정주가로 옮기는 척도 (#1229).

## 왜 분봉은 `upd_stkpc_tp=1` 을 쓸 수 없는가

키움 수정주가는 **`base_dt` 상대**다. `base_dt` **이후**의 액면분할/무상증자는
반영되지 않는다 — 일봉 함정 ④ 와 같은 성질이고, `kiwoom_minute_candles` 는 그것을
**페이지마다** 밟는다(커서가 곧 다음 `base_dt` 다).

340570(2026-08-06 효력, factor 0.5061) 실측 (2026-08-08, `tic_scope=1`):

    base_dt=20260805, upd=1 → 20260805 15:30 봉 종가 65,600  (미반영 = 원주가와 동일)
    base_dt=20260807, upd=1 → 같은 봉        종가 33,200  (반영)
    동일 타임스탬프 900봉 전부에서 비율이 **1.9759 단일값**

즉 한 walk 안에서도 커서가 수정일 밑으로 내려가는 순간 그 아래 페이지 전체가
원주가로 바뀐다. 절벽은 수정일이 아니라 **페이지 경계**(1분 기준 ~2.35 거래일)에
생긴다 — 일봉 #1228 지문("절벽이 분할일에 안 생긴다")의 분봉판이다.

## 왜 일봉과 같은 처방(`adjusted_as_of` 를 `base_dt` 로)을 안 쓰는가

일봉 walk 는 앵커 1개 + `cont-yn` 연속이라 기준일 고정이 전 페이지에 먹힌다.
분봉은 `base_dt` 재지정이 **랜덤 액세스의 본체**라, 앵커를 고정하면 `cont-yn` 으로만
내려가야 하고 페이지 수가 **오늘로부터의 거리**에 비례한다:

    1분 900행 ≈ 2.35 거래일/페이지 → 6개월 전(≈125 거래일)에 ~53 페이지
    `walk_minute_days(max_pages=40)` → **~94 거래일이 천장**(보유는 1년 롤링)
    `LiveMinuteCandleBackfill._fresh_budget_for` 설계값은 collect 당 ~5 페이지

비용이 아니라 **기능 회귀**다(1년 보유 중 뒤쪽 절반에 영원히 못 닿는다). 그래서
기준일을 `base_dt` 가 아니라 **이 테이블**이 쥔다 — 과제가 요구한 "갭 전체가 하나의
명시적 기준일을 공유한다" 는 성질은 그대로다.

## 원주가는 앵커 불변이다 — 이 모듈의 전제

`upd_stkpc_tp=0` 은 절대값이라 `base_dt` 를 뭘로 주든 같은 값이 온다(실측: 340570
`base_dt` 20260805 vs 20260807 겹침 180봉, OHLC 4필드 **불일치 0건**). 그래서 분봉은
원주가로 받고 여기서 곱한다 — 커서 프로토콜은 한 줄도 바뀌지 않는다.

## 정확도 — 재구성 오차는 최대 1원, 그것도 수정 이벤트를 건널 때만

계수는 일봉 종가 쌍(`adj/raw`)에서 나오는데 둘 다 원 단위로 반올림된 값이라 계수에
~1e-6 오차가 남는다. 실측(340570 20260805, 180봉 × OHLC 4필드): **불일치 133/720,
오차 분포 {-1, 0}** — 즉 최대 1원 낮게 나온다.

**계수가 정확히 1.0 인 날짜는 곱셈을 건너뛰므로 벤더 값과 비트 단위로 같다**
(20260806·20260807 실측 불일치 0/2880). 수정 이벤트가 없는 종목·구간, 즉 사실상 전부가
이 경로다. 오차는 "2배 절벽" 을 없앤 대가로 이벤트 구간에만 1원이다.

## 거래량은 곱하지 않는다 — **일봉과 규약이 다르다**

분봉은 `upd=1` 과 `upd=0` 의 `trde_qty` 가 **같다**(실측 900봉 불일치 0건). 반면 일봉은
거래량도 스케일한다(598/600행이 다르다: 20260805 adj 200,796 vs raw 101,623). 일봉
규약을 복사해 거래량까지 곱하면 분봉 거래량이 조용히 2배가 된다.
"""
from __future__ import annotations

from bisect import bisect_right
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from hoga.live.candle_models import LiveCandle
from hoga.live.kiwoom_rest import KiwoomRestClient, Page
from hoga.live.kiwoom_venue import VENUE_SUFFIX
from hoga.live.venue import Venue

API_ID = "ka10081"

UPD_ADJUSTED = "1"
UPD_RAW = "0"

_DATE_LEN = 8

CallRunner = Callable[
    [str, Callable[[KiwoomRestClient], Awaitable[Page]]], Awaitable[Page]
]
"""콜 1건 = 거버너 submit 1건. `kiwoom_access.run_with_capacity` 를 감는 이음매다.

주입하지 않으면 페이싱 없이 직접 나간다 — **테스트·단발 조사용**이다
(`kiwoom_access` 모듈 docstring 의 규범 참조).

첫 인자는 그 콜의 `upd_stkpc_tp` 다. **중복제거 키에 이 값이 반드시 들어가야
한다** — 두 콜은 종목·기준일이 같고 이 축 하나로만 갈리므로, 키에서 빠지면
동시 실행된 두 요청이 조인돼 **수정주가 응답이 원주가 자리에 들어간다**(계수가
전부 1.0 이 되어 절벽이 조용히 되살아난다). `past_candles_cache` 의 `tic_scope`
키 누락과 같은 종류의 오염이다.
"""


def _abs_int(raw: object) -> int | None:
    """원 단위 정수. 부호는 등락 방향이므로 가격에서는 버린다."""
    text = str(raw or "").strip().replace("+", "").replace("-", "")
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def venue_code(code: str, venue: Venue) -> str:
    return f"{code}{VENUE_SUFFIX[venue]}"


@dataclass(frozen=True)
class AdjustFactors:
    """`as_of` 기준 수정계수. `date → adjusted/raw`.

    **계수는 계단 함수다** — 값이 바뀌는 날이 곧 수정 이벤트의 효력일이고, `as_of`
    쪽 끝은 항상 1.0 이다.
    """

    as_of: str
    dates: tuple[str, ...]
    """오름차순. `factor_for` 의 이분 탐색 축이다."""
    values: tuple[float, ...]

    @property
    def is_identity(self) -> bool:
        """전 구간 1.0 — 이 종목엔 커버 구간 안에 수정 이벤트가 없다."""
        return all(v == 1.0 for v in self.values)

    def factor_for(self, date_yyyymmdd: str) -> float | None:
        """그 날짜의 계수. **테이블 밑이면 `None`**(모른다).

        정확히 없는 날짜는 **바로 아래 날짜**의 계수를 쓴다. 일봉은 거래일마다 행이
        있으므로 실제로는 정확히 맞는 것이 정상 경로이고, 이 폴백은 벤더가 한 행을
        빠뜨린 병리 케이스용이다 — 아래쪽을 고르는 것은 그 날 왼쪽에 그려진 봉과
        척도가 이어지게 하려는 것이다.

        `None` 을 0 이나 1.0 으로 접지 말 것. 그러면 척도를 모르는 봉이 화면에
        정상처럼 나간다.
        """
        if not self.dates or date_yyyymmdd < self.dates[0]:
            return None
        idx = bisect_right(self.dates, date_yyyymmdd) - 1
        return self.values[idx]


def build_factors(
    adjusted_rows: list[dict[str, Any]],
    raw_rows: list[dict[str, Any]],
    *,
    as_of: str,
) -> AdjustFactors:
    """일봉 두 페이지(수정/원)를 날짜로 조인해 계수 테이블을 만든다.

    양쪽에 다 있고 종가가 양수인 날짜만 쓴다 — 한쪽만 있는 날짜는 비율을 만들 수
    없고, 없는 채로 두면 `factor_for` 가 이웃 계수를 준다(계단 함수라 옳다).
    """
    adj = _closes_by_date(adjusted_rows)
    raw = _closes_by_date(raw_rows)
    dates = sorted(set(adj) & set(raw))
    pairs = [(d, adj[d] / raw[d]) for d in dates]
    return AdjustFactors(
        as_of=as_of,
        dates=tuple(d for d, _ in pairs),
        values=tuple(f for _, f in pairs),
    )


def _closes_by_date(rows: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for row in rows:
        date_s = str(row.get("dt") or "").strip()
        if len(date_s) != _DATE_LEN or not date_s.isdigit():
            continue
        close = _abs_int(row.get("cur_prc"))   # 종가 전용 필드가 없다(일봉 함정 ②)
        if close is None or close <= 0:
            continue
        out[date_s] = close
    return out


async def fetch_adjust_factors(
    client: KiwoomRestClient,
    code: str,
    *,
    as_of_yyyymmdd: str,
    venue: Venue = "KRX",
    run_call: CallRunner | None = None,
) -> AdjustFactors:
    """`ka10081` 을 수정/원 두 번 불러 계수 테이블을 만든다.

    **`venue` 기본이 KRX 인 것은 의도다.** 법인 이벤트는 종목의 성질이지 거래소의
    성질이 아니므로 계수는 venue 무관이고, NXT 는 출범 이후 구간만 있어(#1042 실측
    `_NX` 333행) 더 얕은 테이블이 나온다.

    `base_dt=as_of` 한 장이면 끝난다 — 600행 ≈ 2.4년(#1042 실측) > 분봉 보유 1년
    롤링(#1008). `walk` 를 쓰지 않는 이유가 그 부등식이고, 그래서 이 함수의 비용은
    **종목·기준일당 2콜**로 고정이다. 부등식이 깨지면(분봉 보유가 늘거나 일봉
    페이지가 줄면) 테이블 밑으로 내려간 날짜가 `factor_for` 에서 `None` 이 되고
    호출자가 경고로 올린다 — 조용히 무척도 봉이 나가지는 않는다.
    """
    async def _call(upd: str) -> Page:
        body = {
            "stk_cd": venue_code(code, venue),
            "base_dt": as_of_yyyymmdd,
            "upd_stkpc_tp": upd,
        }

        def _fetch(c: KiwoomRestClient) -> Awaitable[Page]:
            return c.call(API_ID, body)

        return await (run_call(upd, _fetch) if run_call is not None else _fetch(client))

    # 순차다. 두 콜이 같은 TR 버킷(`ka10081`)을 쓰므로 병렬로 던져 봐야 거버너가
    # 줄을 세운다 — 동시성만 늘고 얻는 것이 없다.
    adjusted = await _call(UPD_ADJUSTED)
    raw = await _call(UPD_RAW)
    return build_factors(adjusted.rows, raw.rows, as_of=as_of_yyyymmdd)


def scale_candle(candle: LiveCandle, factor: float) -> LiveCandle:
    """가격 4필드에만 계수를 건다. **거래량은 건드리지 않는다**(위 규약).

    `factor == 1.0` 이면 원본을 그대로 돌려준다 — 수정 이벤트가 없는 절대다수
    경로에서 벤더 값과 비트 단위로 같아야 하기 때문이다(부동소수 왕복 금지).
    """
    if factor == 1.0:
        return candle
    return LiveCandle(
        t_ms=candle.t_ms,
        open=round(candle.open * factor),
        high=round(candle.high * factor),
        low=round(candle.low * factor),
        close=round(candle.close * factor),
        volume=candle.volume,
    )


def scale_bars(bars: list[LiveCandle], factor: float) -> list[LiveCandle]:
    if factor == 1.0:
        return bars
    return [scale_candle(c, factor) for c in bars]
