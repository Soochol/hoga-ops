"""과거일 **1분** 최대벽 캐시를 미리 채운다 — 콜드 비용을 사용자 대기 밖으로.

## 왜 1분만 채우는가

peak 은 sidecar 콜드 비용의 74%(2026-08-19 실측)인데, 그 비용은 **버킷 수가 아니라
원본 스캔**에 있다. 실측(2026-08-28): 봉을 60배 굵게 해도(1분→60분) 직접 계산은
0.33s 로 그대로인 반면, 1분 rep 행에서 파생하면 **2.6~4.9ms** 다(~70배).

그래서 `bucket_ms = ONE_MINUTE_MS` **한 번**이 `ask_peak`·`bid_peak`·`peak_rep` 세
파일을 채우고, 3m~240m 은 `_peak_slices_from_1m_cache` 가 스캔 없이 파생한다. 봉별로
도는 것은 순수 낭비다 — 그렇게 만든 굵은 봉 캐시는 파생 경로 도입 이후 사실상 생성이
멈췄다(이 머신 실측 15,952건 중 2026-08-19 이후 1건).

## 왜 상위 함수(`build_ask_bid_peak_slices`)를 부르는가

슬라이스 함수를 직접 부르면 세션 경계를 호출부가 재현해야 하는데 **그 값이 계산
결과에 들어간다**. 상위 함수를 그대로 쓰면 실제 요청 경로와 같은 값이 흐르므로 캐시가
정합적이다(`tools/backfill_study_view_indicators.py` 가 같은 이유를 적는다).

## 무효화 코드가 없는 이유

`PastIndicatorsCache` 는 meta.json mtime 을 capture identity 로 쓴다. 재캡처가 mtime 을
전진시키면 미리 채운 값이 자동으로 stale 이 되고 다음 실행이 다시 채운다. 지켜야 할
것은 **meta 가 디스크에 쓰인 뒤에 계산하는 것** 하나뿐이고(그래야
`fetched_at_ms > mtime`), 캡처 완료 후에 도는 이 경로는 그것을 만족한다.

## 오늘자는 대상이 아니다

`PastIndicatorsCache` 는 past-only 다(ADR-0043 — 오늘 parquet 은 5분마다 통째로
overwrite 되므로 디스크에 박제하면 곧 stale). 오늘은 `TODAY_TTL`(ADR-0090)이 맡는다.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.invariants import indicator_session_bounds, normalize_session_bounds
from hoga.api.queries import QueryEngine, StockDateNotFound, resolve_source_dir
from hoga.live.venue import Venue
from hoga.tables.snapshots import ONE_MINUTE_MS

log = logging.getLogger(__name__)

#: 데울 소스. `/live` 가 어느 쪽을 읽는지는 `krx_prefer_hogaplay` 설정에 달렸고
#: (옵트인, 기본은 kiwoom_live 사다리) 둘의 비용이 10배 차이 난다 — 실측 2026-08-28:
#: hogaplay 85,195행 0.37s ↔ kiwoom_live 1,954행 0.07s. 설정이 바뀌어도 warm 이도록
#: **둘 다** 채운다. `depth_daily.SWEEP_SOURCES` 와 같은 목록이고 같은 이유다.
PREWARM_SOURCES: tuple[str, ...] = ("hogaplay", "kiwoom_live")

#: 한 번에 계산할 최대 (code, date, source) 수. 상한을 두는 이유는 **첫 실행**이다 —
#: 캐시가 빈 상태에서 전량을 돌면 수십 분이 걸리고(실측 9,263건 × 0.38s ≈ 59분) 그
#: 시간 동안 일일 런의 뒷단계가 밀린다. 상한을 두면 하루치씩 소진되고, 증분이라
#: 다음 실행이 남은 것을 이어받는다. 즉시 전량을 원하면 CLI 에서 `--limit 0`.
DEFAULT_LIMIT = 2_000


@dataclass(frozen=True)
class PrewarmResult:
    scanned: int      # 스냅샷이 존재한 (code, date, source) 수
    warmed: int       # 새로 계산해 캐시에 넣은 수
    skipped: int      # 이미 warm 이라 건너뛴 수
    failed: int       # 메타 부재·불변식 위반·계산 예외로 건너뛴 수
    truncated: bool   # limit 에 걸려 중단했는가(남은 대상이 있다)
    elapsed_s: float


def _is_yyyymmdd(name: str) -> bool:
    return len(name) == 8 and name.isdigit()  # noqa: PLR2004 — 국소 비교 상수


def _session_bounds(engine: QueryEngine, date: str, code: str, source: str,
                    venue: Venue) -> tuple[int | None, int | None] | None:
    """지표 세션 경계 — 요청 경로(`build_range_bundle`)와 **같은 값**이어야 한다.

    ⚠ `normalize_session_bounds` 를 먼저 통과시킨다(hogaplay 의 `open==0` 센티널
    복원, ADR-0063). 불변식 위반(INVALID) 날짜는 빌더가 계산 자체를 하지 않으므로
    여기서도 제외한다 — 안 하면 매 실행이 같은 칸을 다시 잡아 **수렴하지 않는다**.
    """
    try:
        meta = engine.get_meta(date, code, source, venue=venue)
    except (FileNotFoundError, StockDateNotFound, OSError, ValueError):
        return None
    if classify_from_meta(meta).state is DiskState.INVALID:
        return None
    norm_meta, _ = normalize_session_bounds(meta)
    try:
        open_ms, close_ms = indicator_session_bounds(norm_meta)
    except KeyError:
        # 경계 키가 아예 없는 구형 meta — 그 항만 생략한다(순수 구조 술어로 떨어진다).
        # depth_daily.compute_stock_date_peak 과 같은 완화다.
        raw_open = norm_meta.get("regular_session_open_ms")
        raw_close = meta.get("regular_session_close_ms")
        return (
            raw_open if isinstance(raw_open, int) else None,
            raw_close if isinstance(raw_close, int) else None,
        )
    return open_ms, close_ms


def _iter_stock_dates(
    data_dir: Path,
    *,
    codes: set[str] | None,
    dates: set[str] | None,
    sources: tuple[str, ...],
    venue: Venue,
    today: str,
) -> Iterator[tuple[str, str, str]]:
    """대상 `(code, date, source)` — **최신 날짜부터**.

    순서가 곧 정책이다: `prewarm` 은 상한(`limit`)에 걸리면 중단하므로, 오름차순이면
    첫 실행이 몇 달 전 날짜만 채우고 정작 사용자가 오늘 열어 볼 어제가 콜드로 남는다.

    여기서 거르는 것은 **디스크 사실**뿐이다 — 날짜 형식 · past-only(ADR-0043) ·
    스냅샷 존재. 메타 유효성은 계산 직전에 본다(`_session_bounds`): 그쪽은 파일을
    읽어야 알 수 있어 이미 warm 인 칸에까지 비용을 물릴 이유가 없다.
    """
    parquet_root = data_dir / "parquet"
    if not parquet_root.exists():
        return
    for date_dir in sorted(parquet_root.iterdir(), reverse=True):
        if not date_dir.is_dir() or not _is_yyyymmdd(date_dir.name):
            continue
        date = date_dir.name
        # past-only. 오늘 이후는 TODAY_TTL 의 몫이고, 여기서 쓰면 곧 stale 이 되는
        # 값을 디스크에 박제하게 된다(오늘 parquet 은 5분마다 통째로 overwrite).
        if date >= today:
            continue
        if dates is not None and date not in dates:
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            code = code_dir.name
            if codes is not None and code not in codes:
                continue
            for source in sources:
                src_dir = resolve_source_dir(code_dir, source, venue)
                if (src_dir / "snapshots.parquet").exists():
                    yield code, date, source


def prewarm(
    data_dir: Path,
    *,
    codes: set[str] | None = None,
    dates: set[str] | None = None,
    sources: tuple[str, ...] = PREWARM_SOURCES,
    venue: Venue = "KRX",
    limit: int | None = DEFAULT_LIMIT,
    engine: QueryEngine | None = None,
    dry_run: bool = False,
) -> PrewarmResult:
    """캡처된 과거일의 1분 peak 캐시를 채운다. 멱등이고 증분이다.

    ``limit`` 은 **계산 건수** 상한이다(스캔이 아니라) — 이미 warm 인 것은 세지
    않으므로, 캐시가 다 찬 뒤의 실행은 상한에 닿지 않고 전량을 훑는다.
    ``limit=None`` 또는 0 이면 무제한.

    ``dry_run`` 은 계산 없이 대상만 센다(디스크 stat 만).
    """
    from hoga.api.bundle import _today_kst_yyyymmdd, build_ask_bid_peak_slices  # noqa: PLC0415 — import cycle 회피

    t0 = time.monotonic()
    own_engine = engine is None
    engine = engine if engine is not None else QueryEngine(data_dir)
    # 지연 초기화가 락 없는 getattr/setattr 라(queries.py) 루프 밖에서 한 번 잡는다.
    cache = engine.indicators_cache
    today = _today_kst_yyyymmdd()
    cap = limit if limit else None

    scanned = warmed = skipped = failed = 0
    truncated = False

    try:
        for code, date, source in _iter_stock_dates(
            data_dir, codes=codes, dates=dates, sources=sources, venue=venue, today=today,
        ):
            scanned += 1
            # 두 kind 를 **함께** 본다 — 파생 경로가 `have_ask and have_bid` 를
            # 요구하므로 한쪽만 있으면 굵은 봉이 풀스캔으로 떨어진다.
            if (
                cache.has_ask_peak(code, date, source, ONE_MINUTE_MS, venue=venue)
                and cache.has_bid_peak(code, date, source, ONE_MINUTE_MS, venue=venue)
            ):
                skipped += 1
                continue
            if cap is not None and warmed >= cap:
                truncated = True
                break
            if dry_run:
                warmed += 1
                continue
            bounds = _session_bounds(engine, date, code, source, venue)
            if bounds is None:
                failed += 1
                continue
            try:
                build_ask_bid_peak_slices(
                    engine,
                    code=code, date=date, bucket_ms=ONE_MINUTE_MS,
                    source=source, venue=venue,
                    session_open_ms=bounds[0], session_close_ms=bounds[1],
                    cache=cache, today_kst=today,
                )
            except Exception:
                # 한 스톡데이트의 실패가 나머지를 죽이면 안 된다 — 이 경로는 사용자
                # 요청이 아니라 배치이고, 다음 실행이 같은 칸을 다시 잡는다(멱등).
                log.exception("peak prewarm failed for %s/%s/%s", code, date, source)
                failed += 1
                continue
            warmed += 1
    finally:
        if own_engine:
            engine.close()

    elapsed = time.monotonic() - t0
    log.info(
        "peak_prewarm scanned=%d warmed=%d skipped=%d failed=%d truncated=%s in %.1fs",
        scanned, warmed, skipped, failed, truncated, elapsed,
    )
    return PrewarmResult(
        scanned=scanned, warmed=warmed, skipped=skipped, failed=failed,
        truncated=truncated, elapsed_s=elapsed,
    )
