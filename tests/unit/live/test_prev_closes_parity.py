"""`_load_prev_closes` 가 종전 `_load_daily_rows` + 파이썬 선택과 **글자 그대로 같은가**.

히트맵 그룹 플로우는 코드당 1행(basis 직전 종가)만 쓰는데 코퍼스 전 이력을 파이썬
dict 로 물질화하고 있었다(296종목 → 871,099행, 실측 473ms/폴, 60초 주기). 전용 헬퍼로
바꾸면서 **동작이 같다는 것이 그 성능 수정의 전제**이므로 여기서 값으로 못박는다.

이 파일이 존재하는 진짜 이유는 함정 하나다: **`close > 0` 검사의 위치**.

종전 소비처는
    prev = next((r for r in reversed(rows) if r["date"] < basis), None)
    if prev is not None and float(prev["close"]) > 0: ...
였다. 즉 **① basis 직전 마지막 행을 고르고 → ② 그 행의 종가가 0 이면 종목을 통째로
제외**한다. 더 이전의 양수 종가로 폴백하지 **않는다**. 이 필터를 SQL 술어로 앞당기면
(`filter(close > 0)` 후 last) "0 인 날을 건너뛰고 그 전 양수 종가" 를 집게 되어 조용히
달라진다 — 실코퍼스에 `close <= 0` 행이 실제로 1건 있어(2026-08-16 실측,
8,692,057행 중) 이건 이론적 차이가 아니다.

`(code, date)` 중복은 실코퍼스 0건이라 동률 tie-breaking 은 이 축의 관심사가 아니다.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import polars as pl

from hoga.live.index_sector_rankings import _load_daily_rows, _load_prev_closes

BASIS = dt.date(2026, 6, 19)


def _prev_closes_legacy(path: Path, codes: list[str], basis: dt.date) -> dict[str, float]:
    """종전 구현 그대로 — `heatmap_group_flow.build_group_flow` 에서 옮겨 온 6줄."""
    rows_by_code = _load_daily_rows(path, codes, basis)
    out: dict[str, float] = {}
    for code, rows in rows_by_code.items():
        prev = next((r for r in reversed(rows) if r["date"] < basis), None)
        if prev is not None and float(prev["close"]) > 0:
            out[code] = float(prev["close"])
    return out


def _write(path: Path, rows: list[tuple[str, dt.date, float]]) -> None:
    pl.DataFrame(
        {
            "code": [r[0] for r in rows],
            "date": [r[1] for r in rows],
            "close": [r[2] for r in rows],
        },
        schema={"code": pl.String, "date": pl.Date, "close": pl.Float64},
    ).write_parquet(path)


def _d(offset: int) -> dt.date:
    return BASIS - dt.timedelta(days=offset)


def test_matches_legacy_across_every_edge(tmp_path: Path) -> None:
    path = tmp_path / "daily_adjusted.parquet"
    _write(
        path,
        [
            # 평범한 종목 — 직전 거래일 종가.
            ("000001", _d(3), 1000.0),
            ("000001", _d(1), 1100.0),
            # basis 당일 행은 배제된다(`date < basis`) — 있으면 미래를 보는 것.
            ("000002", _d(1), 2000.0),
            ("000002", BASIS, 9999.0),
            # ⚠ 핵심 케이스: **직전 행의 종가가 0** → 종목 통째로 제외.
            #    앞선 2200.0 으로 폴백하면 안 된다.
            ("000003", _d(2), 2200.0),
            ("000003", _d(1), 0.0),
            # 0 이 중간에 있고 마지막이 양수면 정상 포함(위와 대칭).
            ("000004", _d(2), 0.0),
            ("000004", _d(1), 4400.0),
            # basis 이후 행만 있는 종목 → 없음.
            ("000005", BASIS + dt.timedelta(days=1), 5000.0),
            # 음수 종가(파손 데이터)도 0 과 같은 취급.
            ("000006", _d(1), -1.0),
        ],
    )
    codes = ["000001", "000002", "000003", "000004", "000005", "000006"]

    legacy = _prev_closes_legacy(path, codes, BASIS)
    fast = _load_prev_closes(path, codes, BASIS)

    # ① 종전과 dict 완전 일치.
    assert fast == legacy
    # ② 값 자체를 못박는다 — 둘이 **같은 방식으로 틀리는** 경우를 배제한다.
    assert fast == {"000001": 1100.0, "000002": 2000.0, "000004": 4400.0}
    # ③ 위 딕셔너리가 말하는 바를 이름으로 한 번 더(회귀 메시지 가독성).
    assert "000003" not in fast, "직전 행 종가 0 → 이전 양수로 폴백하면 안 된다"
    assert "000005" not in fast, "basis 이후 행만 있으면 없음"
    assert "000006" not in fast, "음수 종가는 0 과 같은 취급"


def test_empty_codes_short_circuits(tmp_path: Path) -> None:
    path = tmp_path / "daily_adjusted.parquet"
    _write(path, [("000001", _d(1), 1000.0)])
    assert _load_prev_closes(path, [], BASIS) == {}
    assert _load_prev_closes(path, [], BASIS) == _prev_closes_legacy(path, [], BASIS)


def test_code_absent_from_corpus_is_omitted(tmp_path: Path) -> None:
    path = tmp_path / "daily_adjusted.parquet"
    _write(path, [("000001", _d(1), 1000.0)])
    fast = _load_prev_closes(path, ["000001", "999999"], BASIS)
    assert fast == _prev_closes_legacy(path, ["000001", "999999"], BASIS)
    assert fast == {"000001": 1000.0}


def test_reads_one_row_per_code_regardless_of_history_depth(tmp_path: Path) -> None:
    """깊은 이력에서도 결과가 코드당 1행 — 이 헬퍼의 존재 이유(입력 축 성장 차단)."""
    path = tmp_path / "daily_adjusted.parquet"
    rows: list[tuple[str, dt.date, float]] = []
    for code in ("000001", "000002"):
        for i in range(1, 501):
            rows.append((code, _d(i), float(1000 + i)))
    _write(path, rows)
    codes = ["000001", "000002"]

    fast = _load_prev_closes(path, codes, BASIS)
    assert fast == _prev_closes_legacy(path, codes, BASIS)
    # `_d(1)` 이 가장 최근(= offset 이 작을수록 basis 에 가깝다).
    assert fast == {"000001": 1001.0, "000002": 1001.0}
