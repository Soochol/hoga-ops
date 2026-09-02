"""일봉 **봉 패턴** 검색 엔진 (ADR-0166).

OHLC 네 채널을 **창 공유 스케일**로 z-정규화하고 그 벡터들의 피어슨 상관을 낸다.
채널별로 각각 정규화하면 고가·저가 계열이 따로 늘어나 몸통 길이와 꼬리 비율이
사라진다 — 그 순간 이것은 캔들 매칭이 아니라 「4개 라인 매칭」 이다.

`screener_scan.py` 의 SQL leaf-compiler 와 **다른 모듈인 이유**: 저쪽은 조건을
만족하는 종목 집합을 내는 불리언 스크린이고, 이쪽은 거리로 줄 세우는 top-k
랭킹이다. 같은 코퍼스를 읽을 뿐 합칠 표면이 없다.
"""
from __future__ import annotations

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
_FLAT_SD = 1e-9

#: 매칭에 쓰는 채널 순서. 응답의 `bars` 도 이 순서다.
_OHLC = ("open", "high", "low", "close")
_CLOSE = 3

#: 창의 하한·상한 — **날짜 지정 경로**를 지킨다. `models` 의 `lengths` 검증은 요청이
#: 길이를 **말할 때만** 걸리는데, `from`/`to` 경로는 길이를 그 구간에서 뽑으므로 그
#: 검증을 통과한다. 즉 이 두 상수가 없으면 드래그로 그은 200봉이 그대로 돈다
#: (실측: 33봉 구간이 상한을 우회해 사용자 서버에서 24.7초를 썼다).
PATTERN_FLOOR = 5
PATTERN_CEILING = 30


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
    centers: np.ndarray        # (S,) 그 계열에서 뺀 상수. 원가격 복원의 유일한 열쇠
    tv: np.ndarray             # (N,) 거래대금
    dates: np.ndarray          # (N,) datetime64[D]
    names: dict[str, str]
    is_etf: dict[str, bool]
    last_date: np.datetime64

    def index_of(self, code: str) -> int | None:
        hit = np.flatnonzero(self.codes == code)
        return int(hit[0]) if len(hit) else None

    def series_len(self, i: int) -> int:
        return int(self.ends[i] - self.starts[i])

    def date_at(self, i: int, offset: int) -> date:
        return self.dates[self.starts[i] + offset].astype("datetime64[D]").astype(date)


#: (경로, mtime) → 코퍼스. **항상 최대 1개**를 유지한다(아래 `clear()`) — 한 항목이
#: ~360MB 라 갱신 뒤 옛 스냅샷을 붙들면 그대로 두 배가 된다. 키에 경로를 넣는 것은
#: `hoga.duck` 의 인스턴스 캐시와 같은 이유다(테스트가 tmp_path 로 자연 격리된다).
_cache: dict[tuple[Path, int], Corpus] = {}
_cache_lock = threading.Lock()


def load_corpus(data_dir: Path) -> Corpus:
    """프로세스 캐시. `daily_adjusted.parquet` 의 mtime 이 바뀌면 다시 만든다.

    무효화가 필요한 이유: `screener_store.derive_adjusted` 가 갱신 때 파일 **전체를
    재작성**한다. lock 은 콜드 스타트 동시 진입이 같은 1.5초짜리 로드를 N번 하는 것을
    막는다(정확성이 아니라 낭비의 문제라 double-checked 로 충분하다).
    """
    path = data_dir / "screener" / "daily_adjusted.parquet"
    mtime = path.stat().st_mtime_ns if path.exists() else -1
    key = (path, mtime)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            return hit
        corpus = _build_corpus(path, data_dir, mtime)
        _cache.clear()
        _cache[key] = corpus
        return corpus


def reset_cache() -> None:
    """테스트 훅 — 픽스처마다 다른 data_dir 을 쓰므로 프로세스 캐시를 비운다."""
    with _cache_lock:
        _cache.clear()


def _empty_corpus(path: Path, mtime: int) -> Corpus:
    return Corpus(
        path=path, mtime_ns=mtime,
        codes=np.array([], dtype=object),
        starts=np.array([], dtype=np.int64), ends=np.array([], dtype=np.int64),
        ch=np.zeros((4, 0)), logv=np.zeros(0), centers=np.zeros(0), tv=np.zeros(0),
        dates=np.array([], dtype="datetime64[D]"),
        names={}, is_etf={}, last_date=np.datetime64("1970-01-01", "D"),
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


def _build_corpus(path: Path, data_dir: Path, mtime: int) -> Corpus:
    if not path.exists():
        return _empty_corpus(path, mtime)
    df = _sanitized(path)
    if df.height == 0:
        return _empty_corpus(path, mtime)
    codes = df["code"].to_numpy()
    raw = np.stack([df[k].to_numpy().astype(np.float64) for k in _OHLC])
    ch = np.log(raw)
    volume = df["volume"].to_numpy().astype(np.float64)
    tv = raw.mean(axis=0) * volume
    # ⚠ 거래량 축에 **거래대금을 재사용하지 않는다** — `log(tv) = log(price) + log(volume)`
    #   이라 거래대금 상관은 가격 신호를 이중으로 센다. 캐시에 이미 있다는 이유로
    #   그 오염을 받으면 "가격만" 과 "거래량 함께" 의 차이가 흐려진다(ADR-0166 결정 9).
    logv = np.log(np.maximum(volume, 1.0))
    dates = df["date"].to_numpy().astype("datetime64[D]")
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
        ch=ch, logv=logv, centers=centers, tv=tv, dates=dates, names=names, is_etf=is_etf,
        last_date=dates.max(),
    )


