"""peak 매수벽 뒤 「어떤 조건·어떤 시점에 사야 승률이 가장 좋은가」 — 진입 규칙 탐색.

`docs/research/2026-09-03-bid-wall-entry-rule-search.md` 의 수치를 재현한다.

탐색은 과적합의 지름길이다. 170건에서 수백 개 조건을 뒤지면 최고 승률은 대부분 우연이다.
그래서 세 가지를 같이 낸다:
  1. 규칙별 표본 안(in-sample) 승률·평균 — 조건 없음(기저) 대비.
  2. **치환 귀무분포**: 결과를 에피소드 사이에서 섞은 뒤 같은 탐색을 반복해, "효과가 0 이어도
     탐색이 뽑아내는 최고 승률" 의 분포를 잰다. 표본 안 최고 승률이 이 분포의 95 분위 안이면
     우연과 구별되지 않는다.
  3. **종목 2-fold 교차검증**: 종목을 반으로 나눠 한쪽에서 뽑은 상위 규칙을 다른 쪽에서 평가한다.

진입 시점(E)과 결과:
  D0close     급증일 종가(장 마감 직전 판정 가능 — 스크리너 intraday 기준)
  D0next_open 급증일 다음 날 시가(가장 현실적인 최초 진입)
  D_end       에피소드 마지막 날 종가 — ⚠ 그날이 마지막인지는 다음 날 종가에야 안다(사후 정의)
  D_end+1     첫 비우위일 종가(에피소드 종료를 알 수 있는 첫 시점, 벽 유지 여부 무관)
  flipAsk     D_end 뒤 처음 매도 우위(ask_peak > bid_peak)가 된 날 종가 — 사용자 규칙 A
  dipReclaimLow   그 매도 우위 전환 뒤 저가가 close(D_end) 아래로 내려갔다가 다시 close(D_end) 위로 마감한
                  첫날 종가(같은 날 장중 깸+회복 포함) — 사용자 규칙 B(장중 저가 기준)
  dipReclaimClose 위와 같되 「깸」을 종가 < close(D_end) 로 판정하고 그 뒤 첫 종가 > close(D_end) 인 날
                  — 규칙 B(종가 기준)
  hold1/2/3   D_end 뒤 k 일 연속 저가 ≥ W 를 확인한 날 종가(벽 유지 확인 후 진입)
  reclaim   첫 close > close(D_end) (되돌림 캔들, 깸 여부 무관)
  reclaimC  위와 같되 그 전까지 low ≥ W (벽 안 건드린 되돌림)
  breakD0hi 첫 close > high(D0) (급증일 고가 돌파), D_end 뒤 10일 안
  결과는 E 종가 기준 +5/+10/+20일 수익률(수정주가)과 10일 MAE. 승률 = 수익률 > 0 비율.

조건은 1부 이벤트 피처(주도주·지수·52주·이평·캔들·배율·시장·peak 시각·거래량·당일 등락)와
에피소드 피처(길이·D0 우위·벽 위치·당일 장중 깸)의 단일값과 2개 조합. 최소 표본 ``--min-n``.

사용:
    uv run --extra dev python tools/study_bid_wall_entry_rules.py \\
        --data-dir ~/.local/share/hoga-ops/data \\
        --index-json-dir docs/research/assets/2026-09-03-bid-depth-surge \\
        --out-dir /tmp/bid-wall-entry [--ma20 below|none] [--walls-json <2부 out-dir>/walls.json]
"""
from __future__ import annotations

import argparse
import itertools
import json
import time
from pathlib import Path

import numpy as np
import polars as pl
from study_bid_depth_surge import SEED, add_parser_args, build_dataset
from study_bid_wall_shakeout import (
    Series,
    build_episodes,
    depth_by_code,
    extend_episode,
    load_series,
    load_wall_cache,
    wall_price,
)

from hoga.duck import connect_bounded

HORIZONS = (5, 10, 20)
K = 10                                   # D_end 뒤 되돌림/돌파를 찾는 창
RULES = ("D0close", "D0next_open", "D_end", "D_end+1", "flipAsk", "dipReclaimLow", "dipReclaimClose",
         "hold1", "hold2", "hold3", "reclaim", "reclaimC", "breakD0hi")
