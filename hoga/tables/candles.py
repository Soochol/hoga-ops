"""Candles table — 1-minute OHLCV bars parsed from chart.tsv.

Unlike the other table modules, Candles does not register with the first.tsv
dispatcher. Its rows come from a separate endpoint (chart.php) which the
collector saves to chart.tsv. The parser orchestrator calls ``parse_row`` here
directly.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, TypeAdapter

from hoga.tables.dispatch import FieldCountError, split_row
from hoga.util.atomic_write import atomic_write_parquet_table

CANDLE_MIN_FIELDS = 8

# 9번째 컬럼(0-based 8) = 단일가(동시호가) 체결량. `CANDLE_MIN_FIELDS` 를 9 로
# 올리지 않는 이유는 아래 parse_row docstring 참조.
_AUCTION_VOL_FIELD = 8


# === In-memory entity ===


@dataclass(frozen=True)
class Candle:
    ts_ms: int
    open_: int
    close_: int
    high: int
    low: int
    vol_a: int
    vol_b: int


# === Parser ===


def parse_row(line: str) -> Candle:
    """Parse one chart.tsv row into a Candle.

    chart.tsv columns: relative_ts_ms, HH:MM:SS, open, close, high, low,
    vol_a, vol_b, **auction_vol**, cum_a, cum_b.

    ## 9번째 컬럼은 단일가(동시호가) 체결량이다 — vol_a 에 폴드한다 (#1278)

    이 컬럼은 오래 ``[unknown]`` 으로 적혀 **버려지고 있었다**. 그래서
    ``vol_a + vol_b`` 는 정규장 **연속체결만** 담았고, 시가단일가(09:00)·
    종가단일가(15:30) 체결이 통째로 빠졌다 — 일봉 대비 중앙값 **-5%**,
    p75 -11%, 최대 **-64%**(raw 1,525 파일 실측, 2026-08-10).

    **지문**: ``15:30`` 봉이 ``vol_a=0 vol_b=0`` 인데 **가격은 정상**이다 —
    그 봉의 ``close`` 가 벤더 일봉 종가와 정확히 일치한다(44/44 확인). 단일가
    체결의 가격은 이미 맞게 들어와 있고 **수량만** 버려지고 있었다.

    폴드 후 ``vol_a + vol_b`` 는 벤더 일봉 거래량과 0.5% 이내로 맞는다
    (20260716 24종목 중 23건, 9건은 정확히 일치). 남는 잔차는 chart.php 를
    15:31 까지만 받아 생기는 **장후 시간외**(-0.0~0.3%)다.

    ## 왜 별도 컬럼이 아니라 폴드인가

    ``vol_a``/``vol_b`` 를 **따로 소비하는 곳이 없다** — 백엔드·프론트 전부
    ``vol_a + vol_b`` 로만 읽는다(2026-08-10 grep 확인). 그리고 ``promote.py``
    가 이미 "단일 거래량 채널은 vol_a 에" 관례를 갖고 있다. 세 번째 컬럼을
    만들면 parquet 스키마가 구/신으로 갈려 ``queries.py`` 의 배치
    ``read_parquet([paths])`` 가 혼재 시 깨지고, 합산 사이트를 하나라도
    놓치면 **바로 이 버그와 같은 계급의 조용한 과소계상**이 재발한다.

    ⚠ ``vol_a``/``vol_b`` 가 매수/매도 체결 구분이라면(**미검증 추론**) 이
    폴드는 그 비율을 단일가 체결량만큼 왜곡한다. 그 구분을 실제로 쓰는
    소비처가 생기면 **별도 컬럼으로 승격**할 것 — 원자료는 소실되지 않는다.
    hogaplay ``chart.php`` 는 과거일을 그대로 재서빙한다(20250324 를 17개월 뒤
    재요청해 저장본과 바이트 동일, 20250613 은 raw 가 프룬된 날인데도 정상 수신).

    ## 필드 수 계약

    ``CANDLE_MIN_FIELDS`` 는 **8 로 유지**한다. 이 컬럼은 실측상 항상 있지만
    (raw 전수 335,379 행이 전부 11 필드), 하한을 9 로 올리면 8 필드 행이
    ``FieldCountError`` 로 죽는다 — 없던 행을 새로 거부하는 것은 이 수정의
    범위가 아니다. 없으면 0 으로 읽는다.
    """
    parts = split_row(line)
    if len(parts) < CANDLE_MIN_FIELDS:
        raise FieldCountError(f"candle row expects >={CANDLE_MIN_FIELDS} fields, got {len(parts)}")
    auction_vol = int(parts[_AUCTION_VOL_FIELD]) if len(parts) > _AUCTION_VOL_FIELD else 0
    return Candle(
        ts_ms=int(parts[0]),
        open_=int(parts[2]),
        close_=int(parts[3]),
        high=int(parts[4]),
        low=int(parts[5]),
        vol_a=int(parts[6]) + auction_vol,
        vol_b=int(parts[7]),
    )


# === Wire schema ===


PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),
        pa.field("open", pa.int32()),
        pa.field("close", pa.int32()),
        pa.field("high", pa.int32()),
        pa.field("low", pa.int32()),
        pa.field("vol_a", pa.int32()),
        pa.field("vol_b", pa.int32()),
    ]
)


# === Persist ===


def write_parquet(candles: Iterable[Candle], path: Path) -> None:
    rows = sorted(candles, key=lambda c: c.ts_ms)
    cols = {
        "ts_ms": pa.array([c.ts_ms for c in rows], type=pa.int64()),
        "open": pa.array([c.open_ for c in rows], type=pa.int32()),
        "close": pa.array([c.close_ for c in rows], type=pa.int32()),
        "high": pa.array([c.high for c in rows], type=pa.int32()),
        "low": pa.array([c.low for c in rows], type=pa.int32()),
        "vol_a": pa.array([c.vol_a for c in rows], type=pa.int32()),
        "vol_b": pa.array([c.vol_b for c in rows], type=pa.int32()),
    }
    atomic_write_parquet_table(path, pa.table(cols, schema=PARQUET_SCHEMA))


def read_parquet(path: Path) -> list[Candle]:
    """Symmetric inverse of :func:`write_parquet` — reassemble ``Candle``
    rows from the parquet table.

    Load-bearing column remap: the on-disk columns are ``open`` / ``close``
    (the natural OHLCV names, see ``PARQUET_SCHEMA``) but the ``Candle``
    dataclass fields are ``open_`` / ``close_`` (``open`` shadows the builtin).
    A naive ``Candle(**row)`` therefore raises ``unexpected keyword argument
    'open'`` — which silently degraded ``hoga validate --deep`` (candles never
    loaded, so ``series.candles_ts_monotonic`` was never evaluated) and made
    ``--deep --fix`` actively dangerous (a recompute that skips the candle
    check would CLEAR archived ``candles_ts_monotonic`` errors, re-including
    chart-crashing Stock-Dates). Lives here (not in ``cli.py``'s
    ``_run_series_for``) for the same reason as ``snapshots.read_parquet``:
    reading is the inverse of writing, so the write↔read round-trip stays the
    single test surface for the schema and cannot drift.
    """
    rows = pq.read_table(path).to_pylist()
    return [
        Candle(
            ts_ms=r["ts_ms"], open_=r["open"], close_=r["close"],
            high=r["high"], low=r["low"], vol_a=r["vol_a"], vol_b=r["vol_b"],
        )
        for r in rows
    ]


# === API representation ===


class ApiCandle(BaseModel):
    ts_ms: int
    open: int
    close: int
    high: int
    low: int
    vol_a: int
    vol_b: int


# === Query (returns list[ApiCandle] directly) ===

# `query_all` 의 일괄 검증용. 모듈 상수인 이유는 `TypeAdapter` 생성이 스키마를
# 컴파일하기 때문이다 — 호출마다 만들면 그 비용이 이득을 통째로 삼킨다.
_API_CANDLE_FIELDS = ("ts_ms", "open", "close", "high", "low", "vol_a", "vol_b")
_API_CANDLE_LIST = TypeAdapter(list[ApiCandle])



def query_all(
    con: duckdb.DuckDBPyConnection, *, path: Path, ts_offset_ms: int
) -> list[ApiCandle]:
    """파케이의 ms-from-KST-midnight `ts_ms` 를 **SQL 에서** 이동시켜 읽는다.

    ``ts_offset_ms`` 는 보통 그 Stock-Date 의 자정 Unix ms —
    ``ms_from_midnight_to_unix_ms(date, 0)`` 로 구한다. 오프셋의 정의는 그 함수
    하나에만 두고, 여기서는 받은 값을 더하기만 한다.

    ⚠ **키워드 필수이고 기본값이 없다.** 기본 0 을 주면 호출자가 빠뜨렸을 때 조용히
    자정 기준 ms 가 그대로 나가고, 그건 wire 상 Unix ms 와 구별되지 않는 **1970년대
    타임스탬프**다 — venue 기본값이 만들던 것과 같은 종류의 조용한 오답이다
    (`queries.parquet_dir` 주석 참조). 필수면 누락이 런타임 오답이 아니라 타입 에러다.

    왜 SQL 인가: 호출부가 파이썬에서 `model_copy(update={"ts_ms": ...})` 로 보정하면
    같은 행을 **두 벌** 물질화한다. 5개월치 1분봉이면 36,276개를 만들고 다시 36,276개다.
    실측상 이 경로 시간의 38.7% 가 그 두 번째 벌이었다(`build_candles_slice` 분해).
    """
    rows = con.execute(
        'SELECT ts_ms + ? AS ts_ms, "open", "close", high, low, vol_a, vol_b '
        # ORDER BY 는 **테이블 컬럼**을 가리킨다. 오프셋은 상수라 순서를 바꾸지
        # 않으므로 둘 중 무엇으로 정렬하든 결과가 같지만, 별칭을 달아 투영과
        # 정렬이 모호하게 묶이지 않게 한다.
        "FROM read_parquet(?) ORDER BY ts_ms ASC",
        [ts_offset_ms, str(path)],
    ).fetchall()
    # ⚠ **모델을 하나씩 만들지 않는다 — `TypeAdapter` 로 일괄 검증한다.**
    #
    # `ApiCandle(...)` 를 행마다 부르면 호출마다 파이썬 프레임 + kwargs dict 가 생긴다.
    # `TypeAdapter.validate_python` 은 **리스트 전체를 pydantic-core(Rust) 안에서**
    # 돌아 그 임시 객체들을 안 만든다. 검증은 그대로다 — `model_construct` 와 다르다
    # (그건 검증을 건너뛰는데 **오히려 5% 느렸다**).
    #
    # **이득의 정체는 속도가 아니라 GC 압력이다 — 이 구분이 중요하다.**
    # 실측 (2026-08-21, 000660, 3개월 = 파일 56개 · 20,783행, **ABBA 균형** 48 표본):
    #
    #     GC 켬(운영 조건)    min      p25   median     p75    GC 수집
    #     이전 (kwargs)      71.3     80.7    106.9   122.4     4,080
    #     현재 (TypeAdapter) 69.2     73.8     79.4   121.8     2,562  **-37%**
    #
    #     GC 끔 (순수 계산)   min      p25   median     p75
    #     이전 (kwargs)      66.4     68.5     70.7    72.4
    #     현재 (TypeAdapter) 63.2     66.9     68.0    69.9
    #
    # 즉 **순수 계산 차이는 ~4% 뿐**이고(GC 끔에서 min +4.8% · median +3.8%), 운영
    # 조건의 median -26% 는 **느린 실행의 빈도가 준 것**이다. 임시 객체가 줄어 수집이
    # 37% 덜 돌기 때문이며, GC 가 이 경로에 얹는 비용은 이전 +51% → 현재 +17% 다.
    # (ADR-0085 v3.3 이 `gc.disable()` 로 "candles +49%" 를 잰 것과 같은 크기다.)
    #
    # 그래서 **바닥(min)은 안 움직인다** — 기대를 그쪽에 걸지 말 것. 움직이는 것은
    # 분포의 꼬리고, 사용자가 기다리는 것은 그쪽이다.
    #
    # 동등성: 값·필드 타입·`dump_json` 바이트까지 이전과 동일함을 19,921행에서 확인.
    #
    # ⚠ **이 수치를 다시 재려면 ABBA 로 순서를 상쇄할 것.** A,B,A,B 로 번갈아 도는
    # 것만으로는 부족하다 — 라운드마다 A 가 먼저면 워밍 효과가 전부 B 에 쌓여
    # **순서를 변형 차이로 읽는다.** 이 세션이 정확히 그 함정에 빠져 같은 변경을
    # 한때 "-33%" 로 오독했다. 판별 신호는 **min 이 양쪽 같은데 median 만 벌어지는
    # 것**이었다(그건 변형 차이가 아니라 조건 차이의 서명이다).
    rows = _merge_split_minutes(rows)
    return _API_CANDLE_LIST.validate_python(
        [dict(zip(_API_CANDLE_FIELDS, r, strict=True)) for r in rows]
    )


def _merge_split_minutes(
    rows: list[tuple[int, int, int, int, int, int, int]],
) -> list[tuple[int, int, int, int, int, int, int]]:
    """같은 ``ts_ms`` 로 쪼개진 봉 조각들을 한 봉으로 합친다.

    **왜 필요한가 — 디스크에 이미 그런 파일이 7,069개 있다.** ``kiwoom_live`` 소스의
    분봉 합성(ADR-0125)이 한 분(分)을 여러 행으로 내보내는 경우가 있다. 실측
    2026-08-22: ``kiwoom_live`` candles 파케이 **8,934개 중 7,069개(79%)** 가 중복
    ``ts_ms`` 를 갖는다(예: 005930/20260820 은 364행 / 고유 356). ``hogaplay`` 소스는
    깨끗하다 — 즉 이것은 읽기 규약의 문제가 아니라 그 한 생산자의 문제다.

    **증상이 조용하지 않다.** ``/api/range`` 가 비단조 캔들을 그대로 실어 보내면
    lightweight-charts 가 ``data must be asc ordered by time`` 어서션으로 죽고,
    프론트는 차트 전체를 「차트 렌더링에 실패했습니다」로 대체한다(2026-08-22 실측).
    저장뷰·전역 REST 우회·창별 hogaplay 소스가 **셋 다** 이 경로를 탄다.

    **합치는 규칙은 새로 정하지 않는다** — 한 버킷 안을 접는
    ``bundle.downsample_candles`` 와 같다: ``open`` 은 첫 조각, ``close`` 는 마지막
    조각, ``high`` 는 최대, ``low`` 는 최소, 거래량은 합. 조각들이 실제로 그 규칙에
    맞는 시간순 파편이라는 것은 실측으로 확인했다(005930/20260820: 파일 순서가 곧
    시각 순서이고, 뒤 조각의 시가가 앞 조각의 종가에 이어지며 거래량이 꼬리 몫으로
    작다 — 107,264 → 39,722 · 84,601 → 603).

    **읽기 쪽에서 고치는 이유는 이미 쓰인 파일 7,069개다.** 생산자를 고쳐도 그 파일들은
    안 낫는다. 생산자 수정은 별건이다(데이터 위생 — 이 병합이 있으면 더는 크래시가
    아니다).

    ## 성능

    깨끗한 파일에서는 **한 번의 O(n) 스캔** 뒤 입력을 그대로 돌려준다 — 새 리스트도
    새 튜플도 만들지 않는다. 위 TypeAdapter 주석이 재는 것은 임시 객체와 GC 압력이라,
    그 이득을 지키려면 정상 경로가 아무것도 할당하지 않아야 한다. 병합은 중복이 실제로
    있을 때만 리스트를 다시 만든다.

    ## 정렬 가정

    입력은 ``ts_ms`` 오름차순이라(호출부 SQL) 같은 ts 는 **인접**한다. 조각 사이의
    상대 순서는 SQL 이 보장하지 않지만(동률 키에 대해 ORDER BY 는 stable 이 아니다)
    파이썬 리스트의 순서는 결정돼 있으므로, 여기서 **인접 실행(run) 단위로** 접으면
    fetch 가 준 순서가 곧 타이브레이커가 된다. 실측 파일에서 그 순서 = 파일 순서 =
    시각 순서였다. SQL 에 ``file_row_number`` 를 끌어들여 ``arg_min``/``arg_max`` 로
    푸는 길도 있으나, 소수 파일을 위해 **모든 읽기**에 GROUP BY 를 물리게 된다.
    """
    if len(rows) < 2:  # noqa: PLR2004 — 국소 비교 상수(조각이 성립하려면 2행 이상)
        return rows
    if all(rows[i][0] != rows[i - 1][0] for i in range(1, len(rows))):
        return rows

    merged: list[tuple[int, int, int, int, int, int, int]] = []
    for row in rows:
        if merged and merged[-1][0] == row[0]:
            prev = merged[-1]
            merged[-1] = (
                prev[0],
                prev[1],                  # open  = 첫 조각
                row[2],                   # close = 마지막 조각
                max(prev[3], row[3]),     # high
                min(prev[4], row[4]),     # low
                prev[5] + row[5],         # vol_a
                prev[6] + row[6],         # vol_b
            )
        else:
            merged.append(row)
    return merged


def merge_split_candles(candles: list[Candle]) -> list[Candle]:
    """쪼개진 분봉 조각을 **쓰기 전에** 한 봉으로 접는다 — `_merge_split_minutes` 의 쌍.

    같은 규칙, 다른 층이다. `_merge_split_minutes` 는 **이미 쓰인** 파케이를 읽을 때
    접고(과거 파일 7,069개), 이쪽은 `promote` 가 **새 파케이를 쓰기 전에** 접는다.
    그래서 새로 쓰이는 파일에는 애초에 조각이 없다.

    **왜 읽기 병합만으로 부족한가.** `hoga/api/invariants.py` 의
    ``series.candles_ts_monotonic`` 은 "candles ts_ms must be strictly ascending" 를
    **Severity.error** 로 선언한다. 조각 난 파일은 그 불변식을 위반한 채 디스크에
    앉아 있다 — 읽기 병합은 증상을 가릴 뿐 디스크를 진실로 만들지 않는다.

    **조각이 생기는 이유**(생산자 진단, 2026-08-22 실측). `MinuteCandleAggregator`
    (ADR-0125)는 봉을 **거래소 체결시간**으로 버킷팅하면서 봉인은 **로컬 벽시계**로
    한다 — `flush()` 가 ``minute < now_ms // 60_000`` 을 즉시 봉인하고 `commit()` 이
    버킷을 지우므로 **허용 지연이 0** 이다. 그 뒤 같은 분의 틱이 오면 `_Bar` 가 새로
    생겨 두 번째 행이 된다. JSONL 의 `ob` 행 t_ms 가 곧 flush 벽시계라 지연을 역산할
    수 있는데, 첫 조각은 93% 가 분 종료 후 0~10초에 나가는 반면 **추가 조각은
    10~120초** 뒤에 나간다. 유한한 유예로는 이 꼬리를 다 못 덮으므로 봉인 시점을
    미루는 대신 **파생 테이블을 만들 때 정규화**한다(JSONL 은 도착 로그 그대로 둔다).

    ## 정렬이 병합의 일부다 — 인접 판정만으로는 안 된다

    `_merge_split_minutes` 는 입력이 SQL 로 정렬돼 온다는 전제 위에서 **인접 실행**만
    접는다. 여기 들어오는 것은 **도착 순서**의 리스트라 그 전제가 없다. 지연이 60초를
    넘으면 원리적으로 ``M 조각1, M+1, M 조각2`` 순서가 나올 수 있고, 그러면 인접
    판정은 조각2를 놓친다 — 그런데 `write_parquet` 이 쓰기 직전에 정렬하므로 놓친
    조각은 **파일 안에서 다시 이웃이 되어** 중복으로 남는다. 그래서 여기서 먼저
    정렬한다. `sorted` 는 stable 이라 같은 ts 안에서는 도착 순서가 유지되고, 그것이
    ``open``=첫 조각 / ``close``=마지막 조각 규칙이 기대는 타이브레이커다.

    (실측: 파케이 8,934개 전수 스캔에서 **순서가 뒤집힌 파일은 0개**였다. `flush` 가
    한 배치 안의 봉인 봉들을 분 오름차순으로 내보내기 때문이다. 즉 이 정렬은 관측된
    결함을 고치는 것이 아니라 **그 창발적 성질에 기대지 않게 하는 보험**이다.)

    합치는 규칙은 `_merge_split_minutes` · `bundle.downsample_candles` 와 같다:
    ``open`` 은 첫 조각, ``close`` 는 마지막 조각, ``high`` 는 최대, ``low`` 는 최소,
    거래량은 합.

    ## 순수 함수인 이유 — **값이 깨져서가 아니다**

    위 규칙은 **결합법칙이 성립한다**: 이미 접힌 행에 새 조각을 다시 접어도 한꺼번에
    접은 것과 같은 값이 나온다. 그래서 증분 파서의 누적 상태를 제자리에서 접어도
    거래량이 부풀지 않는다 — red-check 으로 확인했다(그 주입은 값 단언을 하나도
    깨지 못했다). 근거를 "값이 부푼다" 로 적으면 다음 사람이 반례를 만들고 이 규율을
    지운다.

    진짜 이유는 **`_JsonlParseState.candles` 가 도착 로그라는 것**이다. 증분 파서는
    "그 시점 파일 전체를 전량 파싱한 것과 동일" 을 계약으로 갖고(`_parse_jsonl_incremental`
    docstring), 그 상태는 소비한 JSONL 라인의 누적이다. 제자리에서 접으면 상태가 더는
    그것이 아니게 되고, 그 뒤에 상태를 raw 로 읽는 코드(행 수 집계·진단·새 소비자)는
    조용히 접힌 행을 본다. 파생은 파생 지점에서만 일어나야 한다.
    """
    if len(candles) < 2:  # noqa: PLR2004 — 국소 비교 상수(조각이 성립하려면 2행 이상)
        return candles
    ordered = sorted(candles, key=lambda c: c.ts_ms)
    if all(ordered[i].ts_ms != ordered[i - 1].ts_ms for i in range(1, len(ordered))):
        return ordered

    merged: list[Candle] = []
    for candle in ordered:
        prev = merged[-1] if merged else None
        if prev is None or prev.ts_ms != candle.ts_ms:
            merged.append(candle)
            continue
        merged[-1] = Candle(
            ts_ms=prev.ts_ms,
            open_=prev.open_,                    # open  = 첫 조각
            close_=candle.close_,                # close = 마지막 조각
            high=max(prev.high, candle.high),
            low=min(prev.low, candle.low),
            vol_a=prev.vol_a + candle.vol_a,
            vol_b=prev.vol_b + candle.vol_b,
        )
    return merged


def query_price_range(con: duckdb.DuckDBPyConnection, *, path: Path) -> tuple[int, int] | None:
    """Return ``(MIN(low), MAX(high))`` across the candles, or ``None`` if the
    table is empty (NULL aggregates).

    This owns the ``low`` / ``high`` candle-column knowledge (ADR-0001) so
    callers that need a price grid — e.g. the range bundle's volume-profile
    slice — get the spread without re-deriving the schema. Mirrors
    ``snapshots.query_time_bounds``'s ``tuple | None`` shape.
    """
    row = con.execute(
        "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [str(path)]
    ).fetchone()
    if row is None or row[0] is None or row[1] is None:
        return None
    return int(row[0]), int(row[1])
