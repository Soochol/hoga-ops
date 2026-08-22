from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from hoga.tables.candles import (
    PARQUET_SCHEMA,
    ApiCandle,
    Candle,
    merge_split_candles,
    parse_row,
    query_all,
    read_parquet,
    write_parquet,
)


def test_parse_row() -> None:
    line = "30600000\t08:30:00\t281000\t281000\t281000\t281000\t119\t0\t0\t43\t5"
    c = parse_row(line)
    assert isinstance(c, Candle)
    assert c.ts_ms == 30600000
    assert c.open_ == c.close_ == c.high == c.low == 281000
    assert c.vol_a == 119
    assert c.vol_b == 0


def test_parse_row_folds_auction_volume_into_vol_a() -> None:
    """9번째 컬럼(단일가 체결량)이 vol_a 에 합쳐진다 (#1278).

    실제 chart.tsv 행이다 — 20260716/053080 의 마감 단일가 봉. 그 봉은
    ``vol_a=0 vol_b=0`` 인데 단일가 체결 261 주가 9번째 컬럼에 있다. 파서가
    그 컬럼을 버리던 시절 이 봉의 거래량은 **0** 이었고, 그게 일봉 거래량이
    벤더보다 항상 적던 원인이다.

    가격은 그때도 맞았다(단일가 8500) — **가격은 맞고 수량만 없는 것**이 이
    결함의 지문이라 아래에서 둘 다 단언한다.
    """
    line = "55800000\t15:30:42\t8500\t8500\t8500\t8500\t0\t0\t261\t4842\t4842"
    c = parse_row(line)
    assert c.open_ == c.close_ == c.high == c.low == 8500
    assert c.vol_a == 261, "단일가 체결량이 vol_a 에 폴드되지 않았다"
    assert c.vol_b == 0
    assert c.vol_a + c.vol_b == 261


def test_parse_row_adds_auction_volume_to_continuous_volume() -> None:
    """시가단일가 봉처럼 연속체결과 단일가가 **같은 봉**에 있으면 더한다.

    09:00 봉은 09:00:00 의 시가단일가 프린트와 09:00:01~09:00:59 의 연속체결을
    함께 담는다. 폴드가 덮어쓰기가 아니라 덧셈이어야 하는 자리 — 덮어쓰기여도
    위 마감봉 테스트(연속체결 0)는 통과하므로 이 케이스가 따로 필요하다.
    """
    line = "32400000\t09:00:31\t8500\t8600\t8600\t8500\t100\t55\t20368\t1\t1"
    c = parse_row(line)
    assert c.vol_a == 100 + 20368
    assert c.vol_b == 55


def test_parse_row_tolerates_row_without_auction_field() -> None:
    """9번째 컬럼이 없는 행은 단일가 0 으로 읽는다 — 거부하지 않는다.

    ``CANDLE_MIN_FIELDS`` 는 8 로 유지한다(#1278). 실측 raw 는 전부 11 필드라
    이 경로가 실제로 타지는 않지만, 하한을 올려 8 필드 행을 새로 죽이는 것은
    이 수정의 범위가 아니다.
    """
    c = parse_row("30600000\t08:30:00\t281000\t281000\t281000\t281000\t119\t7")
    assert (c.vol_a, c.vol_b) == (119, 7)


def test_candles_not_in_dispatcher_registry() -> None:
    """Candles is parsed from chart.tsv, not first.tsv. It must NOT register any event_type.

    This is a contract test against the dispatcher: if a future change accidentally
    adds ``PARSERS = {6: parse_row}`` to candles.py, the dispatcher would pick it up
    and try to feed first.tsv rows through it. Catch that here.
    """
    from hoga.tables import candles as candles_mod
    from hoga.tables.dispatch import PARSERS as registry

    assert getattr(candles_mod, "PARSERS", {}) == {}, "candles must not declare PARSERS"
    # And no registry entry should call into candles.parse_row.
    candles_funcs = {candles_mod.parse_row}
    assert not (set(registry.values()) & candles_funcs), (
        "candles.parse_row leaked into the dispatcher registry"
    )


def test_parquet_schema_columns() -> None:
    names = PARQUET_SCHEMA.names
    for col in ("ts_ms", "open", "close", "high", "low", "vol_a", "vol_b"):
        assert col in names


