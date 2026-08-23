"""ETN `Q` 접두 중복 정리 (#1424 부수 발견).

## 막는 방향

1. **데이터 손실.** 이 도구는 사용자 코퍼스에서 **행을 지운다**. 지워도 되는 근거는
   부류마다 다르다 — `duplicate` 는 같은 종목이 정규 코드로 남아서, `orphan` 은 지울
   것이 애초에 없어서. 근거가 없는 코드를 지우면 그 종목의 이력이 사라진다.
2. **전제가 깨졌는데 계속 진행하는 것.** `orphan` 은 "코퍼스 행이 0" 이 전제다. 행이
   있으면 `blocked` 로 보고하고 **건드리지 않아야** 한다.
3. **조용한 파괴적 실행.** `dry_run` 이 기본이 아니거나 무시되면 리허설이 곧 실행이다.

## 못 보는 것

- 정리 **이후**에 `Q` 형이 다시 생기는가. 로스터가 갱신되는 경로는
  `merge_roster_from_master`(추가만, 마스터는 이미 정규화) 하나뿐이라 재발 경로가 없지만,
  그건 이 파일이 아니라 그 함수의 계약이다.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import polars as pl
import pytest

from hoga.api.screener_q_code_dedup import classify, dedup_q_codes

_ROSTER_SCHEMA = {
    "code": pl.Utf8, "name": pl.Utf8, "market": pl.Utf8,
    "is_etf": pl.Boolean, "is_halted": pl.Boolean,
}
_DAILY_SCHEMA = {
    "code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
    "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64,
}


def _seed(
    sdir: Path, roster: list[str], corpus: list[str],
    *, rows: list[tuple[str, dt.date, float]] | None = None,
) -> None:
    sdir.mkdir(parents=True, exist_ok=True)
    # `rows` 는 **코퍼스 전용**이다 — 로스터는 항상 `roster` 인자가 정한다.
    pl.DataFrame(
        {"code": roster, "name": ["n"] * len(roster), "market": ["KOSPI"] * len(roster),
         "is_etf": [False] * len(roster), "is_halted": [False] * len(roster)},
        schema=_ROSTER_SCHEMA,
    ).write_parquet(sdir / "stocks.parquet")
    body = rows if rows is not None else [(c, dt.date(2026, 6, 1), 1.0) for c in corpus]
    pl.DataFrame(
        {"code": [r[0] for r in body], "date": [r[1] for r in body],
         "open": [r[2] for r in body], "high": [r[2] for r in body], "low": [r[2] for r in body],
         "close": [r[2] for r in body], "volume": [1] * len(body)},
        schema=_DAILY_SCHEMA,
    ).write_parquet(sdir / "daily_unadjusted.parquet")


def test_classify_splits_duplicate_from_orphan() -> None:
    r = classify(
        roster_codes={"Q500023", "500023", "Q500099", "005930"},
        corpus_codes={"Q500023", "500023"},
    )
    assert r.duplicates == ["Q500023"]   # 정규 코드가 로스터에 있다
    assert r.orphans == ["Q500099"]      # 쌍도 없고 코퍼스 행도 없다
    assert r.blocked == []


def test_orphan_with_corpus_rows_is_blocked_not_deleted() -> None:
    """전제("행이 0")가 깨지면 **멈춘다**. 이 도구는 그 상황을 모른다."""
    r = classify(roster_codes={"Q500099"}, corpus_codes={"Q500099"})
    assert r.orphans == []
    assert r.blocked == ["Q500099"]
    assert r.removable == []


def test_plain_codes_are_never_touched() -> None:
    r = classify(roster_codes={"005930", "069500"}, corpus_codes={"005930"})
    assert r.removable == []


def test_dry_run_reports_counts_and_writes_nothing(tmp_path: Path) -> None:
    _seed(tmp_path, roster=["Q500023", "500023", "005930"], corpus=["Q500023", "500023"])
    before_roster = (tmp_path / "stocks.parquet").read_bytes()
    before_corpus = (tmp_path / "daily_unadjusted.parquet").read_bytes()

    r = dedup_q_codes(tmp_path)

    assert r.dry_run is True
    assert r.duplicates == ["Q500023"]
    assert (r.roster_rows_removed, r.corpus_rows_removed) == (1, 1)   # 통계는 정확하다
    assert (tmp_path / "stocks.parquet").read_bytes() == before_roster
    assert (tmp_path / "daily_unadjusted.parquet").read_bytes() == before_corpus
    assert not list(tmp_path.glob("*pre-qdedup*"))                    # 스냅샷도 안 남긴다


def test_removes_duplicates_and_keeps_the_canonical_code(tmp_path: Path) -> None:
    """**이 파일의 핵심 케이스** — 지운 뒤에도 그 종목이 정규 코드로 남아야 한다."""
    _seed(tmp_path, roster=["Q500023", "500023", "005930"], corpus=["Q500023", "500023", "005930"])

    r = dedup_q_codes(tmp_path, dry_run=False, stamp="T")

    assert (r.roster_rows_removed, r.corpus_rows_removed) == (1, 1)
    roster = set(pl.read_parquet(tmp_path / "stocks.parquet")["code"].to_list())
    corpus = set(pl.read_parquet(tmp_path / "daily_unadjusted.parquet")["code"].to_list())
    assert roster == {"500023", "005930"}
    assert corpus == {"500023", "005930"}, "정규 코드까지 지웠다 — 데이터 손실"
    # 수정주가는 원주가에서 재생성된다(직접 건드리지 않는다).
    assert set(pl.read_parquet(tmp_path / "daily_adjusted.parquet")["code"].to_list()) == corpus


def test_snapshots_before_writing(tmp_path: Path) -> None:
    """코퍼스 변경마다 스냅샷을 남기는 이 리포의 관례(`*.prebackfill.parquet` 등)."""
    _seed(tmp_path, roster=["Q500023", "500023"], corpus=["Q500023", "500023"])

    dedup_q_codes(tmp_path, dry_run=False, stamp="T")

    assert (tmp_path / "stocks.pre-qdedup-T.parquet").exists()
    assert (tmp_path / "daily_unadjusted.pre-qdedup-T.parquet").exists()
    # 스냅샷은 **지우기 전** 상태여야 한다.
    snap = pl.read_parquet(tmp_path / "daily_unadjusted.pre-qdedup-T.parquet")
    assert "Q500023" in set(snap["code"].to_list())


def test_no_q_codes_is_a_no_op(tmp_path: Path) -> None:
    _seed(tmp_path, roster=["005930"], corpus=["005930"])
    before = (tmp_path / "stocks.parquet").read_bytes()

    r = dedup_q_codes(tmp_path, dry_run=False)

    assert r.removable == []
    assert (tmp_path / "stocks.parquet").read_bytes() == before
    assert not list(tmp_path.glob("*pre-qdedup*")), "지울 것이 없으면 스냅샷도 안 남긴다"


@pytest.mark.parametrize("code", ["Q", "Q500023"])
def test_bare_q_is_not_treated_as_a_prefix(code: str) -> None:
    """`"Q"` 한 글자는 접두가 아니다 — 벗기면 빈 문자열이라 판정이 성립하지 않는다."""
    r = classify(roster_codes={code}, corpus_codes=set())
    assert r.removable == ([] if code == "Q" else ["Q500023"])


def test_q_only_dates_are_migrated_not_dropped(tmp_path: Path) -> None:
    """**이 파일의 핵심 케이스 — 순진한 삭제가 구멍을 낸다.**

    실측(2026-08-23)에서 321종목이 `Q` 형에만 2026-08-03 봉을 갖고 있었다. 그대로
    지웠으면 그 계열에 하루짜리 구멍이 생긴다. 겹치는 날짜만 버리고 `Q` 전용 날짜는
    **코드를 정규 형으로 고쳐 남겨야** 한다.
    """
    d1, d2 = dt.date(2026, 6, 1), dt.date(2026, 8, 3)
    _seed(
        tmp_path, roster=["Q500023", "500023"], corpus=[],
        rows=[
            ("500023", d1, 10.0),      # 정규 — 겹치는 날
            ("Q500023", d1, 10.0),     # 중복(값 동일) → 버린다
            ("Q500023", d2, 11.0),     # Q 에만 있는 날 → 이관한다
        ],
    )

    r = dedup_q_codes(tmp_path, dry_run=False, stamp="T")

    assert (r.corpus_rows_removed, r.corpus_rows_migrated) == (1, 1)
    assert r.value_conflicts == 0
    out = pl.read_parquet(tmp_path / "daily_unadjusted.parquet")
    assert set(out["code"].to_list()) == {"500023"}, "Q 형이 남았다"
    got = {(row["date"], row["close"]) for row in out.iter_rows(named=True)}
    assert got == {(d1, 10.0), (d2, 11.0)}, "Q 전용 날짜가 사라졌다 — 구멍"


def test_value_conflicts_are_counted_not_hidden(tmp_path: Path) -> None:
    """겹치는데 값이 다르면 「같은 종목의 두 사본」 전제가 깨진 것 — 세어서 보고한다."""
    d1 = dt.date(2026, 6, 1)
    _seed(
        tmp_path, roster=["Q500023", "500023"], corpus=[],
        rows=[("500023", d1, 10.0), ("Q500023", d1, 99.0)],
    )

    r = dedup_q_codes(tmp_path)      # dry-run 에서도 보여야 한다

    assert r.value_conflicts == 1
    assert r.corpus_rows_removed == 1


def test_status_is_refreshed_when_now_ms_is_given(tmp_path: Path) -> None:
    """파생 통계(`universe_size`)를 낡은 채 두지 않는다.

    실행 후 상태 파일이 정리 **전** 종목 수를 들고 있으면, 다음 일일 갱신까지 「아는데
    틀린 값」이 남는다. 화면에 안 나오더라도 파생 통계의 stale 은 이 리포가 반복해서
    물린 실패 유형이다(#1424 조사에서 `prebackfill` 이름이 그랬듯).
    """
    import json
    _seed(tmp_path, roster=["Q500023", "500023", "005930"], corpus=["Q500023", "500023", "005930"])

    dedup_q_codes(tmp_path, dry_run=False, stamp="T", now_ms=1)

    status = json.loads((tmp_path / "status.json").read_text())
    assert status["universe_size"] == 2, "정리 전 종목 수가 남았다"


def test_status_is_left_alone_without_now_ms(tmp_path: Path) -> None:
    """`now_ms` 없이는 상태 파일을 만들지 않는다 — 시각을 지어내지 않는다."""
    _seed(tmp_path, roster=["Q500023", "500023"], corpus=["Q500023", "500023"])

    dedup_q_codes(tmp_path, dry_run=False, stamp="T")

    assert not (tmp_path / "status.json").exists()
