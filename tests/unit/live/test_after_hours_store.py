"""시간외 마지막 호가 저장 — 창 밖 조회의 유일한 소스가 되므로 왕복·병합·복원력을 잰다."""
from __future__ import annotations

import json
from pathlib import Path

from hoga.live.after_hours_store import (
    StoredAfterHoursBook,
    load_book,
    save_cycle,
    stored_codes,
)

DAY = "20260827"


def _book(code: str, *, fetched_at_ms: int = 1_787_000_000_000) -> StoredAfterHoursBook:
    return StoredAfterHoursBook(
        code=code,
        ask=((2000, 50), (2010, 60), (2020, 70), (0, 0), (0, 0)),
        bid=((1990, 80), (1980, 90), (0, 0), (0, 0), (0, 0)),
        total_ask_qty=180,
        total_bid_qty=170,
        cur_price=1995,
        close_price=1995,
        acc_volume=12_345,
        base_tm="160000",
        fetched_at_ms=fetched_at_ms,
    )


def test_roundtrip_preserves_every_field(tmp_path: Path) -> None:
    saved = _book("005930")
    save_cycle(tmp_path, DAY, {"005930": saved})
    assert load_book(tmp_path, DAY, "005930") == saved


def test_missing_code_is_none_not_error(tmp_path: Path) -> None:
    save_cycle(tmp_path, DAY, {"005930": _book("005930")})
    assert load_book(tmp_path, DAY, "000660") is None


def test_missing_day_is_none(tmp_path: Path) -> None:
    assert load_book(tmp_path, "20260826", "005930") is None


def test_cycle_merges_instead_of_replacing(tmp_path: Path) -> None:
    """이번 주기에 실패한 종목의 직전 값을 지우지 않는다.

    통째 교체면 마감 캡처 한 번의 실패가 그날 데이터를 날린다 — 마감 캡처야말로
    가장 중요한 한 장이라 그때의 부분 실패에 가장 강해야 한다.
    """
    save_cycle(tmp_path, DAY, {"005930": _book("005930"), "000660": _book("000660")})
    # 다음 주기에 005930 만 성공했다.
    later = _book("005930", fetched_at_ms=1_787_000_600_000)
    save_cycle(tmp_path, DAY, {"005930": later})
    assert load_book(tmp_path, DAY, "005930") == later
    assert load_book(tmp_path, DAY, "000660") is not None
    assert stored_codes(tmp_path, DAY) == ("000660", "005930")


def test_empty_cycle_writes_nothing(tmp_path: Path) -> None:
    save_cycle(tmp_path, DAY, {})
    assert not (tmp_path / "after_hours").exists()


def test_write_is_atomic_no_temp_left_behind(tmp_path: Path) -> None:
    save_cycle(tmp_path, DAY, {"005930": _book("005930")})
    assert list((tmp_path / "after_hours").glob("*.tmp")) == []


def test_corrupt_file_reads_as_empty(tmp_path: Path) -> None:
    """편의 조회용 데이터라 격리·백업을 두지 않는다 — 폴러가 다음 주기에 다시 쓴다."""
    p = tmp_path / "after_hours" / f"{DAY}.json"
    p.parent.mkdir(parents=True)
    p.write_text("{ not json", encoding="utf-8")
    assert load_book(tmp_path, DAY, "005930") is None
    # 그리고 그 위에 정상 저장이 된다(손상이 영구 고장이 아니다).
    save_cycle(tmp_path, DAY, {"005930": _book("005930")})
    assert load_book(tmp_path, DAY, "005930") is not None


def test_unknown_schema_reads_as_empty(tmp_path: Path) -> None:
    p = tmp_path / "after_hours" / f"{DAY}.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"schema": 999, "codes": {"005930": {}}}), encoding="utf-8")
    assert load_book(tmp_path, DAY, "005930") is None


def test_malformed_row_drops_only_that_code(tmp_path: Path) -> None:
    """한 종목의 모양이 깨져도 **파일 전체를 버리지 않는다**."""
    save_cycle(tmp_path, DAY, {"005930": _book("005930")})
    p = tmp_path / "after_hours" / f"{DAY}.json"
    doc = json.loads(p.read_text(encoding="utf-8"))
    doc["codes"]["000660"] = {"ask": "not-a-list"}
    p.write_text(json.dumps(doc), encoding="utf-8")
    assert load_book(tmp_path, DAY, "000660") is None
    assert load_book(tmp_path, DAY, "005930") is not None
