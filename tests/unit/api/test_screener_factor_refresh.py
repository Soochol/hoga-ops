"""factors 갱신 (#1538).

## 막는 방향

1. **정보 손실.** 벤더 수정주가가 기존 세그먼트 경계보다 늦게 시작하면, 덮어쓰는 순간
   그 경계를 **영구히** 잃는다(벤더가 더는 못 준다). 그 경우 건드리지 않아야 한다.
2. **세그먼트 중복.** 갱신은 concat 이 아니라 **교체**다. 두 벌이 쌓이면 backward asof 가
   조용히 틀린 척도를 집는다.
3. **거짓 성공 보고.** 덮어썼는데 계단이 그대로면 고친 것이 아니다 — `unresolved` 로 나와야 한다.
4. **조용한 파괴적 실행 · 비싼 리허설.** `dry_run` 이 기본이고, 그 리허설은 **벤더를 안 부른다**.

## 못 보는 것

- 「정지 후 재개」와 「주식수 변경」의 구분은 **직전 봉 간격**이라는 대리 지표다. 정지가
  주말만큼 짧으면 못 가른다. 그쪽으로 틀리면 불필요한 벤더 호출 하나이고, 계산 결과가
  기존과 같으면 세그먼트도 안 바뀐다 — 안전한 방향의 오류다.
- 벤더 수정주가 자체가 틀렸는지는 판정하지 않는다. 그건 `unresolved` 로 드러날 뿐이다.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api import screener_factors
from hoga.api.screener_factor_refresh import (
    find_unexplained_steps,
    refresh_factors,
)

_DAILY_SCHEMA = {
    "code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
    "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64,
}
_SINCE = dt.date(2026, 1, 1)


def _daily(rows: list[tuple[str, dt.date, float]]) -> pl.DataFrame:
    return pl.DataFrame(
        {"code": [r[0] for r in rows], "date": [r[1] for r in rows],
         "open": [r[2] for r in rows], "high": [r[2] for r in rows],
         "low": [r[2] for r in rows], "close": [r[2] for r in rows],
         "volume": [1] * len(rows)},
        schema=_DAILY_SCHEMA,
    )


def _factors(rows: list[tuple[str, dt.date, float]]) -> pl.DataFrame:
    return pl.DataFrame(
        {"code": [r[0] for r in rows], "seg_start": [r[1] for r in rows],
         "factor": [r[2] for r in rows]},
        schema=screener_factors.FACTOR_SCHEMA,
    )


def _seed(sdir: Path, daily: pl.DataFrame, factors: pl.DataFrame | None) -> None:
    sdir.mkdir(parents=True, exist_ok=True)
    daily.write_parquet(sdir / "daily_unadjusted.parquet")
    if factors is not None:
        screener_factors.write_factors(factors, sdir / "factors.parquet")


# ── 판정 (벤더 없음) ──────────────────────────────────────────────────────────


def test_step_without_a_segment_is_reported() -> None:
    d = _daily([
        ("A", dt.date(2026, 8, 20), 1000.0),
        ("A", dt.date(2026, 8, 21), 5000.0),   # ×5 — 시세로 불가능
    ])
    got = find_unexplained_steps(d, _factors([]), since=_SINCE)
    assert [(s.code, s.date) for s in got] == [("A", dt.date(2026, 8, 21))]


def test_step_with_a_segment_is_not_reported() -> None:
    """계수가 이미 그 날짜를 설명하면 대상이 아니다 — 그래야 후보가 4,330 으로 안 불어난다."""
    d = _daily([
        ("A", dt.date(2026, 8, 20), 1000.0),
        ("A", dt.date(2026, 8, 21), 5000.0),
    ])
    got = find_unexplained_steps(d, _factors([("A", dt.date(2026, 8, 21), 1.0)]), since=_SINCE)
    assert got == []


def test_halt_resumption_is_excluded_by_the_gap_rule() -> None:
    """**이 파일의 핵심 판별식.** 재개일 기준가는 주식수 변경이 아니다.

    간격만 다르고 나머지가 같은 두 입력을 나란히 둔다 — 그래야 이 테스트가
    「간격 축」을 재는 것이 분명해진다.
    """
    cont = _daily([("A", dt.date(2026, 8, 20), 1000.0), ("A", dt.date(2026, 8, 21), 5000.0)])
    halted = _daily([("A", dt.date(2026, 7, 20), 1000.0), ("A", dt.date(2026, 8, 21), 5000.0)])
    assert len(find_unexplained_steps(cont, None, since=_SINCE)) == 1
    assert find_unexplained_steps(halted, None, since=_SINCE) == [], "정지 후 재개를 대상으로 삼았다"


def test_normal_price_moves_are_not_steps() -> None:
    """±30% 상한 안의 시세는 절대 대상이 아니다 — 오탐이 곧 벤더 호출이다."""
    d = _daily([
        ("A", dt.date(2026, 8, 19), 1000.0),
        ("A", dt.date(2026, 8, 20), 1300.0),   # +30% 상한
        ("A", dt.date(2026, 8, 21), 910.0),    # -30% 하한
    ])
    assert find_unexplained_steps(d, None, since=_SINCE) == []


def test_since_bounds_the_scan() -> None:
    d = _daily([("A", dt.date(2025, 8, 20), 1000.0), ("A", dt.date(2025, 8, 21), 5000.0)])
    assert find_unexplained_steps(d, None, since=dt.date(2026, 1, 1)) == []
    assert len(find_unexplained_steps(d, None, since=dt.date(2025, 1, 1))) == 1


# ── 실행 ──────────────────────────────────────────────────────────────────────


def _split_corpus() -> pl.DataFrame:
    """2026-08-21 에 5:1 병합(가격 ×5). 그 전 구간은 계수 5.0 이 필요하다."""
    return _daily([
        ("A", dt.date(2026, 1, 2), 1000.0),
        ("A", dt.date(2026, 8, 20), 1000.0),
        ("A", dt.date(2026, 8, 21), 5000.0),
    ])


async def _vendor_adjusted_full(_code, _f, _t):
    """벤더 수정주가 — 전 구간을 오늘 척도(병합 후)로 준다."""
    return [(dt.date(2026, 1, 2), 5000.0), (dt.date(2026, 8, 20), 5000.0),
            (dt.date(2026, 8, 21), 5000.0)]


def test_dry_run_reports_candidates_and_calls_no_vendor(tmp_path) -> None:
    """**리허설이 비싸면 아무도 안 돌린다** — dry-run 은 벤더를 부르지 않는다(#1424)."""
    _seed(tmp_path, _split_corpus(), _factors([("A", dt.date(2026, 1, 2), 1.0)]))
    before = (tmp_path / "factors.parquet").read_bytes()
    calls = []

    async def fetch(code, f, t):
        calls.append(code)
        return await _vendor_adjusted_full(code, f, t)

    r = asyncio.run(refresh_factors(tmp_path, fetch_adj=fetch, since=_SINCE))

    assert r.dry_run is True
    assert r.candidates == ["A"] and len(r.steps) == 1
    assert calls == [], "dry-run 이 벤더를 불렀다"
    assert (tmp_path / "factors.parquet").read_bytes() == before
    assert not list(tmp_path.glob("*pre-refresh*"))


def test_refresh_replaces_segments_and_fixes_the_cliff(tmp_path) -> None:
    """**이 파일의 핵심 케이스** — 갱신 후 수정주가에 절벽이 없어야 한다."""
    _seed(tmp_path, _split_corpus(), _factors([("A", dt.date(2026, 1, 2), 1.0)]))

    r = asyncio.run(refresh_factors(
        tmp_path, fetch_adj=_vendor_adjusted_full, since=_SINCE, dry_run=False, stamp="T"))

    assert r.refreshed == ["A"] and r.blocked == [] and r.unresolved == []
    f = screener_factors.read_factors(tmp_path / "factors.parquet").sort("seg_start")
    # 병합 **전** 5.0 · **후** 1.0 — 두 세그먼트가 맞다.
    assert list(zip(f["seg_start"].to_list(), f["factor"].to_list(), strict=True)) == [
        (dt.date(2026, 1, 2), 5.0), (dt.date(2026, 8, 21), 1.0),
    ]
    # 낡은 `(2026-01-02, 1.0)` 이 남아 있으면 교체가 아니라 concat 된 것이다.
    assert f.height == f.unique(subset=["code", "seg_start"]).height, "세그먼트가 두 벌 쌓였다"
    adj = pl.read_parquet(tmp_path / "daily_adjusted.parquet").sort("date")
    assert adj["close"].to_list() == [5000.0, 5000.0, 5000.0], "수정주가에 절벽이 남았다"


def test_snapshots_factors_before_writing(tmp_path) -> None:
    _seed(tmp_path, _split_corpus(), _factors([("A", dt.date(2026, 1, 2), 1.0)]))

    asyncio.run(refresh_factors(
        tmp_path, fetch_adj=_vendor_adjusted_full, since=_SINCE, dry_run=False, stamp="T"))

    snap = tmp_path / "factors.pre-refresh-T.parquet"
    assert snap.exists()
    assert pl.read_parquet(snap)["factor"].to_list() == [1.0], "스냅샷이 갱신 **전** 상태가 아니다"


def test_other_codes_are_left_untouched(tmp_path) -> None:
    daily = pl.concat([_split_corpus(), _daily([
        ("B", dt.date(2026, 8, 20), 100.0), ("B", dt.date(2026, 8, 21), 101.0)])])
    _seed(tmp_path, daily, _factors([
        ("A", dt.date(2026, 1, 2), 1.0), ("B", dt.date(2020, 1, 1), 0.5)]))

    asyncio.run(refresh_factors(
        tmp_path, fetch_adj=_vendor_adjusted_full, since=_SINCE, dry_run=False, stamp="T"))

    f = screener_factors.read_factors(tmp_path / "factors.parquet")
    b = f.filter(pl.col("code") == "B")
    assert b["seg_start"].to_list() == [dt.date(2020, 1, 1)]
    assert b["factor"].to_list() == [0.5], "대상이 아닌 종목의 계수를 건드렸다"


def test_truncated_vendor_history_is_blocked_not_overwritten(tmp_path) -> None:
    """**이 파일에서 가장 비싼 실수를 막는 케이스** — `008500` 이 실제 사례다.

    벤더 수정주가가 2026-08-21 부터인데 기존 세그먼트는 2026-01-02 에 있다. 덮어쓰면
    그 경계를 잃고, 벤더가 더는 줄 수 없으니 되돌릴 수도 없다.
    """
    _seed(tmp_path, _split_corpus(), _factors([("A", dt.date(2026, 1, 2), 0.2)]))

    async def truncated(_code, _f, _t):
        return [(dt.date(2026, 8, 21), 5000.0)]   # 액션 이후만

    r = asyncio.run(refresh_factors(
        tmp_path, fetch_adj=truncated, since=_SINCE, dry_run=False, stamp="T"))

    assert r.refreshed == []
    assert [c for c, _ in r.blocked] == ["A"]
    assert "vendor_adjusted_starts_20260821" in r.blocked[0][1]
    f = screener_factors.read_factors(tmp_path / "factors.parquet")
    assert f["seg_start"].to_list() == [dt.date(2026, 1, 2)], "보류인데 덮어썼다"
    assert f["factor"].to_list() == [0.2]
    assert not list(tmp_path.glob("*pre-refresh*")), "쓸 것이 없으면 스냅샷도 안 남긴다"


def test_no_existing_segments_is_not_blocked_by_short_coverage(tmp_path) -> None:
    """잃을 것이 없으면 통과시킨다 — 최초 구축과 같은 상황이고, 그때의 계약은
    extend-backward 다(ADR-0057). 커버리지가 짧다는 이유만으로 막으면 신규 종목이 막힌다."""
    _seed(tmp_path, _split_corpus(), None)

    async def truncated(_code, _f, _t):
        return [(dt.date(2026, 8, 21), 5000.0)]

    r = asyncio.run(refresh_factors(
        tmp_path, fetch_adj=truncated, since=_SINCE, dry_run=False, stamp="T"))

    assert r.refreshed == ["A"] and r.blocked == []


def test_vendor_that_does_not_reflect_the_action_is_reported_unresolved(tmp_path) -> None:
    """덮어썼는데 계단이 그대로면 **고친 것이 아니다.** 성공으로 세면 리포트가 거짓이 된다."""
    _seed(tmp_path, _split_corpus(), _factors([("A", dt.date(2026, 1, 2), 1.0)]))

    async def flat(_code, _f, _t):   # 수정주가 = 원주가 (액션 미반영)
        return [(dt.date(2026, 1, 2), 1000.0), (dt.date(2026, 8, 20), 1000.0),
                (dt.date(2026, 8, 21), 5000.0)]

    r = asyncio.run(refresh_factors(
        tmp_path, fetch_adj=flat, since=_SINCE, dry_run=False, stamp="T"))

    assert r.refreshed == ["A"]
    assert r.unresolved == ["A"], "계단이 남았는데 해소된 것으로 보고했다"


def test_fetch_failure_is_recorded_and_does_not_stop_the_batch(tmp_path) -> None:
    daily = pl.concat([_split_corpus(), _daily([
        ("B", dt.date(2026, 8, 20), 100.0), ("B", dt.date(2026, 8, 21), 500.0)])])
    _seed(tmp_path, daily, None)

    async def half(code, f, t):
        if code == "A":
            raise RuntimeError("vendor down")
        return [(dt.date(2026, 8, 20), 500.0), (dt.date(2026, 8, 21), 500.0)]

    r = asyncio.run(refresh_factors(
        tmp_path, fetch_adj=half, since=_SINCE, dry_run=False, stamp="T"))

    assert r.failed == ["A"] and r.refreshed == ["B"]


def test_max_codes_truncation_leaves_the_rest_as_candidates(tmp_path) -> None:
    """자른 것이 리포트에 남아야 한다 — 조용한 절단은 「다 훑었다」로 읽힌다."""
    daily = pl.concat([
        _split_corpus(),
        _daily([("B", dt.date(2026, 8, 20), 100.0), ("B", dt.date(2026, 8, 21), 500.0)]),
    ])
    _seed(tmp_path, daily, None)
    calls: list[str] = []

    async def fetch(code, f, t):
        calls.append(code)
        return [(dt.date(2026, 8, 21), 500.0)]

    r = asyncio.run(refresh_factors(
        tmp_path, fetch_adj=fetch, since=_SINCE, dry_run=False, stamp="T", max_codes=1))

    assert r.candidates == ["A"] and calls == ["A"]
    assert len(r.steps) == 2, "잘린 뒤에도 계단 전수는 리포트에 남는다"