def test_write_parquet_is_atomic_on_replace_failure(tmp_path: Path, monkeypatch) -> None:
    """A failed write must leave a pre-existing candles.parquet intact.

    Regression guard (architecture-review QW-1): candles.write_parquet must
    route through the shared atomic-write helper (tempfile + os.replace) like
    its sibling tables, so a crash mid-write can never expose a torn or
    zero-length parquet to a concurrent reader. With the old in-place
    pq.write_table the target was overwritten/torn on failure; with os.replace
    the original survives untouched.
    """
    out = tmp_path / "candles.parquet"
    write_parquet([Candle(ts_ms=1, open_=1, close_=1, high=1, low=1, vol_a=1, vol_b=1)], out)

    import hoga.util.atomic_write as aw

    def _boom(_src, _dst):
        raise OSError("simulated crash during atomic replace")

    monkeypatch.setattr(aw.os, "replace", _boom)

    raised = False
    try:
        write_parquet([Candle(ts_ms=2, open_=2, close_=2, high=2, low=2, vol_a=2, vol_b=2)], out)
    except OSError:
        raised = True
    assert raised, "write_parquet must use os.replace (atomic); a failed replace should propagate"

    rows = query_all(duckdb.connect(), path=out, ts_offset_ms=0)
    assert [r.ts_ms for r in rows] == [1], "original parquet must survive a failed write intact"


def test_write_parquet_sorts_ascending(tmp_path: Path) -> None:
    p = 281000
    candles = [
        Candle(ts_ms=30660000, open_=p, close_=p, high=p, low=p, vol_a=10, vol_b=2),
        Candle(ts_ms=30600000, open_=p, close_=p, high=p, low=p, vol_a=119, vol_b=0),
    ]
    out = tmp_path / "candles.parquet"
    write_parquet(candles, out)
    tbl = pq.read_table(out)
    assert tbl.column("ts_ms").to_pylist() == [30600000, 30660000]


def test_query_all_returns_ascending_api_models(tmp_path: Path) -> None:
    out = tmp_path / "candles.parquet"
    write_parquet(
        [
            Candle(ts_ms=30660000, open_=1, close_=1, high=1, low=1, vol_a=1, vol_b=1),
            Candle(ts_ms=30600000, open_=2, close_=2, high=2, low=2, vol_a=2, vol_b=2),
        ],
        out,
    )
    con = duckdb.connect()
    rows = query_all(con, path=out, ts_offset_ms=0)
    assert all(isinstance(r, ApiCandle) for r in rows)
    assert [r.ts_ms for r in rows] == [30600000, 30660000]
    assert rows[0].open == 2  # ascending sort moves second-inserted to first
    assert rows[1].open == 1


def test_query_all_shifts_ts_by_offset_in_sql(tmp_path: Path) -> None:
    """`ts_offset_ms` 가 SQL 에서 더해진다 — 파케이는 자정 기준 ms 로 남는다.

    보정을 파이썬에서 `model_copy` 로 하면 같은 행을 두 벌 물질화하고, 5개월치
    1분봉이면 36,276개짜리 두 벌이다. 이 단언이 그 보정의 **유일한 위치**가
    SQL 임을 못 박는다.
    """
    out = tmp_path / "candles.parquet"
    write_parquet(
        [
            Candle(ts_ms=30_600_000, open_=2, close_=2, high=2, low=2, vol_a=2, vol_b=2),
            Candle(ts_ms=30_660_000, open_=1, close_=1, high=1, low=1, vol_a=1, vol_b=1),
        ],
        out,
    )
    con = duckdb.connect()
    offset = 1_749_772_800_000  # 어느 Stock-Date 의 KST 자정 Unix ms

    rows = query_all(con, path=out, ts_offset_ms=offset)

    assert [r.ts_ms for r in rows] == [offset + 30_600_000, offset + 30_660_000]
    # 오프셋은 단조라 정렬이 뒤집히지 않는다.
    assert rows[0].ts_ms < rows[1].ts_ms
    # 값 컬럼은 손대지 않는다 — 시프트가 OHLCV 로 새면 안 된다.
    assert [r.open for r in rows] == [2, 1]
    # 디스크는 여전히 자정 기준이다(보정이 읽기 경로에만 있다).
    assert pq.read_table(out).column("ts_ms").to_pylist() == [30_600_000, 30_660_000]