def bars_at(c: Corpus, i: int, offset: int, length: int) -> list[list[float]]:
    """썸네일용 **원가격** `[open, high, low, close]` × length.

    중심화가 상수 한 번의 뺄셈이라 `exp(ch + center)` 로 정확히 되돌아온다.
    """
    w = np.exp(_window(c, i, offset, length) + c.centers[i])
    return [[float(v) for v in row] for row in w.T]


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


def _znorm(w: np.ndarray) -> np.ndarray | None:
    """창 **전체**를 한 스케일로 정규화. 채널별이 아니라는 것이 이 함수의 요점이다."""
    sd = w.std()
    return (w - w.mean()) / sd if sd > _FLAT_SD else None


def _roll_mean(x: np.ndarray, length: int) -> np.ndarray:
    cs = np.concatenate([[0.0], np.cumsum(x)])
    return (cs[length:] - cs[:-length]) / length


def _win_sd(c: Corpus, i: int, length: int) -> np.ndarray:
    """창의 4L 개 값 전체에 대한 표준편차. cumsum 차분이라 O(N)."""
    s, e = c.starts[i], c.ends[i]
    n = int(e - s) - length + 1
    total = np.zeros(n)
    sq = np.zeros(n)
    for k in range(4):
        x = c.ch[k, s:e]
        c1 = np.concatenate([[0.0], np.cumsum(x)])
        c2 = np.concatenate([[0.0], np.cumsum(x * x)])
        total += c1[length:] - c1[:-length]
        sq += c2[length:] - c2[:-length]
    mean = total / (4 * length)
    return np.sqrt(np.maximum(sq / (4 * length) - mean * mean, 0.0))


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
) -> tuple[list[PatternMatch], np.ndarray]:
    """각 종목의 **최신 L봉** 한 창만 비교. 종목당 내적 1회라 싸다.

    계열이 멈춘 종목(상장폐지·장기정지)은 '지금' 이 없으므로 뺀다 — 판정은 그 계열의
    마지막 날짜가 코퍼스 전체의 마지막 날짜인가다.
    """
    out: list[PatternMatch] = []
    scores: list[float] = []
    for i in range(len(c.codes)):
        e = int(c.ends[i])
        if i == skip or c.series_len(i) < length or not _eligible(c, i, exclude_etf=exclude_etf):
            continue
        if c.dates[e - 1] != c.last_date:
            continue
        if min_tv_eok > 0 and c.tv[e - length : e].mean() < min_tv_eok * _WON_PER_EOK:
            continue
        z = _znorm(c.ch[:, e - length : e])
        if z is None:
            continue
        score = float((z * query).sum() / (4 * length))
        if volume_query is not None and volume_weight > 0:
            # 거래량은 가격과 **별도 정규화**다. 평탄한 창은 0 으로 둬 자연 강등시킨다
            # (거래량 축이 없는 자리를 만점으로 쳐 주지 않는다).
            vw = c.logv[e - length : e]
            vsd = vw.std()
            vs = (float(((vw - vw.mean()) / vsd * volume_query).sum() / length)
                  if vsd > _FLAT_SD else 0.0)
            score = score * (1 - volume_weight) + vs * volume_weight
        scores.append(score)
        out.append(PatternMatch(score, i, c.series_len(i) - length))
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
        sd = _win_sd(c, i, length)
        with np.errstate(divide="ignore", invalid="ignore"):
            # 커널: 채널별 correlate 합. `sliding_window_view @ q` 는 스트라이드 뷰를
            # BLAS 가 연속 버퍼로 복사해 L 에 비례해 느려진다(실측 3.5배).
            cross = np.zeros(len(sd))
            for k in range(4):
                cross += np.correlate(c.ch[k, s:e], query[k], mode="valid")
            corr = cross / (4 * length * sd)
        if volume_query is not None and volume_weight > 0:
            corr = corr * (1 - volume_weight) + _volume_corr(c, i, volume_query, length) * volume_weight
        corr[~np.isfinite(corr) | (sd <= _FLAT_SD)] = -np.inf
        if min_tv_eok > 0:
            # rolling *mean* 이라 O(N). rolling min 이면 3배 느려진다(실측).
            corr[_roll_mean(c.tv[s:e], length) < min_tv_eok * _WON_PER_EOK] = -np.inf
        if min_after:
            corr[len(corr) - min_after :] = -np.inf     # 이후 구간이 없는 꼬리
        if since is not None:
            # 창의 **시작일** 기준. 기간은 후보 모집단을 바꾸는 유일한 조건이라
            # 서버에 있다(유사도·개수는 프론트가 결과를 자른다).
            corr[c.dates[s:e][: len(corr)] < since] = -np.inf
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


