"""Tests for three-source display-priority resolution."""
from __future__ import annotations

from pathlib import Path
from typing import get_args
from unittest.mock import MagicMock

import pytest

from hoga.api.disk_state import DiskState
from hoga.api.sources import (
    SourceName,
    ordered_sources,
    resolve_candle_source,
    resolve_source,
    resolve_source_result,
)


def _make_engine(tmp_path: Path) -> MagicMock:
    engine = MagicMock()
    engine.data_dir = tmp_path
    return engine


def _seed_source(tmp_path: Path, date: str, code: str, source: str) -> None:
    sd = tmp_path / "parquet" / date / code / source
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text('{"collection_complete": true, "is_partial": false}')


def _seed_invalid_source(tmp_path: Path, date: str, code: str, source: str) -> None:
    sd = tmp_path / "parquet" / date / code / source
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text("{")


def test_source_name_literal_includes_all_sources() -> None:
    # kiwoom_live 추가(ADR-0116) — kis_live 인접 실시간 WS 티어.
    assert set(get_args(SourceName)) == {"hogaplay", "kis_live", "kiwoom_live", "kis_api"}


@pytest.mark.parametrize(
    ("policy", "expected"),
    [
        ("hogaplay", ("hogaplay", "kis_live", "kiwoom_live", "kis_api")),
        ("hogaplay_first", ("hogaplay", "kis_live", "kiwoom_live", "kis_api")),
        ("kis_live", ("kis_live", "kiwoom_live", "kis_api", "hogaplay")),
        ("kis_ws_first", ("kis_live", "kiwoom_live", "kis_api", "hogaplay")),
        ("kiwoom_live", ("kiwoom_live", "kis_live", "kis_api", "hogaplay")),
        ("kiwoom_ws_first", ("kiwoom_live", "kis_live", "kis_api", "hogaplay")),
        ("kis_api", ("kis_api", "kis_live", "kiwoom_live", "hogaplay")),
        ("kis_api_first", ("kis_api", "kis_live", "kiwoom_live", "hogaplay")),
    ],
)
def test_ordered_sources_maps_legacy_and_policy_names(policy, expected) -> None:
    assert ordered_sources(policy) == expected


def test_resolve_source_uses_ordered_policy(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")
    _seed_source(tmp_path, "20260622", "005930", "kis_live")
    _seed_source(tmp_path, "20260622", "005930", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "hogaplay_first") == "hogaplay"
    assert resolve_source(engine, "20260622", "005930", "kis_ws_first") == "kis_live"
    assert resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"


def test_resolve_source_honors_kiwoom_live(tmp_path: Path) -> None:
    # 히트맵 종목: 키움 WS 승격본만 존재(종목 소유권 단일). hogaplay_first 정책에서도
    # hogaplay/kis_live 부재 시 kiwoom_live로 해석돼야 한다(ADR-0116).
    _seed_source(tmp_path, "20260716", "005930", "kiwoom_live")
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260716", "005930", "hogaplay_first")
    assert result.source == "kiwoom_live"
    assert result.path == tmp_path / "parquet" / "20260716" / "005930" / "kiwoom_live"
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE
    # kiwoom_ws_first 정책은 명시적으로 kiwoom_live를 최우선.
    assert resolve_source(engine, "20260716", "005930", "kiwoom_ws_first") == "kiwoom_live"


def test_resolve_source_falls_back_to_second_source(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "hogaplay_first") == "kis_api"


def test_resolve_source_result_carries_path_and_classification(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "kis_api")
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "hogaplay_first")

    assert result.source == "kis_api"
    assert result.path == tmp_path / "parquet" / "20260622" / "005930" / "kis_api"
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE
    assert result.missing_reason is None


def test_resolve_source_result_skips_invalid_preferred_source(tmp_path: Path) -> None:
    _seed_invalid_source(tmp_path, "20260622", "005930", "hogaplay")
    _seed_source(tmp_path, "20260622", "005930", "kis_api")
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "hogaplay_first")

    assert result.source == "kis_api"
    assert result.path == tmp_path / "parquet" / "20260622" / "005930" / "kis_api"
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE


def test_resolve_source_returns_first_policy_source_when_none_exist(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "kis_api_first") == "kis_api"


