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
    source_venue_dir,
)


def _make_engine(tmp_path: Path) -> MagicMock:
    engine = MagicMock()
    engine.data_dir = tmp_path
    return engine


def _seed_source(tmp_path: Path, date: str, code: str, source: str) -> None:
    sd = source_venue_dir(tmp_path / "parquet" / date / code, source, "KRX")
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text('{"collection_complete": true, "is_partial": false}')


def _seed_invalid_source(tmp_path: Path, date: str, code: str, source: str) -> None:
    sd = source_venue_dir(tmp_path / "parquet" / date / code, source, "KRX")
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text("{")


def test_source_name_literal_includes_all_sources() -> None:
    # KIS WS 계층 삭제(ADR-0118) 후 실시간 소스는 키움 하나이고, 캔들 복구본
    # 네임스페이스(`kis_api`)도 제거됐다(2026-08-07 — 근거는 sources.SourceName 주석).
    assert set(get_args(SourceName)) == {"hogaplay", "kiwoom_live"}


# 소스 선호 옵션 폐지(2026-08-07) — 어떤 정책 문자열이 와도 **같은 사다리**다.
# 구 정책 키를 그대로 넣는 것이 요점이다: 저장된 설정(`chart.sourcePreference.v1`)이나
# 구 URL 이 도착해도 예외 없이 새 사다리로 수렴해야 한다(사용자 화면이 깨지지 않는다).
@pytest.mark.parametrize("policy", [
    "hogaplay", "hogaplay_first", "kis_ws_first", "kiwoom_live",
    "kiwoom_ws_first", "kis_api", "kis_api_first", "completeness_first",
    "", "kis_ws", "HOGAPLAY", "모르는정책",
])
def test_every_policy_string_maps_to_the_single_ladder(policy) -> None:
    assert ordered_sources(policy) == ("kiwoom_live", "hogaplay")


def test_resolve_source_uses_ordered_policy(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")
    _seed_source(tmp_path, "20260622", "005930", "kiwoom_live")
    engine = _make_engine(tmp_path)

    # 둘 다 있으면 **항상 kiwoom_live** — 정책 문자열이 승자를 못 바꾼다(옵션 폐지).
    for pref in ("hogaplay_first", "kis_ws_first", "kis_api_first"):
        assert resolve_source(engine, "20260622", "005930", pref) == "kiwoom_live"


def test_resolve_source_honors_kiwoom_live(tmp_path: Path) -> None:
    # 히트맵 종목: 키움 WS 승격본만 존재(종목 소유권 단일). hogaplay_first 정책에서도
    # hogaplay 부재 시 kiwoom_live로 해석돼야 한다(ADR-0116).
    _seed_source(tmp_path, "20260716", "005930", "kiwoom_live")
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260716", "005930", "hogaplay_first")
    assert result.source == "kiwoom_live"
    # venue 세그먼트가 정본이다 — 평면 폴백은 PR-D2 에서 삭제됐다.
    assert result.path == tmp_path / "parquet" / "20260716" / "005930" / "kiwoom_live" / "KRX"
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE
    assert resolve_source(engine, "20260716", "005930", "kiwoom_ws_first") == "kiwoom_live"


def test_resolve_source_falls_back_to_second_source(tmp_path: Path) -> None:
    # 사다리 1순위(kiwoom_live)가 없으면 2순위(hogaplay)가 이긴다.
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "hogaplay_first") == "hogaplay"


def test_resolve_source_result_carries_path_and_classification(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "hogaplay_first")

    assert result.source == "hogaplay"
    assert result.path == tmp_path / "parquet" / "20260622" / "005930" / "hogaplay"
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE
    assert result.missing_reason is None


def test_resolve_source_result_skips_invalid_preferred_source(tmp_path: Path) -> None:
    # 사다리 1순위가 INVALID 면 건너뛴다 — "부패 데이터는 서빙 안 함" 계약.
    _seed_invalid_source(tmp_path, "20260622", "005930", "kiwoom_live")
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "hogaplay_first")

    assert result.source == "hogaplay"
    assert result.path == tmp_path / "parquet" / "20260622" / "005930" / "hogaplay"
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE


