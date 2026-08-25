"""`depth_delta` 사전 산출 배치의 계약.

이 배치가 지켜야 하는 것은 넷이고, 그중 하나(**오늘은 저장되지 않는다**)는 이 모듈이
직접 구현하지 않고 `build_depth_delta_slice` 의 `_indicator_cacheable` 게이트에
맡긴 것이라, 그 위임이 실제로 성립하는지를 값으로 박아 둔다 — 나중에 누가 "빠르게
하려고" 여기서 date 판정을 따로 적으면 그 사본이 곧 드리프트 지점이 된다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api import depth_delta_precompute as ddp
from hoga.api.error_codes import UpstreamCode
from hoga.api.past_indicators_cache import CACHE_MISS


class _FakeCache:
    def __init__(self, hits: set[tuple[str, str]] | None = None) -> None:
        self.hits = hits or set()

    def get_depth_delta(self, code, date, source, bucket_ms, *, venue="KRX"):  # noqa: ANN001
        return [] if (code, date) in self.hits else CACHE_MISS


class _FakeEngine:
    def __init__(self, data_dir: Path, cache: _FakeCache) -> None:
        self.data_dir = data_dir
        self.indicators_cache = cache

    def get_meta(self, date, code, source="hogaplay", *, venue="KRX"):  # noqa: ANN001
        return {}


@pytest.fixture
def wiring(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, int]]:
    """`build_depth_delta_slice` 호출을 기록한다 — 이 배치의 유일한 부작용 지점."""
    calls: list[tuple[str, str, int]] = []

    def _fake_build(engine, *, code, date, bucket_ms, **kw):  # noqa: ANN001, ARG001
        calls.append((code, date, bucket_ms))
        return []

    monkeypatch.setattr(ddp, "build_depth_delta_slice", _fake_build)
    monkeypatch.setattr(ddp, "normalize_session_bounds", lambda m: (m, []))
    monkeypatch.setattr(ddp, "indicator_session_bounds", lambda m: (0, 1))
    return calls


def _stub_enumeration(
    monkeypatch: pytest.MonkeyPatch, *, dates: list[str], codes: list[str],
) -> None:
    monkeypatch.setattr(ddp, "_recent_trading_days", lambda *a, **k: dates)
    monkeypatch.setattr(ddp, "_captured_codes", lambda *a, **k: codes)


def test_computes_missing_pairs_at_one_minute(
    monkeypatch: pytest.MonkeyPatch, wiring: list[tuple[str, str, int]], tmp_path: Path,
) -> None:
    """캐시에 없는 (code, date) 는 **1분 버킷으로** 만든다.

    1분인 것이 핵심이다 — 그 경로만 ladder 가격 집합까지 저장해서 굵은 봉이 파케이를
    다시 안 읽는다(`bundle.py` 의 "1분으로 계산한 김에" 주석).
    """
    _stub_enumeration(monkeypatch, dates=["20260824"], codes=["005930", "010140"])
    engine = _FakeEngine(tmp_path, _FakeCache())

    res = ddp.precompute_depth_delta_1m(engine, today_kst="20260825")  # type: ignore[arg-type]

    assert res.computed == 2
    assert res.already_cached == 0
    assert wiring == [("005930", "20260824", 60_000), ("010140", "20260824", 60_000)]


def test_skips_pairs_already_cached(
    monkeypatch: pytest.MonkeyPatch, wiring: list[tuple[str, str, int]], tmp_path: Path,
) -> None:
    """멱등 — 이미 있는 쌍은 건드리지 않는다. 이것이 마커·재시도 기계를 안 두는 근거다."""
    _stub_enumeration(monkeypatch, dates=["20260824"], codes=["005930", "010140"])
    engine = _FakeEngine(tmp_path, _FakeCache(hits={("005930", "20260824")}))

    res = ddp.precompute_depth_delta_1m(engine, today_kst="20260825")  # type: ignore[arg-type]

    assert res.computed == 1
    assert res.already_cached == 1
    assert wiring == [("010140", "20260824", 60_000)]


def test_cap_defers_the_rest_and_says_so(
    monkeypatch: pytest.MonkeyPatch, wiring: list[tuple[str, str, int]], tmp_path: Path,
) -> None:
    """상한 초과분은 다음 런으로 미루되 **조용히 자르지 않는다**.

    `capped`/`remaining` 이 없으면 로그가 "computed=N" 만 찍고, 그건 "다 했다" 로
    읽힌다 — 이 리포가 이미 겪은 침묵 실패(ADR-0064)와 같은 모양이다.
    """
    _stub_enumeration(monkeypatch, dates=["20260824"], codes=["a", "b", "c", "d"])
    engine = _FakeEngine(tmp_path, _FakeCache())

    res = ddp.precompute_depth_delta_1m(engine, today_kst="20260825", max_pairs=2)  # type: ignore[arg-type]

    assert res.computed == 2
    assert res.capped is True
    assert res.remaining == 2
    assert len(wiring) == 2


def test_failure_of_one_pair_does_not_stop_the_run(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """한 종목의 예외가 나머지를 막지 않는다 — 다음 런이 그 쌍을 다시 집는다."""
    calls: list[str] = []

    def _boom(engine, *, code, date, bucket_ms, **kw):  # noqa: ANN001, ARG001
        calls.append(code)
        if code == "bad":
            raise RuntimeError("parquet unreadable")
        return []

    monkeypatch.setattr(ddp, "build_depth_delta_slice", _boom)
    monkeypatch.setattr(ddp, "normalize_session_bounds", lambda m: (m, []))
    monkeypatch.setattr(ddp, "indicator_session_bounds", lambda m: (0, 1))
    _stub_enumeration(monkeypatch, dates=["20260824"], codes=["bad", "good"])
    engine = _FakeEngine(tmp_path, _FakeCache())

    res = ddp.precompute_depth_delta_1m(engine, today_kst="20260825")  # type: ignore[arg-type]

    assert res.failed == 1
    assert res.computed == 1
    assert calls == ["bad", "good"]


def test_today_is_never_enumerated(monkeypatch: pytest.MonkeyPatch) -> None:
    """**오늘은 대상이 아니다.**

    `_indicator_cacheable` 이 과거일만 저장하므로 오늘을 넘기면 계산만 하고 버려진다
    — 순수 낭비다. 그 게이트를 여기서 복제하지 않는 대신, 열거 단계가 오늘을 배제하는
    것을 값으로 박는다.
    """
    monkeypatch.setattr(ddp, "coverage_end", lambda: "20260825")
    monkeypatch.setattr(
        ddp, "trading_days_in_range",
        lambda start, end: ["20260820", "20260821", "20260824", "20260825"],
    )

    days = ddp._recent_trading_days("20260825", lookback=5)

    assert "20260825" not in days
    assert days == ["20260824", "20260821", "20260820"]  # 최신 → 과거


def test_calendar_coverage_miss_yields_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """달력 커버리지 밖이면 **추측하지 않고 아무것도 안 한다**.

    근사 날짜로 파케이를 스캔하느니 종전처럼 조회 시점에 계산하는 편이 옳다.
    """
    def _raise(start: str, end: str) -> list[str]:
        raise ddp.TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_UNAVAILABLE)

    monkeypatch.setattr(ddp, "coverage_end", lambda: None)
    monkeypatch.setattr(ddp, "trading_days_in_range", _raise)

    assert ddp._recent_trading_days("20260825", lookback=5) == []
