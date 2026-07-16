from __future__ import annotations

"""스크리너 '매도/매수 총잔량 분봉 peak 신고' 조건 평가.

조건 의미: 당일 총잔량(10단계 합) 분봉 peak ≥ (threshold_pct/100) × 지난 N거래일
hogaplay peak. 당일 값은 오늘 WS/REST(kis_live/kis_api) 데이터에서, 과거 값은
hogaplay 캡처의 depth_daily 집계에서 온다(요구사항: 당일=실시간, 과거=hogaplay).

이 조건은 총잔량 데이터가 정의되는 종목 — 관심∪히트맵(캡처 대상) — 에서만 평가된다.
데이터가 없는 종목은 결과에서 제외하고 커버리지 리포트로 사용자에게 알린다(수집 요청
대상). depth 조건이 없으면 이 모듈은 관여하지 않는다(:func:`has_depth_conditions`).

평가 결과의 통과 코드 집합은 :func:`hoga.api.screener_scan.run_scan` 에 넘겨져
AND 결합된다 — run_scan 의 CTE 아키텍처를 건드리지 않고 사전계산 코드셋으로 주입.
"""

import logging
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from hoga.api import depth_daily
from hoga.api.models import DepthCoverage, DepthCoverageCode, DepthPeakValue
from hoga.duck import connect_bounded
from hoga.tables import snapshots as snapshots_tbl

log = logging.getLogger(__name__)

ASK_TYPE = "ask_depth_new_high"
BID_TYPE = "bid_depth_new_high"
_DEPTH_TYPES = (ASK_TYPE, BID_TYPE)
# 당일 값 소스: 관심종목은 KIS WS 승격(kis_live), 히트맵은 키움 WS 승격(kiwoom_live,
# ADR-0116) 또는 REST30 승격(kis_api 폴백). 종목 소유권 단일이라 코드별로 하나만 존재.
_TODAY_SOURCES = ("kis_live", "kiwoom_live", "kis_api")
_KRX_OPEN_MS = 90_000_000    # 09:00:00.000 (HHMMSSmmm)
_KRX_CLOSE_MS = 153_000_000  # 15:30:00.000


@dataclass
class DepthEvalResult:
    passing: dict[str, set[str]]          # leaf.id -> 통과 코드 집합
    coverage: DepthCoverage
    values: dict[str, DepthPeakValue]     # code -> 결과행 검증용 사이드카
    warnings: list[str] = field(default_factory=list)


def has_depth_conditions(conditions) -> bool:
    return any(getattr(c, "type", None) in _DEPTH_TYPES for c in conditions)


def _depth_universe(data_dir: Path) -> dict[str, str]:
    """관심∪히트맵 코드→이름. 총잔량 데이터가 정의되는 캡처 대상 집합."""
    from hoga.api import heatmap, watchlist  # noqa: PLC0415 — import cycle 회피
    name_by: dict[str, str] = {}
    try:
        for e in heatmap.load_heatmap(data_dir):
            name_by.setdefault(e.code, e.name)
    except Exception:  # noqa: BLE001 — 히트맵 부재/손상이 스캔을 죽이면 안 됨
        log.exception("depth eval: heatmap load failed")
    try:
        for e in watchlist.load_watchlist(data_dir):
            name_by.setdefault(e.code, e.name)
    except Exception:  # noqa: BLE001
        log.exception("depth eval: watchlist load failed")
    return name_by


def _corpus_dates(adjusted_path: Path) -> list[str]:
    """코퍼스(거래일 전용)의 distinct date(YYYYMMDD) 오름차순."""
    if not adjusted_path.exists():
        return []
    con = connect_bounded()
    rows = con.execute(
        f"SELECT DISTINCT strftime(date, '%Y%m%d') d FROM '{adjusted_path}' ORDER BY d"
    ).fetchall()
    return [r[0] for r in rows]


