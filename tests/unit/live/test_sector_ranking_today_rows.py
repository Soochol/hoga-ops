"""당일 경로가 **코드당 1행**만 읽어도 응답이 같은가 (감사 §3-2).

섹터 랭킹의 당일 조회는 응답 캐시가 통째로 꺼져 있다(`use_cache = intraday_prices is None`).
장중 시세 오버레이가 매 폴링 달라지므로 완성 응답을 캐시하면 시세가 얼어붙어 **그 결정은
옳다.** 문제는 비싼 부분(일봉 코퍼스)과 변하는 부분(장중 시세)이 같은 결정에 묶여, 60초마다
코퍼스 전 이력이 파이썬 dict 로 다시 물질화되던 것이다(실측 296종목 → 871,099행 / 453 ms).

수정은 캐시를 손대지 않고 **읽는 양을 줄인다** — 당일 경로가 `rows` 를 쓰는 곳이
`previous_row` 하나뿐이기 때문이다. 그 전제가 깨지면(예: `_stock_from_entry` 가 당일에도
`basis_row` 를 읽게 바뀌면) 이 최적화는 **조용히 틀린 값을 낸다** — 그래서 여기서 값으로
못박는다.

오라클은 `_load_prev_rows` 를 `_load_daily_rows` 로 갈아 끼운 같은 함수다.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import polars as pl
import pytest

from hoga.api.heatmap import save_document
from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder
from hoga.live import index_sector_rankings as rankings
from hoga.live.index_sector_rankings import build_index_sector_rankings

BASIS = "20260619"
BASIS_D = dt.date(2026, 6, 19)
SEMI = "f_00000001"
BIO = "f_00000002"


@pytest.fixture(autouse=True)
def _clear_cache():
    rankings._ranking_cache.clear()
    rankings._fingerprint_cache.clear()
    yield
    rankings._ranking_cache.clear()
    rankings._fingerprint_cache.clear()


def _seed(tmp_path: Path, rows: list[tuple[str, dt.date, float]]) -> None:
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[
                WatchlistFolder.model_construct(id=SEMI, name="반도체", order=0),
                WatchlistFolder.model_construct(id=BIO, name="바이오", order=1),
            ],
            entries=[
                HeatmapEntry.model_construct(code="005930", name="삼성전자", folder_id=SEMI, order=0),
                HeatmapEntry.model_construct(code="000660", name="SK하이닉스", folder_id=SEMI, order=1),
                HeatmapEntry.model_construct(code="068270", name="셀트리온", folder_id=BIO, order=0),
                HeatmapEntry.model_construct(code="999999", name="없는종목", folder_id=BIO, order=1),
            ],
        ),
    )
    sdir = tmp_path / "screener"
    sdir.mkdir(exist_ok=True)
    pl.DataFrame(
        {
            "code": [r[0] for r in rows],
            "date": [r[1] for r in rows],
            "open": [0.0] * len(rows),
            "high": [0.0] * len(rows),
            "low": [0.0] * len(rows),
            "close": [r[2] for r in rows],
            "volume": [1] * len(rows),
        },
        schema_overrides={"date": pl.Date, "close": pl.Float64},
    ).write_parquet(sdir / "daily_adjusted.parquet")


def _d(offset: int) -> dt.date:
    return BASIS_D - dt.timedelta(days=offset)


def _both(tmp_path: Path, intraday: dict[str, int], monkeypatch):
    """(현행, 오라클) 응답 쌍. 오라클은 넓은 집합을 그대로 쓰는 종전 경로."""
    fast = build_index_sector_rankings(tmp_path, BASIS, intraday_prices=dict(intraday))
    monkeypatch.setattr(rankings, "_load_prev_rows", rankings._load_daily_rows)
    oracle = build_index_sector_rankings(tmp_path, BASIS, intraday_prices=dict(intraday))
    return fast, oracle


def test_today_path_matches_full_history(tmp_path, monkeypatch):
    """깊은 이력에서도 당일 응답이 동일하다 — 이 수정의 본체."""
    rows: list[tuple[str, dt.date, float]] = []
    for code, base in (("005930", 100.0), ("000660", 200.0), ("068270", 50.0)):
        for i in range(1, 60):                      # basis 이전 59거래일
            rows.append((code, _d(i), base + i))
        rows.append((code, BASIS_D, base + 999))    # basis 당일 행(당일 경로는 안 읽어야 한다)
    _seed(tmp_path, rows)

    fast, oracle = _both(tmp_path, {"005930": 150, "000660": 250, "068270": 60}, monkeypatch)
    assert fast.model_dump() == oracle.model_dump()
    # 값 자체도 못박는다 — 둘이 **같은 방식으로 틀리는** 경우를 배제한다.
    stocks = {s.code: s for g in fast.sectors for s in g.stocks}
    assert stocks["005930"].previous_close == 101.0, "basis 직전 행(_d(1))이어야 한다"
    assert stocks["005930"].close == 150.0, "close 는 장중 오버레이에서 온다"
    assert stocks["999999"].missing_reason == "no_intraday_price"


def test_basis_day_row_is_never_read_on_today_path(tmp_path, monkeypatch):
    """basis 당일 행이 **터무니없는 값**이어도 응답이 안 바뀐다.

    당일 경로가 `basis_row` 를 읽지 않는다는 전제의 직접 확인이다. 축소된 행 집합에는
    basis 당일 행이 아예 없으므로, 이 단언이 깨지면 전제가 무너진 것이다.
    """
    common = [(c, _d(1), 100.0) for c in ("005930", "000660", "068270")]
    _seed(tmp_path, [*common, *[(c, BASIS_D, 9_999_999.0) for c in ("005930", "000660", "068270")]])
    fast, oracle = _both(tmp_path, {"005930": 110, "000660": 110, "068270": 110}, monkeypatch)
    assert fast.model_dump() == oracle.model_dump()
    stocks = {s.code: s for g in fast.sectors for s in g.stocks}
    assert stocks["005930"].close == 110.0
    assert stocks["005930"].previous_close == 100.0
    assert stocks["005930"].change_pct == 10.0


def test_missing_and_zero_previous_close(tmp_path, monkeypatch):
    """직전 행 부재 · 직전 종가 0 — 둘 다 `no_previous_close` 로 같은 답."""
    _seed(tmp_path, [
        ("005930", _d(1), 0.0),          # 직전 종가 0
        ("000660", BASIS_D, 500.0),      # basis 당일만 있고 직전 행 없음
        ("068270", _d(2), 40.0),
        ("068270", _d(1), 44.0),
    ])
    fast, oracle = _both(tmp_path, {"005930": 10, "000660": 20, "068270": 48}, monkeypatch)
    assert fast.model_dump() == oracle.model_dump()
    stocks = {s.code: s for g in fast.sectors for s in g.stocks}
    assert stocks["005930"].missing_reason == "no_previous_close"
    assert stocks["000660"].missing_reason == "no_previous_close"
    assert stocks["068270"].previous_close == 44.0


def test_past_date_path_still_uses_full_history(tmp_path, monkeypatch):
    """과거 날짜(오버레이 없음)는 **종전 경로 그대로** — 폴백이 넓은 집합을 쓴다.

    `_latest_available_basis` 폴백은 basis 가 아닌 **다른 날짜**로 재계산하므로 1행으로는
    성립하지 않는다. 축소 helper 가 이 경로로 새면 폴백이 조용히 죽는다.
    """
    calls: list[str] = []
    orig_wide = rankings._load_daily_rows
    monkeypatch.setattr(
        rankings, "_load_daily_rows",
        lambda *a, **k: (calls.append("wide"), orig_wide(*a, **k))[1],
    )
    monkeypatch.setattr(
        rankings, "_load_prev_rows",
        lambda *a, **k: (calls.append("narrow"), {})[1],
    )
    # basis 에는 바가 없고 그 전날에만 있다 → 폴백이 발동해야 한다.
    _seed(tmp_path, [(c, _d(1), 100.0) for c in ("005930", "000660", "068270")])
    res = build_index_sector_rankings(tmp_path, BASIS)      # intraday_prices=None
    assert calls == ["wide"], "과거 경로는 넓은 집합만 읽어야 한다"
    # 폴백이 살아 있는지: 전부 no_basis_bar 로 죽지 않고 실제 값이 나온다.
    assert res.source == "daily_adjusted"
    stocks = [s for g in res.sectors for s in g.stocks]
    assert any(s.close == 100.0 for s in stocks), "폴백 basis(_d(1))로 재계산돼야 한다"


def test_today_path_reads_one_row_per_code(tmp_path, monkeypatch):
    """축소가 실제로 일어나는지 — 행 수를 직접 센다(성능 계약의 유일한 결정적 증거)."""
    rows = [(c, _d(i), 100.0 + i) for c in ("005930", "000660", "068270") for i in range(1, 40)]
    _seed(tmp_path, rows)
    seen: dict[str, int] = {}
    orig = rankings._load_prev_rows

    def _counting(path, codes, basis):
        out = orig(path, codes, basis)
        seen["rows"] = sum(len(v) for v in out.values())
        seen["codes"] = len(out)
        return out

    monkeypatch.setattr(rankings, "_load_prev_rows", _counting)
    build_index_sector_rankings(tmp_path, BASIS, intraday_prices={"005930": 150})
    assert seen["rows"] == seen["codes"], "코드당 정확히 1행"
    assert seen["rows"] == 3, "코퍼스에 있는 3종목 × 1행 (117행이 아니다)"
