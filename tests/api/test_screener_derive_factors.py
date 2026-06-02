from __future__ import annotations

import datetime as dt

import polars as pl

from hoga.api.screener_factors import apply_factors


def _unadj():
    return pl.DataFrame({
        "code": ["005930"] * 4,
        "date": [dt.date(2018, 4, 20), dt.date(2018, 4, 27),
                 dt.date(2018, 5, 4), dt.date(2018, 5, 8)],
        "open": [2581000.0, 2650000.0, 51900.0, 52600.0],
        "high": [2581000.0, 2650000.0, 51900.0, 52600.0],
        "low": [2581000.0, 2650000.0, 51900.0, 52600.0],
        "close": [2581000.0, 2650000.0, 51900.0, 52600.0],
        "volume": [235220, 606216, 39565391, 23104720],
    })


def _factors():
    return pl.DataFrame({
        "code": ["005930", "005930"],
        "seg_start": [dt.date(2018, 4, 20), dt.date(2018, 5, 4)],
        "factor": [0.02, 1.0],
    })


def test_apply_factors_adjusts_price_and_volume():
    adj = apply_factors(_unadj(), _factors()).sort("date")
    assert adj["close"][0] == 2581000.0 * 0.02         # 51620
    assert adj["volume"][0] == round(235220 / 0.02)    # 11,761,000
    assert adj["close"][2] == 51900.0
    assert adj["volume"][2] == 39565391


def test_apply_factors_preserves_trade_value():
    u = _unadj().sort("date")
    adj = apply_factors(u, _factors()).sort("date")
    for i in range(u.height):
        raw_tv = u["close"][i] * u["volume"][i]
        adj_tv = adj["close"][i] * adj["volume"][i]
        assert abs(adj_tv - raw_tv) / raw_tv < 1e-6


def test_apply_factors_output_columns_and_dtype():
    adj = apply_factors(_unadj(), _factors())
    assert adj.columns == ["code", "date", "open", "high", "low", "close", "volume"]
    assert adj.schema["volume"] == pl.Int64


def test_apply_factors_extends_oldest_factor_backward():
    """earliest seg_start 이전 날짜(join_asof null) → 그 종목의 最古 factor 로 채움.

    다른 테스트는 전부 earliest date == earliest seg_start 라 fill_null(backward) 이
    한 번도 발동하지 않는다. 이 케이스가 그 한 줄의 계약을 고정한다.
    """
    unadj = pl.DataFrame({
        "code": ["005930"] * 2,
        # 첫 행(2018-04-13)은 가장 오래된 seg_start(2018-04-20)보다 이르다 → 계수 null.
        "date": [dt.date(2018, 4, 13), dt.date(2018, 4, 20)],
        "open": [2500000.0, 2581000.0],
        "high": [2500000.0, 2581000.0],
        "low": [2500000.0, 2581000.0],
        "close": [2500000.0, 2581000.0],
        "volume": [100000, 235220],
    })
    adj = apply_factors(unadj, _factors()).sort("date")
    # seg_start 이전 행도 最古 factor(0.02)를 받는다 (heuristic·null 아님).
    assert adj["close"][0] == 2500000.0 * 0.02
    assert adj["volume"][0] == round(100000 / 0.02)
    assert adj["close"][1] == 2581000.0 * 0.02


# ── Integration: derive_adjusted factors branch ──────────────────────────────

def test_derive_adjusted_with_factors_path(tmp_path):
    """factors_path 있을 때: 커버 종목 계수 적용 + 미커버 종목 adjust_splits 폴백.

    컬럼 정렬(pl.concat) 및 파일 왕복(write→read_parquet)까지 검증.
    """
    from hoga.api.screener_store import derive_adjusted
    from hoga.api.screener_factors import write_factors

    # Two codes: "005930" covered by factors, "000660" not covered (fallback)
    raw = tmp_path / "u.parquet"
    pl.DataFrame({
        "code":   ["005930", "005930", "000660", "000660"],
        "date":   [dt.date(2018, 4, 20), dt.date(2018, 5, 4),
                   dt.date(2018, 4, 20), dt.date(2018, 5, 4)],
        "open":   [2581000.0, 51900.0, 100.0, 100.0],
        "high":   [2581000.0, 51900.0, 100.0, 100.0],
        "low":    [2581000.0, 51900.0, 100.0, 100.0],
        "close":  [2581000.0, 51900.0, 100.0, 100.0],
        "volume": [235220,    39565391, 1000,   1000],
    }).write_parquet(raw)

    factors_path = tmp_path / "factors.parquet"
    write_factors(
        pl.DataFrame({
            "code":      ["005930", "005930"],
            "seg_start": [dt.date(2018, 4, 20), dt.date(2018, 5, 4)],
            "factor":    [0.02, 1.0],
        }),
        factors_path,
    )

    out = tmp_path / "adj.parquet"
    ms = derive_adjusted(raw, out, factors_path=factors_path)
    assert ms >= 0 and out.exists()

    adj = pl.read_parquet(out).sort(["code", "date"])

    # 005930 row 0: price × 0.02, volume ÷ 0.02
    s = adj.filter(pl.col("code") == "005930").sort("date")
    assert abs(s["close"][0] - 2581000.0 * 0.02) < 1e-3
    assert s["volume"][0] == round(235220 / 0.02)

    # 000660: no factors → adjust_splits fallback → prices unchanged (no split detected)
    h = adj.filter(pl.col("code") == "000660").sort("date")
    assert h["close"][0] == 100.0
    assert h["volume"][0] == 1000

    # Column schema must match regardless of which path produced each row
    assert adj.columns == ["code", "date", "open", "high", "low", "close", "volume"]
    assert adj.schema["volume"] == pl.Int64
