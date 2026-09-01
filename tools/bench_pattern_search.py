"""일봉 패턴 검색 실측 탐침 — 착수 전 성능·결과 품질을 직접 확인하는 도구.

읽기 전용이다. `screener/daily_adjusted.parquet` 만 읽고 아무것도 쓰지 않으며,
dev 서버·백엔드를 건드리지 않는다.

**`numpy` 는 이 리포의 의존성이 아니다**(polars·pyarrow·duckdb 뿐) — 그래서 실행에
`--with numpy` 가 필수다. 의존성 추가는 기능 PR 의 일이지 탐침의 일이 아니라 여기서는
`pyproject.toml` 을 건드리지 않는다.

사용:
    # '지금 삼성전자와 같은 모양인 종목' (now 모드, 기본)
    uv run --with numpy python tools/bench_pattern_search.py 005930

    # 과거 전체에서 찾기 + 이후 수익률·베이스라인
    uv run --with numpy python tools/bench_pattern_search.py 005930 --mode history

    # 기간을 직접 지정 (차트에서 구간을 고르는 것과 같다)
    uv run --with numpy python tools/bench_pattern_search.py 005930 --from 20260401 --to 20260630

    # 속도 매트릭스 (L × 모드)
    uv run --with numpy python tools/bench_pattern_search.py --bench

    # 궤적을 겹쳐 그린 HTML 리포트 (now + history 를 함께 담는다)
    uv run --with numpy python tools/bench_pattern_search.py 005930 --html /tmp/pattern.html

⚠ **시간 귀속에 주의.** CLI 는 실행마다 코퍼스 캐시를 새로 만든다(~1.4s). 서버에서는
프로세스당 1회 비용이라 사용자 체감과 무관하다. 그래서 출력이 [캐시]와 [검색]을 분리해
찍는다 — 합산해서 읽지 말 것.
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from hoga.config import resolve_data_dir

try:
    import numpy as np
except ModuleNotFoundError:  # pragma: no cover - 실행 가이드
    sys.exit("numpy 가 없다. `uv run --with numpy python tools/bench_pattern_search.py ...` 로 실행할 것.")

EOK = 100_000_000
_FLAT_SD = 1e-6  # 이 아래는 정지·단일가 구간 — 상관계수가 수치적으로 무의미하다
_MIN_QUERY_BARS = 5   # 캔들 축의 실사용 하한. 실측상 5봉도 변별력이 살아 있다
                      # (corr>0.99 인 창이 0개 — 4L 차원을 다 맞춰야 해서다)


@dataclass
class Corpus:
    """종목별 계열을 연속 배열 + 경계 인덱스로 들고 있는 읽기 전용 캐시."""

    codes: np.ndarray      # 종목 코드 (유니크, 정렬)
    starts: np.ndarray
    ends: np.ndarray
    ch: np.ndarray         # (4, N) 로그 OHLC. 계열별 **공유 상수**로 중심화 (아래 근거)
    raw: np.ndarray        # (4, N) 원가격 — 캔들 렌더용
    tv: np.ndarray         # 거래대금 = OHLC/4 × volume (screener_scan._TV 와 같은 식)
    dates: np.ndarray
    names: dict
    is_etf: dict
    last_date: object

    @property
    def logc(self) -> np.ndarray:
        """종가 축 = 4채널의 close 행. 두 축이 같은 배열을 보므로 갈릴 수 없다."""
        return self.ch[3]

    def index_of(self, code: str) -> int:
        hit = np.flatnonzero(self.codes == code)
        if not len(hit):
            sys.exit(f"코퍼스에 없는 종목: {code}")
        return int(hit[0])


#: 축별 사용 채널. close 는 종가 하나, candle 은 OHLC 넷.
_AXIS_CHANNELS = {"close": (3,), "candle": (0, 1, 2, 3)}


def load_corpus(data_dir: Path) -> tuple[Corpus, float]:
    t0 = time.perf_counter()
    sdir = data_dir / "screener"
    df = (
        pl.read_parquet(
            sdir / "daily_adjusted.parquet",
            columns=["code", "date", "open", "high", "low", "close", "volume"],
        )
        # 양수 가드: log() 가 -inf 가 된다. 실측 4채널 모두 같은 1행(102260/2008-06-20).
        .filter(
            (pl.col("open") > 0) & (pl.col("high") > 0)
            & (pl.col("low") > 0) & (pl.col("close") > 0)
            # OHLC 정합성 — 실측 3행(009070·018880·465780). **존재할 수 없는 봉**이라
            # 캔들 축에서는 없는 모양의 매치를 만든다. 종가 축엔 영향이 없지만 축마다
            # 다른 코퍼스를 쓰면 두 축의 결과를 비교할 수 없으므로 여기서 함께 뺀다.
            & (pl.col("high") >= pl.col("low"))
            & (pl.col("high") >= pl.col("close")) & (pl.col("high") >= pl.col("open"))
            & (pl.col("low") <= pl.col("close")) & (pl.col("low") <= pl.col("open"))
        )
        .sort(["code", "date"])
    )
    stocks = pl.read_parquet(sdir / "stocks.parquet")
    codes = df["code"].to_numpy()
    cols = ("open", "high", "low", "close")
    raw = np.stack([df[k].to_numpy().astype(np.float64) for k in cols])
    ch = np.log(raw)
    tv = (raw.mean(axis=0) * df["volume"].to_numpy().astype(np.float64))
    dates = df["date"].to_numpy()
    b = np.flatnonzero(codes[1:] != codes[:-1]) + 1
    starts = np.concatenate([[0], b])
    ends = np.concatenate([b, [len(codes)]])

    # ★ 계열별 중심화. 상관계수는 평행이동 불변이라 **결과를 바꾸지 않는다**. 이걸 빼면
    #   cumsum 롤링분산이 파국적 상쇄를 일으켜 corr 이 1 을 넘는다(실측 4.4426):
    #   로그가격은 값이 ~10 인데 정지 종목의 구간 분산은 ~1e-9 라 Σx²/L−(Σx/L)² 에서
    #   유효숫자가 전멸한다.
    #   ⚠ 빼는 상수는 **4채널이 공유**한다(종가 평균 하나). 채널별 평균을 각각 빼면
    #   고가−저가 간격과 몸통 크기가 그 자리에서 파괴돼 «캔들 매칭» 이 «4개 라인 매칭»
    #   으로 격하된다.
    for i in range(len(starts)):
        ch[:, starts[i] : ends[i]] -= ch[3, starts[i] : ends[i]].mean()

    c = Corpus(
        codes=codes[starts],
        starts=starts,
        ends=ends,
        ch=ch,
        raw=raw,
        tv=tv,
        dates=dates,
        names=dict(zip(stocks["code"], stocks["name"], strict=True)),
        is_etf=dict(zip(stocks["code"], stocks["is_etf"], strict=True)),
        last_date=dates.max(),
    )
    return c, time.perf_counter() - t0


def _win_stats(c: Corpus, i: int, L: int, axis: str):
    """창의 평균·표준편차. cumsum 차분이라 O(N).

    ⚠ candle 축은 **4L 개 값 전체**를 한 스케일로 본다. 채널별로 따로 정규화하면
    고가·저가 계열이 각자 늘어나 몸통·꼬리 비율이 사라진다 — 그 순간 이것은 캔들
    매칭이 아니라 «4개 라인 매칭» 이다.
    """
    chans = _AXIS_CHANNELS[axis]
    s_, e_ = c.starts[i], c.ends[i]
    total = np.zeros(e_ - s_ - L + 1)
    sq = np.zeros(e_ - s_ - L + 1)
    for k in chans:
        x = c.ch[k, s_:e_]
        c1 = np.concatenate([[0.0], np.cumsum(x)])
        c2 = np.concatenate([[0.0], np.cumsum(x * x)])
        total += c1[L:] - c1[:-L]
        sq += c2[L:] - c2[:-L]
    m = total / (L * len(chans))
    return m, np.sqrt(np.maximum(sq / (L * len(chans)) - m * m, 0.0))


def _roll_mean(x, L):
    c = np.concatenate([[0.0], np.cumsum(x)])
    return (c[L:] - c[:-L]) / L


def _window(c: Corpus, i: int, j: int, L: int, axis: str) -> np.ndarray:
    """계열 i 의 로컬 인덱스 j 에서 L 봉 — (채널, L) 원시 로그값."""
    s_ = c.starts[i]
    return c.ch[list(_AXIS_CHANNELS[axis]), s_ + j : s_ + j + L]


def _znorm_window(w: np.ndarray) -> np.ndarray:
    """창 전체를 한 스케일로 z-정규화. 반환 평균 0, 표준편차 1."""
    sd = w.std()
    return (w - w.mean()) / sd if sd > _FLAT_SD else None


def resolve_window(c: Corpus, qi: int, bars: int | None, frm: str | None, to: str | None):
    """쿼리 구간을 계열 로컬 인덱스 (i_from, i_to) 로. 차트에서 구간을 고르는 것과 같다."""
    s, e = c.starts[qi], c.ends[qi]
    if frm or to:
        if not (frm and to):
            sys.exit("--from 과 --to 는 함께 준다")
        d = c.dates[s:e].astype("datetime64[D]").astype(str)
        d = np.char.replace(d, "-", "")
        sel = np.flatnonzero((d >= frm) & (d <= to))
        if len(sel) < _MIN_QUERY_BARS:
            sys.exit(f"그 구간의 봉이 {len(sel)}개뿐이다 (최소 {_MIN_QUERY_BARS})")
        return int(sel[0]), int(sel[-1])
    n = e - s
    if bars > n:
        sys.exit(f"{c.codes[qi]} 의 봉이 {n}개뿐이다")
    return n - bars, n - 1


def search_now(c: Corpus, qi, i_from, i_to, *, axis, min_tv_eok, exclude_etf,
               fresh_only=True):
    """각 종목의 **최신 L봉**만 후보 — '지금 이 모양인 종목'. 종목당 창 1개라 싸다."""
    L = i_to - i_from + 1
    chans = _AXIS_CHANNELS[axis]
    q = _znorm_window(_window(c, qi, i_from, L, axis))
    out = []
    for i in range(len(c.codes)):
        code = c.codes[i]
        s_, e_ = c.starts[i], c.ends[i]
        if i == qi or (e_ - s_) < L:
            continue
        if exclude_etf and c.is_etf.get(code):
            continue
        # 상장폐지·장기정지로 계열이 멈춘 종목은 '지금' 이 없다
        if fresh_only and c.dates[e_ - 1] != c.last_date:
            continue
        if min_tv_eok > 0 and c.tv[e_ - L : e_].mean() < min_tv_eok * EOK:
            continue
        z = _znorm_window(c.ch[list(chans), e_ - L : e_])
        if z is None:
            continue
        out.append((float((z * q).sum() / (L * len(chans))), i, int(e_ - s_ - L)))
    out.sort(reverse=True)
    return out


def search_history(c: Corpus, qi, i_from, i_to, *, axis, min_tv_eok, exclude_etf,
                   min_after=20, want_baseline=False, no_overlap=False):
    """전 종목 × 전 기간 슬라이딩. 종목당 최고점 1개만 남긴다(결과 다양성).

    `no_overlap` 은 쿼리와 **날짜가 겹치는** 창을 뺀다. 안 빼면 동시대 매치가 상위를
    지배한다 — 같은 장세를 겪은 종목이 당연히 제일 닮기 때문이다(실측: 2026-04~06
    질의의 1·2위가 삼성전자우·SK하이닉스의 **정확히 같은 기간**이었다). '과거의 유사
    사례' 를 보려면 켠다.
    """
    L = i_to - i_from + 1
    chans = _AXIS_CHANNELS[axis]
    q_from = c.dates[c.starts[qi] + i_from]
    q_to = c.dates[c.starts[qi] + i_to]
    q = _znorm_window(_window(c, qi, i_from, L, axis))
    hits, bc, bf = [], [], []
    for i in range(len(c.codes)):
        code = c.codes[i]
        if exclude_etf and c.is_etf.get(code):
            continue
        s_, e_ = c.starts[i], c.ends[i]
        if (e_ - s_) < L + min_after:
            continue
        _, sd = _win_stats(c, i, L, axis)
        with np.errstate(divide="ignore", invalid="ignore"):
            # 커널 선택: np.correlate 가 sliding_window_view(x,L)@q 보다 L=250 에서
            # 3.5배 빠르다(251ms vs 880ms) — 후자는 스트라이드 뷰를 BLAS 가 연속
            # 버퍼로 복사하고 그 비용이 L 에 비례한다. 채널이 늘어도 호출만 늘 뿐이다.
            cross = np.zeros(len(sd))
            for n_, k in enumerate(chans):
                cross += np.correlate(c.ch[k, s_:e_], q[n_], mode="valid")
            corr = cross / (L * len(chans) * sd)
        corr[~np.isfinite(corr) | (sd <= _FLAT_SD)] = -np.inf
        if min_tv_eok > 0:
            # rolling *mean* 이라 O(N). rolling min 으로 하면 169ms→516ms 가 된다.
            corr[_roll_mean(c.tv[s_:e_], L) < min_tv_eok * EOK] = -np.inf
        if min_after:
            corr[len(corr) - min_after :] = -np.inf      # 이후 구간이 없는 꼬리
        if no_overlap:
            d = c.dates[s_:e_]
            corr[(d[: len(corr)] <= q_to) & (d[L - 1 :] >= q_from)] = -np.inf
        if i == qi:                                       # 쿼리 자신과 겹치는 창
            corr[max(0, i_from - L + 1) : min(len(corr), i_to + 1)] = -np.inf
        fin = np.isfinite(corr)
        if want_baseline and fin.any():
            j = np.flatnonzero(fin)
            bc.append(corr[j])
            cl = c.logc[s_:e_]
            bf.append(np.exp(cl[j + L - 1 + min_after] - cl[j + L - 1]) - 1)
        jm = int(np.argmax(corr))
        if np.isfinite(corr[jm]):
            hits.append((float(corr[jm]), i, jm))
    hits.sort(reverse=True)
    base = (np.concatenate(bc), np.concatenate(bf)) if want_baseline and bc else None
    return hits, base


def _fwd(c: Corpus, i, j, L, horizon):
    k = c.starts[i] + j + L - 1
    if k + horizon >= c.ends[i]:
        return None
    return float(np.exp(c.logc[k + horizon] - c.logc[k]) - 1) * 100


def _label(c: Corpus, i, j, L):
    s = c.starts[i]
    return f"{c.dates[s + j]}~{c.dates[s + j + L - 1]}"


# ─────────────────────────────────────────────────────────────────────────────
# HTML 리포트 — 숫자만으로는 "닮았는가" 를 판정할 수 없다. 궤적을 겹쳐 그린다.
# 팔레트는 리포의 DESIGN.md 토큰(Ledger 라이트 / Obsidian 다크)을 그대로 쓴다.
# ─────────────────────────────────────────────────────────────────────────────

_CSS = """
:root{
  --bg:#FDFCF8; --bg-subtle:#F2EFE7; --fg:#1E2732; --fg-dim:#5C6673; --fg-dimmer:#8B94A0;
  --border:#E4E0D3; --border-strong:#C9C3B2; --accent:#1F6F54; --grid:#ECE8DC;
  --up:#C4322E; --down:#1E5FC1;
  --font:"IBM Plex Sans KR","Pretendard",system-ui,-apple-system,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#121216; --bg-subtle:#0E0E11; --fg:#ECECF1; --fg-dim:#9A9AA8; --fg-dimmer:#63636F;
    --border:#232329; --border-strong:#33333C; --accent:#F0B429; --grid:#1B1B21;
    --up:#F04452; --down:#3485FA;
  }
}
:root[data-theme="dark"]{
  --bg:#121216; --bg-subtle:#0E0E11; --fg:#ECECF1; --fg-dim:#9A9AA8; --fg-dimmer:#63636F;
  --border:#232329; --border-strong:#33333C; --accent:#F0B429; --grid:#1B1B21;
  --up:#F04452; --down:#3485FA;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);
     font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
main{max-width:1080px;margin:0 auto;padding:56px 24px 72px;
     display:flex;flex-direction:column;gap:52px}
h1,h2,h3{margin:0;text-wrap:balance;font-weight:600}
h1{font-size:26px;line-height:1.3;letter-spacing:-0.01em}
h2{font-size:17px;padding-bottom:10px;border-bottom:1px solid var(--border)}
h3{font-size:14px;color:var(--fg)}
p{margin:0}
b{font-weight:600}
.eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;color:var(--accent);margin-bottom:10px}
.lede{color:var(--fg-dim);font-size:13.5px;margin-top:10px;max-width:76ch}
.note{color:var(--fg-dim);font-size:13px;margin:12px 0 20px;max-width:70ch}
.top{display:flex;flex-direction:column}
.top .scroll{margin-top:20px}
section{display:flex;flex-direction:column}
.stats{display:flex;flex-wrap:wrap;gap:0;margin:26px 0 0;padding:0;
       border:1px solid var(--border);border-radius:3px;overflow:hidden}
