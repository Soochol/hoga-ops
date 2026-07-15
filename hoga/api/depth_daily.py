from __future__ import annotations

"""depth_daily.parquet — (code, date)당 매도/매수 총잔량 당일 peak 집계 스토어.

스크리너 ``ask_depth_new_high`` / ``bid_depth_new_high`` 조건은 "당일 매도 총잔량
분봉 peak가 지난 N거래일 hogaplay peak의 X% 이상"인지를 본다. 스캔 시점에 종목×일자
별로 ``snapshots.parquet``(스톡데이트당 수만 행)를 훑으면 첫 스캔이 수 초로 늘어나므로,
parse/promote 완료 시점에 (code, date, src)당 1행으로 미리 집계해 둔다.

Peak 정의는 :func:`hoga.tables.snapshots.query_daily_depth_peak` — /live 총잔량 pane의
Intra-Bar Max(``ask_max``, ADR-0076)를 하루로 collapse한 값이며 동시호가·VI 배제
술어(ADR-0062 v3)를 그대로 재사용한다. 사용자가 스크리너 결과의 과거 peak를 /live
pane에서 눈으로 검증할 수 있어야 하기 때문이다.

v1은 스크리너 비교 기준이 hogaplay이므로 스윕도 hogaplay 소스만 집계한다(``src``
컬럼은 두어 추후 kis_live/kis_api 폴백 여지를 남긴다). "당일" peak는 depth_daily가
아니라 스캔 시점에 라이브 parquet(kis_live/kis_api)에서 직접 산출한다 — 그 경로는
screener_runner가 담당한다.
"""

import datetime as dt
import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from hoga.api._atomic_write import atomic_write_parquet_df
from hoga.api.invariants import normalize_session_bounds
from hoga.api.queries import resolve_source_dir
from hoga.duck import connect_bounded
from hoga.tables import snapshots as snapshots_tbl

log = logging.getLogger(__name__)

HOGAPLAY = "hogaplay"

# depth_daily.parquet 의 read-modify-write 를 직렬화한다. sweep 은 캡처 완료 훅에서
# 기본 스레드풀(동시 최대 _max_concurrent 워커)을 통해 호출되므로, lock 없이는 두
# 워커가 같은 existing 을 읽고 각자 merge 를 써서 한쪽 행을 덮어써 유실시킨다. 무거운
# per-스톡데이트 계산(new_rows)은 lock 밖에서 하고, 이 lock 은 load→merge→write 만
# 감싸며 그 안에서 existing 을 다시 로드해 다른 sweep 의 기록을 잃지 않는다.
_WRITE_LOCK = threading.Lock()

# parquet 컬럼 dtype 계약. code 는 VARCHAR(leading-zero 보존), date 는 파케이 트리와
# 같은 YYYYMMDD 문자열(스캔 SQL 에서 코퍼스 최근일 집합과 문자열 비교). meta_mtime_ns
# 는 증분 스윕용 freshness 지문 — 메타가 그대로면 재계산을 건너뛴다.
_SCHEMA: dict = {
    "code": pl.Utf8,
    "date": pl.Utf8,
    "src": pl.Utf8,
    "ask_peak": pl.Int64,
    "bid_peak": pl.Int64,
    "eligible_count": pl.Int64,
    "meta_mtime_ns": pl.Int64,
}
_KEY = ["code", "date", "src"]


def depth_daily_path(data_dir: Path) -> Path:
    return data_dir / "screener" / "depth_daily.parquet"


@dataclass(frozen=True)
class SweepResult:
    scanned: int          # 메타가 존재한 (code,date,src) 수
    computed: int         # 새로/다시 계산한 수(메타 변경 또는 신규)
    skipped: int          # 메타 미변경으로 건너뛴 수
    no_data: int          # 유효 스냅샷 0 → peak 없음(집계 제외)
    total_rows: int       # 기록 후 depth_daily 총 행 수


def compute_stock_date_peak(
    con, code_dir: Path, source: str,
) -> snapshots_tbl.DailyDepthPeak | None:
    """스톡데이트 1개(한 소스)의 당일 총잔량 peak. 메타/스냅샷 부재·유효행 0 → None."""
    src_dir = resolve_source_dir(code_dir, source)
    meta_path = src_dir / "meta.json"
    snap_path = src_dir / "snapshots.parquet"
    if not meta_path.exists() or not snap_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    # regular_session_open_ms 를 값으로 소비하기 전 정규화(open==0 sentinel 복원, ADR-0063).
    norm_meta, _ = normalize_session_bounds(meta)
    open_ms = norm_meta.get("regular_session_open_ms")
    close_ms = meta.get("regular_session_close_ms")
    return snapshots_tbl.query_daily_depth_peak(
        con,
        path=snap_path,
        session_open_ms=open_ms if isinstance(open_ms, int) else None,
        session_close_ms=close_ms if isinstance(close_ms, int) else None,
    )


