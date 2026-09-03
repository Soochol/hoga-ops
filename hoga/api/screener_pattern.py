"""일봉 **봉 패턴** 검색 엔진 (ADR-0166).

OHLC 네 채널을 **창 공유 스케일**로 z-정규화하고 그 벡터들의 피어슨 상관을 낸다.
채널별로 각각 정규화하면 고가·저가 계열이 따로 늘어나 몸통 길이와 꼬리 비율이
사라진다 — 그 순간 이것은 캔들 매칭이 아니라 「4개 라인 매칭」 이다.

`screener_scan.py` 의 SQL leaf-compiler 와 **다른 모듈인 이유**: 저쪽은 조건을
만족하는 종목 집합을 내는 불리언 스크린이고, 이쪽은 거리로 줄 세우는 top-k
랭킹이다. 같은 코퍼스를 읽을 뿐 합칠 표면이 없다.
"""
from __future__ import annotations

import calendar
import threading
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np
import polars as pl

from hoga.api.models import (
    PatternBaseline,
    PatternDistribution,
    PatternEmptyReason,
    PatternLengthResult,
    PatternMatchRow,
    PatternQueryWindow,
    PatternSearchRequest,
    PatternSearchResponse,
)

# 거래대금 = 평균가(OHLC/4) × 거래량. `screener_scan._TV` 와 **같은 식**이다
# (코퍼스에 거래대금 컬럼이 없어 양쪽이 각자 산출한다 — 드리프트하면 필터가 갈린다).
_WON_PER_EOK = 100_000_000

#: 이 아래 표준편차의 창은 정지·단일가 구간이라 상관계수가 수치적으로 무의미하다.
#:
#: ⚠ **값의 근거는 참값이 아니라 `_win_sd` 의 오차다.** cumsum 차분은 계열이 길수록
#: 파국적 상쇄가 커져, 참값이 1e-15 인 완전 정지 창(OHLC 가 한 값)에 **2.4e-06 까지**
#: 되돌린다(2026-09-03 전수 실측 — L=5·7·30 모두 상한이 같다). 그래서 예전 값 1e-9 는
#: **자기 오차보다 작아** 정지 구간을 통과시켰고, 그 작은 sd 로 나눈 상관계수가 1 을
#: 넘었다(실측 1.250 — 참값 0.652).
#:
#: 1e-5 는 그 오차 상한의 4배 여유다. 대가로 «살아 있는» 창도 잘리지만 L=7 에서
#: **128개**(후보창 740만의 0.002%)이고, 그 창들은 창 전체의 로그가격 변동이 0.001%
#: 미만이라 애초에 상관계수가 의미를 갖지 못한다.
#:
#: 표준편차를 **2-pass 로 재는 경로**(`_znorm`·`_price_flat`·`_volume_query`)에는 이
#: 오차가 없다 — 거기서 이 상수는 「거의 정지」를 거르는 원래 뜻 그대로다.
_FLAT_SD = 1e-5

#: 상관계수가 이 값을 넘으면 **수치적으로 신뢰할 수 없다** — 수학적으로 1 을 넘을 수
#: 없기 때문이다. `_FLAT_SD` 가 놓친 창을 잡는 마지막 방어이고, **임계값을 짐작할 필요가
#: 없다**는 것이 그 값어치다(코퍼스가 길어지면 위 오차 상한도 함께 커진다).
#:
#: 여유 1e-6 은 부동소수 오차용이다 — 아핀 사본의 상관은 정확히 1.0 이어야 하고,
#: 그 창을 이 방어가 지우면 «심은 사본을 찾는다»는 계약이 깨진다.
_CORR_CEILING = 1.0 + 1e-6

#: 매칭에 쓰는 채널 순서. 응답의 `bars` 도 이 순서다.
_OHLC = ("open", "high", "low", "close")
_CLOSE = 3

#: 창의 하한·상한 — **날짜 지정 경로**를 지킨다. `models` 의 `lengths` 검증은 요청이
#: 길이를 **말할 때만** 걸리는데, `from`/`to` 경로는 길이를 그 구간에서 뽑으므로 그
#: 검증을 통과한다. 즉 이 두 상수가 없으면 드래그로 그은 200봉이 그대로 돈다
#: (실측: 33봉 구간이 상한을 우회해 사용자 서버에서 24.7초를 썼다).
#: 이평 프리셋. **자유 조합을 열지 않는다** — 조합마다 답이 크게 갈리는데(5·20 대비
#: 20·60 은 상위 20 중 3개만 겹친다) 그건 판별력 차이가 아니라 **질문이 바뀌는 것**이고,
#: 체크박스는 그 사실을 화면에서 말해 주지 못한다. 이름이 무엇을 찾는지 말하게 둔다.
#: 캐시 키도 3배로 바운드된다(자유 조합이면 2**4 = 16배).
MA_PRESETS: dict[str, tuple[int, ...]] = {
    "off": (),
    "short": (5, 20),
    "mid": (20, 60),
}
#: 코퍼스가 상주시킬 기간 — 프리셋들의 합집합. 기간당 ~68MB 다.
MA_PERIODS: tuple[int, ...] = tuple(sorted({p for ps in MA_PRESETS.values() for p in ps}))

PATTERN_FLOOR = 5
PATTERN_CEILING = 30

#: 빈 이유의 우선순위 — 클수록 파이프라인을 **멀리 통과**했다는 뜻이다.
#: 여러 길이를 도는 경로에서 어느 실패를 보고할지 이 순서가 정한다(`run_pattern_search`).
_EMPTY_RANK: dict[str, int] = {"code_missing": 0, "window": 1, "flat": 2, "no_candidates": 3}

#: 코퍼스의 봉 단위. `"W"` 는 일봉 parquet 에서 **파생**한다 — 종목 주봉을 주는 벤더
#: 경로가 없다(키움 W/M TR 은 지수 전용).
#:
#: ⚠ 버킷 규칙은 프론트 `calendarBucketKey`(`aggregateCandles.ts`)와 **같아야** 한다.
#: ADR-0166 이 내세운 「화면의 봉과 검색 대상이 같은 데이터」가 그것으로만 유지된다.
PATTERN_TIMEFRAMES = ("D", "W", "M")

#: 「완성된 주」의 거래일 수. 주봉에서만 쓴다 — 아래 `_partial_days` 참조.
_FULL_WEEK_DAYS = 5


def _month_end(key: date) -> date:
    """그 달의 말일. 월봉의 「아직 안 끝났는가」 판정에 쓴다.

    윤년·월 넘김을 표준 라이브러리에 맡긴다 — 손으로 세면 2월과 12월이 각각 다른
    방식으로 틀린다.
    """
    return key.replace(day=calendar.monthrange(key.year, key.month)[1])