def _today_peaks(
    data_dir: Path, codes: set[str], today: str,
) -> dict[str, tuple[int | None, int | None]]:
    """오늘 live parquet(kis_live/kis_api)의 code별 (ask,bid) 당일 peak.

    두 소스가 모두 있으면 각 side 최댓값을 취한다(관심=WS, 히트맵=REST30). 표준 KRX
    세션 경계로 query_daily_depth_peak 를 재사용 — 장중이라 마감 상한은 무해하고 개장
    동시호가는 하한이 배제한다."""
    con = connect_bounded()
    out: dict[str, tuple[int | None, int | None]] = {}
    day_dir = data_dir / "parquet" / today
    if not day_dir.exists():
        return out
    for code in codes:
        best_ask: int | None = None
        best_bid: int | None = None
        for source in _TODAY_SOURCES:
            snap = day_dir / code / source / "snapshots.parquet"
            if not snap.exists():
                continue
            peak = snapshots_tbl.query_daily_depth_peak(
                con, path=snap,
                session_open_ms=_KRX_OPEN_MS, session_close_ms=_KRX_CLOSE_MS,
            )
            if peak is None:
                continue
            best_ask = peak.ask_peak if best_ask is None else max(best_ask, peak.ask_peak)
            best_bid = peak.bid_peak if best_bid is None else max(best_bid, peak.bid_peak)
        if best_ask is not None or best_bid is not None:
            out[code] = (best_ask, best_bid)
    return out


def _window_dates(corpus: list[str], *, before: str | None, n: int) -> list[str]:
    """코퍼스에서 ``before`` 미만인 가장 최근 N개 거래일(오름차순)."""
    if not corpus:
        return []
    past = [d for d in corpus if before is None or d < before]
    return past[-n:]


def _past_agg(
    dd: pl.DataFrame, window: list[str], side_col: str,
) -> tuple[dict[str, int], dict[str, int]]:
    """window 내 code별 (peak, have_days). dd 는 hogaplay 필터 완료 프레임."""
    if not window or dd.height == 0:
        return {}, {}
    w = dd.filter(pl.col("date").is_in(window))
    if w.height == 0:
        return {}, {}
    agg = w.group_by("code").agg(
        pl.col(side_col).max().alias("peak"),
        pl.col("date").n_unique().alias("have"),
    )
    peak = dict(zip(agg["code"].to_list(), agg["peak"].to_list()))
    have = dict(zip(agg["code"].to_list(), agg["have"].to_list()))
    return peak, have


