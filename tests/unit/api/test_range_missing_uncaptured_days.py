"""거래일인데 캡처가 **아예 없는** 날을 `missing_dates` 로 표면화한다.

종전에는 `list_stock_dates_in_range` 가 parquet 디렉터리를 스캔해 만든 목록만 루프를
돌았으므로, 캡처가 없는 날은 후보 단계에서 사라졌다 — `bundle.py` 의 사유 기록 경로에
**도달조차 못 했다**. 그래서 응답은 `missing_dates: []` 였고 프론트는 그날이 왜 없는지
말할 방법이 없었다(006800/20251218 조사, 2026-08-16).

사유를 둘로 가르는 이유는 **사용자가 할 수 있는 일이 다르기** 때문이다:
  * `no_upstream_data` — hogaplay 가 그날을 못 준다(ADR-0021 센티넬). 영구. 할 일 없음.
  * `not_captured`     — 아직 캡처하지 않았다. 캡처하면 채워진다.

날짜 판정은 `is_trading_day` 가 **확정 True** 인 날만 본다. 커버리지 밖(None)·휴장(False)을
결손으로 보고하면 "모른다" 가 "데이터 없음" 으로 승격되어, 시드 경계 뒤가 통째로 결손처럼
보인다.
"""
import json
from pathlib import Path

_META = json.dumps({
    "collection_complete": True,
    "is_partial": False,
    "regular_session_open_ms": 90000000,
    "regular_session_close_ms": 153000000,
})


def _captured_day(data_dir: Path, date: str, code: str) -> None:
    """그 (날짜, 종목)을 hogaplay 캡처 완료 상태로 만든다."""
    d = data_dir / "parquet" / date / code / "hogaplay"
    d.mkdir(parents=True)
    (d / "meta.json").write_text(_META)


def _sentinel_day(data_dir: Path, date: str, code: str) -> None:
    """ADR-0021 센티넬만 남은 상태 — 업스트림이 그날을 못 줬다."""
    raw = data_dir / "raw" / date / code
    raw.mkdir(parents=True)
    (raw / ".no_upstream_data").touch()


def test_sentinel_day_is_reported_as_no_upstream_data(tmp_path: Path) -> None:
    """`.no_upstream_data` 센티넬이 있는 거래일은 그 사유로 실린다.

    20251218 은 커밋된 거래일 시드에 있는 실제 거래일이라 monkeypatch 가 필요 없다.
    """
    from hoga.api.bundle import uncaptured_trading_days

    _sentinel_day(tmp_path, "20251218", "006800")

    out = uncaptured_trading_days(
        data_dir=tmp_path,
        code="006800",
        from_date="20251217",
        to_date="20251219",
        captured={"20251217", "20251219"},
        today="20260816",
    )

    assert [(m.date, m.reason) for m in out] == [("20251218", "no_upstream_data")]


def test_uncaptured_day_without_sentinel_is_not_captured(tmp_path: Path) -> None:
    """센티넬이 없으면 `not_captured` — 캡처하면 채워지는 상태다.

    사유가 갈리는 것이 요점이다. 둘을 한 값으로 뭉치면 "캡처 한 번이면 되는 날" 과
    "영원히 불가능한 날" 이 화면에서 다시 같아진다.
    """
    from hoga.api.bundle import uncaptured_trading_days

    out = uncaptured_trading_days(
        data_dir=tmp_path,
        code="006800",
        from_date="20251217",
        to_date="20251219",
        captured={"20251217"},
        today="20260816",
    )

    assert [(m.date, m.reason) for m in out] == [
        ("20251218", "not_captured"),
        ("20251219", "not_captured"),
    ]


def test_today_is_never_reported_missing(tmp_path: Path) -> None:
    """오늘은 결손이 아니다 — 아직 캡처될 기회가 오지 않았을 뿐이다.

    `/live` 는 항상 `to=today` 로 range 를 요청하므로, 이 게이트가 없으면 장중 내내
    **매일** 유령 결손이 하나씩 실린다.
    """
    from hoga.api.bundle import uncaptured_trading_days

    out = uncaptured_trading_days(
        data_dir=tmp_path,
        code="006800",
        from_date="20251217",
        to_date="20251219",
        captured={"20251217"},
        today="20251219",
    )

    assert [m.date for m in out] == ["20251218"]


def test_weekends_are_not_missing_data(tmp_path: Path) -> None:
    """주말은 결손이 아니다 — 12/20(토)·12/21(일)은 실리지 않는다."""
    from hoga.api.bundle import uncaptured_trading_days

    out = uncaptured_trading_days(
        data_dir=tmp_path,
        code="006800",
        from_date="20251219",
        to_date="20251222",
        captured=set(),
        today="20260816",
    )

    assert [m.date for m in out] == ["20251219", "20251222"]