def _partial_days(c: Corpus, tail: int) -> int | None:
    """마지막 봉이 **다른 봉과 다르게 담겼으면** 그 거래일 수, 아니면 None.

    ⚠ **질문이 timeframe 마다 다르다.** 하나로 통일하려다 한쪽을 망가뜨리기 쉽다:

    * **주봉** — 5일이 규범이라 「며칠짜리인가」가 곧 답이다. 휴일 낀 완성 주(4일)도
      걸리는데 **의도한 것이다**: 그 봉 역시 5일치와 다른 것을 담고 있어 말할 가치가
      있다. 달력(일요일)으로 물으면 **금요일 마감 뒤에도 늘 미완성**이 된다 — 거래일은
      금요일이 마지막이라 달력 끝에 절대 닿지 못한다.
    * **월봉** — 18~23일로 규범이 없어 일수로는 답이 안 나온다. 대신 「이번 달이 아직
      안 끝났는가」를 **달력으로** 묻는다. 월말에는 거래일이 말일 근처까지 있어 그
      비교가 성립한다.
    """
    if c.timeframe == "W":
        days = int(c.bucket_days[tail])
        return days if days < _FULL_WEEK_DAYS else None
    if c.timeframe == "M":
        key = c.dates[tail].astype("datetime64[D]").astype(date)
        last_seen = c.last_trading_day.astype("datetime64[D]").astype(date)
        return int(c.bucket_days[tail]) if last_seen < _month_end(key) else None
    return None


@dataclass(frozen=True)
class PatternMatch:
    """한 매치 — 계열 인덱스와 **로컬** 봉 인덱스로 들고 있다가 라우트가 살을 붙인다."""

    score: float
    series: int
    offset: int


@dataclass
class Corpus:
    """종목별 계열을 연속 배열 + 경계 인덱스로 들고 있는 읽기 전용 캐시.

    **`raw`(원가격)를 담지 않는다** — 담으면 상주가 +286MB 늘고 그 대부분이 영원히
    쓰이지 않는다(ADR-0166 결정 6). 썸네일용 원가격은 `bars_at()` 이 `centers` 로
    되돌린다: 중심화는 상수 하나를 뺀 것뿐이라 `exp(ch + center)` 가 원가격이다.
    parquet 재스캔(종목당 137MB 파일 메타 재독)을 피하는 것이 이 필드의 존재 이유다.
    """

    path: Path
    mtime_ns: int
    codes: np.ndarray          # 종목 코드 (유니크, 정렬)
    starts: np.ndarray
    ends: np.ndarray
    ch: np.ndarray             # (4, N) 로그 OHLC — 계열별 **공유 상수**로 중심화
    logv: np.ndarray           # (N,) 로그 거래량 — 계열별 중심화. 가격과 **다른 축**이다
    ma: dict[int, np.ndarray]  # 기간 → (N,) 로그 SMA. 가격과 **같은 축**이라 공유 스케일에 든다
    centers: np.ndarray        # (S,) 그 계열에서 뺀 상수. 원가격 복원의 유일한 열쇠
    tv: np.ndarray             # (N,) 거래대금 — 주봉은 **일평균**이다(임계값의 뜻 보존)
    dates: np.ndarray          # (N,) datetime64[D] — **버킷 키**(주봉은 그 주의 월요일)
    #: (N,) 그 버킷의 **첫·마지막 거래일**. 일봉은 셋이 모두 같은 객체다.
    #:
    #: ⚠ 날짜 변환은 **양방향**이라 배열이 셋이어야 한다. 들어오는 요청은 첫 거래일을
    #: 싣고 오는데(프론트 `aggregateCalendar` 의 `t_ms` 가 그렇다) 서버 키는 월요일이라,
    #: 월요일이 휴일이면 둘이 갈린다(주봉의 7.6%). **나가는 응답은 그 반대**다: 키를
    #: 그대로 실으면 차트에 그 날 캔들이 없어 착지 밴드가 아무 데도 걸리지 않는다.
    first_days: np.ndarray
    last_days: np.ndarray
    #: (N,) 그 버킷이 담은 거래일 수. 마지막 버킷은 주 중이면 **미완성**이고(수요일이면
    #: 3일), 화면이 그 봉을 그리므로 코퍼스도 담되 그 사실을 말할 수 있어야 한다.
    bucket_days: np.ndarray
    names: dict[str, str]
    is_etf: dict[str, bool]
    #: 코퍼스 전체의 마지막 **버킷 키**. 생존 판정(`search_now`)이 이 값과 비교한다 —
    #: 거기서는 「그 종목이 마지막 버킷에 있는가」를 묻는 것이라 키가 맞다.
    last_date: np.datetime64
    #: 코퍼스 전체의 마지막 **거래일**. 「오늘」의 근사이고 달력 비교에 쓴다.
    #:
    #: ⚠ `last_date` 로 대신할 수 없다 — 월봉에서 그 값은 **그 달의 1일**(키)이라
    #: 말일과 비교하면 완성된 달도 늘 「진행 중」이 된다.
    last_trading_day: np.datetime64
    timeframe: str = "D"

    def index_of(self, code: str) -> int | None:
        hit = np.flatnonzero(self.codes == code)
        return int(hit[0]) if len(hit) else None

    def series_len(self, i: int) -> int:
        return int(self.ends[i] - self.starts[i])

    def date_at(self, i: int, offset: int) -> date:
        """**버킷 키**. `no_overlap`·`since` 처럼 내부 비교에 쓰는 값이다."""
        return self.dates[self.starts[i] + offset].astype("datetime64[D]").astype(date)

    def first_day_at(self, i: int, offset: int) -> date:
        """그 버킷의 **첫 거래일** — 응답의 `from_date` 다(차트에 캔들이 있는 날)."""
        return self.first_days[self.starts[i] + offset].astype("datetime64[D]").astype(date)

    def last_day_at(self, i: int, offset: int) -> date:
        """그 버킷의 **마지막 거래일** — 응답의 `to_date` 다."""
        return self.last_days[self.starts[i] + offset].astype("datetime64[D]").astype(date)


#: (경로, mtime, timeframe) → 코퍼스. 키에 경로를 넣는 것은 `hoga.duck` 의 인스턴스
#: 캐시와 같은 이유다(테스트가 tmp_path 로 자연 격리된다).
#:
#: **같은 mtime 의 timeframe 들은 함께 상주한다.** 예전에는 항상 1개만 두고 새로 만들 때
#: `clear()` 했는데, timeframe 이 둘이 되면 그 정책이 **번갈아 쓸 때마다 재빌드**를 낸다
#: (일봉 1.8s — 사용자가 느끼는 지연이다). 주봉은 +176MB 라 워커 3개에도 +528MB 이고,
#: 그 교환은 지연 쪽이 비싸다. 옛 mtime 은 여전히 즉시 버린다 — 갱신 뒤 옛 스냅샷을
#: 붙들면 상주가 그대로 두 배가 된다.
_cache: dict[tuple[Path, int, str], Corpus] = {}
_cache_lock = threading.Lock()


