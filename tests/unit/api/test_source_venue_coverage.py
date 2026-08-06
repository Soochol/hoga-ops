"""source 가 **어느 venue 를 덮는가** — 사다리 자격의 축 (ADR-0140).

⚠ 실측된 결함이다. `SOURCE_HAS_VENUE: dict[SourceName, bool]` 이 두 가지를 하나로
뭉갰다 — *"venue 축이 없다"* 와 *"아무 venue 에나 유효하다"*.

hogaplay 는 전자가 아니라 **KRX 정규장 전용**인데 `False` 가 후자로 읽혔다. 사다리
1순위라 NXT 를 요청해도 이기고 **KRX 데이터를 NXT 라고 돌려줬다** — 실측 2026-08-05,
최근 6일 720건 중 **494건(69%)** 이 세 venue 에 같은 파일을 줬다(같은 94,526행).

빈 응답은 정직하다. 다른 시장 데이터를 그 시장 것처럼 주는 건 **조용히 틀린 답**이고,
같은 조작이 날짜에 따라 두 동작(빈 화면 / KRX 데이터)을 해서 사용자가 규칙을 세울 수 없었다.
"""
import json

import pytest

from hoga.api.queries import QueryEngine
from hoga.api.sources import (
    SOURCE_VENUES,
    VenueNotCoveredError,
    resolve_candle_source,
    resolve_source_result,
    source_covers_venue,
    source_venue_dir,
)

_COMPLETE = {"collection_complete": True, "is_partial": False}


def _seed(sd, source, venue=None, *, candles=False):
    d = sd / source / venue if venue else sd / source
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(_COMPLETE))
    if candles:
        (d / "candles.parquet").write_bytes(b"")


@pytest.fixture
def eng(tmp_path):
    e = QueryEngine(tmp_path)
    yield e
    e.close()


# ── 커버리지 선언 ────────────────────────────────────────────────────────────

def test_krx_only_sources_do_not_cover_nxt():
    """hogaplay 는 KRX 전용이다 — 축이 없는 게 아니라 그 시장만 준다.

    `kis_live`(계층 삭제)·`kis_api`(2026-08-07 제거)는 소스 유니온에 없지만, 모르는
    이름은 보수적으로 KRX 전용이라 같은 결과가 나온다 — 그 폴백까지 함께 고정한다.
    """
    for source in ("hogaplay", "kis_live", "kis_api"):
        assert source_covers_venue(source, "KRX")
        assert not source_covers_venue(source, "NXT")
        assert not source_covers_venue(source, "UN")


def test_kiwoom_live_covers_all_three():
    assert SOURCE_VENUES["kiwoom_live"] == frozenset({"KRX", "NXT", "UN"})


def test_unknown_source_is_conservatively_krx_only():
    assert source_covers_venue("???", "KRX")
    assert not source_covers_venue("???", "NXT")


def test_directory_axis_follows_coverage(tmp_path):
    """원소가 하나면 평면, 둘 이상이면 venue 세그먼트 — 한 값에서 나온다."""
    assert source_venue_dir(tmp_path, "hogaplay", "KRX") == tmp_path / "hogaplay"
    assert (source_venue_dir(tmp_path, "kiwoom_live", "NXT")
            == tmp_path / "kiwoom_live" / "NXT")


def test_uncovered_combination_raises_instead_of_returning_krx(tmp_path):
    """⚠ 회귀 가드 — 커버리지 밖 조합은 **조용한 KRX 경로**였다(실측 2026-08-07).

    `hogaplay` 는 venue 를 하나만 덮어 세그먼트가 안 붙는다. 그 규칙이 "NXT 를 물으면
    KRX 경로를 준다" 로 새고 있었다 — 경로가 실제로 존재하므로 호출부는 성공한 줄 안다.

    빈 결과가 아니라 예외인 이유: 데이터 부재가 아니라 **호출부의 venue 필터 누락**이다.
    삼키면 다시 조용해진다.
    """
    for venue in ("NXT", "UN"):
        with pytest.raises(VenueNotCoveredError):
            source_venue_dir(tmp_path, "hogaplay", venue)
        with pytest.raises(VenueNotCoveredError):
            source_venue_dir(tmp_path, "kis_api", venue)  # 모르는 이름 → KRX 전용 폴백
    # 모르는 source 는 보수적으로 KRX 전용 — 같은 규칙이 적용된다.
    with pytest.raises(VenueNotCoveredError):
        source_venue_dir(tmp_path, "???", "NXT")


