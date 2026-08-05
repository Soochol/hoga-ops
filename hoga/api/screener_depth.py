"""스크리너 총잔량 조건 평가 — 두 갈래가 한 모듈에 있다.

**과거 N일 peak 대비** (``ask_depth_new_high`` / ``bid_depth_new_high``):
당일 총잔량(10단계 합) 분봉 peak ≥ (threshold_pct/100) × 지난 N거래일 hogaplay peak.
당일 값은 오늘 WS/REST(kis_live/kis_api) 데이터에서, 과거 값은 hogaplay 캡처의
depth_daily 집계에서 온다(요구사항: 당일=실시간, 과거=hogaplay).

**기준시각 돌파** (``ask_depth_renewal`` / ``bid_depth_renewal``, 당일 전용):
기준시각 이후 그 side 총잔량 최댓값 ≥ (threshold_pct/100) × 개장~기준시각 최댓값.
매도·매수는 같은 스캔에서 함께 나오므로 기준시각이 같으면 쿼리도 한 번이다.
과거일을 전혀 보지 않으므로
depth_daily·코퍼스에 의존하지 않는다 — 애초에 쓸 수도 없다(depth_daily 는 하루당
스칼라 하나여서 시각 분해가 없다). 대신 당일 원본 스냅샷을 기준시각으로 갈라 읽는다.
이후 창의 **최댓값**으로 보므로 하루 중 한 번 돌파하면 재조회에도 계속 잡힌다 —
스크리너는 이벤트 스트림이 아니라 집합이고, 폴링(15~30초) 사이에 지나간 순간을
놓치지 않아야 한다. /live 의 실시간 알림(``sell_total_renewal``)과 같은 의미를 보지만
그쪽은 틱 단위 이벤트라 재무장 히스테리시스가 있고 이쪽은 없다(집합엔 불필요).

이 조건은 총잔량 데이터가 정의되는 종목 — 관심∪히트맵(캡처 대상) — 에서만 평가된다.
데이터가 없는 종목은 결과에서 제외하고 커버리지 리포트로 사용자에게 알린다(수집 요청
대상). depth 조건이 없으면 이 모듈은 관여하지 않는다(:func:`has_depth_conditions`).

평가 결과의 통과 코드 집합은 :func:`hoga.api.screener_scan.run_scan` 에 넘겨져
AND 결합된다 — run_scan 의 CTE 아키텍처를 건드리지 않고 사전계산 코드셋으로 주입.
"""
# PEP 236: __future__ import 는 "첫 문장" 이어야 하지만 **모듈 docstring 은 예외**로
# 허용된다. 순서를 뒤집으면 뒤따르는 문자열이 docstring 자격을 잃어 __doc__ 이 None 이
# 된다 — 문법 오류가 아니라 조용히 사라진다. depth_daily.py 와 같은 결함이었다.
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from hoga.api import depth_daily
from hoga.api.models import DepthCoverage, DepthCoverageCode, DepthPeakValue
from hoga.api.sources import resolve_source_venue_dir
from hoga.duck import connect_bounded
from hoga.tables import snapshots as snapshots_tbl

log = logging.getLogger(__name__)

ASK_TYPE = "ask_depth_new_high"
BID_TYPE = "bid_depth_new_high"
# 기준시각 돌파(당일 전용) — peak 조건과 데이터 의존이 다르다. 저쪽은 과거 N일
# hogaplay 집계(depth_daily)를 보지만 이쪽은 **당일 원본 스냅샷만** 본다: depth_daily
# 는 하루당 스칼라 하나라 시각 분해가 없어서 애초에 쓸 수 없다.
RENEWAL_ASK_TYPE = "ask_depth_renewal"
RENEWAL_BID_TYPE = "bid_depth_renewal"
_PEAK_TYPES = (ASK_TYPE, BID_TYPE)
_RENEWAL_TYPES = (RENEWAL_ASK_TYPE, RENEWAL_BID_TYPE)
# 사전계산 코드셋으로 처리되는 조건 타입의 **단일 진실 소스**. screener_scan 이 같은
# 목록을 따로 들고 있었는데, 새 타입을 한쪽에만 더하면 다른 쪽이 CONDITION_COMPILERS
# 조회로 흘러 KeyError 로 죽는다 — 그래서 여기서 import 하게 했다.
DEPTH_TYPES = (*_PEAK_TYPES, *_RENEWAL_TYPES)
_DEPTH_TYPES = DEPTH_TYPES
# 당일 값 소스: 관심종목은 KIS WS 승격(kis_live), 히트맵은 키움 WS 승격(kiwoom_live,
# ADR-0116). REST30 승격(kis_api)은 캡처와 함께 제거됨(2026-07-17 — api 폴백 없음).
# 종목 소유권 단일이라 코드별로 하나만 존재.
_TODAY_SOURCES = ("kis_live", "kiwoom_live")
_KRX_OPEN_MS = 90_000_000    # 09:00:00.000 (HHMMSSmmm)
_KRX_CLOSE_MS = 153_000_000  # 15:30:00.000
# HHMM(1200) → HHMMSSmmm(120000000). 스냅샷 ts_ms 가 HHMMSSmmm native 라 기준시각도
# 같은 인코딩으로 올려야 한다.
_HHMM_TO_HHMMSSMMM = 100_000


