"""완료된 거래일의 `depth_delta` 1분 산출을 **미리** 만든다 — 조회 시 콜드 제거.

## 왜 이것만인가

2026-08-25 실측(010140 5m, `/api/range` 7일 타일, 사용자 dev 서버)에서 좌팬 워크백
비용의 정체가 갈렸다:

| mode | 소요 |
|---|---|
| `candles` | 0.22~0.40초 |
| `hoga` | 0.21~0.96초 |
| **`sidecar`** | **4.5~6.3초** |

그리고 sidecar 안에서 **`depth_delta` 가 단독 지배항**이다 — 전부 ON 1.19초 → 그것만
OFF **0.11초**(10배). `depth_heatmap` 은 0.02~0.03초라 껐다 켜도 무변화(1.23초)였다.
그래서 여기서 미리 만드는 것은 **`depth_delta` 하나뿐**이다. kind 를 늘리면 이득 없이
디스크만 는다.

비용이 드는 조건도 좁다: 같은 요청 재실행은 **0.069초**(17배 빠름)다.
`PastIndicatorsCache` 가 디스크 영속이라 **1분 산출이 없을 때만** 파케이를 스캔한다
(`build_depth_delta_slice`). 즉 사용자가 처음 보는 날짜만 비싸고, 그 비용을 야간으로
옮기는 것이 이 모듈이다.

## 무엇을 하지 않는가

**계산도 저장도 직접 하지 않는다.** `build_depth_delta_slice` 를 **그대로 호출**할
뿐이다. 그 함수가 이미 캐시 확인 → 계산 → store 를 하고, `_indicator_cacheable`
(과거일만) 게이트도 그 안에 있다. 여기서 date 판정을 새로 적으면 그 사본이 곧 드리프트
지점이 된다 — 오늘 날짜를 넘겨도 저장되지 않는 것은 **그 게이트가 지키기 때문**이고,
이 모듈의 테스트가 그 사실을 값으로 박는다.

`bucket_ms=60000`(1분)으로 부르는 것으로 충분하다. 그 경로가 1분 산출과 **ladder
가격 집합까지 함께** 저장하고(`bundle.py` 의 "1분으로 계산한 김에" 주석), 굵은 봉은
그 둘에서 파생되므로 파케이를 다시 읽지 않는다.

`SLICE_COALESCER` 도 그대로 얻는다 — 이 배치가 도는 중 사용자가 같은 날짜를 열어도
스캔은 한 번이다.

## 실패해도 데이터는 안 잃는다

멱등이라 마커도 재시도 기계도 없다. 실패한 (code, date) 는 다음 런이 자연히 다시
집는다. 그 사이 사용자 조회는 종전처럼 콜드로 계산할 뿐이다.
"""
from __future__ import annotations

import datetime as dt
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

from hoga.api.bundle import build_depth_delta_slice
from hoga.api.calendar import TradingDayUnavailableError, coverage_end, trading_days_in_range
from hoga.api.invariants import indicator_session_bounds, normalize_session_bounds
from hoga.api.past_indicators_cache import CACHE_MISS
from hoga.api.queries import QueryEngine

log = logging.getLogger(__name__)

#: 한 번의 1분 산출 = 파케이 1스캔. 실측 1.30초 / 5거래일 → **하루당 약 0.26초**.
#: 런당 예산을 ~2분으로 잡으면 450쌍이다. 하루 캡처가 300종목대이므로 정상 운영에서는
#: 상한에 닿지 않고, 첫 도입이나 며칠 밀린 뒤에만 여러 런에 걸쳐 따라잡는다.
MAX_PAIRS_PER_RUN = 450

#: 얼마나 거슬러 올라가며 빈 곳을 채울지(거래일). 5 = 대략 한 주. 그보다 오래된 날은
#: 사용자가 볼 확률이 낮고, 봐도 종전처럼 콜드로 계산되므로 손해가 아니라 **비용을
#: 안 쓰는 것**이다. 넓히면 디스크만 는다(1분 산출 ~610KB/일/종목 실측).
LOOKBACK_TRADING_DAYS = 5

#: venue 축은 **KRX 만** 미리 만든다. 캐시 키와 parquet 트리가 venue 별이라 전 venue 를
#: 돌면 디스크가 3배가 되는데(실측 KRX 977MB · NXT 922MB · UN 991MB), `/live` 기본
#: 거래소가 KRX 이고 좌팬 워크백도 거기서 관측됐다. NXT·UN 조회는 종전대로 콜드다.
PRECOMPUTE_VENUE = "KRX"

#: 디스크 캡처의 소스. 우회(hogaplay) 모드가 좌팬 워크백을 쓰는 경로다.
PRECOMPUTE_SOURCE = "hogaplay"

_ONE_MINUTE_MS = 60_000


@dataclass
class PrecomputeResult:
    """한 런의 결과. **상한 도달을 반드시 실어 보낸다** — 조용한 절단은 "다 했다"로
    읽히고, 그 오독이 이 리포가 이미 한 번 겪은 실패 유형이다(ADR-0064 침묵사망)."""

    computed: int = 0
    """새로 만들어 저장한 (code, date) 쌍."""
    already_cached: int = 0
    """이미 캐시에 있어 건너뛴 쌍."""
    failed: int = 0
    """예외로 실패한 쌍(다음 런이 다시 집는다)."""
    capped: bool = False
    """상한에 걸려 남긴 것이 있는가."""
    remaining: int = 0
    """상한 때문에 이번 런에서 못 한 쌍의 수."""
    elapsed_ms: int = 0
    dates: list[str] = field(default_factory=list)
    """실제로 훑은 거래일들(최신 → 과거)."""


