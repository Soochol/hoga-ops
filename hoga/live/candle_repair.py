"""이미 쓰인 `kiwoom_live` candles 파케이의 쪼개진 분봉을 한 봉으로 접는 1회 스윕.

**왜 필요한가.** `MinuteCandleAggregator`(ADR-0125)가 한 분(分)을 여러 행으로 내보냈다
— 봉을 거래소 체결시간으로 버킷팅하면서 봉인은 로컬 벽시계로 하고, 허용 지연이 0이라
봉인 뒤 도착한 틱이 새 봉을 만들었기 때문이다(진단은
`hoga.tables.candles.merge_split_candles` docstring). 생산자는 그 함수로 고쳤지만
**이미 쓰인 파일은 안 낫는다** — 실측 2026-08-22: `kiwoom_live` candles 파케이
**8,934개 중 7,069개(79%)** 가 중복 `ts_ms` 를 갖고, 중복 행은 345만 행 중
**121,955행(3.53%)** 이다.

**읽기 병합이 있는데도 고치는 이유는 불변식이다.** `hoga.api.invariants` 의
``series.candles_ts_monotonic`` 은 "candles ts_ms must be strictly ascending" 를
**Severity.error** 로 선언한다. 읽기 병합(`_merge_split_minutes`)은 화면이 깨지는 것을
막을 뿐, 디스크는 선언된 불변식을 위반한 채 남는다.

**과거 날짜만 훑는다**(``date < today_kst``). 오늘 파케이는 Today Promoter 가 증분
상태에서 **주기마다 통째로 다시 쓴다** — 고쳐 봐야 다음 주기가 되돌리고, 생산자 수정이
배포된 뒤엔 그 재작성이 곧 치유다.

**멱등**: 접을 것이 없는 파일은 읽기만 하고 건너뛴다. 2회차는 repaired=0 이다.

Cold path — `meta_backfill` 과 같은 부류다. 어떤 hot path 에도 없다.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from hoga.api.sources import SOURCE_VENUES, source_venue_dir
from hoga.tables.candles import merge_split_candles, read_parquet, write_parquet
from hoga.util.timeenc import KST

_log = logging.getLogger(__name__)

#: 이 스윕이 고치는 소스. **`kiwoom_live` 하나뿐이다** — 조각을 만드는 생산자가 그것
#: 하나이고, `hogaplay` 파케이는 전수 스캔에서 깨끗했다(2026-08-22). 소스를 늘리려면
#: 그 소스에서 실제로 조각을 관측한 뒤에 늘릴 것: 대상이 넓을수록 스윕이 "고칠 게
#: 없는 파일을 읽는 시간" 만 늘고, 진단이 없는 재작성은 되돌릴 근거도 없다.
_SOURCE = "kiwoom_live"


@dataclass(frozen=True)
class CandleRepairResult:
    scanned: int = 0        # 읽어 본 candles.parquet 개수
    repaired: int = 0       # 조각이 있어 다시 쓴 파일 수
    skipped_clean: int = 0  # 이미 분당 한 행인 파일
    unreadable: int = 0     # 읽기 실패(손상·스키마 드리프트) — 건드리지 않고 넘어감
    rows_before: int = 0    # 재작성 대상 파일의 재작성 전 행 수
    rows_after: int = 0     # 같은 파일의 재작성 후 행 수


def _is_yyyymmdd(name: str) -> bool:
    if len(name) != 8 or not name.isdigit():  # noqa: PLR2004 — 국소 비교 상수
        return False
    try:
        datetime.strptime(name, "%Y%m%d")
    except ValueError:
        return False
    return True


def repair_split_candles(
    data_dir: Path, *, dry_run: bool = False, now: datetime | None = None
) -> CandleRepairResult:
    """`parquet/{date}/{code}/kiwoom_live/{venue}/candles.parquet` 의 조각 봉을 접는다.

    ``dry_run`` 이면 대상만 세고 쓰지 않는다 — 행 수 증감을 먼저 보고 실행할 것.

    쓰기는 `candles.write_parquet` 이 하므로 **원자적**이고(`atomic_write_parquet_table`)
    스키마도 그 한 곳에서만 정해진다. 읽기 실패는 삼키고 `unreadable` 로 센다:
    한 파일의 손상이 남은 수천 개의 복구를 막을 이유가 없다.
    """
    parquet_root = data_dir / "parquet"
    if not parquet_root.exists():
        return CandleRepairResult()
    today = (now or datetime.now(KST)).strftime("%Y%m%d")
    scanned = repaired = clean = unreadable = 0
    rows_before = rows_after = 0
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir() or not _is_yyyymmdd(date_dir.name):
            continue
        if date_dir.name >= today:  # 오늘/미래: Today Promoter 가 다시 쓴다
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            for venue in sorted(SOURCE_VENUES[_SOURCE]):
                path = source_venue_dir(code_dir, _SOURCE, venue) / "candles.parquet"
                if not path.exists():
                    continue
                scanned += 1
                try:
                    candles = read_parquet(path)
                except Exception:  # noqa: BLE001 — 손상 1건이 스윕 전체를 멈추지 않게
                    unreadable += 1
                    _log.warning("candle_repair.unreadable path=%s", path, exc_info=True)
                    continue
                merged = merge_split_candles(candles)
                if len(merged) == len(candles):
                    clean += 1
                    continue
                repaired += 1
                rows_before += len(candles)
                rows_after += len(merged)
                if dry_run:
                    continue
                write_parquet(merged, path)
                _log.info(
                    "candle_repair.rewrote path=%s rows=%d->%d",
                    path, len(candles), len(merged),
                )
    return CandleRepairResult(
        scanned=scanned, repaired=repaired, skipped_clean=clean, unreadable=unreadable,
        rows_before=rows_before, rows_after=rows_after,
    )