@dataclass
class DepthEvalResult:
    passing: dict[str, set[str]]          # leaf.id -> 통과 코드 집합
    # 커버리지는 **과거 hogaplay 데이터**에 대한 리포트다 — 배너의 처방이 "지난 N일
    # 수집 요청"이라 과거 의존이 없는 조건에는 줄 수 있는 조치가 없다. 기준시각 돌파
    # 조건만 있는 스크린은 None 이고, 배너는 그리지 않는다(당일 데이터가 없는 종목은
    # 수집이 아니라 관심·히트맵 편입으로만 해결된다).
    coverage: DepthCoverage | None
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
    except Exception:  # 히트맵 부재/손상이 스캔을 죽이면 안 됨
        log.exception("depth eval: heatmap load failed")
    try:
        for e in watchlist.load_watchlist(data_dir):
            name_by.setdefault(e.code, e.name)
    except Exception:
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


def _existing_today_snapshots(day_dir: Path, codes: set[str]) -> list[tuple[str, Path]]:
    """(code, snapshots.parquet) — 실제로 존재하는 것만, 정렬된 순서로."""
    found: list[tuple[str, Path]] = []
    for code in sorted(codes):
        for source in _TODAY_SOURCES:
            # ⚠ "KRX" 리터럴 — 스크리너 depth 는 아직 venue 개념이 없다(PR-J).
            snap = resolve_source_venue_dir(day_dir / code, source, "KRX") / "snapshots.parquet"
            if snap.exists():
                found.append((code, snap))
    return found


def _fold_peaks(
    out: dict[str, tuple[int | None, int | None]],
    code: str,
    peak: snapshots_tbl.DailyDepthPeak,
) -> None:
    """소스가 둘이면 side 별 최댓값을 취한다(관심=WS, 히트맵=키움 WS)."""
    best_ask, best_bid = out.get(code, (None, None))
    out[code] = (
        peak.ask_peak if best_ask is None else max(best_ask, peak.ask_peak),
        peak.bid_peak if best_bid is None else max(best_bid, peak.bid_peak),
    )


