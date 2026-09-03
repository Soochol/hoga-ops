"""매수벽 에피소드 → 흔들기(트릭) → 되돌림 캔들 이후 흐름 — study 1 의 이벤트 집합 위에서.

`docs/research/2026-09-03-bid-wall-shakeout-followthrough.md` 의 수치를 재현한다.

정의(모두 코퍼스 거래일 기준):
  에피소드   D0(총잔량 급증일, study 1 이벤트)에서 시작해 다음 거래일이 ``bid_peak > ask_peak``
             (eligible ≥ min) 인 동안 이어진다(최대 ``--ext-cap`` 일). 마지막 날이 D_end.
  매수벽 W   D_end 의 **당일 매수 최대벽** 가격 — `/live` 의 당일 매수 최대벽 선과 같은
             :func:`hoga.tables.snapshots.query_day_bid_peak` (1분 대표 기준 ``price``;
             ``max_price`` 는 민감도). **원주가**다.
  깸(break)  D_end 이후 K 거래일 안에 ``low(t) < W`` — 원주가 저가로 판정(수정주가와 섞으면
             액션이 있는 종목에서 틀린다). ``low ≤ W`` 는 「터치」로 따로 센다.
  되돌림 C   D_end 이후 K 거래일 안에 첫 ``close(t) > close(D_end)`` (원주가).
  분류       깸→되돌림(트릭) / 되돌림만 / 깸만 / 둘 다 없음. 깸이 C 보다 늦으면 「되돌림만」.
  결과       C 종가 기준 +1/3/5/10/20 (수정주가), 10일 MFE/MAE, W·깸 저가 유지율.
  대조군     study 1 의 기준군 날 D' 에 같은 패턴을 **저가 기준**으로 적용(``low(t) < low(D')`` 뒤
             첫 ``close(t) > close(D')``) → C'. 이벤트 쪽도 같은 저가 기준 분류를 함께 낸다 —
             W 기반은 이벤트에만 존재하므로 대조는 저가 기준끼리 한다.

사용:
    uv run --extra dev python tools/study_bid_wall_shakeout.py \\
        --data-dir ~/.local/share/hoga-ops/data \\
        --index-json-dir docs/research/assets/2026-09-03-bid-depth-surge \\
        --out-dir /tmp/bid-wall-shakeout

매수벽 가격은 스톡데이트당 snapshots.parquet 스캔이라(691건 실측 30초) ``<out-dir>/walls.json``
에 캐시한다. 사용자 캐시(kis-past-indicators)에는 쓰지 않는다.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import time
from collections import Counter
from pathlib import Path

import numpy as np
import polars as pl
from study_bid_depth_surge import (
    FWD_WINDOW,
    HORIZONS,
    SEED,
    Dataset,
    add_parser_args,
    build_dataset,
    describe,
    load_daily,
    load_factor_boundaries,
)

from hoga.api.invariants import indicator_session_bounds, normalize_session_bounds
from hoga.api.queries import resolve_source_dir
from hoga.duck import connect_bounded
from hoga.tables import snapshots as snapshots_tbl

ONE_MINUTE_MS = 60_000
PATH_PRE, PATH_POST = 5, 20          # 되돌림 캔들 전후 경로(중앙값 차트)
CLASS_TRICK = "깸→되돌림(트릭)"
CLASS_RECLAIM = "되돌림만"
CLASS_BREAK = "깸만"
CLASS_NONE = "둘 다 없음"
CLASSES = (CLASS_TRICK, CLASS_RECLAIM, CLASS_BREAK, CLASS_NONE)
OUTCOME_CLASSES = (CLASS_TRICK, CLASS_RECLAIM)
LEN_BUCKET_HI = 4                    # 에피소드 길이 구간: 1 / 2–3 / 4+
DEPTH_DEEP = -0.03                   # 깸 깊이 구간 경계
SPEED_FAST_DAYS = 3                  # C 도달 속도 구간 경계
OUT_COLS = tuple(f"fwd{h}" for h in HORIZONS) + ("mfe10", "mae10")
HOLD_COLS = ("hold_wall", "hold_break_low", "hold_close_end")


# ── 가격 배열 ─────────────────────────────────────────────────────────────────

class Series:
    """종목 하나의 일봉 배열 — 수정(returns 용)과 원주가(W 비교용)를 같은 행에 둔다."""

    def __init__(self, df: pl.DataFrame) -> None:
        self.d8 = df["d8"].to_list()
        self.idx = {d: i for i, d in enumerate(self.d8)}
        self.close = df["close"].to_numpy()
        self.high = df["high"].to_numpy()
        self.low = df["low"].to_numpy()
        self.u_close = df["u_close"].to_numpy()
        self.u_low = df["u_low"].to_numpy()
        self.u_high = df["u_high"].to_numpy()

    def __len__(self) -> int:
        return len(self.d8)


def load_series(data_dir: Path, codes: set[str]) -> dict[str, Series]:
    codes_l = sorted(codes)
    adj = load_daily(data_dir, since=dt.date(2024, 6, 1), adjusted=True).filter(pl.col("code").is_in(codes_l))
    un = load_daily(data_dir, since=dt.date(2024, 6, 1), adjusted=False).filter(pl.col("code").is_in(codes_l))
    un = un.select("code", "date", pl.col("close").alias("u_close"), pl.col("low").alias("u_low"),
                   pl.col("high").alias("u_high"))
    df = adj.join(un, on=["code", "date"], how="inner").sort(["code", "date"])
    df = df.with_columns(pl.col("date").dt.strftime("%Y%m%d").alias("d8"))
    out = {}
    for key, part in df.partition_by("code", as_dict=True, include_key=True).items():
        code = key[0] if isinstance(key, tuple) else key
        out[str(code)] = Series(part)
    return out


# ── 매수벽 가격 ───────────────────────────────────────────────────────────────

def wall_price(con, data_dir: Path, code: str, date: str) -> dict | None:
    """D 의 당일 매수 최대벽 — depth_daily.compute_stock_date_peak 와 같은 세션 경계 도출."""
    code_dir = data_dir / "parquet" / date / code
    src_dir = resolve_source_dir(code_dir, "hogaplay", "KRX")
    meta_path, snap_path = src_dir / "meta.json", src_dir / "snapshots.parquet"
    if not meta_path.exists() or not snap_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    norm_meta, _ = normalize_session_bounds(meta)
    try:
        open_ms, close_ms = indicator_session_bounds(norm_meta)
    except KeyError:
        open_ms = norm_meta.get("regular_session_open_ms")
        close_ms = meta.get("regular_session_close_ms")
    row = snapshots_tbl.query_day_bid_peak(
        con, path=snap_path, bucket_ms=ONE_MINUTE_MS,
        session_open_ms=open_ms if isinstance(open_ms, int) else None,
        session_close_ms=close_ms if isinstance(close_ms, int) else None,
    )
    if row is None:
        return None
    return {"price": row.price, "qty": row.qty, "intra_ms": row.intra_ms,
            "max_price": row.max_price, "max_qty": row.max_qty}


def load_wall_cache(out_dir: Path) -> dict[str, dict | None]:
    p = out_dir / "walls.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


# ── 에피소드 ─────────────────────────────────────────────────────────────────

def extend_episode(
    by: dict[str, tuple[int, int, int]], corpus: list[str], i0: int, *, cap: int, min_eligible: int,
) -> tuple[int, int, bool, bool]:
    """D0 다음 날부터 bid>ask 가 이어지는 동안 연장. (D_end 인덱스, 길이, 캡 도달, 결손으로 끝남)"""
    n = 0
    while n < cap:
        j = i0 + n + 1
        if j >= len(corpus):
            return i0 + n, n + 1, False, False
        r = by.get(corpus[j])
        if r is None:
            return i0 + n, n + 1, False, True
        bid, ask, elig = r
        if bid > ask and elig >= min_eligible:
            n += 1
            continue
        return i0 + n, n + 1, False, False
    return i0 + n, n + 1, True, False


def classify(low: np.ndarray, close: np.ndarray, i_end: int, *, level: float, ref_close: float, k: int):
    """D_end 다음 k 행에서 깸(low<level)·되돌림(close>ref_close)의 첫 인덱스와 분류."""
    end = min(len(low), i_end + 1 + k)
    brk = touch = rec = None
    for j in range(i_end + 1, end):
        if brk is None and low[j] < level:
            brk = j
        if touch is None and low[j] <= level:
            touch = j
        if rec is None and close[j] > ref_close:
            rec = j
    if rec is not None and brk is not None and brk <= rec:
        cls = CLASS_TRICK
    elif rec is not None:
        cls = CLASS_RECLAIM
    elif brk is not None:
        cls = CLASS_BREAK
    else:
        cls = CLASS_NONE
    return cls, brk, touch, rec, end - (i_end + 1)


def outcomes(s: Series, i_c: int, *, hold_levels: dict[str, float | None]) -> dict:
    """C 행 기준 forward 지표. 창이 코퍼스 끝을 넘으면 None."""
    out: dict = {"c_date": s.d8[i_c]}
    c0 = s.close[i_c]
    for h in HORIZONS:
        out[f"fwd{h}"] = float(s.close[i_c + h] / c0 - 1) if i_c + h < len(s) else None
    if i_c + FWD_WINDOW < len(s):
        hi = s.high[i_c + 1:i_c + 1 + FWD_WINDOW]
        lo = s.low[i_c + 1:i_c + 1 + FWD_WINDOW]
        ulo = s.u_low[i_c + 1:i_c + 1 + FWD_WINDOW]
        out["mfe10"] = float(hi.max() / c0 - 1)
        out["mae10"] = float(lo.min() / c0 - 1)
        for name, lvl in hold_levels.items():
            out[f"hold_{name}"] = bool(ulo.min() >= lvl) if lvl is not None else None
    else:
        out["mfe10"] = out["mae10"] = None
        for name in hold_levels:
            out[f"hold_{name}"] = None
    return out


def path_rel(s: Series, i_c: int) -> list[float | None]:
    c0 = s.close[i_c]
    return [float(s.close[i_c + k] / c0 - 1) if 0 <= i_c + k < len(s) else None
            for k in range(-PATH_PRE, PATH_POST + 1)]


def path_stats(paths: list[list[float | None]]) -> dict:
    ks = list(range(-PATH_PRE, PATH_POST + 1))
    med: list[float | None] = []
    q25: list[float | None] = []
    q75: list[float | None] = []
    n: list[int] = []
    for j, _ in enumerate(ks):
        vals = np.array([p[j] for p in paths if p[j] is not None], dtype=float)
        n.append(int(len(vals)))
        if len(vals):
            med.append(float(np.median(vals)))
            q25.append(float(np.quantile(vals, 0.25)))
            q75.append(float(np.quantile(vals, 0.75)))
        else:
            med.append(None)
            q25.append(None)
            q75.append(None)
    return {"k": ks, "median": med, "q25": q25, "q75": q75, "n": n}


def _qs(values: pl.Series, qs: tuple[float, ...]) -> list[float] | None:
    v = values.drop_nulls().cast(pl.Float64).to_numpy()
    return [float(x) for x in np.quantile(v, qs)] if len(v) else None


# ── 조립 ─────────────────────────────────────────────────────────────────────

def ma20_filter(frame: pl.DataFrame, mode: str) -> pl.DataFrame:
    """사용자 정의: peak 는 일봉 20이평선 **아래**에 있을 때만 유효 — 이벤트일 종가 < MA20.
    ``mode`` = ``below``(기본) / ``none``. 대조군에도 같은 조건을 건다(비교 대상이 같은 국면이어야 한다)."""
    if mode == "none":
        return frame
    if mode != "below":
        raise ValueError(f"unknown ma20 mode: {mode}")
    return frame.filter(~pl.col("above_ma20").fill_null(True))


def build_episodes(  # noqa: PLR0915 — 스터디의 단일 조립점
    ds: Dataset, series: dict[str, Series], walls: dict, args, *, cap: int, wall_key: str = "price",
    same_day_counts: bool = False, reclaim_ref: str = "close", events: pl.DataFrame | None = None,
) -> tuple[pl.DataFrame, dict[str, list], dict[str, int]]:
    """``same_day_counts``: D_end 당일 저가가 W 아래면 그것도 「깸」으로 센다(장중 흔들기를 트릭에
    포함하는 사양). ``reclaim_ref``: 되돌림 기준 — ``close`` = close(D_end), ``high`` = high(D_end).
    ``events``: 기본은 ``ds.events`` 에 ``args.ma20`` 필터를 건 것."""
    if events is None:
        events = ma20_filter(ds.events, args.ma20)
    corpus = ds.corpus
    idx = {d: i for i, d in enumerate(corpus)}
    by_code = depth_by_code(ds)
    bounds = load_factor_boundaries(args.data_dir).with_columns(pl.col("date").dt.strftime("%Y%m%d").alias("d8"))
    bset = {(c, d) for c, d in bounds.select("code", "d8").iter_rows()}

    rows: list[dict] = []
    paths: dict[str, list] = {c: [] for c in CLASSES}
    guards: Counter = Counter()
    last_c_idx: dict[str, int] = {}
    carry = ("name", "market", "leader_bucket", "ix_trend", "hi52_pos", "ma_pos", "d_candle", "ratio", "rs_pct")
    for ev in events.sort(["code", "date"]).iter_rows(named=True):
        code, d0 = ev["code"], ev["date"]
        guards["episodes_in"] += 1
        s = series.get(code)
        if s is None or d0 not in s.idx:
            guards["no_price_series"] += 1
            continue
        i0 = idx[d0]
        i_end_c, length, capped, gap = extend_episode(
            by_code[code], corpus, i0, cap=cap, min_eligible=args.min_eligible,
        )
        d_end = corpus[i_end_c]
        guards["ext_cap_hit"] += int(capped)
        guards["ext_ended_by_gap"] += int(gap)
        if d_end not in s.idx:
            guards["d_end_not_in_series"] += 1
            continue
        i_end = s.idx[d_end]
        # 겹침: 앞 에피소드의 C(또는 K 창) 안에서 시작하면 버린다
        if code in last_c_idx and s.idx[d0] <= last_c_idx[code]:
            guards["dropped_overlap"] += 1
            continue
        # 수정계수 경계가 [D0-lookback, D_end+K+20] 안에 있으면 제외(원주가 비교·forward 수익률 둘 다 오염)
        lo_j, hi_j = max(0, i0 - args.lookback), min(len(corpus) - 1, i_end_c + args.k + PATH_POST)
        if any((code, corpus[j]) in bset for j in range(lo_j, hi_j + 1)):
            guards["dropped_factor_boundary"] += 1
            continue
        w = walls.get(f"{code}:{d_end}")
        if not w:
            guards["wall_missing"] += 1
            continue
        wall = float(w[wall_key])
        d0_dom = by_code[code][d0][0] > by_code[code][d0][1]
        ref_close, low_end = float(s.u_close[i_end]), float(s.u_low[i_end])
        ref_px = float(s.u_high[i_end]) if reclaim_ref == "high" else ref_close
        cls, brk, touch, rec, avail = classify(s.u_low, s.u_close, i_end, level=wall, ref_close=ref_px, k=args.k)
        if same_day_counts and low_end < wall:
            brk = i_end                       # 가장 이른 깸은 D_end 당일 장중
            cls = CLASS_TRICK if rec is not None else CLASS_BREAK
        cls_low, brk_low, _, rec_low, _ = classify(
            s.low, s.close, i_end, level=float(s.low[i_end]), ref_close=float(s.close[i_end]), k=args.k,
        )
        row: dict = {
            "code": code, "d0": d0, "d_end": d_end, "ep_len": length, "d0_dominant": d0_dom,
            "wall_price": wall, "wall_qty": w["qty"], "wall_max_price": w["max_price"],
            "close_end": ref_close, "low_end": low_end,
            "dist_pct": ref_close / wall - 1, "same_day_break": low_end < wall, "avail_days": avail,
            "cls": cls, "cls_low": cls_low,
            "break_day": s.d8[brk] if brk is not None else None,
            "touch_day": s.d8[touch] if touch is not None else None,
            "reclaim_day": s.d8[rec] if rec is not None else None,
            "days_to_c": (rec - i_end) if rec is not None else None,
            "reclaim_day_low": s.d8[rec_low] if rec_low is not None else None,
            "break_before_c_low": (brk_low is not None and rec_low is not None and brk_low <= rec_low),
            "break_depth": None,
        }
        for k in carry:
            row[k] = ev.get(k)
        if rec is not None:
            brk_low_px = float(s.u_low[brk:rec + 1].min()) if brk is not None and brk <= rec else None
            row["break_depth"] = (brk_low_px / wall - 1) if brk_low_px is not None else None
            row.update(outcomes(s, rec, hold_levels={"wall": wall, "break_low": brk_low_px, "close_end": ref_close}))
            paths[cls].append(path_rel(s, rec))
            last_c_idx[code] = rec
        else:
            last_c_idx[code] = i_end + args.k
        rows.append(row)
    return pl.DataFrame(rows), paths, dict(guards)


def depth_by_code(ds: Dataset) -> dict[str, dict[str, tuple[int, int, int]]]:
    by_code: dict[str, dict[str, tuple[int, int, int]]] = {}
    cols = ("code", "date", "bid_peak", "ask_peak", "eligible_count")
    for code, date, bid, ask, elig in ds.dd.select(*cols).iter_rows():
        by_code.setdefault(code, {})[date] = (int(bid), int(ask), int(elig))
    return by_code


def build_control(base: pl.DataFrame, series: dict[str, Series], *, k: int) -> tuple[pl.DataFrame, list]:
    """기준군 날 D' 에 저가 기준 패턴을 적용 — 매수벽 없는 「눌림→되돌림」의 기저율."""
    rows, paths = [], []
    for code, d in base.select("code", "date").iter_rows():
        s = series.get(code)
        if s is None or d not in s.idx:
            continue
        i = s.idx[d]
        cls, _brk, _, rec, avail = classify(
            s.low, s.close, i, level=float(s.low[i]), ref_close=float(s.close[i]), k=k,
        )
        row: dict = {"code": code, "d_end": d, "cls_low": cls, "avail_days": avail,
                     "days_to_c": (rec - i) if rec is not None else None}
        if rec is not None:
            row.update(outcomes(s, rec, hold_levels={"close_end": float(s.u_close[i])}))
            if cls == CLASS_TRICK:
                paths.append(path_rel(s, rec))
        rows.append(row)
    return pl.DataFrame(rows), paths