def load_corpus(data_dir: Path, timeframe: str = "D") -> Corpus:
    """프로세스 캐시. `daily_adjusted.parquet` 의 mtime 이 바뀌면 다시 만든다.

    무효화가 필요한 이유: `screener_store.derive_adjusted` 가 갱신 때 파일 **전체를
    재작성**한다. lock 은 콜드 스타트 동시 진입이 같은 1.5초짜리 로드를 N번 하는 것을
    막는다(정확성이 아니라 낭비의 문제라 double-checked 로 충분하다).

    `timeframe` 이 `"W"` 면 그 일봉 파일에서 **파생**한다(실측 빌드 1.6s). 모르는 값은
    `"D"` 로 떨어뜨린다 — 요청이 답을 못 바꾼다(`ma_periods_for` 와 같은 규칙).
    """
    if timeframe not in PATTERN_TIMEFRAMES:
        timeframe = "D"
    path = data_dir / "screener" / "daily_adjusted.parquet"
    mtime = path.stat().st_mtime_ns if path.exists() else -1
    key = (path, mtime, timeframe)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            return hit
        corpus = _build_corpus(path, data_dir, mtime, timeframe)
        # 옛 mtime 만 버린다 — 같은 스냅샷의 다른 timeframe 은 살려 둔다.
        for stale in [k for k in _cache if k[0] == path and k[1] != mtime]:
            del _cache[stale]
        _cache[key] = corpus
        return corpus


def reset_cache() -> None:
    """테스트 훅 — 픽스처마다 다른 data_dir 을 쓰므로 프로세스 캐시를 비운다."""
    with _cache_lock:
        _cache.clear()


def _build_ma(
    ch: np.ndarray, starts: np.ndarray, ends: np.ndarray, centers: np.ndarray
) -> dict[int, np.ndarray]:
    """계열별 **산술** SMA(종가) → log → 같은 center 뺄셈.

    정의를 `/live` 차트의 `computeSMA` 와 맞춘다 — 산술평균이지 로그의 평균(기하평균)이
    아니다. 어긋나면 화면의 선과 검색이 **같은 이름으로 다른 것**을 가리킨다.

    가격과 **같은 축**이라는 것이 거래량과의 차이다(ADR-0166 결정 9 는 별도 정규화 +
    가중합이었다). 같은 상수로 중심화하므로 공유 스케일 z-정규화에 그대로 섞이고,
    그래야 캔들과 이평선의 상대 위치가 정규화 뒤에도 기하로 남는다.

    앞 `period-1` 봉은 값이 없다. NaN 을 상관에 흘리면 창 전체가 오염되므로 **0 으로
    채우고**, 그 구간을 쓰는 창은 호출부가 `-inf` 로 마스킹한다.
    """
    out: dict[int, np.ndarray] = {}
    for period in MA_PERIODS:
        col = np.zeros(ch.shape[1])
        for i in range(len(starts)):
            s, e = int(starts[i]), int(ends[i])
            if e - s < period:
                continue
            px = np.exp(ch[_CLOSE, s:e] + centers[i])
            cs = np.concatenate([[0.0], np.cumsum(px)])
            col[s + period - 1 : e] = np.log((cs[period:] - cs[:-period]) / period) - centers[i]
        out[period] = col
    return out


def _empty_corpus(path: Path, mtime: int, timeframe: str = "D") -> Corpus:
    empty_dates = np.array([], dtype="datetime64[D]")
    return Corpus(
        path=path, mtime_ns=mtime,
        codes=np.array([], dtype=object),
        starts=np.array([], dtype=np.int64), ends=np.array([], dtype=np.int64),
        ch=np.zeros((4, 0)), logv=np.zeros(0), ma={p: np.zeros(0) for p in MA_PERIODS},
        centers=np.zeros(0), tv=np.zeros(0),
        dates=empty_dates, first_days=empty_dates, last_days=empty_dates,
        bucket_days=np.zeros(0, dtype=np.int8),
        names={}, is_etf={}, last_date=np.datetime64("1970-01-01", "D"),
        last_trading_day=np.datetime64("1970-01-01", "D"), timeframe=timeframe,
    )


def _sanitized(path: Path) -> pl.DataFrame:
    """코퍼스에서 캔들 축이 못 쓰는 행을 뺀 프레임.

    `close > 0` 만으로 부족하다 — **OHLC 정합성 위반 3행**(저가>고가 이거나 종가가
    고저 범위 밖)이 실측으로 있고, 캔들 축에서는 존재할 수 없는 모양의 봉이 되어
    매치를 오염시킨다(ADR-0166 결정 5).
    """
    return (
        pl.read_parquet(path, columns=["code", "date", *_OHLC, "volume"])
        .filter(
            (pl.col("open") > 0) & (pl.col("high") > 0)
            & (pl.col("low") > 0) & (pl.col("close") > 0)
            & (pl.col("high") >= pl.col("low"))
            & (pl.col("high") >= pl.col("close")) & (pl.col("high") >= pl.col("open"))
            & (pl.col("low") <= pl.col("close")) & (pl.col("low") <= pl.col("open"))
        )
        .sort(["code", "date"])
    )


def _bucket_key(timeframe: str) -> pl.Expr:
    """그 날이 속한 버킷의 키. **프론트 `calendarBucketKey` 와 같은 규칙이어야 한다.**

    주 = 그 주의 **월요일** 날짜. `dt.truncate("1w")` 에 맡기지 않고 `date − (weekday−1)`
    로 명시하는 이유는 그 함수의 주 시작 요일이 폴라스 버전의 약속이지 우리 계약이
    아니기 때문이다 — 여기서 갈리면 화면과 검색이 **다른 봉**을 가리킨다.

    polars `dt.weekday()` 는 월=1 … 일=7 이다.
    """
    if timeframe == "W":
        return pl.col("date") - pl.duration(days=pl.col("date").dt.weekday() - 1)
    if timeframe == "M":
        # 달력 월은 시작일 모호성이 없다 — 주와 달리 `truncate` 에 맡겨도 계약이 갈리지 않는다.
        return pl.col("date").dt.truncate("1mo")
    return pl.col("date")