def test_resolve_source_returns_first_policy_source_when_none_exist(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "kis_api_first") == "kiwoom_live"


def test_resolve_source_result_reports_missing_stock_date(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "kis_api_first")

    # 사다리 첫 후보를 에코한다 — 정책 문자열과 무관하게 kiwoom_live 다(옵션 폐지).
    assert result.source == "kiwoom_live"
    assert result.path is None
    assert result.classification is None
    assert result.missing_reason == "stock_date_missing"


def test_resolve_source_result_preserves_legacy_flat_layout(tmp_path: Path) -> None:
    sd = tmp_path / "parquet" / "20260622" / "005930"
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text('{"collection_complete": true, "is_partial": false}')
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "kis_api_first")

    assert result.source == "kiwoom_live"
    assert result.path == sd
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE


# --- 캔들 차원 사다리 (ADR-0121) ------------------------------------------
#
# 회귀 배경: 호가 승자와 캔들 승자를 한 사다리로 정하면, 캔들을 보유하지 않는
# 실시간 WS 승격본이 이겼을 때 같은 Stock-Date의 실제
# 캔들(hogaplay 또는 ADR-0109 복구본)이 통째로 가려진다. /study 저장뷰의
# 마지막 날 분봉이 사라지던 원인.


def _seed_candles(tmp_path: Path, date: str, code: str, source: str) -> None:
    """이미 seed된 Source에 candles.parquet 존재를 표식(내용은 무관 — 존재만 본다)."""
    d = source_venue_dir(tmp_path / "parquet" / date / code, source, "KRX")
    d.mkdir(parents=True, exist_ok=True)
    (d / "candles.parquet").write_bytes(b"")


def test_resolve_candle_source_skips_candle_less_realtime_winner(tmp_path: Path) -> None:
    """kiwoom_live 가 호가로 이겨도 캔들 미보유면 캔들은 hogaplay 에서 온다."""
    _seed_source(tmp_path, "20260720", "042660", "kiwoom_live")   # 호가 승자·캔들 미보유
    _seed_source(tmp_path, "20260720", "042660", "hogaplay")
    _seed_candles(tmp_path, "20260720", "042660", "hogaplay")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260720", "042660", "hogaplay_first") == "kiwoom_live"
    assert resolve_candle_source(engine, "20260720", "042660", "hogaplay_first") == "hogaplay"


def test_resolve_candle_source_prefers_healthy_hogaplay(tmp_path: Path) -> None:
    """정상일 회귀 가드 — 호가·캔들 승자가 모두 hogaplay."""
    _seed_source(tmp_path, "20260716", "042660", "hogaplay")
    _seed_candles(tmp_path, "20260716", "042660", "hogaplay")
    _seed_source(tmp_path, "20260716", "042660", "kiwoom_live")
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260716", "042660", "hogaplay_first") == "hogaplay"


def test_resolve_candle_source_skips_healthy_source_without_candle_file(tmp_path: Path) -> None:
    """캔들 없이 끝난 캡처가 healthy 로 남아도 캔들 가진 소스를 가리지 않는다.

    사다리 1순위(kiwoom_live)가 healthy 인데 `candles.parquet` 이 없으면 건너뛰고
    2순위로 간다 — 승자 선정이 **파일 존재**를 본다는 성질이다.
    """
    _seed_source(tmp_path, "20260611", "009540", "kiwoom_live")    # candles.parquet 없음
    _seed_source(tmp_path, "20260611", "009540", "hogaplay")
    _seed_candles(tmp_path, "20260611", "009540", "hogaplay")
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260611", "009540", "hogaplay_first") == "hogaplay"


def test_resolve_candle_source_none_when_no_candle_bearing_source(tmp_path: Path) -> None:
    """복구 전 상태는 정직하게 '캔들 없음' — 복구 대상 판정의 근거가 된다."""
    _seed_invalid_source(tmp_path, "20260527", "009830", "hogaplay")
    _seed_candles(tmp_path, "20260527", "009830", "hogaplay")
    _seed_source(tmp_path, "20260527", "009830", "kiwoom_live")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260527", "009830", "hogaplay_first") == "kiwoom_live"
    assert resolve_candle_source(engine, "20260527", "009830", "hogaplay_first") is None