# ---------------------------------------------------------------------------
# read_parquet — symmetric inverse of write_parquet (Candle round-trip)
# ---------------------------------------------------------------------------


def test_read_parquet_round_trips_write_parquet(tmp_path: Path) -> None:
    """write_parquet ↔ read_parquet must round-trip Candles exactly (ASC by ts).

    Single test surface for the parquet column schema — if the columns drift,
    this breaks rather than a caller silently re-deriving them.
    """
    candles = [
        Candle(ts_ms=30600000, open_=281000, close_=281500, high=282000, low=280500, vol_a=119, vol_b=3),
        Candle(ts_ms=30660000, open_=281500, close_=281200, high=281900, low=281000, vol_a=42, vol_b=7),
    ]
    out = tmp_path / "candles.parquet"
    write_parquet(candles, out)
    assert read_parquet(out) == candles


def test_read_parquet_maps_open_close_columns_to_underscored_fields(tmp_path: Path) -> None:
    """Regression for the validate --deep candle-load break (2026-06-08): the
    parquet columns are ``open``/``close`` but the Candle fields are
    ``open_``/``close_``. A naive ``Candle(**row)`` raised
    ``unexpected keyword argument 'open'``, so cli._run_series_for loaded NO
    candles and series.candles_ts_monotonic was never evaluated under --deep —
    making --deep --fix able to CLEAR archived candles_ts errors (re-including
    chart-crashing dates). read_parquet owns the remap; assert the field values
    survive it."""
    out = tmp_path / "candles.parquet"
    write_parquet([Candle(ts_ms=1, open_=100, close_=200, high=250, low=90, vol_a=5, vol_b=6)], out)
    [c] = read_parquet(out)
    assert (c.open_, c.close_) == (100, 200)
    assert (c.high, c.low, c.vol_a, c.vol_b) == (250, 90, 5, 6)


def test_read_parquet_empty_table_returns_empty_list(tmp_path: Path) -> None:
    out = tmp_path / "candles.parquet"
    write_parquet([], out)
    assert read_parquet(out) == []


# ---------------------------------------------------------------------------
# query_price_range (ADR-0001): MIN(low)/MAX(high) for the volume-profile grid
# ---------------------------------------------------------------------------


def test_query_price_range_returns_min_low_max_high(tmp_path: Path) -> None:
    from hoga.tables.candles import query_price_range

    out = tmp_path / "candles.parquet"
    write_parquet(
        [
            Candle(ts_ms=1, open_=100, close_=100, high=150, low=90, vol_a=1, vol_b=1),
            Candle(ts_ms=2, open_=100, close_=100, high=200, low=80, vol_a=1, vol_b=1),
        ],
        out,
    )
    con = duckdb.connect()
    assert query_price_range(con, path=out) == (80, 200)  # (MIN(low), MAX(high))


def test_query_price_range_empty_candles_returns_none(tmp_path: Path) -> None:
    from hoga.tables.candles import query_price_range

    out = tmp_path / "candles.parquet"
    write_parquet([], out)
    con = duckdb.connect()
    assert query_price_range(con, path=out) is None


def _write_rows(path: Path, rows: list[tuple[int, int, int, int, int, int, int]]) -> None:
    """행 **순서 그대로** 파케이를 쓴다.

    `write_parquet` 은 오름차순 정렬을 하므로 같은 ts 조각들의 상대 순서를 이 테스트가
    직접 통제할 수 없다. 실제 `kiwoom_live` 파일은 쓰인 순서 = 시각 순서이고, 병합의
    first/last 의미가 그 순서에 달려 있으므로 여기서는 손으로 배치한다.
    """
    import pyarrow as pa

    cols = list(zip(*rows, strict=True))
    names = ["ts_ms", "open", "close", "high", "low", "vol_a", "vol_b"]
    table = pa.table(
        {name: pa.array(list(col), type=PARQUET_SCHEMA.field(name).type)
         for name, col in zip(names, cols, strict=True)},
        schema=PARQUET_SCHEMA,
    )
    pq.write_table(table, path)