def _aggregate(df: pl.DataFrame, timeframe: str) -> pl.DataFrame:
    """일봉 프레임 → 그 timeframe 의 봉. 일봉이면 거래대금 컬럼만 얹는다.

    ⚠ **정제가 먼저다**(`_sanitized`) — 순서가 바뀌면 버려야 할 행이 그 주의 고가·저가를
    오염시킨다. 집계 뒤의 OHLC 정합성은 구성상 보장된다(first/max/min/last).

    ⚠ **거래대금은 «일평균»이다.** 합으로 두면 「50억 이상」이 주봉에서 실질 일 10억이
    된다(2026년 실측 중앙값 일봉 4.8억 vs 주봉 합 23.0억 = 4.8배). 임계값이 timeframe
    마다 다른 뜻을 갖지 않게 평균으로 둔다.
    """
    tv = ((pl.col("open") + pl.col("high") + pl.col("low") + pl.col("close")) / 4
          * pl.col("volume"))
    if timeframe == "D":
        # first/last/bucket_days 컬럼을 만들지 않는다 — 일봉은 셋이 전부 `date` 와 같은
        # 값이라 `_build_corpus` 가 **같은 배열을 재사용**한다(8.9M봉에서 143MB 차이다).
        return df.with_columns(tv.alias("tv"))
    return (
        df.with_columns(tv.alias("tv"), _bucket_key(timeframe).alias("_bkey"))
        .group_by(["code", "_bkey"], maintain_order=True)
        .agg(
            pl.col("open").first(),
            pl.col("high").max(),
            pl.col("low").min(),
            pl.col("close").last(),
            pl.col("volume").sum(),
            pl.col("tv").mean(),                      # ★ 합이 아니라 평균
            pl.col("date").first().alias("first_day"),
            pl.col("date").last().alias("last_day"),
            pl.len().cast(pl.UInt32).alias("bucket_days"),
        )
        .rename({"_bkey": "date"})
        .sort(["code", "date"])
    )


def _build_corpus(path: Path, data_dir: Path, mtime: int, timeframe: str = "D") -> Corpus:
    if not path.exists():
        return _empty_corpus(path, mtime, timeframe)
    df = _aggregate(_sanitized(path), timeframe)
    if df.height == 0:
        return _empty_corpus(path, mtime, timeframe)
    codes = df["code"].to_numpy()
    raw = np.stack([df[k].to_numpy().astype(np.float64) for k in _OHLC])
    ch = np.log(raw)
    volume = df["volume"].to_numpy().astype(np.float64)
    tv = df["tv"].to_numpy().astype(np.float64)
    # ⚠ 거래량 축에 **거래대금을 재사용하지 않는다** — `log(tv) = log(price) + log(volume)`
    #   이라 거래대금 상관은 가격 신호를 이중으로 센다. 캐시에 이미 있다는 이유로
    #   그 오염을 받으면 "가격만" 과 "거래량 함께" 의 차이가 흐려진다(ADR-0166 결정 9).
    logv = np.log(np.maximum(volume, 1.0))
    dates = df["date"].to_numpy().astype("datetime64[D]")
    if timeframe == "D":
        # ★ 같은 **객체**를 가리킨다 — 일봉은 버킷이 곧 그 날이라 사본을 만들 이유가 없다.
        first_days = last_days = dates
        bucket_days = np.ones(len(dates), dtype=np.int8)
    else:
        first_days = df["first_day"].to_numpy().astype("datetime64[D]")
        last_days = df["last_day"].to_numpy().astype("datetime64[D]")
        bucket_days = df["bucket_days"].to_numpy().astype(np.int8)
    bounds = np.flatnonzero(codes[1:] != codes[:-1]) + 1
    starts = np.concatenate([[0], bounds]).astype(np.int64)
    ends = np.concatenate([bounds, [len(codes)]]).astype(np.int64)

    # ★ 계열별 중심화. 상관계수는 평행이동 불변이라 **결과를 바꾸지 않는다**. 이걸 빼면
    #   cumsum 롤링분산이 파국적 상쇄를 일으켜 corr 이 1 을 넘는다(실측 4.4426).
    #   ⚠ 빼는 상수는 **4채널이 공유**한다(종가 로그평균 하나) — 채널별 평균을 각각
    #   빼면 고가−저가 간격과 몸통 크기가 그 자리에서 파괴된다.
    centers = np.zeros(len(starts))
    for i in range(len(starts)):
        centers[i] = ch[_CLOSE, starts[i] : ends[i]].mean()
        ch[:, starts[i] : ends[i]] -= centers[i]
        # 거래량은 가격과 단위가 달라 **자기 평균**으로 따로 중심화한다.
        logv[starts[i] : ends[i]] -= logv[starts[i] : ends[i]].mean()

    ma = _build_ma(ch, starts, ends, centers)

    names: dict[str, str] = {}
    is_etf: dict[str, bool] = {}
    stocks_path = data_dir / "screener" / "stocks.parquet"
    if stocks_path.exists():
        stocks = pl.read_parquet(stocks_path)
        names = dict(zip(stocks["code"], stocks["name"], strict=True))
        if "is_etf" in stocks.columns:
            is_etf = dict(zip(stocks["code"], stocks["is_etf"], strict=True))
    return Corpus(
        path=path, mtime_ns=mtime, codes=codes[starts], starts=starts, ends=ends,
        ch=ch, logv=logv, ma=ma, centers=centers, tv=tv, dates=dates,
        first_days=first_days, last_days=last_days, bucket_days=bucket_days,
        names=names, is_etf=is_etf, last_date=dates.max(),
        last_trading_day=last_days.max(), timeframe=timeframe,
    )


def bars_at(c: Corpus, i: int, offset: int, length: int) -> list[list[float]]:
    """썸네일용 **원가격** `[open, high, low, close]` × length.

    중심화가 상수 한 번의 뺄셈이라 `exp(ch + center)` 로 정확히 되돌아온다.
    """
    w = np.exp(_window(c, i, offset, length) + c.centers[i])
    return [[float(v) for v in row] for row in w.T]


def ma_at(
    c: Corpus, i: int, offset: int, length: int, periods: tuple[int, ...]
) -> list[list[float]] | None:
    """썸네일용 **원가격** 이평값 — 기간마다 length 개, `periods` 순서.

    캔들과 같은 자로 되돌린다(`exp(ma + center)`). 화면이 이 선을 함께 그려야 왜
    매치됐는지 보인다 — 캔들만 그리면 이평 관계는 어디에도 없다.
    """
    if not periods:
        return None
    s = int(c.starts[i]) + offset
    return [[float(v) for v in np.exp(c.ma[p][s : s + length] + c.centers[i])] for p in periods]


def closes_at(c: Corpus, i: int, offset: int, length: int) -> list[float]:
    """매치 뒤에 이어 그릴 종가 — 계열 끝을 넘으면 있는 만큼만 준다."""
    s, e = int(c.starts[i]), int(c.ends[i])
    lo, hi = s + offset, min(s + offset + length, e)
    if hi <= lo:
        return []
    return [float(v) for v in np.exp(c.ch[_CLOSE, lo:hi] + c.centers[i])]


def _window(c: Corpus, i: int, offset: int, length: int) -> np.ndarray:
    s = c.starts[i]
    return c.ch[:, s + offset : s + offset + length]