.stats div{flex:1 1 140px;padding:13px 16px;border-right:1px solid var(--border);
           display:flex;flex-direction:column;gap:3px}
.stats div:last-child{border-right:0}
.stats dt{font-size:11px;color:var(--fg-dim);font-weight:500}
.stats dd{margin:0;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;
          line-height:1.15;letter-spacing:-0.02em}
.stats dd span{font-size:12px;font-weight:500;color:var(--fg-dim);margin-left:3px;letter-spacing:0}
.stats .muted dd{color:var(--fg-dim);font-weight:500}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(212px,1fr))}
.card{border:1px solid var(--border);border-radius:3px;padding:11px 12px 9px;
      display:flex;flex-direction:column;gap:7px;background:var(--bg)}
.card header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.nm{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cd{font-size:11px;color:var(--fg-dimmer);font-variant-numeric:tabular-nums;flex:none}
.card footer{display:flex;align-items:baseline;gap:6px}
.sim{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--accent)}
.sub{font-size:10.5px;color:var(--fg-dim)}
.spark{display:block;width:100%;height:62px;overflow:visible}
.spark polyline{fill:none;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.spark .q{stroke:var(--fg-dim);stroke-width:1;opacity:.8;stroke-dasharray:3 2}
.spark .m{stroke:var(--accent);stroke-width:1.6}
.spark .up{stroke:var(--up);stroke-width:1.6}
.spark .down{stroke:var(--down);stroke-width:1.6}
.spark .split{stroke:var(--border-strong);stroke-width:1;stroke-dasharray:2 3}
.cnd{display:block;width:100%;height:88px;overflow:visible}
.cnd .cu{fill:var(--up);stroke:var(--up);stroke-width:1;vector-effect:non-scaling-stroke}
.cnd .cd{fill:var(--down);stroke:var(--down);stroke-width:1;vector-effect:non-scaling-stroke}
.cnd .tail{fill:none;stroke-width:1.4;vector-effect:non-scaling-stroke;stroke-linejoin:round}
.cnd .split{stroke:var(--border-strong);stroke-width:1;stroke-dasharray:2 3;
            vector-effect:non-scaling-stroke}
.query{border:1px solid var(--border-strong);border-radius:3px;padding:14px 16px 10px;
       display:flex;flex-direction:column;gap:8px;background:var(--bg-subtle);margin-top:22px}
.query .cnd{height:150px;max-width:400px}
.query h3{font-size:12px;color:var(--fg-dim);font-weight:500}
.t-sp .cnd{height:66px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;font-weight:600;color:var(--fg-dim);
   padding:0 10px 8px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid var(--grid);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
th.num{text-align:right}
.t-nm{white-space:nowrap}
.t-nm b{font-weight:600}
.t-nm .cd{margin-left:7px}
.t-rg{color:var(--fg-dim);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.t-sp{width:320px;min-width:260px;padding:2px 10px}
td.up{color:var(--up);font-weight:500}
td.down{color:var(--down);font-weight:500}
.two{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-top:18px}
.box{border:1px solid var(--border);border-radius:3px;padding:15px 16px;
     background:var(--bg-subtle);display:flex;flex-direction:column;gap:9px}
.box p{font-size:12.5px;color:var(--fg-dim)}
.mini td{border:0;padding:2px 0;font-size:12.5px}
.mini td:first-child{color:var(--fg);padding-right:14px}
.mini .muted td{color:var(--fg-dim)}
td.acc{color:var(--accent);font-weight:600}
.foot{font-size:11.5px;color:var(--fg-dimmer);border-top:1px solid var(--border);padding-top:14px}
@media (max-width:600px){main{padding:36px 16px 56px;gap:40px}h1{font-size:21px}
  .stats div{flex-basis:50%;border-bottom:1px solid var(--border)}}
"""


_W, _H, _PAD = 260.0, 62.0, 4.0
_MIN_POLYLINE_POINTS = 2


def _path(vals, lo, hi, x0=0.0, x1=_W):
    """값 배열 → SVG polyline points. y 는 [lo,hi] 를 카드 높이에 매핑."""
    n = len(vals)
    if n < _MIN_POLYLINE_POINTS or hi <= lo:
        return ""
    dx = (x1 - x0) / (n - 1)
    return " ".join(
        f"{x0 + i * dx:.1f},{_PAD + (hi - v) / (hi - lo) * (_H - 2 * _PAD):.1f}"
        for i, v in enumerate(vals)
    )


def _spark_now(qz, mz):
    """쿼리 궤적(회색) 위에 매치 궤적(액센트)을 겹친다 — 둘 다 z-정규화 스케일."""
    lo, hi = min(qz.min(), mz.min()), max(qz.max(), mz.max())
    return (
        f'<svg class="spark" viewBox="0 0 {_W:.0f} {_H:.0f}" preserveAspectRatio="none" aria-hidden="true">'
        f'<polyline class="q" points="{_path(qz, lo, hi)}"/>'
        f'<polyline class="m" points="{_path(mz, lo, hi)}"/></svg>'
    )


def _spark_after(mz, az):
    """매치 구간 + **이후 20봉**. 이후를 가격 방향색으로 이어 그린다 — 이 페이지의 질문."""
    lo = min(mz.min(), az.min() if len(az) else mz.min())
    hi = max(mz.max(), az.max() if len(az) else mz.max())
    n_all = len(mz) + len(az)
    split = _W * (len(mz) - 1) / max(n_all - 1, 1)
    up = len(az) > 0 and az[-1] >= mz[-1]
    tail = ""
    if len(az):
        # 이어붙일 때 마지막 점을 공유해야 선이 끊기지 않는다
        joined = np.concatenate([mz[-1:], az])
        tail = (f'<polyline class="{"up" if up else "down"}" '
                f'points="{_path(joined, lo, hi, split, _W)}"/>')
    return (
        f'<svg class="spark" viewBox="0 0 {_W:.0f} {_H:.0f}" preserveAspectRatio="none" aria-hidden="true">'
        f'<line class="split" x1="{split:.1f}" y1="0" x2="{split:.1f}" y2="{_H:.0f}"/>'
        f'<polyline class="m" points="{_path(mz, lo, hi, 0, split)}"/>{tail}</svg>'
    )


_CW, _CHH = 240.0, 88.0          # 캔들 차트 기본 폭·높이


def _candles(c: Corpus, i, j, L, *, w=_CW, ht=_CHH, pad=7, after=0):
    """봉을 **실제 캔들로** 그린다 — 몸통 rect + 위아래 꼬리 line.

    라인 스파크로는 「봉이 닮았는가」 를 판정할 수 없다. 색은 KRX 관례(상승 빨강 ·
    하락 파랑)이고 토큰에서 온다. `after` 봉은 패턴 뒤에 라인으로 이어 붙인다 —
    캔들로 그리면 20봉이 뭉개진다.
    """
    s_ = c.starts[i]
    o, h, lo_, cl = c.raw[:, s_ + j : s_ + j + L]
    tail = c.raw[3, s_ + j + L : min(s_ + j + L + after, c.ends[i])] if after else np.array([])
    lo = min(lo_.min(), tail.min() if len(tail) else lo_.min())
    hi = max(h.max(), tail.max() if len(tail) else h.max())
    if hi <= lo:
        return ""
    # 봉 구간 폭 하한 45% — 비례 배분(7/27=26%)이면 정작 «패턴» 이 안 보인다
    body_w = w * max(0.45, L / (L + len(tail))) if len(tail) else w

    def y(v):
        return pad + (hi - v) / (hi - lo) * (ht - 2 * pad)

    slot = body_w / L
    bw = max(slot * 0.6, 1.2)
    parts = []
    for k in range(L):
        cx = slot * (k + 0.5)
        up = cl[k] >= o[k]
        klass = "cu" if up else "cd"
        top, bot = max(o[k], cl[k]), min(o[k], cl[k])
        bh = max(y(bot) - y(top), 0.9)
        parts.append(
            f'<line class="{klass}" x1="{cx:.1f}" y1="{y(h[k]):.1f}" '
            f'x2="{cx:.1f}" y2="{y(lo_[k]):.1f}"/>'
            f'<rect class="{klass}" x="{cx - bw / 2:.1f}" y="{y(top):.1f}" '
            f'width="{bw:.1f}" height="{bh:.1f}"/>'
        )
    if len(tail):
        dx = (w - body_w) / len(tail)
        pts = " ".join(
            f"{body_w - slot / 2 + dx * (k + 1):.1f},{y(v):.1f}" for k, v in enumerate(tail)
        )
        klass = "cu" if tail[-1] >= cl[-1] else "cd"
        parts.append(f'<line class="split" x1="{body_w:.1f}" y1="0" x2="{body_w:.1f}" y2="{ht:.0f}"/>')
        parts.append(f'<polyline class="tail {klass}" '
                     f'points="{body_w - slot / 2:.1f},{y(cl[-1]):.1f} {pts}"/>')
    return (f'<svg class="cnd" viewBox="0 0 {w:.0f} {ht:.0f}" '
            f'preserveAspectRatio="none" aria-hidden="true">{"".join(parts)}</svg>')


def _fmt(v, digits=1):
    return "—" if v is None else f"{v:+.{digits}f}%"


def _esc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _z(v):
    sd = v.std()
    return (v - v.mean()) / sd if sd > 0 else v - v.mean()


def render_html(c: Corpus, *, code, i_from, i_to, now_res, now_ms, hist, hist_ms,
                baseline, cache_ms, min_tv_eok, no_overlap, top, axis="close",
                standalone=True):
    L = i_to - i_from + 1
    qs = c.starts[c.index_of(code)]
    qz = _z(c.logc[qs + i_from : qs + i_to + 1])
    q_label = f"{c.dates[qs + i_from]} ~ {c.dates[qs + i_to]}"
    bc, bf = baseline

    candle = axis == "candle"
    cards = []
    for sc, i, _j in now_res[:top]:
        e = c.ends[i]
        art = (_candles(c, i, int(e - c.starts[i] - L), L) if candle
               else _spark_now(qz, _z(c.logc[e - L : e])))
        cards.append(
            f'<article class="card"><header><span class="nm">{_esc(c.names.get(c.codes[i], "?"))}</span>'
            f'<span class="cd">{_esc(c.codes[i])}</span></header>{art}'
            f'<footer><span class="sim">{sc:.3f}</span>'
            f'<span class="sub">유사도</span></footer></article>'
        )

    rows = []
    for sc, i, j in hist[:top]:
        s = c.starts[i]
        if candle:
            art = _candles(c, i, j, L, after=20)
        else:
            base_w = c.logc[s + j : s + j + L]
            mz = _z(base_w)
            k = s + j + L
            az = (c.logc[k : min(k + 20, c.ends[i])] - base_w.mean()) / max(base_w.std(), 1e-9)
            art = _spark_after(mz, az)
        f20 = _fwd(c, i, j, L, 20)
        cls = "up" if (f20 or 0) >= 0 else "down"
        rows.append(
            f'<tr><td class="t-nm"><b>{_esc(c.names.get(c.codes[i], "?"))}</b>'
            f'<span class="cd">{_esc(c.codes[i])}</span></td>'
            f'<td class="t-rg">{c.dates[s + j]} ~ {c.dates[s + j + L - 1]}</td>'
            f'<td class="t-sp">{art}</td>'
            f'<td class="num">{sc:.3f}</td>'
            f'<td class="num {cls}">{_fmt(f20)}</td></tr>'
        )

    top_f = np.array([v for v in (_fwd(c, i, j, L, 20) for _, i, j in hist[:50]) if v is not None])
    hero = (f'<div class="query"><h3>기준 봉 — {_esc(c.names.get(code, "?"))} · {L}봉</h3>'
            f'{_candles(c, c.index_of(code), i_from, L, w=560, ht=150)}</div>') if candle else ""
    axis_label = "OHLC 4채널 (시가·고가·저가·종가를 한 스케일로)" if candle else "로그 종가 한 축"
    note_now = ("위 <b>기준 봉</b>과 나란히 놓고 보라. 몸통 길이·꼬리 방향·봉 사이 갭까지 "
                "함께 맞춘 결과다." if candle else
                "점선이 기준 궤적, 굵은 선이 매치 — 겹쳐 그렸으니 닮았는지는 눈이 판정한다.")
    note_hist = ("패턴 봉 뒤에 <b>이어 그린 20봉</b>이 그 다음에 실제로 온 것이다. "
                 "세로선이 패턴의 끝이다." if candle else
                 "패턴 구간 뒤에 <b>이어 그린 20봉</b>이 그 다음에 실제로 온 것이다. "
                 "세로선이 패턴의 끝이다.")
    body = f"""<title>일봉 패턴 검색 실측</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&display=swap">
<style>{_CSS}</style>
<main>
<header class="top">
  <p class="eyebrow">일봉 패턴 검색 · 프로토타입 실측</p>
  <h1>{_esc(c.names.get(code, "?"))} {q_label}{" 의 봉 패턴과" if candle else " 과"} 닮은 것들</h1>
  <p class="lede">기준 구간 <b>{L}봉</b> · 매칭 축 <b>{axis_label}</b> ·
     코퍼스 {len(c.dates):,}행 / {len(c.codes):,}종목 · 최소 평균거래대금 {min_tv_eok:g}억 · ETF 제외</p>
  <dl class="stats">
    <div><dt>지금 닮은 종목</dt><dd>{now_ms:,.0f}<span>ms</span></dd></div>
    <div><dt>과거 전체 검색</dt><dd>{hist_ms:,.0f}<span>ms</span></dd></div>
    <div><dt>비교한 구간</dt><dd>{len(bc):,}<span>개</span></dd></div>
    <div class="muted"><dt>캐시 구축(1회)</dt><dd>{cache_ms:,.0f}<span>ms</span></dd></div>
  </dl>
  {hero}
</header>

<section>
  <h2>지금 같은 {"캔들 모양" if candle else "모양"}인 종목</h2>
  <p class="note">각 종목의 <b>최신 {L}봉</b>만 비교한다. {note_now}
     섹터 정보는 주지 않았다.</p>
  <div class="grid">{"".join(cards)}</div>
</section>

<section>
  <h2>과거에 이 모양이었던 구간{" · 동시대 제외" if no_overlap else ""}</h2>
  <p class="note">{note_hist}</p>
  <div class="scroll"><table>
    <thead><tr><th>종목</th><th>구간</th><th>{"봉 패턴" if candle else "패턴"} → 이후 20봉</th>
      <th class="num">유사도</th><th class="num">+20일</th></tr></thead>
    <tbody>{"".join(rows)}</tbody>
  </table></div>
</section>

<section class="verdict">
  <h2>읽는 법</h2>
  <div class="two">
    <div class="box">
      <h3>유사도는 절대값이 아니다</h3>
      <p>1위 <b>{hist[0][0]:.3f}</b>은 비교한 {len(bc):,}개 구간 중 최고라는 뜻이지
         “{hist[0][0]*100:.0f}% 닮았다”가 아니다. 같은 분포의
         p99 = {np.percentile(bc, 99):.3f}, p99.99 = {np.percentile(bc, 99.99):.3f}.</p>
    </div>
    <div class="box">
      <h3>이후 수익률은 베이스라인과 구별되지 않는다</h3>
      <table class="mini">
        <tr><td>매치 상위 {len(top_f)}개</td><td class="num">{np.median(top_f):+.2f}%</td>
            <td class="num">승률 {(top_f > 0).mean() * 100:.0f}%</td></tr>
        <tr class="muted"><td>전체 구간 베이스라인</td><td class="num">{np.median(bf) * 100:+.2f}%</td>
            <td class="num">승률 {(bf > 0).mean() * 100:.0f}%</td></tr>
      </table>
      <p>두 줄의 차이는 <b>쿼리마다 부호가 뒤집힌다</b> — 대형주 10종목 교차검증에서
         매치가 나은 쪽이 6/10 이었다. 베이스라인 없이 매치 승률만 읽으면 신호로 오해한다.</p>
    </div>
  </div>
</section>
<footer class="foot">tools/bench_pattern_search.py · 읽기 전용 · 수정주가 일봉 코퍼스</footer>
</main>"""
    if not standalone:
        return body
    head, main = body.split("<main>", 1)
    return ('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f"{head}</head><body><main>{main}</body></html>")


def _timed(fn, repeat):
    """검색만 재고 중앙값을 반환 — 이 머신은 dev 서버·병행 세션이 돌아 단발이 흔들린다."""
    ts, res = [], None
    for _ in range(repeat):
        t0 = time.perf_counter()
        res = fn()
        ts.append((time.perf_counter() - t0) * 1000)
    return res, statistics.median(ts), min(ts), max(ts)


def run_query(c, args, cache_ms):
    qi = c.index_of(args.code)
    i_from, i_to = resolve_window(c, qi, args.bars, getattr(args, "from"), args.to)
    L = i_to - i_from + 1
    s = c.starts[qi]
    print(f"\n질의: {args.code} {c.names.get(args.code, '?')}  "
          f"{c.dates[s + i_from]}~{c.dates[s + i_to]}  ({L}봉)")
    ov = " · 동시대 제외" if (args.mode == "history" and args.no_overlap) else ""
    print(f"축: {'OHLC 4채널 (봉 패턴)' if args.axis == 'candle' else '로그 종가 라인'}")
    print(f"필터: 최소평균거래대금 {args.min_tv_eok}억 · "
          f"ETF {'제외' if not args.include_etf else '포함'}{ov}")

    if args.mode == "now":
        res, ms, lo, hi = _timed(
            lambda a=i_from, b=i_to: search_now(c, qi, a, b, axis=args.axis, min_tv_eok=args.min_tv_eok,
                                                exclude_etf=not args.include_etf), args.repeat)
        scores = np.array([r[0] for r in res])
        print(f"\n[캐시 구축] {cache_ms*1000:,.0f} ms  ← CLI 실행마다 드는 고정비. 서버에선 프로세스 1회")
        print(f"[검색]     {ms:,.1f} ms  (min {lo:,.1f} / max {hi:,.1f}, {args.repeat}회 중앙값)")
        print(f"[후보]     {len(res):,} 종목\n")
        print(f"  {'유사도':>7} {'상위':>7}  종목")
        for sc, i, _j in res[: args.top]:
            pct = 100 - (scores < sc).mean() * 100
            print(f"  {sc:7.4f} {pct:6.2f}%  {c.codes[i]} {c.names.get(c.codes[i], '?')}")
        print(f"\n  [분포] p50={np.percentile(scores,50):.3f} p95={np.percentile(scores,95):.3f} "
              f"p99={np.percentile(scores,99):.3f} max={scores.max():.3f}")
        print("  ※ 유사도 절대값을 읽지 말 것 — 위 분포 대비 어디인지가 신호다.")
        return

    (hits, base), ms, lo, hi = _timed(
        lambda: search_history(c, qi, i_from, i_to, axis=args.axis, min_tv_eok=args.min_tv_eok,
                               exclude_etf=not args.include_etf, want_baseline=True,
                               no_overlap=args.no_overlap), args.repeat)
    print(f"\n[캐시 구축] {cache_ms*1000:,.0f} ms  ← CLI 실행마다 드는 고정비. 서버에선 프로세스 1회")
    print(f"[검색]     {ms:,.1f} ms  (min {lo:,.1f} / max {hi:,.1f}, {args.repeat}회 중앙값)")
    bc, bf = base if base else (np.array([0.0]), np.array([0.0]))
    print(f"[후보]     {len(bc):,} 창 / {len(hits):,} 종목\n")
    print(f"  {'유사도':>7}  종목                    구간                      +5d     +20d")
    for sc, i, j in hits[: args.top]:
        f5, f20 = _fwd(c, i, j, L, 5), _fwd(c, i, j, L, 20)
        a = f"{f5:+6.1f}%" if f5 is not None else "   n/a"
        b_ = f"{f20:+6.1f}%" if f20 is not None else "   n/a"
        nm = f"{c.codes[i]} {c.names.get(c.codes[i], '?')}"
        print(f"  {sc:7.4f}  {nm:<22} {_label(c, i, j, L)}  {a}  {b_}")
    top = np.array([v for v in (_fwd(c, i, j, L, 20) for _, i, j in hits[: args.stat_n]) if v is not None])
    # 백분율은 여기서 무의미하다(350만 창 중 1위 = 0.00003%). **순위/모수**로 찍는다.
    rank = int((bc >= hits[0][0]).sum())
    p9999 = np.percentile(bc, 99.99)
    print(f"\n  [유사도 분포] p50={np.percentile(bc,50):.3f} p99={np.percentile(bc,99):.3f} "
          f"p99.99={p9999:.3f}")
    print(f"                1위 {hits[0][0]:.4f} = 후보창 {len(bc):,}개 중 {rank}위 "
          f"(p99.99 대비 {hits[0][0]-p9999:+.3f})")
    print(f"  [이후 20일] 매치 top{len(top)}: 중앙값 {np.median(top):+.2f}% · 승률 {(top>0).mean()*100:.0f}%")
    print(f"              전체 베이스라인: 중앙값 {np.median(bf)*100:+.2f}% · 승률 {(bf>0).mean()*100:.0f}%")
    print("  ※ 둘을 나란히 볼 것 — 베이스라인 없이 매치 승률만 읽으면 반드시 오독한다.")


def run_bench(c, args, cache_ms):
    print(f"\n[캐시 구축] {cache_ms*1000:,.0f} ms  ← 아래 표와 별개인 1회 비용\n")
    qi = c.index_of(args.code or "005930")
    print(f"기준 종목: {c.codes[qi]} {c.names.get(c.codes[qi], '?')} · "
          f"최소평균거래대금 {args.min_tv_eok}억 · {args.repeat}회 중앙값\n")
    print(f"  {'봉수':>5} {'now':>12} {'history':>12}   {'now 후보':>10} {'history 후보':>14}")
    n = c.ends[qi] - c.starts[qi]
    for L in (20, 60, 120, 250):
        i_from, i_to = n - L, n - 1
        rn, mn, _, _ = _timed(
            lambda a=i_from, b=i_to: search_now(c, qi, a, b, axis=args.axis, min_tv_eok=args.min_tv_eok,
                                                exclude_etf=not args.include_etf), args.repeat)
        (rh, bh), mh, _, _ = _timed(
            lambda a=i_from, b=i_to: search_history(c, qi, a, b, axis=args.axis, min_tv_eok=args.min_tv_eok,
                                                    exclude_etf=not args.include_etf,
                                                    want_baseline=True), args.repeat)
        nb = len(bh[0]) if bh else 0
        print(f"  {L:5d} {mn:10.1f}ms {mh:10.1f}ms   {len(rn):10,} {nb:14,}")
    print("\n  now = 각 종목 최신 L봉만 (종목당 창 1개) · history = 전 기간 슬라이딩")


def run_html(c: Corpus, args, cache_ms: float) -> None:
    """HTML 리포트는 **두 모드를 함께** 담는다 — 하나만으로는 판정이 안 된다."""
    qi = c.index_of(args.code)
    i_from, i_to = resolve_window(c, qi, args.bars, getattr(args, "from"), args.to)
    now_res, now_ms, _, _ = _timed(
        lambda: search_now(c, qi, i_from, i_to, axis=args.axis, min_tv_eok=args.min_tv_eok,
                           exclude_etf=not args.include_etf), args.repeat)
    (hits, base), hist_ms, _, _ = _timed(
        lambda: search_history(c, qi, i_from, i_to, axis=args.axis, min_tv_eok=args.min_tv_eok,
                               exclude_etf=not args.include_etf, want_baseline=True,
                               no_overlap=args.no_overlap), args.repeat)
    html = render_html(c, code=args.code, i_from=i_from, i_to=i_to,
                       now_res=now_res, now_ms=now_ms, hist=hits, hist_ms=hist_ms,
                       baseline=base, cache_ms=cache_ms * 1000,
                       min_tv_eok=args.min_tv_eok, no_overlap=args.no_overlap,
                       top=args.top, axis=args.axis,
                       standalone=not args.html_fragment)
    out = Path(args.html)
    out.write_text(html, encoding="utf-8")
    print(f"\n[캐시 구축] {cache_ms*1000:,.0f} ms  ← CLI 고정비")
    print(f"[검색] now {now_ms:,.1f} ms · history {hist_ms:,.1f} ms")
    print(f"[HTML] {out}  ({out.stat().st_size/1024:.0f} KB, "
          f"now {min(args.top, len(now_res))}개 · history {min(args.top, len(hits))}개)")



def _compare_rows(c: Corpus, args, lengths):
    """길이별 now/history 를 한 프로세스에서 돌려 비교 가능한 행 목록으로."""
    qi = c.index_of(args.code)
    n = int(c.ends[qi] - c.starts[qi])
    out = []
    for L in lengths:
        i_from, i_to = n - L, n - 1
        now, now_ms, _, _ = _timed(
            lambda a=i_from, b=i_to: search_now(c, qi, a, b, axis=args.axis,
                                                min_tv_eok=args.min_tv_eok,
                                                exclude_etf=not args.include_etf), args.repeat)
        (hits, base), h_ms, _, _ = _timed(
            lambda a=i_from, b=i_to: search_history(c, qi, a, b, axis=args.axis,
                                                    min_tv_eok=args.min_tv_eok,
                                                    exclude_etf=not args.include_etf,
                                                    want_baseline=True,
                                                    no_overlap=args.no_overlap), args.repeat)
        out.append({"L": L, "i_from": i_from, "i_to": i_to, "now": now, "now_ms": now_ms,
                    "hist": hits, "hist_ms": h_ms, "bc": base[0], "bf": base[1]})
    return qi, out


def run_compare(c: Corpus, args, cache_ms: float) -> None:
    lengths = [int(v) for v in args.compare.split(",")]
    bad = [v for v in lengths if v < _MIN_QUERY_BARS]
    if bad:
        sys.exit(f"봉수는 {_MIN_QUERY_BARS} 이상이어야 한다: {bad}")
    qi, rows = _compare_rows(c, args, lengths)
    print(f"\n기준 {args.code} {c.names.get(args.code, '?')} · "
          f"축 {'OHLC 4채널' if args.axis == 'candle' else '종가 라인'} · "
          f"최소평균거래대금 {args.min_tv_eok:g}억")
    print(f"[캐시 구축] {cache_ms*1000:,.0f} ms  ← 아래 표와 별개인 1회 비용\n")
    print(f"  {'봉수':>4}{'now':>8}{'history':>10}{'후보창':>12}"
          f"{'1위':>8}{'p99':>8}{'p99.99':>9}{'여유':>8}  now 1위")
    for r in rows:
        bc, hit = r["bc"], r["hist"][0][0]
        p9999 = np.percentile(bc, 99.99)
        top_now = r["now"][0]
        print(f"  {r['L']:4d}{r['now_ms']:6.0f}ms{r['hist_ms']:8.0f}ms{len(bc):12,}"
              f"{hit:8.3f}{np.percentile(bc,99):8.3f}{p9999:9.3f}{hit-p9999:+8.3f}"
              f"  {top_now[0]:.3f} {c.codes[top_now[1]]} {c.names.get(c.codes[top_now[1]], '?')}")
    print("\n  여유 = history 1위 − p99.99. 클수록 «우연히 닮은 것들» 에서 확실히 떨어져 나온다.")
    if args.html:
        html = render_compare_html(c, code=args.code, rows=rows, cache_ms=cache_ms * 1000,
                                   min_tv_eok=args.min_tv_eok, no_overlap=args.no_overlap,
                                   axis=args.axis, top=args.top,
                                   standalone=not args.html_fragment)
        Path(args.html).write_text(html, encoding="utf-8")
        print(f"\n[HTML] {args.html}")


def render_compare_html(c: Corpus, *, code, rows, cache_ms, min_tv_eok, no_overlap,
                        axis, top, standalone=True):
    """길이 비교 리포트 — 같은 질문을 봉수만 바꿔 던진 결과를 나란히 놓는다."""
    candle = axis == "candle"
    name = _esc(c.names.get(code, "?"))
    qi = c.index_of(code)
    trs, secs = [], []
    for r in rows:
        L, bc = r["L"], r["bc"]
        hit, p9999 = r["hist"][0][0], np.percentile(bc, 99.99)
        tn = r["now"][0]
        trs.append(
            f'<tr><td class="t-nm"><b>{L}봉</b></td>'
            f'<td class="num">{r["now_ms"]:.0f} ms</td><td class="num">{r["hist_ms"]:.0f} ms</td>'
            f'<td class="num">{len(bc):,}</td><td class="num">{hit:.3f}</td>'
            f'<td class="num">{p9999:.3f}</td><td class="num acc">{hit - p9999:+.3f}</td>'
            f'<td class="t-nm">{tn[0]:.3f} {_esc(c.names.get(c.codes[tn[1]], "?"))}</td></tr>'
        )
        cards = []
        for sc, i, _j in r["now"][:top]:
            e = c.ends[i]
            art = (_candles(c, i, int(e - c.starts[i] - L), L) if candle
                   else _spark_now(_z(c.logc[c.starts[qi] + r["i_from"]: c.starts[qi] + r["i_to"] + 1]),
                                   _z(c.logc[e - L : e])))
            cards.append(
                f'<article class="card"><header><span class="nm">'
                f'{_esc(c.names.get(c.codes[i], "?"))}</span>'
                f'<span class="cd">{_esc(c.codes[i])}</span></header>{art}'
                f'<footer><span class="sim">{sc:.3f}</span><span class="sub">유사도</span>'
                f'</footer></article>')
        hero = (f'<div class="query"><h3>기준 봉 — {name} · 최근 {L}봉 '
                f'({c.dates[c.starts[qi] + r["i_from"]]} ~ {c.dates[c.starts[qi] + r["i_to"]]})</h3>'
                f'{_candles(c, qi, r["i_from"], L, w=80.0 * L, ht=140)}</div>') if candle else ""
        secs.append(
            f'<section><h2>{L}봉</h2>{hero}'
            f'<p class="note">지금 같은 모양인 종목 상위 {len(cards)}개 · '
            f'검색 {r["now_ms"]:.0f} ms · 후보 {len(r["now"]):,}종목</p>'
            f'<div class="grid">{"".join(cards)}</div></section>')

    body = f"""<title>봉 패턴 길이 비교</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&display=swap">
<style>{_CSS}</style>
<main>
<header class="top">
  <p class="eyebrow">일봉 패턴 검색 · 봉수 비교</p>
  <h1>{name}로 던진 같은 질문, 봉수만 {" · ".join(str(r["L"]) + "봉" for r in rows)}</h1>
  <p class="lede">매칭 축 <b>{"OHLC 4채널" if candle else "로그 종가"}</b> ·
     코퍼스 {len(c.dates):,}행 / {len(c.codes):,}종목 · 최소 평균거래대금 {min_tv_eok:g}억 ·
     ETF 제외{" · 동시대 제외" if no_overlap else ""}</p>
  <div class="scroll"><table>
    <thead><tr><th>봉수</th><th class="num">지금 닮은 종목</th><th class="num">과거 전체</th>
      <th class="num">비교한 구간</th><th class="num">1위</th><th class="num">p99.99</th>
      <th class="num">여유</th><th>지금 1위 종목</th></tr></thead>
    <tbody>{"".join(trs)}</tbody>
  </table></div>
  <p class="note" style="margin-top:14px"><b>여유</b> = 과거 전체 검색의 1위 유사도 − p99.99.
     클수록 그 1위가 “우연히 닮은 것들”의 무리에서 확실히 떨어져 나온다는 뜻이다.
     캐시 구축 {cache_ms:,.0f} ms 는 CLI 실행마다 드는 고정비로, 위 검색 시간과 별개다.</p>
</header>
{"".join(secs)}
<footer class="foot">tools/bench_pattern_search.py --compare · 읽기 전용 · 수정주가 일봉 코퍼스</footer>
</main>"""
    if not standalone:
        return body
    head, main = body.split("<main>", 1)
    return ('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f"{head}</head><body><main>{main}</body></html>")



def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("code", nargs="?", help="종목코드 (예: 005930)")
    p.add_argument("--mode", choices=("now", "history"), default="now")
    p.add_argument("--axis", choices=("candle", "close"), default="candle",
                   help="candle=OHLC 4채널 봉 패턴(기본) · close=종가 라인")
    p.add_argument("--bars", type=int, default=None,
                   help="최근 N봉을 쿼리 구간으로 (기본: candle 7 · close 60)")
    p.add_argument("--from", dest="from", help="구간 시작 YYYYMMDD (--to 와 함께)")
    p.add_argument("--to", help="구간 끝 YYYYMMDD")
    p.add_argument("--top", type=int, default=15)
    p.add_argument("--min-tv-eok", type=float, default=10.0, dest="min_tv_eok",
                   help="최소 평균 거래대금(억). 0 이면 필터 없음")
    p.add_argument("--include-etf", action="store_true")
    p.add_argument("--no-overlap", action="store_true", dest="no_overlap",
                   help="history: 쿼리와 날짜가 겹치는 창 제외 (= 과거 사례만 본다)")
    p.add_argument("--repeat", type=int, default=3, help="검색 반복 횟수(중앙값 보고)")
    p.add_argument("--stat-n", type=int, default=50, dest="stat_n",
                   help="history 이후수익률 통계 표본 수")
    p.add_argument("--bench", action="store_true", help="L × 모드 속도 매트릭스")
    p.add_argument("--compare", help="봉수를 쉼표로 (예: 5,7,10) — 같은 질문을 길이만 바꿔 비교")
    p.add_argument("--html", type=Path, help="결과를 HTML 리포트로 저장 (두 모드를 함께 담는다)")
    p.add_argument("--html-fragment", action="store_true", dest="html_fragment",
                   help="html 껍데기 없이 본문만 (아티팩트 발행용)")
    p.add_argument("--data-dir", type=Path, default=None)
    args = p.parse_args()
    if args.bars is None:
        # 축마다 자연스러운 길이가 다르다 — 봉 패턴은 5~10봉, 종가 궤적은 수십 봉.
        args.bars = 7 if args.axis == "candle" else 60
    if not args.bench and not args.code:
        p.error("종목코드를 주거나 --bench 를 쓸 것")

    data_dir = args.data_dir or resolve_data_dir()
    print(f"코퍼스: {data_dir / 'screener' / 'daily_adjusted.parquet'}")
    c, cache_s = load_corpus(data_dir)
    print(f"        {len(c.dates):,}행 · {len(c.codes):,}종목 · "
          f"{c.dates.min()}~{c.dates.max()}")
    if args.compare:
        run_compare(c, args, cache_s)
    elif args.html:
        run_html(c, args, cache_s)
    else:
        (run_bench if args.bench else run_query)(c, args, cache_s)


if __name__ == "__main__":
    main()