def _captured_codes(data_dir: Path, date: str) -> list[str]:
    """그 거래일에 `snapshots.parquet` 이 있는 종목들.

    `depth_delta` 는 스냅샷 diff 라 그 파일이 없으면 애초에 만들 것이 없다 —
    `build_depth_delta_slice` 도 같은 판정으로 빈 리스트를 돌려준다. 여기서 미리
    거르는 것은 그 왕복(그리고 캐시 조회)을 아끼기 위해서다.
    """
    day_dir = data_dir / "parquet" / date
    if not day_dir.is_dir():
        return []
    out: list[str] = []
    for code_dir in sorted(day_dir.iterdir()):
        if not code_dir.is_dir():
            continue
        snap = code_dir / PRECOMPUTE_SOURCE / PRECOMPUTE_VENUE / "snapshots.parquet"
        if not snap.exists():
            # venue 하위 디렉터리가 없는 구형 레이아웃(평면)도 받아 준다.
            snap = code_dir / PRECOMPUTE_SOURCE / "snapshots.parquet"
            if not snap.exists():
                continue
        out.append(code_dir.name)
    return out


def _recent_trading_days(today_kst: str, *, lookback: int) -> list[str]:
    """오늘 **이전**의 최근 거래일들(최신 → 과거).

    오늘을 빼는 것은 `_indicator_cacheable` 이 과거일만 저장하기 때문이다 — 오늘을
    넘겨도 계산만 하고 버려져 순수 낭비가 된다. 달력 커버리지 밖이면 빈 목록이라
    이 배치는 조용히 아무것도 하지 않는다(근사로 밀고 나가지 않는다).
    """
    end_d = dt.date(int(today_kst[:4]), int(today_kst[4:6]), int(today_kst[6:8]))
    # 거래일 밀도가 최악(연휴)이어도 lookback 개를 담도록 넉넉히 잡는다.
    start = (end_d - dt.timedelta(days=lookback * 3 + 10)).strftime("%Y%m%d")
    # ⚠ 달력 커버리지 밖이면 `trading_days_in_range` 가 **던진다**(추측 목록 금지).
    # 그 경우 이 배치는 조용히 아무것도 안 한다 — 근사 날짜로 파케이를 스캔하느니
    # 종전처럼 조회 시점에 계산하는 편이 옳다. `end` 를 커버리지 안쪽으로 당겨
    # 예외 자체를 피하고, 그래도 없으면 빈 목록이다.
    cov_end = coverage_end()
    end = min(today_kst, cov_end) if cov_end else today_kst
    if end < start:
        return []
    try:
        days = trading_days_in_range(start, end)
    except TradingDayUnavailableError:
        log.warning("depth_delta precompute: trading-day coverage miss %s~%s", start, end)
        return []
    past = [d for d in days if d < today_kst]
    return sorted(past, reverse=True)[:lookback]


def precompute_depth_delta_1m(
    engine: QueryEngine,
    *,
    today_kst: str,
    lookback: int = LOOKBACK_TRADING_DAYS,
    max_pairs: int = MAX_PAIRS_PER_RUN,
) -> PrecomputeResult:
    """최근 완료 거래일의 `depth_delta` 1분 산출을 채운다(최신 날짜부터).

    최신부터 도는 이유: 사용자가 좌팬으로 만나는 순서가 그쪽이라, 상한에 걸려 잘리는
    쪽이 **더 오래된 날**이어야 한다.
    """
    started = time.monotonic()
    result = PrecomputeResult()
    cache = engine.indicators_cache
    data_dir = engine.data_dir
    result.dates = _recent_trading_days(today_kst, lookback=lookback)

    for date in result.dates:
        for code in _captured_codes(data_dir, date):
            if result.computed >= max_pairs:
                result.capped = True
                result.remaining += 1
                continue
            cached = cache.get_depth_delta(
                code, date, PRECOMPUTE_SOURCE, _ONE_MINUTE_MS, venue=PRECOMPUTE_VENUE,
            )
            if cached is not CACHE_MISS:
                result.already_cached += 1
                continue
            try:
                meta = engine.get_meta(
                    date, code, PRECOMPUTE_SOURCE, venue=PRECOMPUTE_VENUE,
                )
                norm_meta, _ = normalize_session_bounds(meta)
                open_ms, close_ms = indicator_session_bounds(norm_meta)
                build_depth_delta_slice(
                    engine,
                    code=code,
                    date=date,
                    bucket_ms=_ONE_MINUTE_MS,
                    source=PRECOMPUTE_SOURCE,
                    venue=PRECOMPUTE_VENUE,
                    session_open_ms=open_ms,
                    session_close_ms=close_ms,
                )
            except Exception:
                # 한 종목의 실패가 나머지를 막지 않는다. 멱등이라 다음 런이 다시 집는다.
                result.failed += 1
                log.exception(
                    "depth_delta precompute failed code=%s date=%s", code, date,
                )
                continue
            result.computed += 1

    result.elapsed_ms = int((time.monotonic() - started) * 1000)
    return result