def class_outcomes(
    frame: pl.DataFrame, col: str, ctrl_map: dict[str, pl.DataFrame], base_uncond: pl.DataFrame, rng,
) -> dict:
    res: dict = {}
    for cls in CLASSES:
        e = frame.filter(pl.col(col) == cls)
        entry: dict = {"n": e.height, "n_fwd10": int(e["fwd10"].is_not_null().sum()) if "fwd10" in e.columns else 0}
        if cls in OUTCOME_CLASSES and e.height:
            b = ctrl_map.get(cls, base_uncond)
            entry.update({c: describe(e, b, c, rng) for c in OUT_COLS})
            entry["vs_uncond"] = {c: describe(e, base_uncond, c, rng) for c in ("fwd5", "fwd10", "fwd20")}
            for hcol in HOLD_COLS:
                if hcol in e.columns and e[hcol].is_not_null().sum() > 0:
                    v = e[hcol].drop_nulls().cast(pl.Float64)
                    entry[hcol] = {"n": v.len(), "rate": float(v.mean())}  # type: ignore[arg-type]
            if "days_to_c" in e.columns:
                entry["days_to_c_q"] = _qs(e["days_to_c"], (0.25, 0.5, 0.75))
            if "break_depth" in e.columns:
                entry["break_depth_q"] = _qs(e["break_depth"], (0.1, 0.5, 0.9))
        res[cls] = entry
    return res


