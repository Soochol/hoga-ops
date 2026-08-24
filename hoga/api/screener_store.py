from __future__ import annotations

import datetime as dt
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from hoga.duck import connect_bounded
from hoga.util.atomic_write import atomic_write_json, atomic_write_parquet_df

log = logging.getLogger(__name__)

# parquet 컬럼 dtype 계약. code 는 전 구간 VARCHAR (leading-zero 보존).
_DAILY_COLS = {
    "code": "VARCHAR", "date": "DATE", "open": "DOUBLE", "high": "DOUBLE",
    "low": "DOUBLE", "close": "DOUBLE", "volume": "BIGINT",
}


def seed_daily_from_csv(csv_path: Path, out_path: Path) -> int:
    """CSV(원주가 일봉) → daily_unadjusted.parquet. code VARCHAR 강제, count 반환."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    con = connect_bounded()
    csv_s = str(csv_path).replace("'", "''")
    out_s = str(out_path).replace("'", "''")
    con.execute(
        f"COPY (SELECT code, CAST(date AS DATE) date, open, high, low, close, volume "
        f"FROM read_csv('{csv_s}', header=true, types={{'code':'VARCHAR'}})) "
        f"TO '{out_s}' (FORMAT parquet, COMPRESSION zstd)"
    )
    return con.execute(f"SELECT count(*) FROM '{out_s}'").fetchone()[0]


def export_db_to_csv(csv_path: Path, *, container: str = "tradingview-db",
                     db: str = "tradingview", user: str = "tradingview") -> None:
    """docker exec psql \\copy ohlcv_daily → CSV (운영 1회 시드용)."""
    sql = ("\\copy (SELECT code, date, open, high, low, close, volume "
           "FROM ohlcv_daily ORDER BY code, date) TO STDOUT WITH CSV HEADER")
    with csv_path.open("wb") as f:
        subprocess.run(["docker", "exec", container, "psql", "-U", user, "-d", db, "-c", sql],
                       stdout=f, check=True)


def seed_stocks_from_csv(csv_path: Path, out_path: Path) -> int:
    """CSV(code,name,market,is_etf,is_halted) → stocks.parquet. code VARCHAR 강제."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    con = connect_bounded()
    csv_s = str(csv_path).replace("'", "''")
    out_s = str(out_path).replace("'", "''")
    con.execute(
        f"COPY (SELECT code, name, market, is_etf, is_halted "
        f"FROM read_csv('{csv_s}', header=true, types={{'code':'VARCHAR'}})) "
        f"TO '{out_s}' (FORMAT parquet, COMPRESSION zstd)"
    )
    return con.execute(f"SELECT count(*) FROM '{out_s}'").fetchone()[0]


def export_stocks_from_db(csv_path: Path, *, container: str = "tradingview-db",
                          db: str = "tradingview", user: str = "tradingview") -> None:
    """docker exec psql \\copy stocks → CSV (운영 1회 시드용)."""
    sql = ("\\copy (SELECT code, name, market, is_etf, is_halted "
           "FROM stocks ORDER BY code) TO STDOUT WITH CSV HEADER")
    with csv_path.open("wb") as f:
        subprocess.run(["docker", "exec", container, "psql", "-U", user, "-d", db, "-c", sql],
                       stdout=f, check=True)


import polars as pl  # noqa: E402 — appended after stdlib imports

from hoga.api import screener_factors  # noqa: E402 — 순환 없음(screener_factors는 hoga.util.atomic_write만 import)


@dataclass(frozen=True)
class DailyBar:
    """원주가 일봉 한 행 — 벤더 fetch와 SSOT append 사이 이음매의 타입 계약."""
    code: str
    date: dt.date
    open: float
    high: float
    low: float
    close: float
    volume: int


# 코퍼스 parquet 과 동형(append concat 가 스키마 일치하도록). _DAILY_COLS(duckdb 문자열)의 polars 짝.
_DAILY_PL_SCHEMA: dict = {
    "code": pl.Utf8, "date": pl.Date,
    "open": pl.Float64, "high": pl.Float64, "low": pl.Float64, "close": pl.Float64,
    "volume": pl.Int64,
}

# 깨끗한 분할 비율(신주/구주) 후보 + 역수. ratio = close[d]/close[d-1].
_SPLIT_RATIOS = [1/2, 1/3, 1/4, 1/5, 1/10, 1/20, 1/50, 2, 3, 4, 5, 10]
_SPLIT_TOL = 0.03  # ±3%


