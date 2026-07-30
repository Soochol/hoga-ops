"""screener `_today_peaks` 실측 — 배치 경로 vs 종목당 단건 경로.

`_today_peaks` 는 2026-07-30 에 배치 1쿼리로 바뀌었다(실측 1.5s → 0.12s). 이 도구는
그 배치가 여전히 유효한지, 그리고 단건 폴백 경로의 비용이 얼마인지 재현한다.

사용:
    uv run --extra dev python tools/measure_screener_today_peaks.py \\
        ~/.local/share/hoga-ops/data 20260729
"""
from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

from hoga.api.screener_depth import (
    _KRX_CLOSE_MS,
    _KRX_OPEN_MS,
    _TODAY_SOURCES,
    _depth_universe,
    _today_peaks,
)
from hoga.duck import connect_bounded
from hoga.tables import snapshots as snapshots_tbl

MIB = 1024 * 1024


def main() -> None:
    data_dir = Path(sys.argv[1])
    today = sys.argv[2]

    universe = set(_depth_universe(data_dir))
    day_dir = data_dir / "parquet" / today

    # 실제로 파일이 있는 (code, source) 쌍과 총 바이트
    present: list[tuple[str, Path]] = []
    total_bytes = 0
    for code in sorted(universe):
        for source in _TODAY_SOURCES:
            snap = day_dir / code / source / "snapshots.parquet"
            if snap.exists():
                present.append((code, snap))
                total_bytes += snap.stat().st_size

    print(f"date={today}  유니버스={len(universe)}  파일보유={len(present)}")
    print(f"스캔 대상 총 {total_bytes / MIB:,.0f} MiB "
          f"(파일당 평균 {total_bytes / max(1, len(present)) / MIB:,.2f} MiB)")

    # 1) 현행(배치) 경로 전체 소요
    started = time.perf_counter()
    peaks = _today_peaks(data_dir, universe, today)
    elapsed = time.perf_counter() - started
    print(f"\n[배치] _today_peaks 전체: {elapsed * 1000:,.0f} ms  (결과 {len(peaks)}종목)")
    print(f"  종목당 평균 {elapsed / max(1, len(present)) * 1000:,.1f} ms")

    # 2) 단건 경로(폴백) 비용 — 배치가 없을 때의 값
    con = connect_bounded()
    per_call: list[float] = []
    for _code, snap in present:
        t0 = time.perf_counter()
        snapshots_tbl.query_daily_depth_peak(
            con, path=snap,
            session_open_ms=_KRX_OPEN_MS, session_close_ms=_KRX_CLOSE_MS,
        )
        per_call.append((time.perf_counter() - t0) * 1000)
    per_call.sort()
    if per_call:
        print(f"\n[단건 폴백 분포] n={len(per_call)}  "
              f"중위 {statistics.median(per_call):.1f} ms  "
              f"p95 {per_call[int(len(per_call) * 0.95)]:.1f} ms  "
              f"최대 {per_call[-1]:.1f} ms  "
              f"합계 {sum(per_call):,.0f} ms")


if __name__ == "__main__":
    main()