FEATURES = ("leader_bucket", "ix_trend", "ix_mom5", "hi52_pos", "ma_state", "ma_pos", "d_candle", "ratio_bucket",
            "market", "peak_tod_bucket", "vol_bucket", "retd_bucket", "rs_bucket", "len_bucket", "d0_bucket",
            "wall_bucket", "sdb_bucket", "ix_candle", "ma120_bucket")
N_PERM = 300
#: 1·2부에서 이미 나온 조건 — 탐색 밖에서 그대로 평가한다(선택 편향이 없는 쪽).
PREREG = (
    "leader_bucket=비주도주", "ix_trend=지수>MA20", "sdb_bucket=당일벽유지", "len_bucket=에피소드1일",
    "leader_bucket=비주도주 & len_bucket=에피소드1일", "leader_bucket=비주도주 & sdb_bucket=당일벽유지",
    "leader_bucket=비주도주 & ix_trend=지수>MA20", "ix_trend=지수>MA20 & sdb_bucket=당일벽유지",
    "leader_bucket=주도주(RS상위20%)", "ix_trend=지수<MA20",
    # 사용자 추가 규칙(2026-09-03): 일봉 MA120 기울기 우상향(20거래일 전 대비). 기존 규칙에 얹었을 때를 본다.
    "ma120_bucket=MA120상승", "ma120_bucket=MA120하락",
    "ma120_bucket=MA120상승 & leader_bucket=비주도주",
    "ma120_bucket=MA120상승 & leader_bucket=비주도주 & len_bucket=에피소드1일",
    "ma120_bucket=MA120하락 & leader_bucket=비주도주 & len_bucket=에피소드1일",
    "ma120_bucket=MA120상승 & leader_bucket=비주도주 & sdb_bucket=당일벽유지",
    "ma120_bucket=MA120상승 & leader_bucket=주도주(RS상위20%)",
    "ma120_5=MA120상승(5일)", "ma120_60=MA120상승(60일)",
    "ma120_5=MA120상승(5일) & leader_bucket=비주도주 & len_bucket=에피소드1일",
    "ma120_60=MA120상승(60일) & leader_bucket=비주도주 & len_bucket=에피소드1일",
)
VOL_HI, VOL_MID = 3.0, 1.5
RETD_DEEP = -0.03
RS_HI, RS_MID = 0.8, 0.5
LEN_HI = 4


# ── 진입 시점 ────────────────────────────────────────────────────────────────

def entry_indices(
    s: Series, i0: int, i_end: int, wall: float, depth: dict[str, tuple[int, int, int]] | None = None,
) -> dict[str, int | None]:
    """규칙별 진입 행 인덱스(없으면 None). ``depth`` = 그 종목의 date → (bid_peak, ask_peak, eligible)."""
    n = len(s)
    out: dict[str, int | None] = {"D0close": i0, "D0next_open": i0 + 1 if i0 + 1 < n else None, "D_end": i_end,
                                  "D_end+1": i_end + 1 if i_end + 1 < n else None}
    for k in (1, 2, 3):
        j = i_end + k
        held = j < n and all(s.u_low[i_end + 1:j + 1] >= wall)
        out[f"hold{k}"] = j if held else None
    rec = rec_c = brk = None
    broke = False
    hi0 = float(s.u_high[i0])
    for j in range(i_end + 1, min(n, i_end + 1 + K)):
        if s.u_low[j] < wall:
            broke = True
        if rec is None and s.u_close[j] > s.u_close[i_end]:
            rec = j
            if not broke:
                rec_c = j
        if brk is None and s.u_close[j] > hi0:
            brk = j
    out["reclaim"], out["reclaimC"], out["breakD0hi"] = rec, rec_c, brk
    # 사용자 규칙 A/B: 매도 우위 전환일 → close(D_end) 아래로 깸 → 다시 그 위로 마감
    end = min(n, i_end + 1 + K)
    flip = None
    for j in range(i_end + 1, end):
        r = (depth or {}).get(s.d8[j])
        if r is not None and r[1] > r[0]:
            flip = j
            break
    out["flipAsk"] = flip
    ref = float(s.u_close[i_end])
    dip_low = dip_close = None
    if flip is not None:
        t_low = next((j for j in range(flip, end) if s.u_low[j] < ref), None)
        if t_low is not None:
            dip_low = next((j for j in range(t_low, end) if s.u_close[j] > ref), None)
        t_close = next((j for j in range(flip, end) if s.u_close[j] < ref), None)
        if t_close is not None:
            dip_close = next((j for j in range(t_close + 1, end) if s.u_close[j] > ref), None)
    out["dipReclaimLow"], out["dipReclaimClose"] = dip_low, dip_close
    return out