def _detect_factor(ratio: float) -> float | None:
    """ratio 가 깨끗한 분할 비율에 가까우면 그 비율, 아니면 None."""
    for r in _SPLIT_RATIOS:
        if abs(ratio - r) / r <= _SPLIT_TOL:
            return r
    return None


def adjust_splits(df: pl.DataFrame) -> pl.DataFrame:
    """원주가 일봉 → 수정주가(최신일 basis). per-code back-adjust."""
    out = []
    # 전역 date 정렬 + maintain_order → 각 그룹은 이미 date 오름차순(group 별 재정렬 불요).
    for (code,), g in df.sort("date").group_by(["code"], maintain_order=True):  # noqa: B007 — 루프 변수 미사용이 의도(인덱스만 필요)
        closes = g["close"].to_list()
        n = len(closes)
        factor = [1.0] * n              # 각 날 d 의 누적계수(d 이후 분할 비율 곱). 최신일=1.
        cum = 1.0
        for d in range(n - 1, 0, -1):
            ratio = closes[d] / closes[d - 1] if closes[d - 1] else 1.0
            split = _detect_factor(ratio)
            if split is not None:
                cum *= split            # d 에 split → d 이전에 split 곱
            factor[d - 1] = cum
        f = pl.Series("f", factor)
        adj = g.with_columns([
            (pl.col(c) * f).alias(c) for c in ("open", "high", "low", "close")
        ]).with_columns((pl.col("volume") / f).round(0).cast(pl.Int64).alias("volume"))
        out.append(adj)
    return pl.concat(out)


def derive_adjusted(unadjusted_path: Path, out_path: Path, *,
                    factors_path: Path | None = None,
                    unadjusted_df: pl.DataFrame | None = None) -> int:
    """원주가 parquet → 수정주가 parquet. 소요 ms 반환.

    factors_path 가 있고 로드되면 계수 적용(원주가×계수, ADR-0057). 없거나 손상이면
    기존 split 휴리스틱(adjust_splits)으로 폴백. factors에 없는 종목도 휴리스틱 폴백.

    unadjusted_df 가 주어지면 read_parquet 을 건너뛰고 해당 프레임을 사용 —
    append_rows 가 방금 원자적으로 기록한 merged df 를 재사용해 중복 I/O 제거.
    """
    t0 = time.perf_counter()
    df = unadjusted_df if unadjusted_df is not None else pl.read_parquet(unadjusted_path)
    factors = screener_factors.read_factors(factors_path) if factors_path else None
    if factors is not None and factors.height:
        covered = set(factors["code"].unique().to_list())
        have = df.filter(pl.col("code").is_in(covered))
        miss = df.filter(~pl.col("code").is_in(covered))
        parts = [screener_factors.apply_factors(have, factors)]
        if miss.height:
            parts.append(adjust_splits(miss).select(parts[0].columns))
        adjusted = pl.concat(parts)
    else:
        adjusted = adjust_splits(df)
    atomic_write_parquet_df(out_path, adjusted)
    return int((time.perf_counter() - t0) * 1000)


from hoga.api.models import ScreenerStatusFile  # noqa: E402


def last_raw_date(unadjusted_path: Path) -> str | None:
    """아카이브 최신 거래일(YYYYMMDD) 또는 None(파일 없음)."""
    if not unadjusted_path.exists():
        return None
    r = connect_bounded().execute(
        f"SELECT max(date) FROM '{unadjusted_path}'").fetchone()[0]
    return r.strftime("%Y%m%d") if r else None


def append_rows(
    unadjusted_path: Path, new: pl.DataFrame
) -> tuple[int, str | None, pl.DataFrame]:
    """원주가 신규 거래일 append. (code,date) 멱등(중복 트리거 안전), 정렬 유지.
    무백업 SSOT 이므로 원자적 기록(tempfile→os.replace) — 중도 종료가 부분/손상
    parquet 를 readers 에게 노출하지 않는다. 반환: (universe_size=distinct code,
    last_raw_date=max date YYYYMMDD|None, merged_df) — 호출부가 같은 파일을 재독하지
    않도록 메모리 df 까지 전달(derive_adjusted 의 중복 read_parquet 제거)."""
    base = pl.read_parquet(unadjusted_path)
    merged = pl.concat([base, new.select(base.columns)]).unique(
        subset=["code", "date"], keep="last").sort(["code", "date"])
    atomic_write_parquet_df(unadjusted_path, merged)
    n_codes = merged.select(pl.col("code").n_unique()).item()
    max_date = merged.select(pl.col("date").max()).item()
    return n_codes, (max_date.strftime("%Y%m%d") if max_date is not None else None), merged