def main() -> None:  # noqa: PLR0915 — 스터디 스크립트의 단일 조립점
    ap = argparse.ArgumentParser()
    add_parser_args(ap)
    ap.add_argument("--ext-cap", type=int, default=5, help="D0 뒤로 연장하는 최대 거래일 수")
    ap.add_argument("--k", type=int, default=10, help="D_end 뒤 깸/되돌림을 찾는 창(거래일)")
    ap.add_argument("--ma20", choices=("below", "none"), default="below",
                    help="peak 유효 조건: below = 이벤트일 종가 < 일봉 MA20 (사용자 정의) / none = 조건 없음")
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)

    ds = build_dataset(args)
    codes = set(ds.events["code"].to_list()) | set(ds.base["code"].to_list())
    series = load_series(args.data_dir, codes)
    corpus = ds.corpus
    idx = {d: i for i, d in enumerate(corpus)}

    # 1) 에피소드 끝 후보 전부의 매수벽 가격(캐시)
    by_code = depth_by_code(ds)
    need = set()
    for code, d0 in ds.events.select("code", "date").iter_rows():
        for cap in sorted({args.ext_cap, 3, 0}):
            i_end_c, *_ = extend_episode(by_code[code], corpus, idx[d0], cap=cap, min_eligible=args.min_eligible)
            need.add((code, corpus[i_end_c]))
    walls = load_wall_cache(args.out_dir)
    todo = [(c, d) for c, d in sorted(need) if f"{c}:{d}" not in walls]
    if todo:
        con = connect_bounded()
        t0 = time.time()
        for n, (c, d) in enumerate(todo, 1):
            walls[f"{c}:{d}"] = wall_price(con, args.data_dir, c, d)
            if n % 50 == 0:
                print(f"  walls {n}/{len(todo)} ({time.time() - t0:.0f}s)")
        (args.out_dir / "walls.json").write_text(json.dumps(walls, ensure_ascii=False), encoding="utf-8")
    print("== walls:", len(need), "needed,", sum(1 for c, d in need if walls.get(f"{c}:{d}")), "available")

    # 2) 본 사양 — 이벤트·대조군 모두 args.ma20 조건
    base_f = ma20_filter(ds.base, args.ma20)
    print("== ma20 filter:", args.ma20, "| events", ma20_filter(ds.events, args.ma20).height, "/", ds.events.height,
          "| base", base_f.height, "/", ds.base.height)
    ep, paths, guards = build_episodes(ds, series, walls, args, cap=args.ext_cap)
    ctrl, ctrl_paths = build_control(base_f, series, k=args.k)
    print("== guards:", guards)
    print("== ep_len:", sorted(Counter(ep["ep_len"].to_list()).items()))
    print("== d0_dominant:", int(ep["d0_dominant"].sum()), "/", ep.height)
    print("== cls (W):", dict(Counter(ep["cls"].to_list())))
    print("== cls (low):", dict(Counter(ep["cls_low"].to_list())))
    print("== ctrl cls (low):", dict(Counter(ctrl["cls_low"].to_list())))

    base_uncond = base_f.select("code", *OUT_COLS)   # study 1 의 무조건부 기준군(D 기준 forward), 같은 MA20 조건
    ctrl_trick = ctrl.filter(pl.col("cls_low") == CLASS_TRICK)
    ctrl_reclaim = ctrl.filter(pl.col("cls_low") == CLASS_RECLAIM)
    ctrl_map = {CLASS_TRICK: ctrl_trick, CLASS_RECLAIM: ctrl_reclaim}
    broke = ep["break_day"].is_not_null()
    summary: dict = {
        "params": {k: str(v) for k, v in vars(args).items()},
        "guards": guards,
        "episodes": ep.height,
        "ep_len_dist": dict(sorted(Counter(ep["ep_len"].to_list()).items())),
        "d0_dominant": int(ep["d0_dominant"].sum()),
        "same_day_break": int(ep["same_day_break"].sum()),
        "dist_pct_q": _qs(ep["dist_pct"], (0.1, 0.25, 0.5, 0.75, 0.9)),
        "class_counts_W": dict(Counter(ep["cls"].to_list())),
        "class_counts_low": dict(Counter(ep["cls_low"].to_list())),
        "class_counts_ctrl_low": dict(Counter(ctrl["cls_low"].to_list())),
        "class_counts_W_by_d0_dominant": {
            str(flag): dict(Counter(ep.filter(pl.col("d0_dominant") == flag)["cls"].to_list()))
            for flag in (True, False)
        },
        "survivorship": {
            "broke": {"n": int(broke.sum()), "reclaimed_within_k": int((broke & (ep["cls"] == CLASS_TRICK)).sum())},
            "not_broke": {"n": int((~broke).sum()),
                          "reclaimed_within_k": int(((~broke) & (ep["cls"] == CLASS_RECLAIM)).sum())},
        },
        "outcomes_W": class_outcomes(ep, "cls", ctrl_map, base_uncond, rng),
        "outcomes_low": class_outcomes(ep, "cls_low", ctrl_map, base_uncond, rng),
        "control": {
            cls: {
                "n": ctrl.filter(pl.col("cls_low") == cls).height,
                **({c: describe(ctrl.filter(pl.col("cls_low") == cls), base_uncond, c, rng)
                    for c in ("fwd5", "fwd10", "fwd20", "mfe10", "mae10")} if cls in OUTCOME_CLASSES else {}),
            }
            for cls in CLASSES
        },
        "paths": {cls: path_stats(paths[cls]) for cls in OUTCOME_CLASSES} | {"control_trick": path_stats(ctrl_paths)},
    }
    # 조건부(트릭 클래스 안에서)
    trick = ep.filter(pl.col("cls") == CLASS_TRICK).with_columns(
        pl.when(pl.col("ep_len") >= LEN_BUCKET_HI).then(pl.lit("4일+"))
          .when(pl.col("ep_len") > 1).then(pl.lit("2–3일")).otherwise(pl.lit("1일")).alias("len_bucket"),
        pl.when(pl.col("d0_dominant")).then(pl.lit("D0 매수>매도")).otherwise(pl.lit("D0 매수≤매도"))
          .alias("d0_bucket"),
        pl.when(pl.col("break_depth") <= DEPTH_DEEP).then(pl.lit("깊은 깸(≤−3%)"))
          .otherwise(pl.lit("얕은 깸(>−3%)")).alias("depth_bucket"),
        pl.when(pl.col("days_to_c") <= SPEED_FAST_DAYS).then(pl.lit("C 3일 이내")).otherwise(pl.lit("C 4일+"))
          .alias("speed_bucket"),
    )
    summary["trick_conditional"] = {}
    for by in ("len_bucket", "d0_bucket", "depth_bucket", "speed_bucket", "leader_bucket", "ix_trend", "hi52_pos",
               "market"):
        summary["trick_conditional"][by] = {}
        for key in sorted(trick[by].drop_nulls().unique().to_list(), key=str):
            e = trick.filter(pl.col(by) == key)
            summary["trick_conditional"][by][str(key)] = {
                "n": e.height, **{c: describe(e, ctrl_trick, c, rng) for c in ("fwd5", "fwd10", "fwd20", "mae10")},
            }
    # D_end 당일 장중 깸(low(D_end) < W) × 분류 교차표 — 사용자가 차트에서 보는 「깨고 올라옴」은 당일
    # 장중 흔들기일 수 있고, 본 사양은 D_end 뒤의 깸만 세므로 그 사례가 「되돌림만」에 들어간다.
    summary["same_day_break_crosstab"] = {}
    for flag in (True, False):
        for cls in OUTCOME_CLASSES:
            e = ep.filter((pl.col("same_day_break") == flag) & (pl.col("cls") == cls))
            entry: dict = {"n": e.height}
            if e.height:
                entry.update({c: describe(e, ctrl_map[cls], c, rng) for c in ("fwd5", "fwd10", "fwd20", "mae10")})
                hv = e["hold_wall"].drop_nulls().cast(pl.Float64)
                entry["hold_wall"] = {"n": hv.len(), "rate": float(hv.mean())} if hv.len() else None  # type: ignore[arg-type]
            summary["same_day_break_crosstab"][f"same_day_break={flag}|{cls}"] = entry

    # 민감도
    def _sens_entry(e2: pl.DataFrame) -> dict:
        t2 = e2.filter(pl.col("cls") == CLASS_TRICK)
        r2 = e2.filter(pl.col("cls") == CLASS_RECLAIM)
        return {"episodes": e2.height, "class_counts_W": dict(Counter(e2["cls"].to_list())),
                "trick": {c: describe(t2, ctrl_trick, c, rng) for c in ("fwd5", "fwd10", "fwd20")},
                "reclaim": {c: describe(r2, ctrl_reclaim, c, rng) for c in ("fwd5", "fwd10", "fwd20")}}

    sens: dict = {}
    variants: tuple[tuple[str, dict], ...] = (
        ("ext_cap=3", {"cap": 3}),
        ("ext_cap=0(D0만)", {"cap": 0}),
        ("W=max_price", {"cap": args.ext_cap, "wall_key": "max_price"}),
        ("당일 장중 깸 포함", {"cap": args.ext_cap, "same_day_counts": True}),
        ("되돌림=close>high(D_end)", {"cap": args.ext_cap, "reclaim_ref": "high"}),
        ("당일 장중 깸 포함+되돌림=high", {"cap": args.ext_cap, "same_day_counts": True, "reclaim_ref": "high"}),
    )
    for name, kw in variants:
        e2, _, _g2 = build_episodes(ds, series, walls, args, **kw)
        sens[name] = _sens_entry(e2)
    sens["require_d0_dominant"] = _sens_entry(ep.filter(pl.col("d0_dominant")))
    # MA20 조건을 뒤집은 사양 — 대조군도 함께 뒤집는다(비교 대상이 같은 국면이어야 한다)
    other = "none" if args.ma20 == "below" else "below"
    e_other, _, _ = build_episodes(ds, series, walls, args, cap=args.ext_cap, events=ma20_filter(ds.events, other))
    c_other, _ = build_control(ma20_filter(ds.base, other), series, k=args.k)
    t_o = e_other.filter(pl.col("cls") == CLASS_TRICK)
    r_o = e_other.filter(pl.col("cls") == CLASS_RECLAIM)
    ct_o = c_other.filter(pl.col("cls_low") == CLASS_TRICK)
    cr_o = c_other.filter(pl.col("cls_low") == CLASS_RECLAIM)
    sens[f"ma20={other}"] = {
        "episodes": e_other.height, "class_counts_W": dict(Counter(e_other["cls"].to_list())),
        "trick": {c: describe(t_o, ct_o, c, rng) for c in ("fwd5", "fwd10", "fwd20")},
        "reclaim": {c: describe(r_o, cr_o, c, rng) for c in ("fwd5", "fwd10", "fwd20")},
    }
    summary["sensitivity"] = sens
    # 예시
    ex_cols = ("code", "name", "d0", "d_end", "ep_len", "wall_price", "close_end", "dist_pct", "break_day",
               "break_depth", "reclaim_day", "days_to_c", "fwd5", "fwd10", "fwd20", "mae10", "hold_wall",
               "leader_bucket", "ix_trend")
    tw = trick.filter(pl.col("fwd10").is_not_null()).select(ex_cols)
    summary["examples"] = {"best": tw.sort("fwd10", descending=True).head(12).to_dicts(),
                           "worst": tw.sort("fwd10").head(12).to_dicts()}

    (args.out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1, default=str), encoding="utf-8",
    )
    ep.write_csv(args.out_dir / "episodes.csv")
    ctrl.write_csv(args.out_dir / "control.csv")
    print("== wrote", args.out_dir)
    for cls in OUTCOME_CLASSES:
        o = summary["outcomes_W"][cls]
        f = o["fwd10"]
        print(f"  {cls}: n={o['n']} fwd10 {f['event_mean']*100:+.2f}% (win {f['event_win']*100:.0f}%) "
              f"vs ctrl {f['base_mean']*100:+.2f}% diff {f.get('diff', 0)*100:+.2f}%p CI {f.get('diff_ci95')} "
              f"| hold_wall {o.get('hold_wall')}")


if __name__ == "__main__":
    main()
