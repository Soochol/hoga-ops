"""매수 총잔량 급증 이벤트(10일 peak 대비 1.5×) 이후 주가 흐름 — 이벤트 스터디.

`docs/research/2026-09-03-bid-depth-surge-event-study.md` 의 수치를 재현한다.

이벤트 정의는 스크리너 ``bid_depth_new_high`` (lookback=10, threshold_pct=150) 를
**그대로 미러**한다 — `depth_daily.select_with_fallback` 로 (code,date)당 1행을 고르고,
직전 10 **코퍼스 거래일**(D 제외)의 ``bid_peak`` 최댓값을 기준선으로 쓴다.
``bid_peak`` 는 :func:`hoga.tables.snapshots.query_daily_depth_peak` 의 정의
(연속거래 호가창 · 정규장 구간 · 10단계 합의 당일 최댓값)다.

사용:
    uv run --extra dev python tools/study_bid_depth_surge.py \\
        --data-dir ~/.local/share/hoga-ops/data \\
        --index-json-dir docs/research/assets/2026-09-03-bid-depth-surge \\
        --out-dir /tmp/bid-depth-surge

``--index-json-dir`` 에는 ``index_KOSPI.json`` / ``index_KOSDAQ.json`` 이 있어야 한다 —
사용자 dev 서버의 ``GET /api/live/index-candles?index_id=KOSPI&timeframe=D&from=..&to=..``
응답을 그대로 저장한 것이다(워크트리 백엔드는 무자격이라 지수 일봉을 못 받는다).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from collections import Counter
from pathlib import Path

import numpy as np
import polars as pl

from hoga.api import depth_daily

HORIZONS = (1, 3, 5, 10, 20)
FWD_WINDOW = 10           # 지지/저항·MFE/MAE 판정 창(거래일)
RESIST_LOOKBACK = 20      # 저항 = 직전 20거래일 고가
MA_PERIODS = (5, 20, 60, 120)
RS_PERIOD = 120           # 주도주 = 120거래일 수익률 상위
RS_TOP_PCT = 0.80         # 상위 20 %
ADV_FLOOR_KRW = 5e9       # 주도주 유니버스 유동성 하한(20일 평균 거래대금 50억)
N_BOOT = 2000
SEED = 0
MIN_N_FOR_CI = 5          # 이보다 적으면 부트스트랩 구간을 내지 않는다
RATIO_BUCKET_HI = 3.0     # ratio 구간 경계(≥3.0× / 2.0–3.0× / 1.5–2.0×)
RATIO_BUCKET_MID = 2.0
HI52_NEAR = 0.95          # 52주 고가 대비 위치 구간 경계
HI52_MID = 0.80
QUANTILES = (0.1, 0.25, 0.5, 0.75, 0.9)


# ── 적재 ──────────────────────────────────────────────────────────────────────

def load_depth(data_dir: Path) -> pl.DataFrame:
    dd = depth_daily.select_with_fallback(depth_daily.load(data_dir))
    return dd.select("code", "date", "src", "bid_peak", "ask_peak", "eligible_count")


def load_stocks(data_dir: Path) -> pl.DataFrame:
    return pl.read_parquet(data_dir / "screener" / "stocks.parquet").select("code", "name", "market", "is_etf")


def load_daily(data_dir: Path, *, since: dt.date) -> pl.DataFrame:
    df = pl.read_parquet(data_dir / "screener" / "daily_adjusted.parquet")
    df = df.filter(
        (pl.col("date") >= since) & pl.col("code").str.contains(r"^[0-9]{6}$"),
    )
    return df.sort(["code", "date"])


def load_factor_boundaries(data_dir: Path) -> pl.DataFrame:
    """(code, seg_start) — 수정계수 세그먼트 경계. 경계가 기준선 창 안에 있으면 depth
    ratio 가 주식 수 변동으로 왜곡될 수 있어 이벤트에서 뺀다."""
    f = pl.read_parquet(data_dir / "screener" / "factors.parquet")
    return f.select("code", pl.col("seg_start").alias("date")).unique()


def load_index(index_json_dir: Path, name: str) -> pl.DataFrame:
    body = json.loads((index_json_dir / f"index_{name}.json").read_text(encoding="utf-8"))
    rows = [
        {
            "date": dt.datetime.fromtimestamp(c["t_ms"] / 1000, tz=dt.UTC).date(),
            "open": float(c["open"]), "high": float(c["high"]),
            "low": float(c["low"]), "close": float(c["close"]),
        }
        for c in body["candles"]
    ]
    df = pl.DataFrame(rows).sort("date")
    return df.with_columns(
        (pl.col("close") / pl.col("close").shift(1) - 1).alias("ix_ret1"),
        ((pl.col("close") - pl.col("open")) / pl.col("open")).alias("ix_body"),
        (pl.col("close") / pl.col("close").shift(5) - 1).alias("ix_ret5_pre"),
        (pl.col("close") / pl.col("close").shift(20) - 1).alias("ix_ret20_pre"),
        (pl.col("close") > pl.col("close").rolling_mean(20)).alias("ix_above_ma20"),
        (pl.col("close") > pl.col("close").rolling_mean(60)).alias("ix_above_ma60"),
        *[(pl.col("close").shift(-h) / pl.col("close") - 1).alias(f"ix_fwd{h}") for h in HORIZONS],
    ).with_columns(pl.lit(name).alias("market"))


def load_user_leaders(data_dir: Path, folder: str = "주도주 공부") -> set[str]:
    path = data_dir / "watchlist.json"
    if not path.exists():
        return set()
    body = json.loads(path.read_text(encoding="utf-8"))
    for f in body.get("folders", []):
        if f.get("name") == folder:
            return {it["code"] for it in f.get("items", []) if isinstance(it, dict) and it.get("code")}
    return set()


# ── 가격 피처(시점 정합: 모두 D 이하 정보 + 명시된 forward 열) ──────────────────

def price_features(daily: pl.DataFrame) -> pl.DataFrame:
    g = pl.col("code")
    tv = pl.col("close") * pl.col("volume")
    exprs = [
        (pl.col("close") / pl.col("close").shift(1).over(g) - 1).alias("ret_d"),
        ((pl.col("close") - pl.col("open")) / pl.col("open")).alias("body_d"),
        (pl.col("close") / pl.col("close").shift(5).over(g) - 1).alias("ret5_pre"),
        (pl.col("close") / pl.col("close").shift(20).over(g) - 1).alias("ret20_pre"),
        (pl.col("close") / pl.col("close").shift(RS_PERIOD).over(g) - 1).alias("ret_rs"),
        tv.rolling_mean(20).over(g).alias("adv20"),
        (pl.col("volume") / pl.col("volume").shift(1).rolling_mean(20).over(g)).alias("vol_ratio20"),
        pl.col("high").rolling_max(250).over(g).alias("hi52"),
        pl.col("high").shift(1).rolling_max(RESIST_LOOKBACK).over(g).alias("prior_hi20"),
        # forward: 다음 h 거래일 종가 / D 종가
        *[(pl.col("close").shift(-h).over(g) / pl.col("close") - 1).alias(f"fwd{h}") for h in HORIZONS],
        # 다음날 시가 진입 기준
        *[(pl.col("close").shift(-h).over(g) / pl.col("open").shift(-1).over(g) - 1).alias(f"fwd{h}_o")
          for h in HORIZONS],
        (pl.col("open").shift(-1).over(g) / pl.col("close") - 1).alias("gap_next"),
        # D+1..D+10 창의 최고가/최저가/최저종가
        pl.col("high").shift(-FWD_WINDOW).rolling_max(FWD_WINDOW).over(g).alias("fwd_max_high"),
        pl.col("low").shift(-FWD_WINDOW).rolling_min(FWD_WINDOW).over(g).alias("fwd_min_low"),
        pl.col("close").shift(-FWD_WINDOW).rolling_min(FWD_WINDOW).over(g).alias("fwd_min_close"),
    ]
    exprs += [pl.col("close").rolling_mean(p).over(g).alias(f"ma{p}") for p in MA_PERIODS]
    df = daily.with_columns(exprs)
    df = df.with_columns(
        (pl.col("fwd_max_high") / pl.col("close") - 1).alias("mfe10"),
        (pl.col("fwd_min_low") / pl.col("close") - 1).alias("mae10"),
        (pl.col("fwd_min_low") >= pl.col("low")).alias("support_low_held"),
        (pl.col("fwd_min_close") >= pl.col("low")).alias("support_close_held"),
        (pl.col("fwd_max_high") > pl.col("prior_hi20")).alias("resist_broken"),
        (pl.col("close") > pl.col("prior_hi20")).alias("breakout_on_d"),
        (pl.col("close") / pl.col("hi52")).alias("pct_of_hi52"),
        *[(pl.col("close") > pl.col(f"ma{p}")).alias(f"above_ma{p}") for p in MA_PERIODS],
        ((pl.col("ma5") > pl.col("ma20")) & (pl.col("ma20") > pl.col("ma60"))).alias("ma_bull_align"),
    )
    return df


def rs_percentile(df: pl.DataFrame, stocks: pl.DataFrame) -> pl.DataFrame:
    """D 시점 유동성 유니버스(비ETF · adv20 ≥ floor) 안에서 120일 수익률 백분위."""
    uni = df.join(stocks.select("code", "is_etf"), on="code", how="left")
    uni = uni.filter(
        (~pl.col("is_etf").fill_null(False)) & (pl.col("adv20") >= ADV_FLOOR_KRW) & pl.col("ret_rs").is_not_null(),
    )
    ranked = uni.with_columns(
        (pl.col("ret_rs").rank("average").over("date") / pl.col("ret_rs").count().over("date")).alias("rs_pct"),
    ).select("code", "date", "rs_pct")
    return df.join(ranked, on=["code", "date"], how="left")


# ── 이벤트 추출 ───────────────────────────────────────────────────────────────

def build_event_table(
    dd: pl.DataFrame, corpus: list[str], *, lookback: int, start: str, end: str,
) -> pl.DataFrame:
    """(code, D) 마다 기준선(직전 lookback 코퍼스 거래일의 bid_peak max), 보유일수,
    소스 구성, 최소 eligible_count 를 붙인다. 판정은 호출자가 한다."""
    idx = {d: i for i, d in enumerate(corpus)}
    by_code: dict[str, dict[str, tuple[str, int, int]]] = {}
    for code, date, src, bid, elig in dd.select("code", "date", "src", "bid_peak", "eligible_count").iter_rows():
        by_code.setdefault(code, {})[date] = (src, int(bid), int(elig))
    rows = []
    for code, days in by_code.items():
        for date, (src, bid, elig) in days.items():
            if date < start or date > end or date not in idx:
                continue
            i = idx[date]
            window = corpus[max(0, i - lookback):i]
            base = [days[d] for d in window if d in days]
            if not base:
                continue
            base_peak = max(b[1] for b in base)
            rows.append({
                "code": code, "date": date, "src": src, "bid_peak": bid, "eligible_count": elig,
                "base_peak": base_peak, "have_days": len(base),
                "base_all_hogaplay": all(b[0] == "hogaplay" for b in base),
                "base_min_eligible": min(b[2] for b in base),
                "ratio": bid / base_peak if base_peak > 0 else None,
            })
    return pl.DataFrame(rows)


def dedup_cooldown(ev: pl.DataFrame, corpus: list[str], cooldown: int) -> pl.DataFrame:
    idx = {d: i for i, d in enumerate(corpus)}
    keep = []
    last: dict[str, int] = {}
    for code, date in ev.sort(["code", "date"]).select("code", "date").iter_rows():
        i = idx[date]
        if code in last and i - last[code] <= cooldown:
            keep.append(False)
            continue
        last[code] = i
        keep.append(True)
    return ev.sort(["code", "date"]).filter(pl.Series(keep))


def peak_time_of_day(data_dir: Path, code: str, date: str) -> str | None:
    """hogaplay 1분 캐시의 bid_max(Intra-Bar Max) argmax → HH:MM. 없으면 None."""
    p = data_dir / "kis-past-indicators" / code / "hogaplay" / f"{date}.ratio.json"
    if not p.exists():
        return None
    try:
        rows = json.loads(p.read_text(encoding="utf-8")).get("rows") or []
    except (OSError, json.JSONDecodeError):
        return None
    best = max(rows, key=lambda r: r[3], default=None)
    if best is None or best[3] <= 0:
        return None
    ms = int(best[0])
    return f"{ms // 3_600_000:02d}:{(ms % 3_600_000) // 60_000:02d}"


# ── 통계 ─────────────────────────────────────────────────────────────────────

def _boot_diff(ev: np.ndarray, ev_code: np.ndarray, bl: np.ndarray, bl_code: np.ndarray, rng) -> tuple[float, float]:
    """종목 클러스터 부트스트랩(종목 재표집) — 평균 차이의 95 % 구간."""
    codes = np.unique(np.concatenate([ev_code, bl_code]))
    ev_groups = {c: ev[ev_code == c] for c in codes}
    bl_groups = {c: bl[bl_code == c] for c in codes}
    diffs = []
    for _ in range(N_BOOT):
        sample = rng.choice(codes, size=len(codes), replace=True)
        e = np.concatenate([ev_groups[c] for c in sample])
        b = np.concatenate([bl_groups[c] for c in sample])
        if len(e) == 0 or len(b) == 0:
            continue
        diffs.append(e.mean() - b.mean())
    return float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))


def _mean(s: pl.Series) -> float | None:
    v = s.cast(pl.Float64).drop_nulls()
    return float(v.mean()) if v.len() else None  # type: ignore[arg-type]


def describe(ev: pl.DataFrame, bl: pl.DataFrame, col: str, rng) -> dict:
    e = ev.filter(pl.col(col).is_not_null())
    b = bl.filter(pl.col(col).is_not_null())
    ev_v = e[col].cast(pl.Float64).to_numpy()
    bl_v = b[col].cast(pl.Float64).to_numpy()
    out = {
        "n_event": int(len(ev_v)), "n_base": int(len(bl_v)),
        "event_mean": float(ev_v.mean()) if len(ev_v) else None,
        "event_median": float(np.median(ev_v)) if len(ev_v) else None,
        "event_win": float((ev_v > 0).mean()) if len(ev_v) else None,
        "base_mean": float(bl_v.mean()) if len(bl_v) else None,
        "base_median": float(np.median(bl_v)) if len(bl_v) else None,
        "base_win": float((bl_v > 0).mean()) if len(bl_v) else None,
    }
    if len(ev_v):
        out["event_q"] = [float(x) for x in np.quantile(ev_v, QUANTILES)]
    if len(bl_v):
        out["base_q"] = [float(x) for x in np.quantile(bl_v, QUANTILES)]
    if len(ev_v) >= MIN_N_FOR_CI and len(bl_v) >= MIN_N_FOR_CI:
        lo, hi = _boot_diff(ev_v, e["code"].to_numpy(), bl_v, b["code"].to_numpy(), rng)
        out["diff"] = out["event_mean"] - out["base_mean"]
        out["diff_ci95"] = [lo, hi]
    return out


def conditional(ev: pl.DataFrame, bl: pl.DataFrame, by: str, cols: tuple[str, ...], rng) -> dict:
    res = {}
    for key in sorted(ev[by].drop_nulls().unique().to_list(), key=str):
        e = ev.filter(pl.col(by) == key)
        b = bl.filter(pl.col(by) == key) if by in bl.columns else bl
        res[str(key)] = {c: describe(e, b, c, rng) for c in cols}
    return res


# ── 메인 ─────────────────────────────────────────────────────────────────────

def main() -> None:  # noqa: PLR0915 — 스터디 스크립트의 단일 조립점
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, required=True)
    ap.add_argument("--index-json-dir", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--start", default="20250903")
    ap.add_argument("--end", default="20260902")
    ap.add_argument("--ratio", type=float, default=1.5)
    ap.add_argument("--lookback", type=int, default=10)
    ap.add_argument("--min-have-days", type=int, default=9)
    ap.add_argument("--min-eligible", type=int, default=1000)
    ap.add_argument("--cooldown", type=int, default=10)
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)

    stocks = load_stocks(args.data_dir)
    daily = load_daily(args.data_dir, since=dt.date(2024, 6, 1))
    corpus = sorted(daily["date"].unique().dt.strftime("%Y%m%d").to_list())
    feats = rs_percentile(price_features(daily), stocks)
    feats = feats.with_columns(pl.col("date").dt.strftime("%Y%m%d").alias("d8"))
    dd = load_depth(args.data_dir)
    bounds = load_factor_boundaries(args.data_dir).with_columns(pl.col("date").dt.strftime("%Y%m%d").alias("d8"))
    leaders_user = load_user_leaders(args.data_dir)
    ix = pl.concat([load_index(args.index_json_dir, "KOSPI"), load_index(args.index_json_dir, "KOSDAQ")])
    ix = ix.with_columns(pl.col("date").dt.strftime("%Y%m%d").alias("d8")).drop("date")

    # 1) 판정 가능한 전체 (code, D) 표
    table = build_event_table(dd, corpus, lookback=args.lookback, start=args.start, end=args.end)
    guards: dict[str, int] = {"candidates": table.height}
    table = table.join(stocks, on="code", how="left").filter(~pl.col("is_etf").fill_null(False))
    guards["after_etf_filter"] = table.height
    table = table.filter(pl.col("have_days") >= args.min_have_days)
    guards["after_coverage"] = table.height
    same_src = (pl.col("src") == "hogaplay") & pl.col("base_all_hogaplay")
    table = table.with_columns(same_src.alias("same_source"))
    table = table.filter(
        (pl.col("eligible_count") >= args.min_eligible) & (pl.col("base_min_eligible") >= args.min_eligible),
    )
    guards["after_min_eligible"] = table.height
    # 수정계수 경계가 [D-lookback, D] 안에 있으면 제외(주식 수 변동 → depth ratio 왜곡)
    idx = {d: i for i, d in enumerate(corpus)}
    bset = {(c, d) for c, d in bounds.select("code", "d8").iter_rows()}

    def _boundary_in_window(code: str, date: str) -> bool:
        i = idx[date]
        return any((code, corpus[j]) in bset for j in range(max(0, i - args.lookback), i + 1))

    flag = [not _boundary_in_window(c, d) for c, d in table.select("code", "date").iter_rows()]
    table = table.filter(pl.Series(flag))
    guards["after_split_guard"] = table.height

    table = table.join(feats.drop("date"), left_on=["code", "date"], right_on=["code", "d8"], how="left")
    table = table.join(ix, left_on=["market", "date"], right_on=["market", "d8"], how="left")
    table = table.with_columns(
        (pl.col("rs_pct") >= RS_TOP_PCT).alias("leader_rs"),
        pl.col("code").is_in(sorted(leaders_user)).alias("leader_user"),
        pl.when(pl.col("rs_pct") >= RS_TOP_PCT).then(pl.lit("주도주(RS상위20%)"))
          .when(pl.col("rs_pct").is_not_null()).then(pl.lit("비주도주"))
          .otherwise(pl.lit("유니버스 밖")).alias("leader_bucket"),
        pl.when(pl.col("ratio") >= RATIO_BUCKET_HI).then(pl.lit("≥3.0×"))
          .when(pl.col("ratio") >= RATIO_BUCKET_MID).then(pl.lit("2.0–3.0×"))
          .when(pl.col("ratio") >= args.ratio).then(pl.lit("1.5–2.0×"))
          .otherwise(pl.lit("<1.5×")).alias("ratio_bucket"),
        pl.when(pl.col("ix_ret5_pre") > 0).then(pl.lit("지수 5일 상승")).otherwise(pl.lit("지수 5일 하락"))
          .alias("ix_mom5"),
        pl.when(pl.col("ix_ret1") > 0).then(pl.lit("지수 양봉")).otherwise(pl.lit("지수 음봉")).alias("ix_candle"),
        pl.when(pl.col("ix_above_ma20")).then(pl.lit("지수>MA20")).otherwise(pl.lit("지수<MA20")).alias("ix_trend"),
        pl.when(pl.col("ret_d") > 0).then(pl.lit("당일 양봉")).otherwise(pl.lit("당일 음봉")).alias("d_candle"),
        pl.when(pl.col("ma_bull_align")).then(pl.lit("정배열")).otherwise(pl.lit("비정배열")).alias("ma_state"),
        pl.when(pl.col("above_ma20") & pl.col("above_ma60")).then(pl.lit("MA20·60 위"))
          .when(pl.col("above_ma20")).then(pl.lit("MA20 위·MA60 아래"))
          .otherwise(pl.lit("MA20 아래")).alias("ma_pos"),
        pl.when(pl.col("pct_of_hi52") >= HI52_NEAR).then(pl.lit("52주 고가 5% 이내"))
          .when(pl.col("pct_of_hi52") >= HI52_MID).then(pl.lit("52주 고가 5–20% 아래"))
          .otherwise(pl.lit("52주 고가 20%+ 아래")).alias("hi52_pos"),
        *[(pl.col(f"fwd{h}") - pl.col(f"ix_fwd{h}")).alias(f"xs{h}") for h in HORIZONS],
    )

    # 2) 이벤트 / 기준군
    is_event = pl.col("ratio") >= args.ratio
    events_raw = table.filter(is_event & pl.col("same_source"))
    guards["events_same_source_raw"] = events_raw.height
    events_fallback = table.filter(is_event & ~pl.col("same_source"))
    guards["events_with_fallback_source"] = events_fallback.height
    events = dedup_cooldown(events_raw, corpus, args.cooldown)
    guards["events_after_cooldown"] = events.height
    guards["event_codes"] = events["code"].n_unique()

    # 기준군: 같은 판정 가능 조건을 지나면서 ratio < 임계, 그리고 이벤트 후 10일 창 밖
    post = set()
    for code, date in events.select("code", "date").iter_rows():
        i = idx[date]
        post.update((code, corpus[j]) for j in range(i, min(len(corpus), i + FWD_WINDOW + 1)))
    base = table.filter(~is_event & pl.col("same_source"))
    base = base.filter(pl.Series([(c, d) not in post for c, d in base.select("code", "date").iter_rows()]))
    guards["baseline_days"] = base.height
    base_same_stock = base.filter(pl.col("code").is_in(events["code"].unique().to_list()))
    guards["baseline_same_stock_days"] = base_same_stock.height

    tod = [peak_time_of_day(args.data_dir, c, d) for c, d in events.select("code", "date").iter_rows()]
    events = events.with_columns(pl.Series("peak_tod", tod, dtype=pl.Utf8))
    events = events.with_columns(
        pl.when(pl.col("peak_tod").is_null()).then(pl.lit(None))
          .when(pl.col("peak_tod") < "10:00").then(pl.lit("09:00–10:00"))
          .when(pl.col("peak_tod") < "12:00").then(pl.lit("10:00–12:00"))
          .when(pl.col("peak_tod") < "14:00").then(pl.lit("12:00–14:00"))
          .otherwise(pl.lit("14:00–15:30")).alias("peak_tod_bucket"),
    )

    print("== guards")
    for k, v in guards.items():
        print(f"  {k}: {v}")
    print("== events by month:", Counter(events["date"].str.slice(0, 6).to_list()))
    print("== n per horizon:", {h: int(events[f"fwd{h}"].is_not_null().sum()) for h in HORIZONS})
    print("== leader buckets:", Counter(events["leader_bucket"].to_list()))
    print("== user folder leaders:", int(events["leader_user"].sum()))
    print("== markets:", Counter(events["market"].to_list()))

    # 3) 요약
    metric_cols = tuple(f"fwd{h}" for h in HORIZONS) + tuple(f"xs{h}" for h in HORIZONS) + (
        "fwd5_o", "fwd10_o", "gap_next", "mfe10", "mae10",
        "support_low_held", "support_close_held", "resist_broken",
        "ret_d", "ret5_pre", "ret20_pre", "vol_ratio20", "pct_of_hi52", "body_d", "ix_ret1",
    )
    summary = {
        "params": vars(args) | {"data_dir": str(args.data_dir), "index_json_dir": str(args.index_json_dir),
                                "out_dir": str(args.out_dir)},
        "guards": guards,
        "n_per_horizon": {h: int(events[f"fwd{h}"].is_not_null().sum()) for h in HORIZONS},
        "events_by_month": dict(sorted(Counter(events["date"].str.slice(0, 6).to_list()).items())),
        "overall": {c: describe(events, base, c, rng) for c in metric_cols},
        "overall_same_stock_base": {c: describe(events, base_same_stock, c, rng) for c in ("fwd5", "fwd10", "xs10")},
        "fallback_source_events": {c: describe(events_fallback, base, c, rng) for c in ("fwd5", "fwd10")},
        "counts": {
            k: dict(Counter(events[k].fill_null("N/A").to_list()))
            for k in ("leader_bucket", "ratio_bucket", "ix_candle", "ix_trend", "ix_mom5", "d_candle",
                      "ma_state", "ma_pos", "hi52_pos", "market", "peak_tod_bucket")
        },
        "state_flags": {
            k: {"event": _mean(events[k]), "base": _mean(base[k])}
            for k in ("above_ma5", "above_ma20", "above_ma60", "above_ma120", "ma_bull_align", "breakout_on_d")
        },
    }
    cond_cols = ("fwd5", "fwd10", "xs10", "support_low_held", "resist_broken", "mfe10", "mae10")
    summary["conditional"] = {
        by: conditional(events, base, by, cond_cols, rng)
        for by in ("leader_bucket", "ratio_bucket", "ix_candle", "ix_trend", "ix_mom5", "d_candle", "ma_state",
                   "ma_pos", "hi52_pos", "market", "peak_tod_bucket")
    }
    user_base = base.filter(pl.col("code").is_in(sorted(leaders_user)))
    summary["user_folder"] = {
        c: describe(events.filter(pl.col("leader_user")), user_base, c, rng)
        for c in ("fwd5", "fwd10", "xs10", "support_low_held", "resist_broken")
    }
    # 민감도: 임계·창
    sens = {}
    for r in (1.3, 1.5, 2.0):
        e = dedup_cooldown(table.filter((pl.col("ratio") >= r) & pl.col("same_source")), corpus, args.cooldown)
        b = table.filter((pl.col("ratio") < r) & pl.col("same_source"))
        sens[f"ratio≥{r}"] = {"n": e.height, **{c: describe(e, b, c, rng) for c in ("fwd5", "fwd10", "xs10")}}
    for lb in (5, 20):
        t2 = build_event_table(dd, corpus, lookback=lb, start=args.start, end=args.end)
        t2 = t2.filter(pl.col("have_days") >= max(1, round(lb * 0.9)))
        t2 = t2.filter((pl.col("src") == "hogaplay") & pl.col("base_all_hogaplay"))
        t2 = t2.join(stocks, on="code", how="left").filter(~pl.col("is_etf").fill_null(False))
        t2 = t2.join(feats.drop("date"), left_on=["code", "date"], right_on=["code", "d8"], how="left")
        t2 = t2.join(ix, left_on=["market", "date"], right_on=["market", "d8"], how="left")
        t2 = t2.with_columns(*[(pl.col(f"fwd{h}") - pl.col(f"ix_fwd{h}")).alias(f"xs{h}") for h in HORIZONS])
        e = dedup_cooldown(t2.filter(pl.col("ratio") >= args.ratio), corpus, args.cooldown)
        b = t2.filter(pl.col("ratio") < args.ratio)
        sens[f"lookback={lb}"] = {"n": e.height, **{c: describe(e, b, c, rng) for c in ("fwd5", "fwd10", "xs10")}}
    summary["sensitivity"] = sens

    (args.out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=str),
                                                encoding="utf-8")
    events.write_csv(args.out_dir / "events.csv")
    base.select("code", "date", "market", "leader_bucket", *cond_cols).write_csv(args.out_dir / "baseline.csv")
    print("== wrote", args.out_dir)
    ov = summary["overall"]
    for h in HORIZONS:
        o, x = ov[f"fwd{h}"], ov[f"xs{h}"]
        print(f"  fwd{h:>2}: ev {o['event_mean']*100:+.2f}% (win {o['event_win']*100:.0f}%, n={o['n_event']}) "
              f"vs base {o['base_mean']*100:+.2f}% | diff {o.get('diff', 0)*100:+.2f}% CI {o.get('diff_ci95')} "
              f"| excess-vs-index diff {x.get('diff', 0)*100:+.2f}% CI {x.get('diff_ci95')}")


if __name__ == "__main__":
    main()