def write_status(path: Path, *, last_raw_date: str | None, universe_size: int,
                 derive_ms: int, now_ms: int) -> None:
    # 원자적 기록(saves.json 과 동일 계약) — 중도 종료가 잘린 status.json 을 남기지
    # 않는다. last_raw_date 는 None 허용(빈/NULL-date 아카이브에서도 안 죽고 표현).
    atomic_write_json(path, ScreenerStatusFile(
        schema_version=1, last_raw_date=last_raw_date, last_built_ms=now_ms,
        universe_size=universe_size, derive_ms=derive_ms).model_dump(mode="json"))


def _quarantine_status(path: Path) -> None:
    """손상/잘린 status.json 격리(saves.json _quarantine 과 동일 계약). 실패는 로깅만."""
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    try:
        path.rename(path.with_name(f"{path.name}.corrupt-{stamp}"))
        log.warning("screener status.json unusable; backed up to %s.corrupt-%s",
                    path.name, stamp)
    except OSError:
        log.exception("could not back up corrupt status.json")


def read_status(path: Path) -> ScreenerStatusFile | None:
    if not path.exists():
        return None
    try:
        return ScreenerStatusFile.model_validate_json(path.read_text())
    except ValidationError:
        # 부분쓰기/수동편집으로 손상된 status.json → 격리 후 None(not_seeded)으로 강등.
        # /status 가 500 대신 not_seeded 를 돌려주고, 다음 update/seed 가 재생성한다.
        _quarantine_status(path)
        return None


def seed_all(data_dir: Path, *, now_ms: int) -> int:
    """운영 1회 시드: dev-tradingview DB → screener/ parquet 전체 빌드. 종목 수 반환.
    daily + stocks export(CSV) → seed parquet(VARCHAR code) → derive 수정주가 → status."""
    sdir = data_dir / "screener"
    sdir.mkdir(parents=True, exist_ok=True)
    import tempfile  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)  # noqa: PLW2901 — 방어적 복사·정규화 후 재대입
        export_db_to_csv(td / "daily.csv")
        seed_daily_from_csv(td / "daily.csv", sdir / "daily_unadjusted.parquet")
        export_stocks_from_db(td / "stocks.csv")
        seed_stocks_from_csv(td / "stocks.csv", sdir / "stocks.parquet")
    ms = derive_adjusted(sdir / "daily_unadjusted.parquet", sdir / "daily_adjusted.parquet",
                         factors_path=sdir / "factors.parquet")
    n = pl.read_parquet(sdir / "stocks.parquet").height
    write_status(sdir / "status.json",
                 last_raw_date=last_raw_date(sdir / "daily_unadjusted.parquet"),
                 universe_size=n, derive_ms=ms, now_ms=now_ms)
    return n


import asyncio  # noqa: E402 — appended orchestration block
from collections.abc import Awaitable, Callable  # noqa: E402

FetchOne = Callable[[str, str, str], Awaitable[list[DailyBar]]]

# **이 상수의 역할이 PR-F(#1042) 로 바뀌었다.** 예전엔 KIS `_get` 의 15/s
# leaky-bucket 위에 얹는 2차 방어(공유 quota 를 벽처럼 채우지 않기)였다. 지금은
# 유량 페이싱을 키움 거버너가 **전부** 소유한다 — 페이지 1장 = submit 1건이고
# (`screener.py::_run_page`), 버킷은 TR별 5 req/s · 앱키별 병렬(ADR-0138)이며,
# 이 경로는 `priority="background"` 라 user_visible 에 양보한다.
#
# 남은 역할은 하나다: **동시에 걷는 종목 수의 상한**. 즉 거버너 큐 깊이와 메모리를
# 묶는 값이지 속도 손잡이가 아니다 — 올려도 병목(버킷)은 그대로라 처리량은 안 는다.
_DEFAULT_FETCH_CONCURRENCY = 3
_MAX_FETCH_CONCURRENCY = 8


def fetch_concurrency_from_env() -> int:
    raw = os.environ.get("HOGA_SCREENER_FETCH_CONCURRENCY")
    if raw is None:
        return _DEFAULT_FETCH_CONCURRENCY
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_FETCH_CONCURRENCY
    if 1 <= value <= _MAX_FETCH_CONCURRENCY:
        return value
    return _DEFAULT_FETCH_CONCURRENCY