def _today_peaks(
    data_dir: Path, codes: set[str], today: str,
) -> dict[str, tuple[int | None, int | None]]:
    """오늘 live parquet(kis_live/kiwoom_live)의 code별 (ask,bid) 당일 peak.

    두 소스가 모두 있으면 각 side 최댓값을 취한다. 표준 KRX 세션 경계로 재사용 —
    장중이라 마감 상한은 무해하고 개장 동시호가는 하한이 배제한다.

    **배치 1쿼리 + 단건 폴백.** 종목당 개별 쿼리는 유니버스 전체에서 ~478 쿼리가 되고
    실측 1.5초였다(2026-07-30, 241종목 · 42MiB). 데이터량이 아니라 왕복 비용이 종목
    수만큼 반복되는 것이 원인이라(호출당 중위 6.4ms 로 균일) 한 쿼리로 접으면 0.12초다
    — 실데이터 3거래일 719파일에서 결과 완전 일치를 확인했다.

    배치는 **최적화일 뿐**이다: 파일 하나의 스키마가 어긋나면 배치 전체가 죽으므로
    (부분 마이그레이션된 Stock-Date 등) 실패 시 단건 경로로 조용히 되돌아간다 —
    느리지만 파일 단위 격리가 보존된다(``_batch_parquet_stats`` 와 같은 규율).
    """
    out: dict[str, tuple[int | None, int | None]] = {}
    day_dir = data_dir / "parquet" / today
    if not day_dir.exists():
        return out
    present = _existing_today_snapshots(day_dir, codes)
    if not present:
        return out

    con = connect_bounded()
    try:
        batched = snapshots_tbl.query_daily_depth_peaks(
            con, paths=[p for _code, p in present],
            session_open_ms=_KRX_OPEN_MS, session_close_ms=_KRX_CLOSE_MS,
        )
    except Exception:  # noqa: BLE001 — 배치는 최적화, 실패는 단건으로 흡수
        log.warning("depth eval: batched today-peak query failed; per-file fallback",
                    exc_info=True)
    else:
        for code, snap in present:
            peak = batched.get(str(snap))
            if peak is not None:
                _fold_peaks(out, code, peak)
        return out

    for code, snap in present:
        peak = snapshots_tbl.query_daily_depth_peak(
            con, path=snap,
            session_open_ms=_KRX_OPEN_MS, session_close_ms=_KRX_CLOSE_MS,
        )
        if peak is not None:
            _fold_peaks(out, code, peak)
    return out


def _max_opt(a: int | None, b: int | None) -> int | None:
    """None 을 "값 없음"으로 다루는 max — 0 과 구분된다(0 은 실제 잔량 0)."""
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


def _today_split_peaks(
    data_dir: Path, codes: set[str], today: str, *, split_ms: int,
) -> dict[str, snapshots_tbl.DepthSplitPeak]:
    """오늘 live parquet 의 code별 기준시각 분할 peak(매도·매수 양측).

    두 소스(관심=KIS WS, 히트맵=키움 WS)가 모두 있으면 **창별·side별로 각각**
    최댓값을 취한다 — :func:`_fold_peaks` 와 같은 규칙.

    배치 1쿼리를 쓰고, 실패하면 같은 배치 함수를 **파일 1개짜리로** 재호출해 되돌린다.
    별도의 단건 SQL 을 만들지 않는 이유는 술어가 두 벌이 되면 정의가 갈릴 수 있어서다
    — 여기서 필요한 건 속도가 아니라 파일 하나가 배치 전체를 죽이지 않는 격리다.
    """
    out: dict[str, snapshots_tbl.DepthSplitPeak] = {}
    day_dir = data_dir / "parquet" / today
    if not day_dir.exists():
        return out
    present = _existing_today_snapshots(day_dir, codes)
    if not present:
        return out

    def _fold(code: str, peak: snapshots_tbl.DepthSplitPeak) -> None:
        prev = out.get(code)
        if prev is None:
            out[code] = peak
            return
        out[code] = snapshots_tbl.DepthSplitPeak(
            pre_ask_peak=_max_opt(prev.pre_ask_peak, peak.pre_ask_peak),
            post_ask_peak=_max_opt(prev.post_ask_peak, peak.post_ask_peak),
            pre_bid_peak=_max_opt(prev.pre_bid_peak, peak.pre_bid_peak),
            post_bid_peak=_max_opt(prev.post_bid_peak, peak.post_bid_peak),
            eligible_count=prev.eligible_count + peak.eligible_count,
        )

    con = connect_bounded()
    try:
        batched = snapshots_tbl.query_daily_depth_split_peaks(
            con, paths=[p for _code, p in present], split_ms=split_ms,
            session_open_ms=_KRX_OPEN_MS, session_close_ms=_KRX_CLOSE_MS,
        )
    except Exception:  # noqa: BLE001 — 배치는 최적화, 실패는 파일 단위로 흡수
        log.warning("depth eval: batched split-peak query failed; per-file fallback",
                    exc_info=True)
    else:
        for code, snap in present:
            peak = batched.get(str(snap))
            if peak is not None:
                _fold(code, peak)
        return out

    for code, snap in present:
        try:
            single = snapshots_tbl.query_daily_depth_split_peaks(
                con, paths=[snap], split_ms=split_ms,
                session_open_ms=_KRX_OPEN_MS, session_close_ms=_KRX_CLOSE_MS,
            )
        except Exception:
            log.exception("depth eval: split-peak query failed for %s", snap)
            continue
        peak = single.get(str(snap))
        if peak is not None:
            _fold(code, peak)
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
    peak = dict(zip(agg["code"].to_list(), agg["peak"].to_list(), strict=True))
    have = dict(zip(agg["code"].to_list(), agg["have"].to_list(), strict=True))
    return peak, have