def fwd_from(s: Series, i: int, *, at_open: bool = False) -> dict[str, float | None]:
    c0 = s.open[i] if at_open else s.close[i]
    out: dict[str, float | None] = {}
    for h in HORIZONS:
        out[f"fwd{h}"] = float(s.close[i + h] / c0 - 1) if i + h < len(s) else None
    out["mae10"] = float(s.low[i + 1:i + 11].min() / c0 - 1) if i + 10 < len(s) else None
    return out


# ── 탐색 ─────────────────────────────────────────────────────────────────────

def single_masks(df: pl.DataFrame, features: tuple[str, ...]) -> dict[str, np.ndarray]:
    """feature=value 단일 조건 → 마스크. 사전 지정 조건의 임의 개수 AND 조립에 쓴다."""
    out: dict[str, np.ndarray] = {}
    for f in features:
        if f not in df.columns:
            continue
        col = df[f].to_numpy()
        for v in sorted({x for x in col.tolist() if x is not None}, key=str):
            out[f"{f}={v}"] = col == v
    return out


def candidate_masks(df: pl.DataFrame, features: tuple[str, ...]) -> list[tuple[str, np.ndarray]]:
    """단일 조건과 서로 다른 피처의 2개 조합 → (이름, 불리언 마스크)."""
    singles: list[tuple[str, str, np.ndarray]] = []
    for f in features:
        if f not in df.columns:
            continue
        col = df[f].to_numpy()
        for v in sorted({x for x in col.tolist() if x is not None}, key=str):
            singles.append((f, f"{f}={v}", col == v))
    out = [(name, m) for _, name, m in singles]
    for (fa, na, ma), (fb, nb, mb) in itertools.combinations(singles, 2):
        if fa != fb:
            out.append((f"{na} & {nb}", ma & mb))
    return out


def evaluate(y10: np.ndarray, y5: np.ndarray, y20: np.ndarray, mae: np.ndarray, masks, *, min_n: int,
             months: np.ndarray | None = None) -> list[dict]:
    rows = []
    for name, m in masks:
        mm = m & ~np.isnan(y10)
        n = int(mm.sum())
        if n < min_n:
            continue
        v = y10[mm]
        mo = months[mm] if months is not None else None
        top_share = float(max(np.unique(mo, return_counts=True)[1]) / n) if mo is not None and len(mo) else None
        rows.append({
            "rule": name, "n": n,
            "n_months": int(len(set(mo.tolist()))) if mo is not None else None, "top_month_share": top_share,
            "win10": float((v > 0).mean()), "mean10": float(v.mean()), "median10": float(np.median(v)),
            "win5": float((y5[mm & ~np.isnan(y5)] > 0).mean()) if (mm & ~np.isnan(y5)).any() else None,
            "win20": float((y20[mm & ~np.isnan(y20)] > 0).mean()) if (mm & ~np.isnan(y20)).any() else None,
            "mean20": float(y20[mm & ~np.isnan(y20)].mean()) if (mm & ~np.isnan(y20)).any() else None,
            "mae10": float(mae[mm & ~np.isnan(mae)].mean()) if (mm & ~np.isnan(mae)).any() else None,
        })
    return rows