def query_vector(c: Corpus, series: int, offset: int, length: int) -> np.ndarray | None:
    """쿼리 창 → 공유 스케일 z-정규화된 (4, L) 벡터. 평탄하면 None."""
    return _znorm(_window(c, series, offset, length))


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
    days = c.dates[s : s + n].astype("datetime64[D]").astype(str)
    days = np.char.replace(days, "-", "")
    sel = np.flatnonzero((days >= frm) & (days <= to))
    span = int(sel[-1] - sel[0] + 1) if len(sel) else 0
    if len(sel) < PATTERN_FLOOR or span > PATTERN_CEILING:
        return None
    return int(sel[0]), span


def _ymd(c: Corpus, i: int, offset: int) -> str:
    return c.date_at(i, offset).strftime("%Y%m%d")


def run_pattern_search(data_dir: Path, req: PatternSearchRequest) -> PatternSearchResponse:
    """라우트가 부르는 유일한 진입점. **`asyncio.to_thread` 에서 돌 것** —
    콜드 캐시 1.5s + history 검색 0.4s 를 이벤트 루프에서 돌리면 프로세스가 멈춘다."""
    c = load_corpus(data_dir)
    qi = c.index_of(req.code)
    if qi is None:
        return PatternSearchResponse(code=req.code, name="", mode=req.mode, results=[])
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

    results: list[PatternLengthResult] = []
    for want in lengths:
        win = _resolve_window(c, qi, want, req.from_, req.to)
        if win is None:
            continue
        offset, base_length = win
        base_query = query_vector(c, qi, offset, base_length)
        if base_query is None:
            continue
        # 유연 검색은 **한 쿼리를 여러 길이로** 돌린다 — `lengths`(각 길이의 최신 창)와
        # 다른 축이다. 쿼리 창은 그대로 두고 시간축만 늘렸다 줄인다.
        for length in flex_lengths(base_length, req.flex_bars):
            query = base_query if length == base_length else resample_query(base_query, length)
            _append_one(c, req, results, qi=qi, offset=offset, length=length,
                        base_length=base_length, query=query)
    return PatternSearchResponse(code=req.code, name=name, mode=req.mode, results=results)


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
) -> None:
    """길이 하나의 결과를 만들어 담는다. 유연 검색이 이 함수를 길이마다 부른다."""
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
            volume_query=vq, volume_weight=vw,
        )
        fwd_all = np.zeros(0)
    else:
        matches, scores, fwd_all = search_history(
            c, query=query, length=length, query_series=qi, query_offset=offset,
            min_tv_eok=req.min_tv_eok, exclude_etf=req.exclude_etf,
            min_after=req.forward_days, no_overlap=req.no_overlap,
            per_code=req.per_code, volume_query=vq, volume_weight=vw,
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
        return
    pcts = percentiles(scores, (50, 95, 99, 99.99) if req.mode == "history" else (50, 95, 99))
    rows = [
        PatternMatchRow(
            code=c.codes[m.series],
            name=c.names.get(c.codes[m.series], ""),
            from_date=_ymd(c, m.series, m.offset),
            to_date=_ymd(c, m.series, m.offset + length - 1),
            corr=m.score,
            bars=bars_at(c, m.series, m.offset, length),
            tail=(closes_at(c, m.series, m.offset + length, req.forward_days)
                  if req.mode == "history" else None),
            forward_pct=(forward_return_pct(c, m.series, m.offset, length, req.forward_days)
                         if req.mode == "history" else None),
        )
        for m in matches[: req.top]
    ]
    results.append(PatternLengthResult(
        # 이 결과가 찾은 **매치의 길이**다. 유연 검색에서는 기준 길이와 다를 수 있고,
        # 프론트가 그 값을 「10봉으로」 뱃지로 쓴다.
        length=length,
        # 쿼리 창은 **기준 길이 그대로**다 — 리샘플한 것은 비교에 쓰는 벡터이지
        # 사용자가 그은 구간이 아니다.
        query=PatternQueryWindow(
            length=base_length,
            from_date=_ymd(c, qi, offset),
            to_date=_ymd(c, qi, offset + base_length - 1),
            bars=bars_at(c, qi, offset, base_length),
        ),
        universe=len(matches),
        dist=PatternDistribution(
            p50=pcts["p50"], p95=pcts["p95"], p99=pcts["p99"],
            p99_99=pcts.get("p99_99"), sample=int(len(scores)),
        ),
        matches=rows,
        baseline=baseline,
        elapsed_ms=(time.perf_counter() - started) * 1000,
    ))