def test_resolve_candle_source_none_for_missing_stock_date(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260720", "999999", "hogaplay_first") is None


# --- kiwoom_live 캔들 보유 (ADR-0125 — 실시간 WS 틱 합성 1분봉) ----------------
#
# kiwoom_live는 캔들을 절대 안 쓴다는 ADR-0040/0043 불변식이 ADR-0125로 개정돼
# CANDLE_BEARING_SOURCES에 편입됐다. 파일 존재 판정이 캔들 합성 못한 날을 걸러낸다.


def test_kiwoom_live_wins_candle_when_hogaplay_absent(tmp_path: Path) -> None:
    """hogaplay INVALID → 실시간 합성 kiwoom_live 캔들이 서빙된다."""
    _seed_invalid_source(tmp_path, "20260723", "005930", "hogaplay")
    _seed_source(tmp_path, "20260723", "005930", "kiwoom_live")
    _seed_candles(tmp_path, "20260723", "005930", "kiwoom_live")
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260723", "005930", "hogaplay_first") == "kiwoom_live"


def test_kiwoom_candle_wins_over_hogaplay_regardless_of_policy(tmp_path: Path) -> None:
    """캔들도 단일 사다리 — 정책 문자열이 승자를 못 바꾼다(2026-08-07 옵션 폐지).

    **이 성질은 뒤집힌 것이다.** 예전엔 `hogaplay_first` 에서 hogaplay 틱 캔들(고화질)이
    kiwoom_live 합성봉을 이겼다. 캔들만 다른 사다리를 쓰면 같은 화면에서 캔들과 호가가
    서로 다른 업스트림이 되고, venue 를 바꿀 때 그 조합이 또 달라진다 — 옵션을 없앤
    이유가 그대로 캔들에도 적용된다.
    """
    _seed_source(tmp_path, "20260723", "005930", "hogaplay")
    _seed_candles(tmp_path, "20260723", "005930", "hogaplay")
    _seed_source(tmp_path, "20260723", "005930", "kiwoom_live")
    _seed_candles(tmp_path, "20260723", "005930", "kiwoom_live")
    engine = _make_engine(tmp_path)

    for pref in ("hogaplay_first", "kis_ws_first", "completeness_first"):
        assert resolve_candle_source(engine, "20260723", "005930", pref) == "kiwoom_live"


def test_ws_first_prefers_kiwoom_candle_over_hogaplay(tmp_path: Path) -> None:
    """실시간 WS 우선: 캔들도 kiwoom_live 합성봉을 hogaplay보다 앞세운다."""
    _seed_source(tmp_path, "20260723", "005930", "hogaplay")
    _seed_candles(tmp_path, "20260723", "005930", "hogaplay")
    _seed_source(tmp_path, "20260723", "005930", "kiwoom_live")
    _seed_candles(tmp_path, "20260723", "005930", "kiwoom_live")
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260723", "005930", "kis_ws_first") == "kiwoom_live"


def test_kiwoom_live_without_candle_file_skipped(tmp_path: Path) -> None:
    """캔들 합성 못한 kiwoom_live(파일 부재)는 걸러지고 hogaplay 가 이긴다."""
    _seed_source(tmp_path, "20260723", "005930", "kiwoom_live")   # candles.parquet 없음
    _seed_source(tmp_path, "20260723", "005930", "hogaplay")
    _seed_candles(tmp_path, "20260723", "005930", "hogaplay")
    engine = _make_engine(tmp_path)

    assert resolve_candle_source(engine, "20260723", "005930", "hogaplay_first") == "hogaplay"


# --- 완결성 우선 정책 (completeness_first, ADR-0039) ------------------------
#
# 기존 정책은 "사다리 첫 non-INVALID"라 hogaplay가 반쪽(SOURCE_PARTIAL)이어도
# hogaplay_first면 그대로 이긴다. completeness_first는 소스를 완결성 등급으로
# 정렬해 더 완결한 쪽을 고르고, 동급이면 실시간 WS 우선으로 타이브레이크한다.
# 완결성 판정은 재구현하지 않고 classify_from_meta(캡처 게이트와 동일 SSOT)가
# 산출한 per_source 상태를 그대로 소비한다.


def _seed_partial(tmp_path: Path, date: str, code: str, source: str) -> None:
    """SOURCE_PARTIAL — 수집은 끝났으나 갭 존재."""
    sd = source_venue_dir(tmp_path / "parquet" / date / code, source, "KRX")
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text('{"collection_complete": true, "is_partial": true}')


def test_completeness_first_both_complete_prefers_ws(tmp_path: Path) -> None:
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")   # COMPLETE
    _seed_source(tmp_path, "20260622", "005930", "kiwoom_live")   # COMPLETE
    engine = _make_engine(tmp_path)

    # 둘 다 완결 → 동급 → WS-first 타이브레이크로 kiwoom_live.
    assert resolve_source(engine, "20260622", "005930", "completeness_first") == "kiwoom_live"


def test_partial_ws_still_wins_over_complete_hogaplay(tmp_path: Path) -> None:
    """⚠ **의도된 트레이드오프** — 완결성 등급 정렬 폐지(2026-08-07).

    예전엔 완결성이 1차 키라 부분 결손인 kiwoom_live 대신 완결한 hogaplay 를 골랐다.
    그 방식은 KRX 에서만 소스가 갈리고(NXT 는 후보가 하나뿐) **어떤 날은 venue 대칭이고
    어떤 날은 아니게** 만들었다 — 사용자는 그게 언제인지 알 수 없었다.

    잃는 것은 실재한다(실측 2026-08-06: 키움 54분 vs hogaplay 401분인 날). 그래서 자동
    교체 대신 **소스 배지**가 승자와 완결 상태를 보여 준다 — 무엇을 보고 있는지 알리는
    쪽을 택했다.
    """
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")   # COMPLETE
    _seed_partial(tmp_path, "20260622", "005930", "kiwoom_live")  # SOURCE_PARTIAL
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "completeness_first")
    assert result.source == "kiwoom_live"
    assert result.classification is not None
    assert result.classification.state == DiskState.SOURCE_PARTIAL