def evaluate(
    *,
    data_dir: Path,
    sdir: Path,
    conditions,
    universe_codes: set[str],
    basis: str,
    today: str,
) -> DepthEvalResult:
    """depth 조건들을 평가해 leaf별 통과 코드셋 + 커버리지 + 표시값을 반환.

    호출 전 :func:`has_depth_conditions` 로 depth 조건 존재를 확인한다(없으면 부르지
    않음). ``universe_codes`` 는 스캔 유니버스(KOSPI/KOSDAQ 필터 후) 코드 집합.
    """
    depth_leaves = [c for c in conditions if c.type in _DEPTH_TYPES]
    warnings: list[str] = []

    name_by = _depth_universe(data_dir)
    depth_codes = set(name_by) & universe_codes

    dd_all = depth_daily.load(data_dir)
    # eligible_count>0 만 — 퇴화 캡처의 센티넬 행(peak null)은 과거 peak/커버리지에서 제외.
    dd = (
        dd_all.filter((pl.col("src") == depth_daily.HOGAPLAY) & (pl.col("eligible_count") > 0))
        if dd_all.height else dd_all
    )
    corpus = _corpus_dates(sdir / "daily_adjusted.parquet")

    # 당일 기준일과 당일 peak 소스.
    if basis == "intraday":
        today_ref = today
        today_peaks = _today_peaks(data_dir, depth_codes, today)
    else:  # eod: '당일' = 코퍼스 최신 확정 거래일, 그 날의 hogaplay peak.
        today_ref = corpus[-1] if corpus else None
        today_peaks = {}
        if today_ref is not None and dd.height:
            tp = dd.filter(pl.col("date") == today_ref)
            for r in tp.iter_rows(named=True):
                today_peaks[r["code"]] = (r["ask_peak"], r["bid_peak"])

    if not corpus:
        warnings.append("depth_corpus_unavailable")

    # leaf별 통과 코드셋.
    passing: dict[str, set[str]] = {}
    for leaf in depth_leaves:
        n = leaf.params.lookback
        thr = leaf.params.threshold_pct
        side = "ask_peak" if leaf.type == ASK_TYPE else "bid_peak"
        idx = 0 if leaf.type == ASK_TYPE else 1
        window = _window_dates(corpus, before=today_ref, n=n)
        peak_by, have_by = _past_agg(dd, window, side)
        ok: set[str] = set()
        for code in depth_codes:
            if have_by.get(code, 0) == 0:
                continue  # 과거 데이터 없음 → 비교 불가(제외)
            past = peak_by.get(code)
            tp = today_peaks.get(code)
            today_val = tp[idx] if tp else None
            if today_val is None or past is None:
                continue
            if today_val >= past * (thr / 100.0):
                ok.add(code)
        passing[leaf.id] = ok

    # 커버리지(집합 관점: excluded/partial)는 가장 넓은 N 창 기준.
    max_n = max(leaf.params.lookback for leaf in depth_leaves)
    _, cov_have_by = _past_agg(dd, _window_dates(corpus, before=today_ref, n=max_n), "ask_peak")

    # 표시값(사이드카)은 각 side 의 자기 leaf N 창 기준 — 혼합 N 스크린에서 배지가 실제
    # 통과를 좌우한 값을 보여주도록(가장 넓은 N 을 양쪽에 쓰지 않는다).
    def _side_n(t: str) -> int | None:
        ns = [lf.params.lookback for lf in depth_leaves if lf.type == t]
        return max(ns) if ns else None

    ask_n, bid_n = _side_n(ASK_TYPE), _side_n(BID_TYPE)
    ask_peak_by: dict[str, int] = {}
    ask_have_by: dict[str, int] = {}
    bid_peak_by: dict[str, int] = {}
    bid_have_by: dict[str, int] = {}
    if ask_n is not None:
        ask_peak_by, ask_have_by = _past_agg(
            dd, _window_dates(corpus, before=today_ref, n=ask_n), "ask_peak")
    if bid_n is not None:
        bid_peak_by, bid_have_by = _past_agg(
            dd, _window_dates(corpus, before=today_ref, n=bid_n), "bid_peak")

    excluded: list[DepthCoverageCode] = []
    partial: list[DepthCoverageCode] = []
    values: dict[str, DepthPeakValue] = {}
    for code in sorted(depth_codes):
        have = int(cov_have_by.get(code, 0))
        tp = today_peaks.get(code)
        values[code] = DepthPeakValue(
            ask_today=tp[0] if tp else None,
            ask_past_peak=ask_peak_by.get(code),
            ask_have_days=int(ask_have_by.get(code, 0)),
            ask_need_days=ask_n or 0,
            bid_today=tp[1] if tp else None,
            bid_past_peak=bid_peak_by.get(code),
            bid_have_days=int(bid_have_by.get(code, 0)),
            bid_need_days=bid_n or 0,
        )
        if have == 0:
            excluded.append(DepthCoverageCode(
                code=code, name=name_by[code], have_days=0, need_days=max_n))
        elif have < max_n:
            partial.append(DepthCoverageCode(
                code=code, name=name_by[code], have_days=have, need_days=max_n))

    coverage = DepthCoverage(
        lookback=max_n, evaluated=len(depth_codes),
        excluded=excluded, partial=partial,
    )
    return DepthEvalResult(
        passing=passing, coverage=coverage, values=values, warnings=warnings,
    )