#: 한 거래일의 행 중 `volume == 0` 이 이 비율을 넘으면 **그 날짜를 저장하지 않는다.**
#:
#: 실측 기저선(`daily_unadjusted`, 최근 1년 · 전 종목): 평균 **3.4%** · 최소 2.1% ·
#: 정상일 최대 ~7%. 사고일 `2026-06-18` 은 **89.4%**(3541 중 3164). 마진이 7배라
#: 오탐 여지가 없어 임계를 넉넉히 50% 로 둔다 — 정확한 값보다 **정상 시장의 어떤 날도
#: 걸리지 않는 것**이 중요하다.
_UNCONFIRMED_ZERO_VOLUME_RATIO = 0.5


def drop_unconfirmed_days(rows: list[DailyBar]) -> tuple[list[DailyBar], list[dt.date]]:
    """미확정으로 보이는 **날짜 단위**로 행을 걸러낸다. (남길 행, 버린 날짜들) 반환.

    **왜 필요한가 — `2026-06-18` 사고.** 그날 코퍼스는 3541 종목 전부가 `o=h=l=c`(전일
    종가) 에 거래량 0 이었다. 정규장 시작 전(장전 시간외) 스냅샷이 그날 일봉으로 굳은
    것이다. `_gap_trading_days` 의 EOD 컷오프는 **요청 범위**만 좁힐 뿐 **응답을 검증하지
    않아서**, 상류가 미확정 봉을 실어 보내면 그대로 저장됐다.

    그리고 한 번 저장되면 **영원히 안 고쳐진다**: 갱신기는 `last_raw_date` 다음날부터만
    긁으므로 행이 있는 날짜는 갭이 아니다. 실측으로 두 달간(6/18~8/20) 그대로였다.

    **버린 날짜는 갭으로 남는 것까지가 설계다.** 저장하지 않으면 `last_raw_date` 가
    그 날짜를 넘지 않으므로 **다음 갱신이 자동으로 재시도**한다 — 별도 재시도 큐가
    필요 없다. 반대로 저장해 버리면 위의 영구 고착이 된다.

    **날짜 단위**인 이유: 여러 날을 한 번에 캐치업할 때 하루가 부실하다고 정상인 날까지
    버리면 갱신이 통째로 멎는다.

    ⚠ 실패 모드 하나: 상류가 같은 날짜를 계속 부실하게 주면 매 갱신이 같은 날짜를 다시
    거부한다(무한 재시도). 코드로 막지 않고 **로그로 드러낸다** — 재시도 자체는 옳은
    동작이고, 상류가 나으면 저절로 풀린다.
    """
    by_date: dict[dt.date, list[DailyBar]] = {}
    for bar in rows:
        by_date.setdefault(bar.date, []).append(bar)
    kept: list[DailyBar] = []
    dropped: list[dt.date] = []
    for date, bars in by_date.items():
        zero = sum(1 for b in bars if not b.volume)
        if len(bars) and zero / len(bars) > _UNCONFIRMED_ZERO_VOLUME_RATIO:
            dropped.append(date)
            log.warning(
                "screener.update.unconfirmed_day_dropped date=%s codes=%d zero_volume=%d "
                "(%.1f%% > %.0f%%) — 미확정(장전) 스냅샷으로 보여 저장하지 않는다. "
                "갭으로 남으므로 다음 갱신이 재시도한다.",
                date, len(bars), zero, zero / len(bars) * 100,
                _UNCONFIRMED_ZERO_VOLUME_RATIO * 100,
            )
            continue
        kept.extend(bars)
    return kept, dropped


