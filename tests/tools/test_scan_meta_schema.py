"""`tools/scan_meta_schema.py` — 합성 디스크로 분류 규칙을 고정한다.

이 스캐너는 **자기가 틀려도 조용하다**(그럴듯한 수를 낸다). 초안이 실제로 그랬다:
`kiwoom_live/meta.json`(venue 롤업)을 Stock-Date meta 로 세서 721건을 "필드 누락"
으로 보고했다. 그래서 여기서 고정하는 건 총계가 아니라 **분류**다.
"""
import json

from tools.scan_meta_schema import (
    is_source_rollup,
    meta_defect,
    predict_api_meta,
    scan,
)

_FULL = {
    "code": "028670", "name": "팬오션",
    "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
    "prev_close": 100, "upper_limit": 130, "lower_limit": 70,
    "today_open": 100, "today_high": 120, "today_low": 90, "today_close": 110,
    "pages_collected": 1, "total_unique_events": 42, "parser_version": "v3",
}


def _write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


# === 결함 판정 ===


def test_full_meta_has_no_defect():
    assert meta_defect(_FULL) is None


def test_missing_field_is_the_reported_reason():
    partial = {k: v for k, v in _FULL.items() if k != "parser_version"}
    assert meta_defect(partial) == "missing:parser_version"


def test_wrong_type_is_reported_separately_from_missing():
    """타입 축을 누락과 안 섞는다 — 원인이 다르면 사유도 달라야 한다."""
    assert meta_defect({**_FULL, "parser_version": 3}) == "type:parser_version"


def test_bool_passes_where_int_is_required():
    """`Meta` 가 bool 을 int 로 받으므로 스캐너도 통과시킨다.

    스캐너가 라우트보다 엄격하면 존재하지 않는 500 을 보고한다.
    """
    assert meta_defect({**_FULL, "pages_collected": True}) is None


def test_non_dict_meta_is_a_defect():
    assert meta_defect([1, 2, 3]) == "not-dict"


# === 롤업 vs Stock-Date meta ===


def test_kiwoom_live_source_level_meta_is_a_rollup(tmp_path):
    """venue 를 여럿 덮는 source 의 `{source}/meta.json` 은 완결성 meta 가 아니다."""
    assert is_source_rollup(tmp_path / "20260806" / "028670" / "kiwoom_live" / "meta.json")


def test_kiwoom_live_venue_level_meta_is_not_a_rollup(tmp_path):
    assert not is_source_rollup(
        tmp_path / "20260806" / "028670" / "kiwoom_live" / "KRX" / "meta.json"
    )


def test_hogaplay_source_level_meta_is_not_a_rollup(tmp_path):
    """hogaplay 는 KRX 하나만 덮어 세그먼트가 없다 — 같은 자리가 **진짜** meta 다."""
    assert not is_source_rollup(tmp_path / "20260806" / "028670" / "hogaplay" / "meta.json")


# === /api/meta 예상 응답 ===


def test_predicts_200_for_complete_hogaplay_meta(tmp_path):
    code_dir = tmp_path / "20260806" / "028670"
    _write(code_dir / "hogaplay" / "meta.json", _FULL)
    assert predict_api_meta(code_dir) == ("200", "ok")


def test_predicts_404_when_only_live_sources_exist(tmp_path):
    """라우트는 hogaplay 고정이라 live 소스만 있으면 **도달 자체를 안 한다**.

    그 meta 가 아무리 결함이어도 500 이 아니다 — 이 줄이 실측의 5,442건이
    위험이 아니었던 이유다.
    """
    code_dir = tmp_path / "20260806" / "028670"
    _write(code_dir / "kiwoom_live" / "KRX" / "meta.json", {"code": "028670"})
    status, _ = predict_api_meta(code_dir)
    assert status == "404"


def test_predicts_500_for_defective_hogaplay_meta(tmp_path):
    code_dir = tmp_path / "20260806" / "028670"
    _write(code_dir / "hogaplay" / "meta.json", {k: v for k, v in _FULL.items() if k != "name"})
    assert predict_api_meta(code_dir) == ("500", "missing:name")


def test_legacy_flat_layout_is_read_when_hogaplay_absent(tmp_path):
    code_dir = tmp_path / "20260806" / "028670"
    _write(code_dir / "meta.json", _FULL)
    assert predict_api_meta(code_dir) == ("200", "ok")


# === 전체 스캔 ===


def test_scan_separates_schema_defects_from_reachable_500s(tmp_path):
    """실측이 만든 그 모양 — **결함은 있는데 도달 가능한 500 은 0** 이다."""
    code_dir = tmp_path / "parquet" / "20260806" / "028670"
    _write(code_dir / "hogaplay" / "meta.json", _FULL)                    # 온전한 hogaplay
    _write(code_dir / "kiwoom_live" / "KRX" / "meta.json", {"code": "x"})  # 결함이지만 미도달
    _write(code_dir / "kiwoom_live" / "meta.json", {"expected_venues": ["KRX"]})  # 롤업

    report = scan(tmp_path)

    assert report.rollups_skipped == 1
    assert report.scanned == 2
    assert sum(report.defects_by_reason.values()) == 1
    assert report.defects_by_source == {"kiwoom_live/KRX": 1}
    assert report.reachable == {"200": 1}          # 도달 가능한 500 없음
    assert report.five_hundred_examples == []


def test_scan_returns_empty_report_when_no_parquet_root(tmp_path):
    report = scan(tmp_path)
    assert report.scanned == 0
    assert report.reachable == {}