def test_completeness_first_picks_complete_ws_over_partial_hogaplay(tmp_path: Path) -> None:
    _seed_partial(tmp_path, "20260622", "005930", "hogaplay")  # SOURCE_PARTIAL
    _seed_source(tmp_path, "20260622", "005930", "kiwoom_live")   # COMPLETE
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "completeness_first") == "kiwoom_live"


def test_completeness_first_both_partial_prefers_ws(tmp_path: Path) -> None:
    # 예: hogaplay가 아침을 영구 소실(SOURCE_PARTIAL)하고 WS도 PARTIAL — 동급이면 WS.
    _seed_partial(tmp_path, "20260622", "005930", "hogaplay")
    _seed_partial(tmp_path, "20260622", "005930", "kiwoom_live")
    engine = _make_engine(tmp_path)

    assert resolve_source(engine, "20260622", "005930", "completeness_first") == "kiwoom_live"


def test_completeness_first_excludes_invalid_even_if_more_recent_tier(tmp_path: Path) -> None:
    # WS가 부패(INVALID)면 등급 비교 이전에 제외 — 완결한 hogaplay가 이긴다.
    _seed_source(tmp_path, "20260622", "005930", "hogaplay")        # COMPLETE
    _seed_invalid_source(tmp_path, "20260622", "005930", "kiwoom_live")
    engine = _make_engine(tmp_path)

    result = resolve_source_result(engine, "20260622", "005930", "completeness_first")
    assert result.source == "hogaplay"
    assert result.classification is not None
    assert result.classification.state == DiskState.COMPLETE


# `test_completeness_first_candle_dimension_keeps_hogaplay_first` 는 제거됐다
# (2026-08-07). 검증하던 것이 "캔들 사다리에서 hogaplay 가 kis_api 복구본을 앞선다"
# 인데, 그 복구본 소스가 사라져 비교 대상이 없다. 캔들 승자는 이제
# `test_kiwoom_candle_wins_over_hogaplay_regardless_of_policy` 가 고정한다.