def test_resolve_source_result_reports_missing_stock_date(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "kis_api_first")

    assert result.source == "kis_api"
    assert result.path is None
    assert result.classification is None
    assert result.missing_reason == "stock_date_missing"


def test_resolve_source_result_preserves_legacy_flat_layout(tmp_path: Path) -> None:
    sd = tmp_path / "parquet" / "20260622" / "005930"
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text('{"collection_complete": true, "is_partial": false}')
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "kis_api_first")

    assert result.source == "kis_api"
    assert result.path == sd
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE


@pytest.mark.parametrize("bad", ["", "kis_ws", "HOGAPLAY"])
def test_ordered_sources_rejects_unknown_policy(bad: str) -> None:
    with pytest.raises(ValueError, match="unknown source policy"):
        ordered_sources(bad)


# --- 캔들 차원 사다리 (ADR-0121) ------------------------------------------
#
# 회귀 배경: 호가 승자와 캔들 승자를 한 사다리로 정하면, 캔들을 보유하지 않는
# 실시간 WS 승격본(kis_live/kiwoom_live)이 이겼을 때 같은 Stock-Date의 실제
# 캔들(hogaplay 또는 ADR-0109 복구본)이 통째로 가려진다. /study 저장뷰의
# 마지막 날 분봉이 사라지던 원인.


def _seed_candles(tmp_path: Path, date: str, code: str, source: str) -> None:
    """이미 seed된 Source에 candles.parquet 존재를 표식(내용은 무관 — 존재만 본다)."""
    (tmp_path / "parquet" / date / code / source / "candles.parquet").write_bytes(b"")


def test_resolve_candle_source_skips_candle_less_realtime_winner(tmp_path: Path) -> None:
    """kiwoom_live가 호가로 이겨도 캔들은 복구본(kis_api)에서 온다."""
    _seed_invalid_source(tmp_path, "20260720", "042660", "hogaplay")
    _seed_candles(tmp_path, "20260720", "042660", "hogaplay")
    _seed_source(tmp_path, "20260720", "042660", "kiwoom_live")   # 캔들 미보유 티어
    _seed_source(tmp_path, "20260720", "042660", "kis_api")
    _seed_candles(tmp_path, "20260720", "042660", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260720", "042660", "hogaplay_first") == "kiwoom_live"
    assert resolve_candle_source(engine, "20260720", "042660", "hogaplay_first") == "kis_api"


def test_resolve_candle_source_prefers_healthy_hogaplay(tmp_path: Path) -> None:
    """정상일 회귀 가드 — 호가·캔들 승자가 모두 hogaplay."""
    _seed_source(tmp_path, "20260716", "042660", "hogaplay")
    _seed_candles(tmp_path, "20260716", "042660", "hogaplay")
    _seed_source(tmp_path, "20260716", "042660", "kiwoom_live")
    _seed_source(tmp_path, "20260716", "042660", "kis_api")
    _seed_candles(tmp_path, "20260716", "042660", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260716", "042660", "hogaplay_first") == "hogaplay"


def test_resolve_candle_source_skips_healthy_source_without_candle_file(tmp_path: Path) -> None:
    """캔들 없이 끝난 hogaplay 캡처가 healthy로 남아도 복구본을 가리지 않는다."""
    _seed_source(tmp_path, "20260611", "009540", "hogaplay")       # candles.parquet 없음
    _seed_source(tmp_path, "20260611", "009540", "kis_api")
    _seed_candles(tmp_path, "20260611", "009540", "kis_api")
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260611", "009540", "hogaplay_first") == "kis_api"


def test_resolve_candle_source_none_when_no_candle_bearing_source(tmp_path: Path) -> None:
    """복구 전 상태는 정직하게 '캔들 없음' — 복구 대상 판정의 근거가 된다."""
    _seed_invalid_source(tmp_path, "20260527", "009830", "hogaplay")
    _seed_candles(tmp_path, "20260527", "009830", "hogaplay")
    _seed_source(tmp_path, "20260527", "009830", "kis_live")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260527", "009830", "hogaplay_first") == "kis_live"
    assert resolve_candle_source(engine, "20260527", "009830", "hogaplay_first") is None


def test_resolve_candle_source_none_for_missing_stock_date(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260720", "999999", "hogaplay_first") is None