def evaluate(  # noqa: PLR0912, PLR0915
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

    두 조건 갈래는 데이터 의존이 달라 서로의 비용을 지지 않는다 — 기준시각 돌파만
    있는 스크린은 depth_daily·코퍼스를 읽지 않고, 반환 ``coverage`` 도 None 이다
    (그 커버리지 배너의 처방인 "지난 N일 수집"이 당일 전용 조건엔 무의미하다).
    """
    peak_leaves = [c for c in conditions if c.type in _PEAK_TYPES]
    renewal_leaves = [c for c in conditions if c.type in _RENEWAL_TYPES]
    warnings: list[str] = []

    name_by = _depth_universe(data_dir)
    depth_codes = set(name_by) & universe_codes

    passing: dict[str, set[str]] = {}
    today_peaks: dict[str, tuple[int | None, int | None]] = {}
    cov_have_by: dict[str, int] = {}
    ask_peak_by: dict[str, int] = {}
    ask_have_by: dict[str, int] = {}
    bid_peak_by: dict[str, int] = {}
    bid_have_by: dict[str, int] = {}
    ask_n: int | None = None
    bid_n: int | None = None
    max_n = 0

    # === 과거 N일 peak 대비 조건 (ask/bid_depth_new_high) ===
    # 과거 코퍼스·depth_daily 는 이 갈래에서만 필요하다 — 기준시각 돌파 조건만 있는
    # 스크린에서 parquet 을 읽거나 depth_corpus_unavailable 을 붙이지 않는다.
    if peak_leaves:
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
            if today_ref is not None and dd.height:
                tp = dd.filter(pl.col("date") == today_ref)
                for r in tp.iter_rows(named=True):
                    today_peaks[r["code"]] = (r["ask_peak"], r["bid_peak"])

        if not corpus:
            warnings.append("depth_corpus_unavailable")

        for leaf in peak_leaves:
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
                tp_v = today_peaks.get(code)
                today_val = tp_v[idx] if tp_v else None
                if today_val is None or past is None:
                    continue
                if today_val >= past * (thr / 100.0):
                    ok.add(code)
            passing[leaf.id] = ok

        # 커버리지(집합 관점: excluded/partial)는 가장 넓은 N 창 기준.
        max_n = max(leaf.params.lookback for leaf in peak_leaves)
        _, cov_have_by = _past_agg(
            dd, _window_dates(corpus, before=today_ref, n=max_n), "ask_peak")

        # 표시값(사이드카)은 각 side 의 자기 leaf N 창 기준 — 혼합 N 스크린에서 배지가 실제
        # 통과를 좌우한 값을 보여주도록(가장 넓은 N 을 양쪽에 쓰지 않는다).
        def _side_n(t: str) -> int | None:
            ns = [lf.params.lookback for lf in peak_leaves if lf.type == t]
            return max(ns) if ns else None

        ask_n, bid_n = _side_n(ASK_TYPE), _side_n(BID_TYPE)
        if ask_n is not None:
            ask_peak_by, ask_have_by = _past_agg(
                dd, _window_dates(corpus, before=today_ref, n=ask_n), "ask_peak")
        if bid_n is not None:
            bid_peak_by, bid_have_by = _past_agg(
                dd, _window_dates(corpus, before=today_ref, n=bid_n), "bid_peak")

    # === 기준시각 돌파 조건 (ask/bid_depth_renewal) — 당일 원본 스냅샷만 본다 ===
    # side 별 사이드카: (기준시각, code -> (이전 최대, 이후 최대)).
    renewal_side: dict[str, tuple[int | None, dict[str, tuple[int | None, int | None]]]] = {
        RENEWAL_ASK_TYPE: (None, {}), RENEWAL_BID_TYPE: (None, {}),
    }
    if renewal_leaves:
        if basis != "intraday":
            # 당일 전용 조건이다. eod 기준에선 '기준시각 이후'가 정의되지 않으므로
            # 조용히 전 종목을 통과시키지 않고 명시적으로 0행 + 경고로 끝낸다.
            warnings.append("depth_renewal_requires_intraday")
            for leaf in renewal_leaves:
                passing[leaf.id] = set()
        else:
            # 스냅샷 스캔은 기준시각당 한 번이면 된다 — 매도·매수가 같은 시각을 쓰면
            # 쿼리도 한 번이다(같은 파일에서 양측 값이 함께 나온다).
            by_hhmm: dict[int, dict[str, snapshots_tbl.DepthSplitPeak]] = {}
            for leaf in renewal_leaves:
                hhmm = leaf.params.start_hhmm
                thr = leaf.params.threshold_pct
                is_ask = leaf.type == RENEWAL_ASK_TYPE
                if hhmm not in by_hhmm:
                    by_hhmm[hhmm] = _today_split_peaks(
                        data_dir, depth_codes, today, split_ms=hhmm * _HHMM_TO_HHMMSSMMM)
                windows = {
                    code: ((sp.pre_ask_peak, sp.post_ask_peak) if is_ask
                           else (sp.pre_bid_peak, sp.post_bid_peak))
                    for code, sp in by_hhmm[hhmm].items()
                }
                passing[leaf.id] = {
                    code for code, (pre, post) in windows.items()
                    # 두 창 모두 유효 데이터가 있어야 한다. post 가 None 이면 기준시각이
                    # 아직 미래이거나 그 뒤 유효 스냅샷이 없다는 뜻 — 미통과가 옳다.
                    # 비교식(≥)은 peak 조건·실시간 알림과 글자 그대로 같다.
                    if pre is not None and post is not None and post >= pre * (thr / 100.0)
                }
                # 사이드카는 side 당 한 벌뿐이라 같은 side 에 기준시각이 여럿이면 가장
                # 늦은 것을 싣는다(_side_n 이 가장 넓은 N 을 싣는 것과 같은 규칙 —
                # 배지가 무엇을 말하는지 *_renewal_start_hhmm 으로 함께 밝힌다).
                prev_hhmm, _ = renewal_side[leaf.type]
                if prev_hhmm is None or hhmm > prev_hhmm:
                    renewal_side[leaf.type] = (hhmm, windows)

    ask_hhmm, ask_split = renewal_side[RENEWAL_ASK_TYPE]
    bid_hhmm, bid_split = renewal_side[RENEWAL_BID_TYPE]

    excluded: list[DepthCoverageCode] = []
    partial: list[DepthCoverageCode] = []
    values: dict[str, DepthPeakValue] = {}
    for code in sorted(depth_codes):
        tp_v = today_peaks.get(code)
        ask_pre, ask_post = ask_split.get(code, (None, None))
        bid_pre, bid_post = bid_split.get(code, (None, None))
        values[code] = DepthPeakValue(
            ask_today=tp_v[0] if tp_v else None,
            ask_past_peak=ask_peak_by.get(code),
            ask_have_days=int(ask_have_by.get(code, 0)),
            ask_need_days=ask_n or 0,
            bid_today=tp_v[1] if tp_v else None,
            bid_past_peak=bid_peak_by.get(code),
            bid_have_days=int(bid_have_by.get(code, 0)),
            bid_need_days=bid_n or 0,
            ask_pre_max=ask_pre,
            ask_post_max=ask_post,
            ask_renewal_start_hhmm=ask_hhmm,
            bid_pre_max=bid_pre,
            bid_post_max=bid_post,
            bid_renewal_start_hhmm=bid_hhmm,
        )
        if not peak_leaves:
            continue
        have = int(cov_have_by.get(code, 0))
        if have == 0:
            excluded.append(DepthCoverageCode(
                code=code, name=name_by[code], have_days=0, need_days=max_n))
        elif have < max_n:
            partial.append(DepthCoverageCode(
                code=code, name=name_by[code], have_days=have, need_days=max_n))

    coverage = DepthCoverage(
        lookback=max_n, evaluated=len(depth_codes),
        excluded=excluded, partial=partial,
    ) if peak_leaves else None
    return DepthEvalResult(
        passing=passing, coverage=coverage, values=values, warnings=warnings,
    )