# ── 사다리 필터 ──────────────────────────────────────────────────────────────

def test_krx_only_winner_is_not_served_for_nxt(tmp_path, eng):
    """⚠ 회귀 가드 — 이게 그 결함이다. hogaplay 가 NXT 요청을 이기면 안 된다.

    사유가 `source_missing` 인 것이 맞다: hogaplay 는 후보에서 빠졌고, NXT 를 덮는
    `kiwoom_live` 는 사다리에 남았는데 **그날 디스크에 없다**. 두 사유는 다른 사실을
    말한다 —

    - `venue_unsupported` — 사다리에 그 venue 를 덮는 source 가 **아예 없다**
    - `source_missing` — 덮는 source 는 있는데 **그날 데이터가 없다**
    """
    sd = tmp_path / "parquet" / "20260804" / "000660"
    _seed(sd, "hogaplay")

    krx = resolve_source_result(eng, "20260804", "000660", "hogaplay_first", "KRX")
    nxt = resolve_source_result(eng, "20260804", "000660", "hogaplay_first", "NXT")

    assert (krx.source, krx.path) == ("hogaplay", sd / "hogaplay")
    assert nxt.source != "hogaplay"   # KRX 전용 소스가 이기지 않는다 — 요점
    assert nxt.path is None
    assert nxt.missing_reason == "source_missing"


def test_nxt_falls_through_to_a_covering_source(tmp_path, eng):
    """hogaplay 가 빠지면 사다리의 다음 후보 중 **그 venue 를 덮는** 것이 이긴다."""
    sd = tmp_path / "parquet" / "20260804" / "000660"
    _seed(sd, "hogaplay")
    _seed(sd, "kiwoom_live", "KRX")

    nxt = resolve_source_result(eng, "20260804", "000660", "hogaplay_first", "NXT")

    # 소스는 정직하게 kiwoom_live 다. 경로는 아직 없는 NXT 디렉터리라 하류가
    # 빈 200 으로 낸다 — "없음" 이지 "KRX 데이터" 가 아니다.
    assert nxt.source == "kiwoom_live"
    assert nxt.path == sd / "kiwoom_live" / "NXT"
    assert not nxt.path.exists()


def test_legacy_flat_layout_is_krx_only(tmp_path, eng):
    """평면 레이아웃은 venue 축 이전 데이터라 정의상 KRX — 뒷문으로 새면 안 된다."""
    sd = tmp_path / "parquet" / "20260622" / "005930"
    sd.mkdir(parents=True)
    (sd / "meta.json").write_text(json.dumps(_COMPLETE))

    assert resolve_source_result(eng, "20260622", "005930", "hogaplay_first", "KRX").path == sd
    nxt = resolve_source_result(eng, "20260622", "005930", "hogaplay_first", "NXT")
    assert nxt.path is None
    assert nxt.missing_reason == "venue_unsupported"


# ── 캔들 사다리 ──────────────────────────────────────────────────────────────

def test_candle_ladder_applies_the_same_filter(tmp_path, eng):
    """`CANDLE_BEARING_SOURCES`(캔들을 갖나)와 커버리지(그 시장을 갖나)를 **둘 다** 본다."""
    sd = tmp_path / "parquet" / "20260804" / "000660"
    _seed(sd, "hogaplay", candles=True)

    assert resolve_candle_source(eng, "20260804", "000660", "hogaplay_first", "KRX") == "hogaplay"
    assert resolve_candle_source(eng, "20260804", "000660", "hogaplay_first", "NXT") is None


def test_candle_ladder_serves_a_covering_source_for_nxt(tmp_path, eng):
    sd = tmp_path / "parquet" / "20260804" / "000660"
    _seed(sd, "hogaplay", candles=True)
    _seed(sd, "kiwoom_live", "NXT", candles=True)

    assert resolve_candle_source(eng, "20260804", "000660", "hogaplay_first", "KRX") == "hogaplay"
    assert resolve_candle_source(eng, "20260804", "000660", "hogaplay_first", "NXT") == "kiwoom_live"


def test_krx_path_is_unchanged_by_the_filter(tmp_path, eng):
    """KRX 요청은 모든 source 가 후보라 **동작이 그대로**여야 한다(회귀 없음)."""
    sd = tmp_path / "parquet" / "20260804" / "000660"
    _seed(sd, "hogaplay", candles=True)

    assert resolve_candle_source(eng, "20260804", "000660", "hogaplay_first", "KRX") == "hogaplay"