def resample_query(query: np.ndarray, out_len: int) -> np.ndarray:
    """쿼리를 **시간축으로** 늘리거나 줄인다 — 길이 유연 검색의 전부다.

    「7봉 패턴이 10봉에 걸쳐 전개된 것」 은 앞 7봉만 잘라 보면 상관이 0.13 이지만
    (실측) 길이를 맞춰 리샘플하면 0.98 이다. DTW 를 만들지 않는 이유가 이것이다 —
    전수 46초 대신 기존 커널을 길이마다 한 번씩 돌리면 되고, 심은 신축 사본을
    corr 1.0 으로 되찾는다.

    ⚠ **균일 신축만** 잡는다. 국소 신축(앞은 빠르고 뒤는 느린)은 DTW 의 영역이고,
    그 DTW 조차 신축 사본(1.03)과 그냥 닮은 것(1.16)을 잘 못 가른다(실측).
    """
    src = np.linspace(0, query.shape[1] - 1, out_len)
    grid = np.arange(query.shape[1])
    out = np.stack([np.interp(src, grid, query[k]) for k in range(query.shape[0])])
    return (out - out.mean()) / out.std()


def flex_lengths(base: int, flex: int) -> list[int]:
    """유연 검색이 돌 길이들. 하한·상한 밖은 버린다(응답 시간을 바운드한다)."""
    if flex <= 0:
        return [base]
    lo, hi = max(PATTERN_FLOOR, base - flex), min(PATTERN_CEILING, base + flex)
    return list(range(lo, hi + 1))


def ma_periods_for(preset: str) -> tuple[int, ...]:
    """프리셋 이름 → 기간들. 모르는 이름은 «끄기» 로 떨어뜨린다(요청이 답을 못 바꾼다)."""
    return MA_PRESETS.get(preset, ())


def _channels(c: Corpus, periods: tuple[int, ...]) -> list[np.ndarray]:
    """가격 4채널 + 이평 채널들. 전 계열 연속 배열이라 창은 슬라이스로 뽑는다.

    이평이 **여기 섞이는** 것이 이 기능의 전부다 — 채널별로 따로 정규화하면 7봉 창의
    MA20 은 거의 직선이라 위치가 사라지고 기울기만 남는다.
    """
    return [c.ch[k] for k in range(4)] + [c.ma[p] for p in periods]


def _stack_window(c: Corpus, i: int, offset: int, length: int, periods: tuple[int, ...]) -> np.ndarray:
    s = int(c.starts[i]) + offset
    return np.stack([ch[s : s + length] for ch in _channels(c, periods)])


def _ma_warmup(periods: tuple[int, ...]) -> int:
    """이평이 아직 없는 앞 구간의 길이. 그 자리에서 시작하는 창은 쓸 수 없다."""
    return max(periods) - 1 if periods else 0


def _price_flat(c: Corpus, i: int, offset: int, length: int) -> bool:
    """**가격 채널만으로** 평탄 판정. 이평을 섞어 재면 안 된다 — 7봉 내내 멎은 종목이
    「MA 가 기울어서」 되살아난다(실측: 모집단 2,675 → 2,713)."""
    s = int(c.starts[i]) + offset
    return bool(c.ch[:, s : s + length].std() <= _FLAT_SD)


def _znorm(w: np.ndarray) -> np.ndarray | None:
    """창 **전체**를 한 스케일로 정규화. 채널별이 아니라는 것이 이 함수의 요점이다."""
    sd = w.std()
    return (w - w.mean()) / sd if sd > _FLAT_SD else None


def _roll_mean(x: np.ndarray, length: int) -> np.ndarray:
    cs = np.concatenate([[0.0], np.cumsum(x)])
    return (cs[length:] - cs[:-length]) / length


def _win_sd(c: Corpus, i: int, length: int, periods: tuple[int, ...] = ()) -> np.ndarray:
    """창의 **모든 채널** 값 전체에 대한 표준편차. cumsum 차분이라 O(N).

    이평 채널의 워밍업 구간은 0 으로 채워져 있어 여기 섞이지만, 그 자리에서 시작하는
    창은 호출부가 `-inf` 로 지우므로 결과에 닿지 않는다.
    """
    s, e = c.starts[i], c.ends[i]
    n = int(e - s) - length + 1
    chans = _channels(c, periods)
    total = np.zeros(n)
    sq = np.zeros(n)
    for ch in chans:
        x = ch[s:e]
        c1 = np.concatenate([[0.0], np.cumsum(x)])
        c2 = np.concatenate([[0.0], np.cumsum(x * x)])
        total += c1[length:] - c1[:-length]
        sq += c2[length:] - c2[:-length]
    cells = len(chans) * length
    mean = total / cells
    return np.sqrt(np.maximum(sq / cells - mean * mean, 0.0))


def _volume_query(c: Corpus, i: int, offset: int, length: int) -> np.ndarray | None:
    """쿼리 창의 z-정규화된 로그 거래량. 평탄하면 None(그 창은 거래량 축이 없다)."""
    s = c.starts[i]
    w = c.logv[s + offset : s + offset + length]
    sd = w.std()
    return (w - w.mean()) / sd if sd > _FLAT_SD else None


def _volume_corr(c: Corpus, i: int, qv: np.ndarray, length: int) -> np.ndarray:
    """슬라이딩 거래량 상관. 가격과 **별도 정규화**다 — 단위가 달라 한 스케일로 못 누른다.

    평탄한 창(정지 후 재개 등)은 0 으로 둔다. 그러면 그 창의 총점이 가격 상관 × (1-w)
    만 남아 **자연 강등**된다 — 거래량 축이 없는 자리를 만점으로 쳐 주지 않는다.
    """
    s, e = int(c.starts[i]), int(c.ends[i])
    x = c.logv[s:e]
    c1 = np.concatenate([[0.0], np.cumsum(x)])
    c2 = np.concatenate([[0.0], np.cumsum(x * x)])
    m = (c1[length:] - c1[:-length]) / length
    sd = np.sqrt(np.maximum((c2[length:] - c2[:-length]) / length - m * m, 0.0))
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.correlate(x, qv, mode="valid") / (length * sd)
    out[~np.isfinite(out)] = 0.0
    return out


def _eligible(c: Corpus, i: int, *, exclude_etf: bool) -> bool:
    return not (exclude_etf and c.is_etf.get(c.codes[i], False))


