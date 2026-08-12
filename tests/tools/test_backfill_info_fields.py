"""`tools/backfill_info_fields.py` — 재계산 대상 판정과 부작용 없음을 고정한다.

이 도구가 건드리는 건 사용자의 실캡처 디렉터리다. 그래서 여기서 고정하는 두 축은
**무엇을 고치는가**(파생 7키만)와 **무엇을 안 건드리는가**(카운터·mtime)다.
"""
import json
import os
from pathlib import Path

from tools.backfill_info_fields import DERIVED_KEYS, backfill

# 실제 hogaplay 행(대한항공 003490). 고친 매핑의 기대값:
#   today 25700/26450/25100/25800 · 상한 33200 · 하한 17900 · 기준가 25550
RAW_INFO = (
    "1\t003490\t대한항공\t0\t90000000\t153000000\t48854\t83000215\t160000230\t"
    "1956286\t50299\t25700\t26450\t25100\t25800\t33200\t17900\t25550\t25750\t"
    "25900\t25450\t25550"
)

#: 구 매핑이 실제로 써 놓은 값 — `high < low`, `high < open` 인 그 행이다.
BROKEN = {
    "prev_close": 25700, "upper_limit": 26450, "lower_limit": 25100,
    "today_open": 25800, "today_high": 25550, "today_low": 25750,
    "today_close": 25900,
}

CORRECT = {
    "prev_close": 25550, "upper_limit": 33200, "lower_limit": 17900,
    "today_open": 25700, "today_high": 26450, "today_low": 25100,
    "today_close": 25800,
}


def _write_meta(data_dir: Path, *, date="20260519", code="003490", **overrides) -> Path:
    path = data_dir / "parquet" / date / code / "hogaplay" / "meta.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "code": code, "name": "대한항공",
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
        **BROKEN,
        "raw_info_tsv": RAW_INFO,
        "info_unknowns": {"f11": "50299", "f16": "33200"},
        "pages_collected": 3, "total_unique_events": 42,
        "parser_version": "0.1.0", "full_capture_count": 7,
        "gap_ranges": [{"start_ms": 90000000, "end_ms": 90100000}],
    }
    meta.update(overrides)
    path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return path


def test_dry_run_reports_but_does_not_write(tmp_path):
    path = _write_meta(tmp_path)
    before = path.read_text(encoding="utf-8")

    report = backfill(tmp_path, apply=False)

    assert report.scanned == 1
    assert report.changed == 1
    assert path.read_text(encoding="utf-8") == before


def test_apply_rewrites_only_the_derived_keys(tmp_path):
    path = _write_meta(tmp_path)

    report = backfill(tmp_path, apply=True)
    meta = json.loads(path.read_text(encoding="utf-8"))

    assert report.changed == 1
    assert {k: meta[k] for k in DERIVED_KEYS} == CORRECT
    assert meta["parser_version"] == "0.2.0"
    assert meta["info_unknowns"] == {"f11": "50299"}
    # 손대면 안 되는 것들 — 카운터·gap·원문은 그대로여야 한다.
    assert meta["full_capture_count"] == 7
    assert meta["gap_ranges"] == [{"start_ms": 90000000, "end_ms": 90100000}]
    assert meta["raw_info_tsv"] == RAW_INFO
    assert meta["total_unique_events"] == 42


def test_apply_preserves_mtime(tmp_path):
    """`captured_at` 이 디렉터리 파일들의 **최대 mtime** 이라(queries.py) 재작성이
    전 종목의 캡처 시각을 오늘로 밀어 버린다. 그래서 복원한다."""
    path = _write_meta(tmp_path)
    os.utime(path, ns=(1_500_000_000_000_000_000, 1_500_000_000_000_000_000))
    before_ns = path.stat().st_mtime_ns

    backfill(tmp_path, apply=True)

    assert path.stat().st_mtime_ns == before_ns


def test_second_run_is_a_no_op(tmp_path):
    _write_meta(tmp_path)

    backfill(tmp_path, apply=True)
    report = backfill(tmp_path, apply=True)

    assert report.changed == 0
    assert report.unchanged == 1


def test_meta_without_raw_info_tsv_is_skipped_not_failed(tmp_path):
    """venue 롤업·라이브 승격 meta 에는 info 행이 없다 — 결함이 아니다."""
    path = _write_meta(tmp_path)
    meta = json.loads(path.read_text(encoding="utf-8"))
    del meta["raw_info_tsv"]
    path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    report = backfill(tmp_path, apply=True)

    assert report.changed == 0
    assert report.skipped["no-raw_info_tsv"] == 1


def test_truncated_info_row_is_skipped_with_its_own_reason(tmp_path):
    _write_meta(tmp_path, raw_info_tsv="1\t003490\t대한항공")

    report = backfill(tmp_path, apply=True)

    assert report.changed == 0
    assert sum(v for k, v in report.skipped.items() if k.startswith("unparsable:")) == 1


def test_unreadable_meta_is_counted_not_raised(tmp_path):
    path = tmp_path / "parquet" / "20260519" / "003490" / "hogaplay" / "meta.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")

    report = backfill(tmp_path, apply=True)

    assert report.skipped["unreadable"] == 1


def test_missing_parquet_root_is_an_empty_report(tmp_path):
    report = backfill(tmp_path, apply=True)

    assert report.scanned == 0
