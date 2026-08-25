"""`QueryEngine.earliest_stock_date` — 디스크 모드 좌팬의 **바닥**.

이 값이 없어서 사용자가 캡처 시작 이전으로 무한히 팬했고, 그 구간엔 데이터가 영원히
없어 빈 화면 + 「과거 불러오는 중」이 계속 떴다(2026-08-26, 028050: 캡처 20260106 인데
창이 20251117 까지).

`resolve_source_result` 는 `classify_stock_date` 로 meta.json 을 읽으므로 실트리
픽스처가 무겁다 — **source 해석만 모의**해서 이 메서드의 고유 로직(순회 순서 · 첫
매치 조기 종료 · 비거래일 제외 · venue 축)을 겨냥한다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api import queries as q
from hoga.api.queries import QueryEngine


def _tree(root: Path, dates: list[str], code: str) -> None:
    for d in dates:
        (root / "parquet" / d / code).mkdir(parents=True)


class _Resolved:
    """`resolve_source_result` 의 반환 중 이 메서드가 보는 것은 `.path` 뿐이다."""

    def __init__(self, path: Path | None) -> None:
        self.path = path


@pytest.fixture
def seen(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """해석이 실제로 닿은 날짜들 — **조기 종료**를 값으로 재기 위한 기록."""
    hit: list[str] = []

    def _fake(engine, date, code, pref, venue="KRX"):  # noqa: ANN001, ANN202, ARG001
        hit.append(date)
        return _Resolved(Path("/x"))

    monkeypatch.setattr(q, "resolve_source_result", _fake)
    return hit


def test_returns_the_oldest_captured_date(tmp_path: Path, seen: list[str]) -> None:
    _tree(tmp_path, ["20260304", "20260106", "20260203"], "028050")
    engine = QueryEngine(tmp_path)
    try:
        assert engine.earliest_stock_date(code="028050") == "20260106"
    finally:
        engine.close()


def test_stops_at_the_first_match(tmp_path: Path, seen: list[str]) -> None:
    """**조기 종료가 계약이다.** `/api/range` 가 워크백에서 타일마다 부르므로,
    전 범위를 훑으면 그 자체가 이 PR 이 고치려던 지연을 되살린다."""
    _tree(tmp_path, ["20260106", "20260203", "20260304"], "028050")
    engine = QueryEngine(tmp_path)
    try:
        engine.earliest_stock_date(code="028050")
    finally:
        engine.close()
    assert seen == ["20260106"]  # 뒤 두 날짜는 해석조차 안 한다


def test_none_when_the_code_was_never_captured(tmp_path: Path, seen: list[str]) -> None:
    """모르는 것을 바닥이라 말하지 않는다 — 프론트가 이 null 을 "하한 없음" 으로 읽는다."""
    _tree(tmp_path, ["20260106", "20260203"], "005930")
    engine = QueryEngine(tmp_path)
    try:
        assert engine.earliest_stock_date(code="028050") is None
    finally:
        engine.close()
    assert seen == []  # 코드 디렉터리가 없으면 해석 자체를 안 한다(싼 경로)


def test_none_when_there_is_no_parquet_tree(tmp_path: Path, seen: list[str]) -> None:
    """새 머신·빈 워크트리에서 조용히 None."""
    engine = QueryEngine(tmp_path)
    try:
        assert engine.earliest_stock_date(code="028050") is None
    finally:
        engine.close()


def test_skips_non_trading_day_partitions(tmp_path: Path, seen: list[str]) -> None:
    """유령 파티션(주말)이 바닥을 과거로 끌어내리면 안 된다.

    `list_stock_dates_in_range` 와 같은 방어다 — 비거래일 파티션이 만들어지는 경로가
    실제로 있었고(REST 호가 캡처), 그게 바닥이 되면 데이터 없는 구간이 다시 열린다.
    """
    _tree(tmp_path, ["20260103", "20260106"], "028050")  # 20260103 = 토요일
    engine = QueryEngine(tmp_path)
    try:
        assert engine.earliest_stock_date(code="028050") == "20260106"
    finally:
        engine.close()


def test_venue_is_passed_through(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """캡처 트리가 venue 별이라 NXT/UN 시작일이 KRX 와 다를 수 있다 — 하나로 뭉치면
    그 창에서 **틀린 바닥**이 된다."""
    got: list[str] = []

    def _fake(engine, date, code, pref, venue="KRX"):  # noqa: ANN001, ANN202, ARG001
        got.append(venue)
        return _Resolved(Path("/x"))

    monkeypatch.setattr(q, "resolve_source_result", _fake)
    _tree(tmp_path, ["20260106"], "028050")
    engine = QueryEngine(tmp_path)
    try:
        engine.earliest_stock_date(code="028050", venue="NXT")
    finally:
        engine.close()
    assert got == ["NXT"]
