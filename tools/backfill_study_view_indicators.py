"""저장뷰 구간의 봉 종속 호가 지표를 미리 계산해 `PastIndicatorsCache` 를 채운다.

**왜 필요한가.** 봉 종속 지표(`depth`·`ask_peak`·`bid_peak`·`depth_delta`)는 캐시
파일명에 `bucket_ms` 가 들어간다. 그래서 지표를 **새로 도입하면 그 이전에 만들어진
저장뷰 구간은 전부 그 지표에 대해 콜드**가 된다 — 계산될 기회 자체가 없었기 때문이다.

실측(2026-08-13)이 그 구조를 그대로 보여줬다. `depth_delta` 는 2026-07-20 에 들어왔고
(#748), 분봉 저장뷰 63개 중 58개가 그전에 만들어졌다:

    저장뷰 생성 시점        depth_delta warm    depth warm
    도입 이전 (58개)              5.8%           88.5%
    도입 이후 ( 5개)             88.8%           92.1%

콜드 sidecar 는 저장 구간 **전체**를 계산하므로 수십 초가 걸린다(같은 URL 실측
콜드 73.2초 → 웜 2.36초). 이 스크립트는 그 계산을 사용자가 기다리지 않는 시점으로
옮긴다.

**왜 HTTP 가 아니라 함수 직접 호출인가.** `/api/range` 로 때리면 sidecar 전용 레인
(동시 2)을 점유해 그동안 앱이 느려진다. `build_range_bundle` 을 직접 부르면 별도
프로세스에서 돌아 레인과 무관하다. 캐시 쓰기는 `atomic_write_json` 이라 dev 서버가
같은 파일을 동시에 써도 안전하다.

**왜 상위 함수인가.** 슬라이스 함수(`build_depth_delta_slice` 등)를 직접 부르면
세션 경계를 호출부가 재현해야 하는데, 그 값이 계산 결과에 들어간다. 상위 함수를
그대로 쓰면 실제 요청 경로와 **같은 값**이 흐르므로 캐시가 정합적이다.

지표 플래그는 프론트가 sidecar 요청에 싣는 것과 맞춘다(실측 URL 기준). 다만
`depth_heatmap_enabled` 만은 **항상 켠다** — 프론트는 사용자 지표 설정에 따라 끄기도
하는데, 여기서 켜 두면 그 지표를 나중에 켤 때도 이미 warm 이다(대가는 계산 시간뿐).

가격 범위가 캐시 키에 들어가는 지표(`trade_volume_poc`·`volume_distribution`)와
거래원 늦은 진입은 **대상이 아니다** — 프론트가 현재 끄고 요청하며, 가격 범위 축은
카디널리티가 커서 미리 채워도 맞을 보장이 없다.

사용 예::

    uv run python tools/backfill_study_view_indicators.py --dry-run
    uv run python tools/backfill_study_view_indicators.py
    uv run python tools/backfill_study_view_indicators.py --timeframes saved,3m,10m
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from hoga.api import study_views
from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine
from hoga.config import resolve_data_dir

# 이 스크립트가 채우는 지표. 캐시 파일명이 `{date}.{이름}.{bucket_ms}.json` 이라
# **봉을 바꾸면 통째로 콜드**가 되는 것들이다. `ratio`/`fill` 은 파일명에 봉이 없어
# 대상이 아니고, poc/vdist 는 가격 범위가 키라 모듈 docstring 의 이유로 제외한다.
BUCKET_KEYED_INDICATORS = ("depth", "ask_peak", "bid_peak", "depth_delta")

TIMEFRAME_TO_MS = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "10m": 600_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "60m": 3_600_000,
    "120m": 7_200_000,
    "240m": 14_400_000,
}

SOURCE = "hogaplay"
VENUE = "KRX"


def _cache_dir(data_dir: Path, code: str) -> Path:
    return data_dir / "kis-past-indicators" / code / SOURCE


def _captured_dates(data_dir: Path, code: str, from_date: str, to_date: str) -> list[str]:
    """구간 안에서 **원본 호가 스냅샷이 있는** 거래일.

    판정 기준은 `snapshots.parquet` 의 존재다 — 이 스크립트가 채우는 4종이 전부 그
    파일에서 나오고, 없으면 슬라이스 빌더가 빈 결과를 돌려주며 **캐시에 저장하지도
    않는다**(`build_depth_delta_slice` 의 `path_obj.exists()` 가드).

    ⚠ **캐시 디렉터리로 판정하면 안 된다.** 처음엔 그렇게 했는데 두 가지가 어긋났다:
    ① `mode=sidecar` 는 `ratio`/`fill` 도 함께 채우는데 그 둘은 `trades.parquet` 에서도
    나오므로, 스냅샷이 없는 날짜에 캐시 파일이 생긴다 → 그 날짜가 다음 실행에서 "캡처일"
    로 새로 등장한다. ② 그 날짜의 4종은 영원히 채워지지 않으므로 **반복 실행이 수렴하지
    않는다**(실측: 재실행에서 `신규 0파일` 인 작업이 계속 남았다).
    """
    dates: list[str] = []
    parquet_root = data_dir / "parquet"
    if not parquet_root.is_dir():
        return dates
    for date_dir in parquet_root.iterdir():
        name = date_dir.name
        if not (name.isdigit() and from_date <= name <= to_date):
            continue
        if (date_dir / code / SOURCE / "snapshots.parquet").exists():
            dates.append(name)
    return sorted(dates)


def _missing_cells(data_dir: Path, code: str, dates: list[str], bucket_ms: int) -> int:
    """(지표 × 날짜) 단위 미계산 건수.

    캐시는 **지표별 × 날짜별**이라(`bundle.py` 의 `get_depth`/`get_depth_delta` 등이
    각각 `CACHE_MISS` 를 본다) 한 날짜에 하나만 비어도 그 하나만 계산된다. 그래서
    "날짜 단위 콜드" 로 세면 비용이 과대평가된다.
    """
    cache_dir = _cache_dir(data_dir, code)
    if not cache_dir.is_dir():
        return len(dates) * len(BUCKET_KEYED_INDICATORS)
    names = {p.name for p in cache_dir.iterdir()}
    return sum(
        1
        for date in dates
        for indicator in BUCKET_KEYED_INDICATORS
        if f"{date}.{indicator}.{bucket_ms}.json" not in names
    )


def _cache_file_count(data_dir: Path, code: str) -> int:
    cache_dir = _cache_dir(data_dir, code)
    return sum(1 for _ in cache_dir.iterdir()) if cache_dir.is_dir() else 0


def _resolve_timeframes(spec: str, saved_timeframe: str) -> list[str]:
    """`--timeframes` 스펙을 실제 봉 목록으로. `saved` 는 그 저장뷰의 저장 봉."""
    out: list[str] = []
    for token in (t.strip() for t in spec.split(",")):
        if not token:
            continue
        timeframe = saved_timeframe if token == "saved" else token
        if timeframe in TIMEFRAME_TO_MS and timeframe not in out:
            out.append(timeframe)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument(
        "--timeframes",
        default="saved",
        help="쉼표 구분. `saved` = 그 저장뷰의 저장 봉. 예: saved,3m,10m",
    )
    parser.add_argument("--dry-run", action="store_true", help="대상만 세고 계산하지 않는다")
    # 상한은 **작업(=채울 것이 있는 저장뷰×봉) 기준**이다. 저장뷰 목록을 자르면
    # 앞쪽이 이미 warm 일 때 대상이 0건이 나와 시험이 아무것도 검증하지 못한다.
    parser.add_argument("--limit", type=int, default=None, help="작업 수 상한(시험용)")
    args = parser.parse_args()

    data_dir = args.data_dir or resolve_data_dir()
    # **캘린더 봉(D/W/M) 저장뷰도 대상이다** — 봉을 명시했을 때만.
    #
    # 캘린더 저장뷰 자체는 스크리너 일봉 한 방이라 채울 것이 없다(`--timeframes saved`
    # 면 `_resolve_timeframes` 가 알아서 걸러 낸다 — `'D'` 는 아래 표에 없다). 그런데
    # `/study` 는 **창마다 봉이 다르고**, 저장뷰를 열 때 봉이 맞춰지는 것은 포커스 창
    # 하나뿐이다. 그래서 분봉 창을 하나 벌려 두면 그 창이 **일봉 저장뷰의 구간을 분봉
    # 해상도로** 요청한다 — 실측된 40~93초가 전부 이 경우였다.
    #
    # 그 창이 실제로 보여주는 것은 마지막 300봉뿐인데(`initialVisibleMinuteBarsFor`)
    # 받는 것은 구간 전체라, 10분봉이면 12배·3분봉이면 41배를 받아서 버린다. 그 구조를
    # 고치는 것이 정답이지만 결합이 넷이라 미뤘고(창 봉 축·`historicalFromDate` 배선·
    # 가변 범위 키·뷰포트 정책), 저장뷰가 **열거 가능한 고정 집합**인 동안은 여기서
    # 미리 채우는 편이 싸다.
    saves = list(study_views.load_saves(data_dir).saves)

    jobs: list[tuple[str, str, str, str, int, list[str], int]] = []
    for save in saves:
        for timeframe in _resolve_timeframes(args.timeframes, save.timeframe):
            bucket_ms = TIMEFRAME_TO_MS[timeframe]
            dates = _captured_dates(data_dir, save.code, save.range.from_date, save.range.to_date)
            if not dates:
                continue
            missing = _missing_cells(data_dir, save.code, dates, bucket_ms)
            if missing:
                # 저장 봉을 라벨에 남긴다 — "D 저장뷰를 10m 로 채우는 중" 이 보여야
                # 이 실행이 무엇을 하는지 로그만으로 판별된다.
                jobs.append(
                    (f"[{save.timeframe}] {save.name}", save.code, timeframe,
                     save.range.from_date, bucket_ms, dates, missing)
                )

    if args.limit is not None:
        jobs = jobs[: args.limit]
    total_missing = sum(j[6] for j in jobs)
    print(f"data_dir={data_dir}")
    print(f"저장뷰 {len(saves)}개 · 봉 스펙 '{args.timeframes}'")
    print(f"작업 대상 {len(jobs)}건 · 미계산 (지표×날짜) {total_missing:,}건")
    if args.dry_run:
        for name, code, timeframe, from_date, _bucket, dates, missing in jobs[:15]:
            print(f"  {code} {timeframe:>4} {from_date} 거래일{len(dates):3d} → 미계산 {missing:4d}건  {name}")
        if len(jobs) > 15:  # noqa: PLR2004 — 출력 미리보기 길이
            print(f"  … 외 {len(jobs) - 15}건")
        return 0
    if not jobs:
        print("채울 것이 없다.")
        return 0

    # DuckDB temp 를 따로 둔다 — dev 서버와 같은 디렉터리를 쓰면 스필 파일이 섞인다.
    engine = QueryEngine(data_dir, temp_directory=data_dir / "duckdb-tmp-backfill")
    started = time.monotonic()
    written_total = 0
    try:
        for index, (name, code, timeframe, _from, bucket_ms, dates, missing) in enumerate(jobs, start=1):
            before = _cache_file_count(data_dir, code)
            t0 = time.monotonic()
            build_range_bundle(
                engine,
                code=code,
                from_date=dates[0],
                to_date=dates[-1],
                bucket_ms=bucket_ms,
                source_pref=SOURCE,
                venue=VENUE,
                mode="sidecar",
                # 프론트 sidecar 요청과 같은 값(실측 URL). heatmap 만 항상 켠다 — 모듈 docstring.
                broker_late_entries_enabled=False,
                trade_volume_poc_enabled=False,
                volume_distribution_bins=None,
                trade_volume_poc_bins=None,
                ask_peaks_enabled=True,
                bid_peaks_enabled=True,
                depth_heatmap_enabled=True,
                depth_delta_enabled=True,
                program_trade_enabled=False,
            )
            written = _cache_file_count(data_dir, code) - before
            written_total += written
            elapsed = time.monotonic() - t0
            # flush 필수: 이 루프는 몇 시간 돌 수 있고 출력이 파이프·파일로 가면
            # 블록 버퍼링이라 **끝날 때까지 한 줄도 안 보인다**(실측). 진행이 안 보이면
            # 멈춘 것과 구별할 수 없어 조사자가 멀쩡한 실행을 죽인다.
            print(
                f"[{index}/{len(jobs)}] {code} {timeframe:>4} 거래일{len(dates):3d} "
                f"미계산{missing:4d} → 신규 {written:4d}파일 {elapsed:6.1f}s  {name}",
                flush=True,
            )
    finally:
        engine.close()

    total_elapsed = time.monotonic() - started
    print(f"완료: 신규 캐시 {written_total:,}파일 · {total_elapsed / 60:.1f}분")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