def search_now(
    c: Corpus,
    *,
    query: np.ndarray,
    length: int,
    skip: int,
    min_tv_eok: float,
    exclude_etf: bool,
    volume_query: np.ndarray | None = None,
    volume_weight: float = 0.0,
    ma_periods: tuple[int, ...] = (),
) -> tuple[list[PatternMatch], np.ndarray]:
    """각 종목의 **최신 L봉** 한 창만 비교. 종목당 내적 1회라 싸다.

    계열이 멈춘 종목(상장폐지·장기정지)은 '지금' 이 없으므로 뺀다 — 판정은 그 계열의
    마지막 날짜가 코퍼스 전체의 마지막 날짜인가다.
    """
    out: list[PatternMatch] = []
    scores: list[float] = []
    # 이평을 쓰면 최신 창이 워밍업 뒤에 있어야 한다 — 신규 상장주는 그 선이 없다.
    need = length + _ma_warmup(ma_periods)
    cells = (4 + len(ma_periods)) * length
    for i in range(len(c.codes)):
        e = int(c.ends[i])
        if i == skip or c.series_len(i) < need or not _eligible(c, i, exclude_etf=exclude_etf):
            continue
        if c.dates[e - 1] != c.last_date:
            continue
        if min_tv_eok > 0 and c.tv[e - length : e].mean() < min_tv_eok * _WON_PER_EOK:
            continue
        offset = c.series_len(i) - length
        # ★ 평탄 판정은 **가격만** 본다. 이평을 섞으면 멎은 종목이 되살아난다.
        if _price_flat(c, i, offset, length):
            continue
        z = _znorm(_stack_window(c, i, offset, length, ma_periods))
        if z is None:
            continue
        score = float((z * query).sum() / cells)
        if volume_query is not None and volume_weight > 0:
            # 거래량은 가격과 **별도 정규화**다. 평탄한 창은 0 으로 둬 자연 강등시킨다
            # (거래량 축이 없는 자리를 만점으로 쳐 주지 않는다).
            vw = c.logv[e - length : e]
            vsd = vw.std()
            vs = (float(((vw - vw.mean()) / vsd * volume_query).sum() / length)
                  if vsd > _FLAT_SD else 0.0)
            score = score * (1 - volume_weight) + vs * volume_weight
        scores.append(score)
        out.append(PatternMatch(score, i, offset))
    out.sort(key=lambda m: m.score, reverse=True)
    return out, np.array(scores)