async def run_update(sdir: Path, *, codes: list[str], fetch_one: FetchOne,
                     trading_days: list[str], now_ms: int) -> int:
    """gap 거래일 행을 await fetch_one 으로 모아 append→derive→status. 실제로 추가된
    거래일 수(append 된 행의 distinct date) 반환 — 상류가 갭 일부만 반환해도 요청
    거래일 수(len(trading_days))로 과대보고하지 않는다. fetch 는 세마포어로 제한한
    동시 호출(직렬 RTT 병목 제거; 15/s 버킷은 _get 가 캡)."""
    sem = asyncio.Semaphore(fetch_concurrency_from_env())

    async def _one(code: str) -> list[DailyBar]:
        async with sem:
            return await fetch_one(code, trading_days[0], trading_days[-1])

    fetched = await asyncio.gather(*(_one(c) for c in codes))
    rows: list[DailyBar] = [b for batch in fetched for b in batch]
    # 저장 **전에** 응답을 검증한다 — 요청 범위를 좁히는 것만으로는 상류가 실어 보내는
    # 미확정 봉을 못 막는다(`drop_unconfirmed_days` 의 2026-06-18 사고 참조).
    rows, _dropped = drop_unconfirmed_days(rows)
    if not rows:
        return 0
    up = sdir / "daily_unadjusted.parquet"

    def _commit() -> int:                  # 동기 polars는 to_thread로 (루프 블로킹 방지)
        new = pl.DataFrame([vars(b) for b in rows], schema=_DAILY_PL_SCHEMA)
        n, last, merged = append_rows(up, new)   # 통계 + merged df 는 메모리에서(재독 X)
        ms = derive_adjusted(up, sdir / "daily_adjusted.parquet",
                             factors_path=sdir / "factors.parquet",
                             unadjusted_df=merged)  # 방금 기록한 merged 를 재사용(I/O 절감)
        write_status(sdir / "status.json", last_raw_date=last,
                     universe_size=n, derive_ms=ms, now_ms=now_ms)
        return ms

    await asyncio.to_thread(_commit)
    return len({b.date for b in rows})


def merge_roster_from_master(
    stocks_path: Path, master_rows: list[tuple[str, str, str, bool]] | None,
) -> int:
    """마스터에만 있는 신규 상장을 stocks.parquet 에 **추가**한다. 추가된 행 수 반환.

    왜 필요한가: 이 파일은 외부 DB 에서 수동 1회 시드된 스냅샷이고 갱신 경로가
    아예 없었다. 그런데 일봉 갱신 대상 목록이 여기서 나오므로
    (``screener._build_plan``), 로스터에 없는 종목은 **봉을 받지도 못하고** 따라서
    스크리너 결과에 나타날 수도 없다. 실측 2026-08-03: 마스터에만 있는 종목
    79 개가 그 상태였다(신규 상장·스팩 포함). #984 가 고친 ``is_etf`` 축과 같은
    뿌리이고, 그때 남겨 둔 나머지 절반이다.

    **추가만 한다 — 기존 행은 손대지 않고, 마스터에 없다고 지우지도 않는다.**
    지우는 쪽은 상장폐지 처리이고 그건 과거 일봉·캡처 이력과 얽힌 별개 결정이다.
    (실측상 마스터에 없는 기존 코드 916 개는 대부분 ETF/ETN 과 구 종목이라,
    지우는 구현이었다면 멀쩡한 데이터를 대량으로 날렸다.)

    ``is_halted`` 는 마스터가 답을 주지 않으므로 ``False`` 로 넣는다. 보수적인
    방향이 어느 쪽인지가 갈리는 자리인데 — ``True`` 면 "거래정지 제외" 를 켠
    사용자에게 신규 상장이 계속 안 보이고, 이는 지금 상태(아예 없음)와 같다.
    ``False`` 는 정지된 신규 상장이 잠깐 목록에 낄 수 있지만 그 종목은 일봉이
    안 쌓여 어차피 결과에 못 든다. 보이는 쪽을 택했다.

    ``master_rows`` 가 ``None``(마스터 미로드)이면 아무것도 하지 않는다 — 빈
    목록으로 오해해 로스터를 건드리면 안 된다(``symbols.all_listed_rows`` 참고).
    """
    if not master_rows:
        return 0
    if not stocks_path.exists():
        return 0
    df = pl.read_parquet(stocks_path)
    have = set(df["code"].to_list())
    fresh = [r for r in master_rows if r[0] not in have]
    if not fresh:
        return 0
    added = pl.DataFrame(
        {
            "code": [r[0] for r in fresh],
            "name": [r[1] for r in fresh],
            "market": [r[2] for r in fresh],
            "is_etf": [r[3] for r in fresh],
            "is_halted": [False] * len(fresh),
        },
        schema={
            "code": pl.Utf8, "name": pl.Utf8, "market": pl.Utf8,
            "is_etf": pl.Boolean, "is_halted": pl.Boolean,
        },
    )
    # 열 순서·타입을 기존 파일에 맞춘다 — concat 이 스키마 불일치로 죽지 않게.
    atomic_write_parquet_df(stocks_path, pl.concat([df, added.select(df.columns)]))
    log.info("screener roster: added %d newly listed codes", len(fresh))
    return len(fresh)