def test_dates_beyond_calendar_coverage_are_not_reported(tmp_path: Path) -> None:
    """달력이 **모르는**(None) 날짜는 결손으로 보고하지 않는다.

    `is_trading_day` 는 커버리지 끝을 넘으면 None 을 준다 — "아직 안 열린 날일 수도,
    휴장일 수도" 있기 때문이다(calendar.py `_beyond_coverage`). 그 모름을 결손으로
    승격시키면 시드 경계 뒤 구간이 통째로 "데이터 없음" 으로 뜬다.

    data_dir 을 tmp_path 로 고정해 오버레이를 비우면, 커버리지는 커밋된 시드 끝
    (20260803)까지다.
    """
    from hoga.api import calendar as cal
    from hoga.api.bundle import uncaptured_trading_days

    cal.set_data_dir(tmp_path)
    cal.reset_cache_for_tests()
    try:
        assert cal.coverage_end() == "20260803", "시드 끝이 바뀌면 이 테스트의 전제를 갱신할 것"
        # 20260805(수)는 커버리지 밖 = 모름. 20260803(월)은 커버리지 안의 거래일.
        out = uncaptured_trading_days(
            data_dir=tmp_path,
            code="006800",
            from_date="20260803",
            to_date="20260805",
            captured=set(),
            today="20260816",
        )
        assert [m.date for m in out] == ["20260803"]
    finally:
        cal.set_data_dir(None)
        cal.reset_cache_for_tests()


def test_range_bundle_surfaces_the_gap_between_captured_days(tmp_path: Path) -> None:
    """12/17·12/19 는 캡처됐고 12/18 은 업스트림에 없다 → 그 사유가 응답에 실린다.

    실제 006800 사례의 축소판. 종전에는 `list_stock_dates_in_range` 가 12/18 을
    후보 목록에서 지워, 응답의 `missing_dates` 가 **빈 배열**이었다.
    """
    from hoga.api.bundle import build_range_bundle
    from hoga.api.queries import QueryEngine

    _captured_day(tmp_path, "20251217", "006800")
    _captured_day(tmp_path, "20251219", "006800")
    _sentinel_day(tmp_path, "20251218", "006800")

    engine = QueryEngine(tmp_path)
    try:
        rb = build_range_bundle(
            engine, code="006800", from_date="20251217", to_date="20251219",
            bucket_ms=60_000, mode="candles",
        )
    finally:
        engine.close()

    assert [(m.date, m.reason) for m in rb.missing_dates] == [
        ("20251218", "no_upstream_data"),
    ]


def test_single_missing_day_request_still_reports_the_reason(tmp_path: Path) -> None:
    """구간 전체가 결손이어도 사유가 실린다 — **빈 번들 분기**를 타는 경로다.

    `dates` 가 비면 `build_range_bundle` 은 루프 전에 `_empty_range_bundle` 로 빠진다.
    사유 계산을 루프 안에 두면 이 경로가 통째로 우회되는데, 하필 "그날 하나만 조회" 가
    사용자가 원인을 가장 알고 싶어 하는 요청이다.
    """
    from hoga.api.bundle import build_range_bundle
    from hoga.api.queries import QueryEngine

    _sentinel_day(tmp_path, "20251218", "006800")

    engine = QueryEngine(tmp_path)
    try:
        rb = build_range_bundle(
            engine, code="006800", from_date="20251218", to_date="20251218",
            bucket_ms=60_000, mode="candles",
        )
    finally:
        engine.close()

    assert rb.segments == []
    assert [(m.date, m.reason) for m in rb.missing_dates] == [
        ("20251218", "no_upstream_data"),
    ]


def test_every_produced_reason_is_a_declared_literal() -> None:
    """생산되는 사유 6개가 전부 모델을 통과한다 — 계약의 정방향."""
    from hoga.api.models import MissingDate

    for reason in (
        "venue_unsupported", "source_missing", "stock_date_missing",
        "meta_unreadable", "no_upstream_data", "not_captured",
    ):
        assert MissingDate(date="20251218", reason=reason).reason == reason


def test_undeclared_reason_is_rejected() -> None:
    """선언되지 않은 사유는 거부된다 — 계약의 역방향(red-check).

    `reason: str` 이던 시절엔 아무 문자열이나 실려 나갔고, 실제로 `meta_unreadable`
    이 `sources.MissingReason` 밖에서 조용히 생산되고 있었다. 좁혀 두면 새 사유를
    만드는 사람이 **프론트 미러를 같이 고치도록** 강제된다(ADR-0004).
    """
    import pytest
    from pydantic import ValidationError

    from hoga.api.models import MissingDate

    with pytest.raises(ValidationError):
        MissingDate(date="20251218", reason="totally_bogus_reason")