def test_query_all_merges_minute_fragments_split_across_rows(tmp_path: Path) -> None:
    """같은 ``ts_ms`` 로 쪼개진 조각을 한 봉으로 합친다.

    **막는 방향**: 비단조 캔들이 `/api/range` 로 나가는 것. 나가면 프론트의
    lightweight-charts 가 ``data must be asc ordered by time`` 어서션으로 죽고 차트
    전체가 「차트 렌더링에 실패했습니다」로 대체된다(2026-08-22 실측). 저장뷰·전역 REST
    우회·창별 hogaplay 소스가 셋 다 이 경로를 탄다.

    **못 보는 것**: 조각을 만들어 내는 생산자(`kiwoom_live` 분봉 합성, ADR-0125)는
    그대로다 — 이것은 이미 쓰인 파일 7,069개를 읽을 수 있게 하는 읽기 쪽 수용이지
    데이터 위생의 해결이 아니다.

    값은 실측 파일에서 가져왔다(005930/20260820 09:08 · 09:55 = 3조각).
    """
    out = tmp_path / "candles.parquet"
    _write_rows(out, [
        (32820000, 252000, 252750, 253000, 251500, 50000, 0),   # 단일 조각(불변)
        (32880000, 252750, 253000, 253500, 252500, 107264, 0),  # 09:08 조각 1
        (32880000, 253250, 253500, 254000, 253000, 39722, 0),   # 09:08 조각 2
        (35700000, 263500, 263750, 264000, 263500, 29538, 0),   # 09:55 조각 1
        (35700000, 263750, 263750, 263750, 263750, 13, 0),      # 09:55 조각 2
        (35700000, 263750, 263750, 263750, 263500, 1395, 0),    # 09:55 조각 3
    ])

    rows = query_all(duckdb.connect(), path=out, ts_offset_ms=0)

    assert [r.ts_ms for r in rows] == [32820000, 32880000, 35700000]
    merged = rows[1]
    assert merged.open == 252750    # 첫 조각
    assert merged.close == 253500   # 마지막 조각
    assert merged.high == 254000    # max
    assert merged.low == 252500     # min
    assert merged.vol_a == 146986   # 합
    three = rows[2]
    assert (three.open, three.close) == (263500, 263750)
    assert (three.high, three.low) == (264000, 263500)
    assert three.vol_a == 29538 + 13 + 1395
    assert rows[0].vol_a == 50000   # 단일 조각은 손대지 않는다


def test_query_all_returns_the_same_list_object_when_nothing_is_split(tmp_path: Path) -> None:
    """중복이 없으면 **아무것도 할당하지 않는다**.

    `query_all` 의 TypeAdapter 경로가 재는 것은 속도가 아니라 GC 압력이므로(그 주석의
    실측표), 정상 경로가 리스트를 한 벌 더 만들면 그 이득이 도로 나간다. hogaplay
    소스 파일은 전부 이쪽이다.
    """
    from hoga.tables.candles import _merge_split_minutes

    clean = [(1, 1, 1, 1, 1, 1, 1), (2, 2, 2, 2, 2, 2, 2)]
    assert _merge_split_minutes(clean) is clean

    out = tmp_path / "candles.parquet"
    _write_rows(out, clean)
    rows = query_all(duckdb.connect(), path=out, ts_offset_ms=0)
    assert [r.ts_ms for r in rows] == [1, 2]


# === merge_split_candles — 쓰기 전 병합(생산자 쪽) ===
#
# 읽기 쪽 `_merge_split_minutes` 와 **같은 규칙, 다른 층**이다. 여기 테스트가 재는 것은
# 그 규칙이 아니라 층이 다르기 때문에 생기는 차이 두 가지다: ① 입력이 도착 순서라
# 정렬이 병합의 일부다 ② 증분 파서의 누적 상태를 변이하면 안 되므로 순수해야 한다.


def _frag(ts: int, open_: int, close_: int, high: int, low: int, vol: int) -> Candle:
    return Candle(ts_ms=ts, open_=open_, close_=close_, high=high, low=low,
                  vol_a=vol, vol_b=0)