def _top_in_series(corr: np.ndarray, series: int, length: int, per_code: int) -> list[PatternMatch]:
    """한 종목에서 남길 매치들.

    두 번째부터 **겹침 배제**(창 길이의 절반)를 건다 — 안 걸면 한 칸씩 밀린 같은 자리가
    상위를 도배한다(이웃 창은 봉 하나만 달라 점수가 거의 같다).
    """
    if per_code <= 1:
        best = int(np.argmax(corr))
        return [PatternMatch(float(corr[best]), series, best)] if np.isfinite(corr[best]) else []
    # 복사는 per_code>1 에서만 — 창 수가 수천이라 기본 경로에 얹지 않는다.
    remaining = corr.copy()
    zone = max(1, length // 2)
    out: list[PatternMatch] = []
    for _ in range(per_code):
        best = int(np.argmax(remaining))
        if not np.isfinite(remaining[best]):
            break
        out.append(PatternMatch(float(remaining[best]), series, best))
        remaining[max(0, best - zone) : best + zone + 1] = -np.inf
    return out


def search_history(
    c: Corpus,
    *,
    query: np.ndarray,
    length: int,
    query_series: int,
    query_offset: int,
    min_tv_eok: float,
    exclude_etf: bool,
    min_after: int,
    no_overlap: bool,
    want_baseline: bool = False,
    per_code: int = 1,
    volume_query: np.ndarray | None = None,
    volume_weight: float = 0.0,
    since: np.datetime64 | None = None,
    ma_periods: tuple[int, ...] = (),
) -> tuple[list[PatternMatch], np.ndarray, np.ndarray]:
    """전 종목 × 전 기간 슬라이딩. 종목당 최고점 **1개**만 남긴다(결과 다양성).

    반환은 (매치, 전 후보창 점수, 그 창들의 `min_after` 봉 뒤 수익률). 뒤의 둘이
    베이스라인이고, ADR-0166 결정 7 이 그것을 **응답에서 뺄 수 없게** 한다.
    """
    q_from = c.dates[c.starts[query_series] + query_offset]
    q_to = c.dates[c.starts[query_series] + query_offset + length - 1]
    matches: list[PatternMatch] = []
    all_scores: list[np.ndarray] = []
    all_fwd: list[np.ndarray] = []
    for i in range(len(c.codes)):
        if not _eligible(c, i, exclude_etf=exclude_etf):
            continue
        s, e = int(c.starts[i]), int(c.ends[i])
        if (e - s) < length + min_after:
            continue
        sd = _win_sd(c, i, length, ma_periods)
        chans = _channels(c, ma_periods)
        with np.errstate(divide="ignore", invalid="ignore"):
            # 커널: 채널별 correlate 합. `sliding_window_view @ q` 는 스트라이드 뷰를
            # BLAS 가 연속 버퍼로 복사해 L 에 비례해 느려진다(실측 3.5배).
            cross = np.zeros(len(sd))
            for k, ch in enumerate(chans):
                cross += np.correlate(ch[s:e], query[k], mode="valid")
            corr = cross / (len(chans) * length * sd)
        if volume_query is not None and volume_weight > 0:
            corr = corr * (1 - volume_weight) + _volume_corr(c, i, volume_query, length) * volume_weight
        # ★ `corr > 1` 은 **수치가 무너졌다는 신호**다(상관계수는 1 을 넘을 수 없다).
        #   `_FLAT_SD` 가 그 원인을 대부분 막지만, 그 상수는 오늘 코퍼스에서 잰 오차
        #   상한에 기대므로 계열이 길어지면 다시 부족해질 수 있다. 이 줄은 임계값을
        #   짐작하지 않고 **결과가 불가능한 값인지**만 물어 그 창을 버린다.
        corr[~np.isfinite(corr) | (sd <= _FLAT_SD) | (corr > _CORR_CEILING)] = -np.inf
        if ma_periods:
            # 이평이 아직 없는 앞 구간. 0 으로 채워 둔 자리라 지우지 않으면 «이평이 바닥에
            # 붙은 모양» 이 매치로 올라온다.
            corr[: _ma_warmup(ma_periods)] = -np.inf
        if min_tv_eok > 0:
            # rolling *mean* 이라 O(N). rolling min 이면 3배 느려진다(실측).
            corr[_roll_mean(c.tv[s:e], length) < min_tv_eok * _WON_PER_EOK] = -np.inf
        if min_after:
            corr[len(corr) - min_after :] = -np.inf     # 이후 구간이 없는 꼬리
        if since is not None:
            # 창의 **시작 버킷** 기준. 기간은 후보 모집단을 바꾸는 유일한 조건이라
            # 서버에 있다(유사도·개수는 프론트가 결과를 자른다).
            #
            # ⚠ 버킷 **키**가 아니라 그 버킷의 **마지막 거래일**과 비교한다. 키로 재면
            #   경계 버킷이 통째로 빠진다 — 프론트가 보내는 `since` 는 「오늘 − N년」이라
            #   버킷 중간일 확률이 높고(주봉 6/7 · 월봉 ~29/30), 그 주/달이 부분적으로
            #   범위 안인데도 제외됐다. 일봉은 last=key 라 기존과 같은 식이다.
            corr[c.last_days[s:e][: len(corr)] < since] = -np.inf
        if no_overlap:
            d = c.dates[s:e]
            corr[(d[: len(corr)] <= q_to) & (d[length - 1 :] >= q_from)] = -np.inf
        if i == query_series:                            # 쿼리 자신과 겹치는 창
            lo = max(0, query_offset - length + 1)
            corr[lo : min(len(corr), query_offset + length)] = -np.inf
        finite = np.isfinite(corr)
        if finite.any():
            idx = np.flatnonzero(finite)
            all_scores.append(corr[idx])
            close = c.ch[_CLOSE, s:e]
            all_fwd.append(np.exp(close[idx + length - 1 + min_after] - close[idx + length - 1]) - 1)
        matches.extend(_top_in_series(corr, i, length, per_code))
    matches.sort(key=lambda m: m.score, reverse=True)
    scores = np.concatenate(all_scores) if all_scores else np.zeros(0)
    fwd = np.concatenate(all_fwd) if all_fwd else np.zeros(0)
    return matches, scores, fwd


def query_vector(
    c: Corpus, series: int, offset: int, length: int, periods: tuple[int, ...] = ()
) -> np.ndarray | None:
    """쿼리 창 → 공유 스케일 z-정규화된 (채널, L) 벡터. 평탄하면 None.

    이평을 쓰는데 쿼리 자리에 워밍업이 안 찼으면(신규 상장 등) None 이다 — 없는 선을
    0 으로 채운 채 검색하면 «이평이 바닥에 붙은 종목» 을 찾게 된다.
    """
    if periods and offset < _ma_warmup(periods):
        return None
    return _znorm(_stack_window(c, series, offset, length, periods))


def forward_return_pct(c: Corpus, i: int, offset: int, length: int, horizon: int) -> float | None:
    """매치 구간 **끝 봉** 기준 `horizon` 봉 뒤 수익률(%). 계열을 넘으면 None."""
    s, e = int(c.starts[i]), int(c.ends[i])
    end = s + offset + length - 1
    if end + horizon >= e:
        return None
    return float(np.exp(c.ch[_CLOSE, end + horizon] - c.ch[_CLOSE, end]) - 1) * 100


def percentiles(scores: np.ndarray, qs: tuple[float, ...]) -> dict[str, float]:
    """분포 요약 — 유사도 절대값을 단독으로 내보내지 않기 위한 동반 데이터."""
    if not len(scores):
        return {}
    out: dict[str, float] = {}
    for q in qs:
        key = f"p{q:g}".replace(".", "_")
        out[key] = float(np.percentile(scores, q))
    return out


# ── 응답 조립 ─────────────────────────────────────────────────────────────────

def _resolve_window(c: Corpus, i: int, length: int, frm: str | None, to: str | None):
    """(offset, length). 날짜를 주면 **그 구간이 곧 길이**이고 `lengths` 는 무시된다 —
    차트에서 구간을 그어 들어오는 경로(measure)가 그 의미다."""
    n = c.series_len(i)
    if frm is None or to is None:
        return (n - length, length) if n >= length else None
    s = c.starts[i]

    def ymd(arr: np.ndarray) -> np.ndarray:
        return np.char.replace(arr[s : s + n].astype("datetime64[D]").astype(str), "-", "")

    # ★ **버킷 키가 아니라 그 버킷의 거래일 범위와 겹치는가**를 묻는다.
    #   프론트가 보내는 날짜는 화면 봉의 타임스탬프 = 그 버킷의 **첫 거래일**인데
    #   (`aggregateCalendar` 가 Gap 회피 때문에 그렇게 잡는다), 서버의 키는 월요일이다.
    #   월요일이 휴일이면 둘이 갈리고(주봉의 7.6%, 최근 2026-08-17) 키로 비교하면 그
    #   버킷이 통째로 빠진다. 겹침 판정은 그 비대칭을 **정규화 없이** 흡수한다.
    #   일봉은 first=last=key 라 기존과 같은 식이다.
    sel = np.flatnonzero((ymd(c.last_days) >= frm) & (ymd(c.first_days) <= to))
    span = int(sel[-1] - sel[0] + 1) if len(sel) else 0
    if len(sel) < PATTERN_FLOOR or span > PATTERN_CEILING:
        return None
    return int(sel[0]), span


def _ymd_from(c: Corpus, i: int, offset: int) -> str:
    """구간 **시작** — 그 버킷의 첫 거래일.

    ⚠ 버킷 키(주봉이면 월요일)를 그대로 실으면 안 된다. 그 날이 휴일이면 차트에 캔들이
    없어 **착지 밴드가 아무 데도 걸리지 않는다**(주봉의 7.6%). 일봉은 셋이 같은 값이라
    이 구분이 보이지 않는다.
    """
    return c.first_day_at(i, offset).strftime("%Y%m%d")


def _ymd_to(c: Corpus, i: int, offset: int) -> str:
    """구간 **끝** — 그 버킷의 마지막 거래일."""
    return c.last_day_at(i, offset).strftime("%Y%m%d")


def run_pattern_search(data_dir: Path, req: PatternSearchRequest) -> PatternSearchResponse:
    """라우트가 부르는 유일한 진입점. **`asyncio.to_thread` 에서 돌 것** —
    콜드 캐시 1.5s + history 검색 0.4s 를 이벤트 루프에서 돌리면 프로세스가 멈춘다."""
    c = load_corpus(data_dir, req.timeframe)
    qi = c.index_of(req.code)
    if qi is None:
        # 커버리지도 없다 — **그 부재가 곧 「코퍼스에 계열이 없다」는 정보**다.
        return PatternSearchResponse(code=req.code, name="", mode=req.mode,
                                     timeframe=req.timeframe, results=[],
                                     empty_reason="code_missing")
    name = c.names.get(req.code, "")
    dated = req.from_ is not None
    # 바깥 루프가 1회가 되는 경우 셋:
    #  · 날짜 지정 — 길이가 구간에서 나온다.
    #  · history — 길이당 ~0.6s 라 묶어 받지 않는다.
    #  · **길이 유연** — `lengths`(각 길이의 최신 창)와 flex(한 쿼리의 리샘플)는 다른
    #    축이라 곱하면 안 된다. 곱하면 11 × 5 = 55회가 돌고 기준 7봉 질의에서 15봉
    #    매치가 상위에 오른다(실측). 유연이 켜지면 스크럽을 접고 고른 길이만 편다.
    single = dated or req.mode == "history" or req.flex_bars > 0
    lengths = [req.lengths[0]] if single else req.lengths
    periods = ma_periods_for(req.ma_preset)

    results: list[PatternLengthResult] = []
    reason: PatternEmptyReason | None = None

    def note(kind: PatternEmptyReason) -> None:
        """빈 이유를 모은다 — **파이프라인을 가장 멀리 통과한 것**이 이긴다.

        ⚠ 먼저 만난 것을 채택하면 안 된다. `now` 는 5~15봉을 한 번에 도는데, 계열이
        짧으면 15봉은 `window` 로 죽고 5봉은 그 뒤 단계에서 죽는다 — 먼저 만난 것을
        고르면 「구간이 짧다」고 보고하고 화면이 엉뚱한 커버리지 문장을 띄운다.
        멀리 간 쪽이 사용자가 실제로 손댈 수 있는 축이다.
        """
        nonlocal reason
        if reason is None or _EMPTY_RANK[kind] > _EMPTY_RANK[reason]:
            reason = kind

    for want in lengths:
        win = _resolve_window(c, qi, want, req.from_, req.to)
        if win is None:
            note("window")
            continue
        offset, base_length = win
        base_query = query_vector(c, qi, offset, base_length, periods)
        if base_query is None:
            note("flat")
            continue
        # 유연 검색은 **한 쿼리를 여러 길이로** 돌린다 — `lengths`(각 길이의 최신 창)와
        # 다른 축이다. 쿼리 창은 그대로 두고 시간축만 늘렸다 줄인다.
        for length in flex_lengths(base_length, req.flex_bars):
            query = base_query if length == base_length else resample_query(base_query, length)
            miss = _append_one(c, req, results, qi=qi, offset=offset, length=length,
                               base_length=base_length, query=query, periods=periods)
            if miss is not None:
                note(miss)
    return PatternSearchResponse(
        code=req.code, name=name, mode=req.mode, timeframe=req.timeframe, results=results,
        # 결과가 하나라도 있으면 이유가 없다 — 일부 길이가 죽은 것은 실패가 아니다.
        empty_reason=None if results else reason,
        coverage_from=c.first_day_at(qi, 0).strftime("%Y%m%d"),
        coverage_to=c.last_day_at(qi, c.series_len(qi) - 1).strftime("%Y%m%d"),
    )


def _append_one(
    c: Corpus,
    req: PatternSearchRequest,
    results: list[PatternLengthResult],
    *,
    qi: int,
    offset: int,
    length: int,
    base_length: int,
    query: np.ndarray,
    periods: tuple[int, ...] = (),
) -> PatternEmptyReason | None:
    """길이 하나의 결과를 만들어 담는다. 유연 검색이 이 함수를 길이마다 부른다.

    담았으면 `None`, 담지 못했으면 **그 이유**를 돌려준다 — 호출부가 빈 응답의 이유를
    모으기 위해서다. 이 함수가 조용히 return 하던 시절 그 실패는 호출부에서 「길이가
    안 맞았다」와 구별되지 않았다.
    """
    started = time.perf_counter()
    # 거래량 축은 가격과 **별도 정규화**다(단위가 달라 한 스케일로 못 누른다).
    # 쿼리 창의 거래량이 평탄하면 그 축이 없으므로 가중을 0 으로 접는다.
    # ⚠ 거래량 쿼리는 **기준 길이**로 잡는다 — 가격은 리샘플해도 거래량 축까지 늘리면
    #   두 축의 시간 해상도가 갈린다(리샘플은 가격 모양의 신축을 뜻하지 거래량의
    #   재분배가 아니다). 길이가 다르면 거래량 축을 접는다.
    same_len = length == base_length
    vq = _volume_query(c, qi, offset, length) if (req.volume_weight > 0 and same_len) else None
    vw = req.volume_weight if vq is not None else 0.0
    baseline = None
    if req.mode == "now":
        matches, scores = search_now(
            c, query=query, length=length, skip=qi,
            min_tv_eok=req.min_tv_eok, exclude_etf=req.exclude_etf,
            volume_query=vq, volume_weight=vw, ma_periods=periods,
        )
        fwd_all = np.zeros(0)
    else:
        matches, scores, fwd_all = search_history(
            c, query=query, length=length, query_series=qi, query_offset=offset,
            min_tv_eok=req.min_tv_eok, exclude_etf=req.exclude_etf,
            min_after=req.forward_days, no_overlap=req.no_overlap,
            per_code=req.per_code, volume_query=vq, volume_weight=vw, ma_periods=periods,
            since=(np.datetime64(
                f"{req.since[:4]}-{req.since[4:6]}-{req.since[6:]}", "D")
                if req.since else None),
        )
        if len(fwd_all):
            baseline = PatternBaseline(
                fwd_median_pct=float(np.median(fwd_all) * 100),
                fwd_win_rate_pct=float((fwd_all > 0).mean() * 100),
                sample=int(len(fwd_all)),
            )
    if not len(scores):
        # 후보 창이 하나도 안 남았다 — 기간·거래대금·forward 필터가 전부 걸렀다.
        # **넷 중 유일하게 조건으로 풀리는 이유**라 화면이 그렇게 말할 수 있어야 한다.
        return "no_candidates"
    pcts = percentiles(scores, (50, 95, 99, 99.99) if req.mode == "history" else (50, 95, 99))
    rows = [
        PatternMatchRow(
            code=c.codes[m.series],
            name=c.names.get(c.codes[m.series], ""),
            from_date=_ymd_from(c, m.series, m.offset),
            to_date=_ymd_to(c, m.series, m.offset + length - 1),
            corr=m.score,
            bars=bars_at(c, m.series, m.offset, length),
            tail=(closes_at(c, m.series, m.offset + length, req.forward_days)
                  if req.mode == "history" else None),
            forward_pct=(forward_return_pct(c, m.series, m.offset, length, req.forward_days)
                         if req.mode == "history" else None),
            ma=ma_at(c, m.series, m.offset, length, periods),
        )
        for m in matches[: req.top]
    ]
    # 마지막 봉이 미완성인가 — 주봉에서 수요일이면 3일치다. `now` 만 그 봉을 본다
    # (history 의 창은 과거라 전부 완성이다). 일봉은 `bucket_days` 가 항상 1 이라 null.
    partial = (_partial_days(c, int(c.ends[qi]) - 1)
               if req.mode == "now" and len(c.bucket_days) else None)
    results.append(PatternLengthResult(
        # 이 결과가 찾은 **매치의 길이**다. 유연 검색에서는 기준 길이와 다를 수 있고,
        # 프론트가 그 값을 「10봉으로」 뱃지로 쓴다.
        length=length,
        # 쿼리 창은 **기준 길이 그대로**다 — 리샘플한 것은 비교에 쓰는 벡터이지
        # 사용자가 그은 구간이 아니다.
        query=PatternQueryWindow(
            length=base_length,
            from_date=_ymd_from(c, qi, offset),
            to_date=_ymd_to(c, qi, offset + base_length - 1),
            bars=bars_at(c, qi, offset, base_length),
            ma=ma_at(c, qi, offset, base_length, periods),
        ),
        ma_periods=list(periods),
        universe=len(matches),
        dist=PatternDistribution(
            p50=pcts["p50"], p95=pcts["p95"], p99=pcts["p99"],
            p99_99=pcts.get("p99_99"), sample=int(len(scores)),
        ),
        matches=rows,
        baseline=baseline,
        partial_last_bucket_days=partial,
        elapsed_ms=(time.perf_counter() - started) * 1000,
    ))
    return None