def perm_null_max(y10: np.ndarray, masks, *, min_n: int, rng, n_perm: int) -> list[float]:
    """결과를 섞어도 탐색이 뽑는 최고 승률 — 귀무분포."""
    valid = ~np.isnan(y10)
    idx = np.where(valid)[0]
    ms = [(m & valid) for _, m in masks if int((m & valid).sum()) >= min_n]
    if not ms:
        return []
    M = np.stack(ms)                              # (rules, episodes)
    ns = M.sum(axis=1)
    out = []
    for _ in range(n_perm):
        yp = y10.copy()
        yp[idx] = rng.permutation(y10[idx])
        wins = (M @ (yp > 0).astype(float)) / ns
        out.append(float(wins.max()))
    return out


def _pc(x) -> str:
    return "—" if x is None else f"{x * 100:.0f}%"


def main() -> None:  # noqa: PLR0912, PLR0915 — 스터디 스크립트의 단일 조립점
    ap = argparse.ArgumentParser()
    add_parser_args(ap)
    ap.add_argument("--ext-cap", type=int, default=5)
    ap.add_argument("--k", type=int, default=K)
    ap.add_argument("--min-n", type=int, default=20)
    ap.add_argument("--walls-json", type=Path, default=None, help="2부 out-dir 의 walls.json (있으면 재사용)")
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)

    ds = build_dataset(args)
    codes = set(ds.events["code"].to_list())
    series = load_series(args.data_dir, codes)
    corpus = ds.corpus
    idx = {d: i for i, d in enumerate(corpus)}

    walls = load_wall_cache(args.out_dir)
    if args.walls_json and args.walls_json.exists():
        walls = {**json.loads(args.walls_json.read_text(encoding="utf-8")), **walls}
    by_code = depth_by_code(ds)
    need = set()
    for code, d0 in ds.events.select("code", "date").iter_rows():
        for cap in sorted({args.ext_cap, 3, 0}):
            i_end_c, *_ = extend_episode(by_code[code], corpus, idx[d0], cap=cap, min_eligible=args.min_eligible)
            need.add((code, corpus[i_end_c]))
    todo = [(c, d) for c, d in sorted(need) if f"{c}:{d}" not in walls]
    if todo:
        con = connect_bounded()
        t0 = time.time()
        for n, (c, d) in enumerate(todo, 1):
            walls[f"{c}:{d}"] = wall_price(con, args.data_dir, c, d)
            if n % 50 == 0:
                print(f"  walls {n}/{len(todo)} ({time.time() - t0:.0f}s)")
        (args.out_dir / "walls.json").write_text(json.dumps(walls, ensure_ascii=False), encoding="utf-8")

    ep, _, guards = build_episodes(ds, series, walls, args, cap=args.ext_cap)
    feat_cols = ["code", "date", "ix_mom5", "ma_state", "ratio_bucket", "peak_tod_bucket", "vol_ratio20", "ret_d",
                 "ix_candle", "ma120_slope5", "ma120_slope20", "ma120_slope60"]
    ep = ep.join(ds.events.select(feat_cols), left_on=["code", "d0"], right_on=["code", "date"], how="left")
    ep = ep.with_columns(
        pl.when(pl.col("vol_ratio20") >= VOL_HI).then(pl.lit("거래량≥3×"))
          .when(pl.col("vol_ratio20") >= VOL_MID).then(pl.lit("거래량1.5–3×"))
          .otherwise(pl.lit("거래량<1.5×")).alias("vol_bucket"),
        pl.when(pl.col("ret_d") <= RETD_DEEP).then(pl.lit("당일≤−3%"))
          .when(pl.col("ret_d") <= 0).then(pl.lit("당일−3~0%")).otherwise(pl.lit("당일상승")).alias("retd_bucket"),
        pl.when(pl.col("rs_pct") >= RS_HI).then(pl.lit("RS상위20%"))
          .when(pl.col("rs_pct") >= RS_MID).then(pl.lit("RS중상"))
          .when(pl.col("rs_pct").is_not_null()).then(pl.lit("RS하위50%"))
          .otherwise(pl.lit("RS없음")).alias("rs_bucket"),
        pl.when(pl.col("ep_len") >= LEN_HI).then(pl.lit("에피소드4일+"))
          .when(pl.col("ep_len") > 1).then(pl.lit("에피소드2–3일"))
          .otherwise(pl.lit("에피소드1일")).alias("len_bucket"),
        pl.when(pl.col("d0_dominant")).then(pl.lit("D0매수>매도")).otherwise(pl.lit("D0매수≤매도")).alias("d0_bucket"),
        pl.when(pl.col("dist_pct") < 0).then(pl.lit("벽이 종가 위")).otherwise(pl.lit("벽이 종가 아래"))
          .alias("wall_bucket"),
        pl.when(pl.col("same_day_break")).then(pl.lit("당일장중깸")).otherwise(pl.lit("당일벽유지")).alias("sdb_bucket"),
        pl.when(pl.col("ma120_slope20") > 0).then(pl.lit("MA120상승")).otherwise(pl.lit("MA120하락"))
          .alias("ma120_bucket"),
        pl.when(pl.col("ma120_slope5") > 0).then(pl.lit("MA120상승(5일)")).otherwise(pl.lit("MA120하락(5일)"))
          .alias("ma120_5"),
        pl.when(pl.col("ma120_slope60") > 0).then(pl.lit("MA120상승(60일)")).otherwise(pl.lit("MA120하락(60일)"))
          .alias("ma120_60"),
    )

    # 규칙별 진입·결과
    rows = []
    for r in ep.iter_rows(named=True):
        s = series[r["code"]]
        i0, i_end = s.idx[r["d0"]], s.idx[r["d_end"]]
        ent = entry_indices(s, i0, i_end, float(r["wall_price"]), by_code.get(r["code"]))
        for rule, i in ent.items():
            rec = {"code": r["code"], "d0": r["d0"], "rule": rule, "entry_idx": i,
                   "entry_date": s.d8[i] if i is not None else None}
            if i is not None:
                rec.update(fwd_from(s, i, at_open=(rule == "D0next_open")))
            else:
                rec.update({f"fwd{h}": None for h in HORIZONS} | {"mae10": None})
            rows.append(rec)
    outcomes = pl.DataFrame(rows)
    feats = ep.select("code", "d0", *[f for f in FEATURES if f in ep.columns], "ma120_5", "ma120_60")
    full = outcomes.join(feats, on=["code", "d0"], how="left")

    summary: dict = {"params": {k: str(v) for k, v in vars(args).items()}, "guards": guards, "episodes": ep.height,
                     "rules": {}, "search": {}, "perm_null": {}, "cv": {}}
    rule_frames: dict[str, pl.DataFrame] = {}
    for rule in RULES:
        f = full.filter(pl.col("rule") == rule)
        rule_frames[rule] = f
        y10 = f["fwd10"].cast(pl.Float64).fill_null(np.nan).to_numpy()
        y5 = f["fwd5"].cast(pl.Float64).fill_null(np.nan).to_numpy()
        y20 = f["fwd20"].cast(pl.Float64).fill_null(np.nan).to_numpy()
        mae = f["mae10"].cast(pl.Float64).fill_null(np.nan).to_numpy()
        months = np.array([(d or "")[:6] for d in f["entry_date"].to_list()])
        base = evaluate(y10, y5, y20, mae, [("(조건 없음)", np.ones(f.height, dtype=bool))], min_n=1, months=months)
        summary["rules"][rule] = {"available": int(f["entry_idx"].is_not_null().sum()),
                                  "base": base[0] if base else None}
        masks = candidate_masks(f, FEATURES)
        res = evaluate(y10, y5, y20, mae, masks, min_n=args.min_n, months=months)
        res.sort(key=lambda d: (d["win10"], d["mean10"]), reverse=True)
        big_n = args.min_n * 2
        res_big = [d for d in res if d["n"] >= big_n]
        singles = single_masks(f, FEATURES + ("ma120_5", "ma120_60"))
        pre_masks = []
        for name in PREREG:
            parts = [x.strip() for x in name.split("&")]
            if all(x in singles for x in parts):
                m = np.ones(f.height, dtype=bool)
                for x in parts:
                    m &= singles[x]
                pre_masks.append((name, m))
        prereg = evaluate(y10, y5, y20, mae, pre_masks, min_n=1, months=months)
        summary["search"][rule] = {"n_candidates": len(res), "top": res[:15],
                                   "top_by_mean": sorted(res, key=lambda d: d["mean10"], reverse=True)[:8],
                                   "top_big_n": res_big[:8], "prereg": prereg}
        null = perm_null_max(y10, masks, min_n=args.min_n, rng=rng, n_perm=N_PERM)
        null_big = perm_null_max(y10, masks, min_n=big_n, rng=rng, n_perm=N_PERM)
        summary["perm_null"][rule] = {
            "max_win10_p50": float(np.percentile(null, 50)) if null else None,
            "max_win10_p95": float(np.percentile(null, 95)) if null else None,
            "observed_max_win10": res[0]["win10"] if res else None,
            "p_value_max": float(np.mean([m >= res[0]["win10"] for m in null])) if null and res else None,
            "big_n": big_n,
            "big_max_win10_p95": float(np.percentile(null_big, 95)) if null_big else None,
            "big_observed_max_win10": res_big[0]["win10"] if res_big else None,
            "big_p_value_max": (float(np.mean([m >= res_big[0]["win10"] for m in null_big]))
                                if null_big and res_big else None),
        }
        # 종목 2-fold 교차검증 — 한쪽에서 뽑은 상위 3 규칙을 다른 쪽에서 평가
        code_arr = f["code"].to_numpy()
        fold = np.array([int(str(c)[:5]) % 2 for c in code_arr])
        cv = []
        for tr in (0, 1):
            te = 1 - tr
            mtr, mte = fold == tr, fold == te
            res_tr = evaluate(np.where(mtr, y10, np.nan), np.where(mtr, y5, np.nan), np.where(mtr, y20, np.nan),
                              np.where(mtr, mae, np.nan), masks, min_n=max(8, args.min_n // 2))
            res_tr.sort(key=lambda d: (d["win10"], d["mean10"]), reverse=True)
            for top in res_tr[:3]:
                m = dict(masks)[top["rule"]]
                v = y10[m & mte & ~np.isnan(y10)]
                cv.append({"train_fold": tr, "rule": top["rule"], "train_n": top["n"], "train_win10": top["win10"],
                           "test_n": int(len(v)), "test_win10": float((v > 0).mean()) if len(v) else None,
                           "test_mean10": float(v.mean()) if len(v) else None})
        summary["cv"][rule] = cv

    (args.out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=str),
                                                encoding="utf-8")
    full.write_csv(args.out_dir / "entries.csv")
    print("== episodes", ep.height, "guards", guards)
    for rule in RULES:
        b = summary["rules"][rule]["base"]
        pn = summary["perm_null"][rule]
        top = summary["search"][rule]["top"][:3]
        print(f"--- {rule}: available {summary['rules'][rule]['available']} | base n={b['n']} win10 {_pc(b['win10'])} "
              f"mean10 {b['mean10'] * 100:+.2f}% | null max win p50 {_pc(pn['max_win10_p50'])} "
              f"p95 {_pc(pn['max_win10_p95'])} | obs max {_pc(pn['observed_max_win10'])} p={pn['p_value_max']}")
        pb = summary["perm_null"][rule]
        print(f"      big-n(≥{pb['big_n']}): obs max {_pc(pb['big_observed_max_win10'])} null p95 "
              f"{_pc(pb['big_max_win10_p95'])} p={pb['big_p_value_max']}")
        for t in top + summary["search"][rule]["top_big_n"][:3]:
            print(f"      {t['rule']:60s} n={t['n']:3d} win10 {_pc(t['win10'])} mean10 {t['mean10'] * 100:+.2f}% "
                  f"win20 {_pc(t['win20'])} months {t['n_months']} top-month {_pc(t['top_month_share'])}")
        for t in summary["search"][rule]["prereg"]:
            print(f"      prereg {t['rule']:53s} n={t['n']:3d} win10 {_pc(t['win10'])} "
                  f"mean10 {t['mean10'] * 100:+.2f}% win20 {_pc(t['win20'])}")
        for c in summary["cv"][rule][:6]:
            print(f"      cv fold{c['train_fold']}: {c['rule'][:55]:55s} train {_pc(c['train_win10'])}"
                  f"(n={c['train_n']}) → test {_pc(c['test_win10'])}(n={c['test_n']})")


if __name__ == "__main__":
    main()