def load(data_dir: Path) -> pl.DataFrame:
    """현재 depth_daily.parquet(없으면 빈 프레임, 스키마 고정)."""
    path = depth_daily_path(data_dir)
    if not path.exists():
        return pl.DataFrame(schema=_SCHEMA)
    return pl.read_parquet(path)


def is_yyyymmdd(name: str) -> bool:
    if len(name) != 8 or not name.isdigit():
        return False
    try:
        dt.datetime.strptime(name, "%Y%m%d")
    except ValueError:
        return False
    return True


def sweep(
    data_dir: Path,
    *,
    codes: set[str] | None = None,
    dates: set[str] | None = None,
    sources: tuple[str, ...] = (HOGAPLAY,),
) -> SweepResult:
    """parquet 트리를 훑어 depth_daily 를 증분 갱신.

    ``codes`` / ``dates`` 로 대상을 좁힐 수 있다(parse 완료 훅은 방금 캡처한 (code,date)
    한 쌍만 넘긴다). 메타 mtime 이 기존 행과 같으면 재계산을 건너뛴다(증분). 유효
    스냅샷이 0인 스톡데이트(퇴화 캡처)는 peak 를 만들지 않고 no_data 로만 집계한다 —
    그 날은 스크리너 비교에서 "데이터 없음"으로 취급된다.
    """
    parquet_root = data_dir / "parquet"
    existing = load(data_dir)
    # (code,date,src) -> meta_mtime_ns 지문(증분 판정용).
    fresh: dict[tuple[str, str, str], int] = {
        (r["code"], r["date"], r["src"]): int(r["meta_mtime_ns"])
        for r in existing.iter_rows(named=True)
    }
    con = connect_bounded()
    new_rows: list[dict] = []
    scanned = computed = skipped = no_data = 0

    if parquet_root.exists():
        for date_dir in sorted(parquet_root.iterdir()):
            if not date_dir.is_dir() or not is_yyyymmdd(date_dir.name):
                continue
            date = date_dir.name
            if dates is not None and date not in dates:
                continue
            for code_dir in sorted(date_dir.iterdir()):
                if not code_dir.is_dir():
                    continue
                code = code_dir.name
                if codes is not None and code not in codes:
                    continue
                for source in sources:
                    src_dir = resolve_source_dir(code_dir, source)
                    meta_path = src_dir / "meta.json"
                    if not meta_path.exists():
                        continue
                    try:
                        mtime = meta_path.stat().st_mtime_ns
                    except FileNotFoundError:
                        continue
                    scanned += 1
                    key = (code, date, source)
                    if fresh.get(key) == mtime:
                        skipped += 1
                        continue
                    peak = compute_stock_date_peak(con, code_dir, source)
                    if peak is None:
                        # 유효 스냅샷 0(퇴화 캡처) — 센티넬 행(peak null, eligible_count 0)을
                        # 기록한다. ① 다음 sweep 이 fingerprint 로 건너뛰어(재계산 방지)
                        # ② 재캡처로 good→degenerate 시 keep='last' 가 기존 good 행을 덮어
                        # stale peak 를 남기지 않는다. 스크리너는 eligible_count>0 만 읽으므로
                        # 센티넬은 과거 peak/커버리지에 잡히지 않는다.
                        new_rows.append({
                            "code": code, "date": date, "src": source,
                            "ask_peak": None, "bid_peak": None,
                            "eligible_count": 0, "meta_mtime_ns": mtime,
                        })
                        no_data += 1
                        continue
                    new_rows.append({
                        "code": code, "date": date, "src": source,
                        "ask_peak": peak.ask_peak, "bid_peak": peak.bid_peak,
                        "eligible_count": peak.eligible_count,
                        "meta_mtime_ns": mtime,
                    })
                    computed += 1

    if new_rows:
        new_df = pl.DataFrame(new_rows, schema=_SCHEMA)
        # 동시 sweep 간 read-modify-write 경쟁 방지(_WRITE_LOCK): lock 안에서 existing 을
        # 다시 로드해, 그 사이 다른 sweep 이 기록한 행을 잃지 않는다. 재계산 행(new)이
        # 기존 행을 덮어쓰도록 keep='last'. 미변경 행은 current 유지.
        with _WRITE_LOCK:
            current = load(data_dir)
            merged = pl.concat([current, new_df]).unique(
                subset=_KEY, keep="last").sort(_KEY)
            atomic_write_parquet_df(depth_daily_path(data_dir), merged)
            total = merged.height
    else:
        total = existing.height

    log.info(
        "depth_daily.sweep scanned=%d computed=%d skipped=%d no_data=%d total=%d",
        scanned, computed, skipped, no_data, total,
    )
    return SweepResult(
        scanned=scanned, computed=computed, skipped=skipped,
        no_data=no_data, total_rows=total,
    )