def test_merge_split_candles_folds_fragments_of_the_same_minute() -> None:
    """실측 값(005930/20260820 09:08)으로 한 분을 한 봉으로 접는다."""
    merged = merge_split_candles([
        _frag(32820000, 252000, 252750, 253000, 251500, 50000),
        _frag(32880000, 252750, 253000, 253500, 252500, 107264),
        _frag(32880000, 253250, 253500, 254000, 253000, 39722),
    ])

    assert [c.ts_ms for c in merged] == [32820000, 32880000]
    assert merged[1].open_ == 252750    # 첫 조각
    assert merged[1].close_ == 253500   # 마지막 조각
    assert merged[1].high == 254000     # max
    assert merged[1].low == 252500      # min
    assert merged[1].vol_a == 146986    # 합
    assert merged[0].vol_a == 50000     # 단일 조각은 손대지 않는다


def test_merge_split_candles_folds_fragments_that_are_not_adjacent() -> None:
    """``M 조각1, M+1, M 조각2`` — **인접 판정만으로는 못 잡는 배치**.

    **막는 방향**: 도착 순서가 시각 순서와 어긋난 조각이 병합을 빠져나가는 것.
    빠져나가면 `write_parquet` 이 쓰기 직전에 정렬하므로 두 조각은 **파일 안에서
    다시 이웃이 되어** 중복 행으로 남는다 — 즉 인접 판정은 조각을 놓칠 뿐 아니라
    놓친 사실이 파일에서 지워진다.

    **못 보는 것**: 이 배치는 실측 파케이 8,934개 전수 스캔에서 **0건**이었다(`flush`
    가 한 배치의 봉인 봉들을 분 오름차순으로 내보내기 때문). 이 테스트는 관측된
    결함이 아니라 그 창발적 성질에 기대지 않는다는 계약을 고정한다.
    """
    merged = merge_split_candles([
        _frag(32880000, 252750, 253000, 253500, 252500, 107264),  # 09:08 조각 1
        _frag(32940000, 253500, 254000, 254500, 253500, 90000),   # 09:09
        _frag(32880000, 253250, 253500, 254000, 253000, 39722),   # 09:08 조각 2 (늦음)
    ])

    assert [c.ts_ms for c in merged] == [32880000, 32940000]
    assert merged[0].vol_a == 146986
    assert merged[0].open_ == 252750    # 도착 순서가 동률 타이브레이커(stable sort)
    assert merged[0].close_ == 253500
    assert merged[1].vol_a == 90000


def test_merge_split_candles_does_not_mutate_its_input() -> None:
    """순수 함수 — 증분 파서의 누적 상태(`_JsonlParseState.candles`)를 그대로 받는다.

    **막는 방향**: 그 상태가 도착 로그이기를 그만두는 것. 증분 파서는 "그 시점 파일
    전체를 전량 파싱한 것과 동일" 을 계약으로 갖고 상태는 소비한 라인의 누적이다.
    제자리에서 접으면 그 뒤 상태를 raw 로 읽는 코드가 조용히 접힌 행을 본다.

    **못 보는 것 — 값**. 병합 규칙은 결합법칙이 성립해서 이미 접힌 행에 새 조각을
    다시 접어도 값이 같다(red-check 확인: 변이 주입은 승격 쪽 값 단언을 하나도 깨지
    못했다). 그러니 이 테스트가 지키는 것은 **불변식이지 산술이 아니다** — 반례를
    찾았다고 지우지 말 것.
    """
    original = [
        _frag(32880000, 252750, 253000, 253500, 252500, 107264),
        _frag(32880000, 253250, 253500, 254000, 253000, 39722),
    ]
    snapshot = list(original)

    merged = merge_split_candles(original)

    assert len(merged) == 1
    assert original == snapshot           # 원소 순서·값 불변
    assert original[0].vol_a == 107264    # 접힌 값이 되돌아오지 않았다


def test_merge_split_candles_sorts_even_when_nothing_is_split() -> None:
    clean = [_frag(2, 1, 1, 1, 1, 1), _frag(1, 2, 2, 2, 2, 2)]
    assert [c.ts_ms for c in merge_split_candles(clean)] == [1, 2]
    assert merge_split_candles([]) == []
