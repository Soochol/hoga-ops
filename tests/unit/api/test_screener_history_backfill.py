"""스크리너 일봉 앞쪽 갭 백필 (#1424).

## 이 파일이 막는 방향

1. **이중 수정.** 벤더가 주는 것은 수정주가인데 SSOT 는 원주가다. 역-수정을 빠뜨리면
   `derive_adjusted` 가 계수를 한 번 더 곱해 그 종목의 과거가 통째로 어긋난다.
   그래서 가장 중요한 케이스는 **왕복**이다 — 백필 후 `daily_adjusted` 가 벤더 값과
   같아지는가.
2. **조용한 파괴적 실행.** `dry_run` 이 기본이 아니거나 무시되면, 리허설이 곧 실행이
   된다. 대상은 사용자의 129MB 코퍼스다.
3. **계수 없는 종목에 행을 넣는 것.** `apply_factors` 의 전제가 "각 code 는 최소 1개
   세그먼트" 라, 계수 없이 행을 넣으면 그 종목의 수정주가 전체가 휴리스틱 폴백으로
   넘어간다(조용한 값 변경).

## 못 보는 것

- **갭 안의 미기록 액면 이벤트.** `factors.parquet` 은 코퍼스에서 계산되므로 코퍼스가
  없는 구간을 원리적으로 못 본다. 그 경우 재구성된 raw 는 부정확하지만 adjusted 는
  정확하다(모듈 도크스트링의 감수 항목). 여기서 잴 수 있는 성질이 아니다.
- **벤더 응답의 진위.** 주입이라 테스트가 주는 값이 곧 진실이다.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import polars as pl
import pytest

from hoga.api.screener_history_backfill import (
    VendorBar,
    history_backfill,
    oldest_factors,
    plan_targets,
    read_probe,
    unadjust,
)
from hoga.api.screener_store import derive_adjusted

GAP_FROM = dt.date(2024, 1, 2)
CORPUS_START = dt.date(2025, 4, 22)
WINDOW_TO = dt.date(2025, 4, 23)

#: 테스트 달력 — 실제 시드가 아니라 **이 픽스처가 정한 거래일**이다. 달력을 주입하지
#: 않으면 결손 계산이 시드 커버리지에 묶여 테스트가 날짜에 의존한다.
TRADING = {GAP_FROM, GAP_FROM + dt.timedelta(days=1), CORPUS_START, WINDOW_TO}


def _write_corpus(sdir: Path, *, factor: float | None) -> None:
    """코퍼스 시작이 CORPUS_START 인 1종목 + (선택) 계수."""
    sdir.mkdir(parents=True, exist_ok=True)
    rows = [
        {"code": "005930", "date": CORPUS_START, "open": 100.0, "high": 110.0,
         "low": 90.0, "close": 100.0, "volume": 1_000},
        {"code": "005930", "date": CORPUS_START + dt.timedelta(days=1), "open": 101.0,
         "high": 111.0, "low": 91.0, "close": 101.0, "volume": 1_100},
    ]
    pl.DataFrame(rows).write_parquet(sdir / "daily_unadjusted.parquet")
    if factor is not None:
        pl.DataFrame({"code": ["005930"], "seg_start": [CORPUS_START], "factor": [factor]}).write_parquet(
            sdir / "factors.parquet"
        )


def _vendor(*closes: float) -> list[VendorBar]:
    return [
        VendorBar(date=GAP_FROM + dt.timedelta(days=i), open=c, high=c, low=c, close=c, volume=500)
        for i, c in enumerate(closes)
    ]


async def _fetch_ok(_code: str, _frm: str, _to: str) -> list[VendorBar]:
    return _vendor(1_000.0, 1_010.0)


def test_unadjust_is_the_exact_inverse_of_apply_factors() -> None:
    """가격은 ÷factor, **거래량은 ×factor** — 방향이 반대다(거래대금 보존)."""
    [row] = unadjust([VendorBar(date=GAP_FROM, open=10, high=10, low=10, close=10, volume=100)], 5.0)
    assert row["close"] == pytest.approx(2.0)
    assert row["volume"] == 500


def test_unadjust_is_identity_at_factor_one() -> None:
    """대상 477종목 중 422(88.5%)가 이 경로다."""
    [row] = unadjust([VendorBar(date=GAP_FROM, open=7, high=7, low=7, close=7, volume=3)], 1.0)
    assert (row["close"], row["volume"]) == (7.0, 3)


def test_oldest_factor_is_the_one_extend_backward_will_reapply(tmp_path: Path) -> None:
    """세그먼트가 여럿이면 **가장 오래된** 것 — 그것이 갭에 적용될 계수다."""
    pl.DataFrame({
        "code": ["005930", "005930"],
        "seg_start": [dt.date(2025, 4, 22), dt.date(2026, 1, 5)],
        "factor": [5.0, 1.0],
    }).write_parquet(tmp_path / "factors.parquet")
    assert oldest_factors(tmp_path / "factors.parquet")["005930"] == 5.0


def _plan(starts, factors, present, **kw):
    return plan_targets(
        starts, factors, present, TRADING,
        gap_from=GAP_FROM, window_to=WINDOW_TO,
        corpus_start_after=kw.get("after"), codes=kw.get("codes"),
    )


def test_plan_skips_codes_without_factors() -> None:
    """계수 없는 종목에 행을 넣으면 그 종목 수정주가가 휴리스틱 폴백으로 넘어간다."""
    plans = _plan({"005930": CORPUS_START}, {}, {"005930": {CORPUS_START}},
                  after=dt.date(2025, 1, 1))
    assert [p.skipped_reason for p in plans] == ["no_factor"]


def test_plan_skips_when_nothing_is_missing() -> None:
    """재실행 안전 — 달력의 그 창을 이미 다 갖고 있으면 채울 것이 없다."""
    plans = _plan({"005930": GAP_FROM}, {"005930": 1.0}, {"005930": set(TRADING)},
                  codes=["005930"])
    assert [p.skipped_reason for p in plans] == ["no_gap"]


def test_plan_counts_leading_and_interior_separately() -> None:
    """**이번 확장의 핵심** — 코퍼스 안쪽 구멍도 대상이다.

    실측(2026-08-23): 705종목 × 31거래일 = 21,855칸이 코퍼스 **안쪽**에 비어 있었고,
    옛 판정(`[gap_from, corpus_start-1]`)은 그것을 하나도 보지 못했다.
    """
    # 시작일은 GAP_FROM 인데 그 뒤 하루가 비어 있다 = 내부 구멍.
    present = {"005930": {GAP_FROM, CORPUS_START, WINDOW_TO}}
    [plan] = _plan({"005930": GAP_FROM}, {"005930": 1.0}, present, codes=["005930"])
    assert plan.skipped_reason is None
    assert plan.missing_dates == [GAP_FROM + dt.timedelta(days=1)]
    assert (plan.leading, plan.interior) == (0, 1)


def test_plan_ignores_non_trading_days() -> None:
    """달력에 없는 날은 결손이 아니다 — 주말을 벤더에 물으러 가면 안 된다."""
    present = {"005930": set(TRADING)}
    plans = plan_targets(
        {"005930": GAP_FROM}, {"005930": 1.0}, present, TRADING,
        gap_from=GAP_FROM, window_to=WINDOW_TO + dt.timedelta(days=30),
        corpus_start_after=None, codes=["005930"],
    )
    assert [p.skipped_reason for p in plans] == ["no_gap"]


@pytest.mark.anyio
async def test_dry_run_neither_writes_nor_calls_the_vendor(tmp_path: Path) -> None:
    """**dry-run 은 벤더를 부르지 않는다.**

    처음 판은 쓰기만 막고 조회는 그대로 했다 — 실 코퍼스에 돌려 보고서야 드러났다
    (477종목치 유량을 태우고 수 분이 걸린다). 안전 장치가 비용을 만들면 아무도 안
    돌리게 되므로, 리허설은 **달력과 코퍼스만으로** 성립해야 한다. 결정에 필요한
    것은 「무엇이 비었는가」이고 그건 벤더 없이 나온다.
    """
    _write_corpus(tmp_path, factor=1.0)
    before = (tmp_path / "daily_unadjusted.parquet").read_bytes()

    async def _must_not_fetch(_c: str, _f: str, _t: str) -> list[VendorBar]:
        raise AssertionError("dry-run 이 벤더를 불렀다")

    report = await history_backfill(
        tmp_path, fetch_adjusted_daily=_must_not_fetch, gap_from=GAP_FROM, window_to=WINDOW_TO,
        corpus_start_after=dt.date(2025, 1, 1),
    )

    assert report.dry_run is True
    assert report.written_rows == 0
    assert report.plans[0].skipped_reason is None            # 대상으로 잡혔고
    assert report.missing_cells["leading"] > 0               # 무엇이 빈지도 안다
    assert (tmp_path / "daily_unadjusted.parquet").read_bytes() == before   # 파일 무변경


@pytest.mark.anyio
async def test_backfill_round_trips_to_the_vendor_value_in_adjusted_space(tmp_path: Path) -> None:
    """**이 파일의 핵심 케이스.**

    계수 5.0 인 종목에 벤더 수정주가 1,000 을 채운다. 원주가에는 200 이 들어가야 하고
    (÷5), `derive_adjusted` 가 되곱해 다시 1,000 이 나와야 한다. 역-수정을 빠뜨리면
    여기가 5,000 으로 뜬다 — 이중 수정.
    """
    _write_corpus(tmp_path, factor=5.0)

    report = await history_backfill(
        tmp_path, fetch_adjusted_daily=_fetch_ok, gap_from=GAP_FROM, window_to=WINDOW_TO,
        corpus_start_after=dt.date(2025, 1, 1), dry_run=False,
    )
    assert report.written_rows == 2

    raw = pl.read_parquet(tmp_path / "daily_unadjusted.parquet").filter(pl.col("date") == GAP_FROM)
    assert raw["close"][0] == pytest.approx(200.0)

    derive_adjusted(tmp_path / "daily_unadjusted.parquet", tmp_path / "daily_adjusted.parquet",
                    factors_path=tmp_path / "factors.parquet")
    adj = pl.read_parquet(tmp_path / "daily_adjusted.parquet").filter(pl.col("date") == GAP_FROM)
    assert adj["close"][0] == pytest.approx(1_000.0), "왕복이 안 닫혔다 — 이중 수정 의심"


@pytest.mark.anyio
async def test_rows_outside_the_gap_are_dropped(tmp_path: Path) -> None:
    """벤더는 기준일에서 걸어 내려오느라 요청보다 넓게 준다. 그 행은 이미 코퍼스에 있다."""
    _write_corpus(tmp_path, factor=1.0)

    async def _wide(_c: str, _f: str, _t: str) -> list[VendorBar]:
        return [
            VendorBar(date=GAP_FROM, open=1, high=1, low=1, close=1, volume=1),
            VendorBar(date=CORPUS_START, open=2, high=2, low=2, close=2, volume=2),   # 갭 밖
        ]

    report = await history_backfill(
        tmp_path, fetch_adjusted_daily=_wide, gap_from=GAP_FROM, window_to=WINDOW_TO,
        corpus_start_after=dt.date(2025, 1, 1), dry_run=False,
    )
    assert report.written_rows == 1


@pytest.mark.anyio
async def test_one_code_failing_does_not_abort_the_run(tmp_path: Path) -> None:
    """수백 종목 백필에서 한 종목 실패가 전체를 끊으면 재개 비용이 그 종목만이 아니다."""
    _write_corpus(tmp_path, factor=1.0)

    async def _boom(_c: str, _f: str, _t: str) -> list[VendorBar]:
        raise RuntimeError("vendor down")

    report = await history_backfill(
        tmp_path, fetch_adjusted_daily=_boom, gap_from=GAP_FROM, window_to=WINDOW_TO,
        corpus_start_after=dt.date(2025, 1, 1), dry_run=False,
    )
    assert report.written_rows == 0
    assert report.skipped == {"fetch_failed": 1}


# ── #1532: 「없는 날」과 「안 받은 날」을 구별한다 ──────────────────────────────

def test_tail_after_the_last_observed_bar_is_not_a_gap() -> None:
    """폐지·거래정지 종목의 「그 뒤」는 결손이 아니다.

    실측(2026-08-23): `012510` 은 코퍼스가 2026-07-14 에 끝나고 벤더도 0봉을 준다.
    그 뒤 26 거래일을 결손으로 세면 리포트가 부풀고 헛 호출이 나간다.
    """
    d1, d2, d3 = GAP_FROM, GAP_FROM + dt.timedelta(days=1), CORPUS_START
    plans = plan_targets(
        {"005930": d1}, {"005930": 1.0}, {"005930": {d1}}, {d1, d2, d3},
        gap_from=d1, window_to=d3, corpus_start_after=None, codes=["005930"],
    )
    assert [p.skipped_reason for p in plans] == ["no_gap"], "마지막 관측일 이후를 셌다"


def test_probe_none_means_the_vendor_had_nothing(tmp_path: Path) -> None:
    """벤더가 아무것도 안 준 종목은 **앞쪽을 아예 안 센다** — 헛 호출을 두 번 하지 않는다."""
    d1, d2 = GAP_FROM, CORPUS_START
    args = ({"005930": d2}, {"005930": 1.0}, {"005930": {d2}}, {d1, d2})
    kw = dict(gap_from=d1, window_to=d2, corpus_start_after=None, codes=["005930"])

    [before] = plan_targets(*args, **kw)
    assert before.missing_dates == [d1]                     # 모를 때는 후보다

    [after] = plan_targets(*args, **kw, probe={"005930": None})
    assert after.skipped_reason == "no_gap", "프로브를 무시했다"


def test_probe_date_clamps_the_leading_window() -> None:
    """벤더가 가진 가장 이른 봉보다 앞은 안 센다."""
    days = [GAP_FROM + dt.timedelta(days=i) for i in range(4)]
    plans = plan_targets(
        {"005930": days[3]}, {"005930": 1.0}, {"005930": {days[3]}}, set(days),
        gap_from=days[0], window_to=days[3], corpus_start_after=None, codes=["005930"],
        probe={"005930": days[2]},
    )
    assert plans[0].missing_dates == [days[2]], "프로브 이전까지 셌다"


@pytest.mark.anyio
async def test_leading_is_flagged_as_an_upper_bound_until_probed(tmp_path: Path) -> None:
    """숫자만 보고 「이만큼 채운다」로 읽지 못하게 한다."""
    _write_corpus(tmp_path, factor=1.0)

    async def _never(_c: str, _f: str, _t: str) -> list[VendorBar]:
        raise AssertionError("dry-run")

    r = await (history_backfill(
        tmp_path, fetch_adjusted_daily=_never, gap_from=GAP_FROM, window_to=WINDOW_TO,
        corpus_start_after=dt.date(2025, 1, 1),
    ))
    assert r.leading_is_upper_bound is True


@pytest.mark.anyio
async def test_probe_is_persisted_so_the_next_run_is_cheaper(tmp_path: Path) -> None:
    """**이 확장의 요점** — 한 번의 헛 호출이 이후 런을 정확하게 만든다."""
    _write_corpus(tmp_path, factor=1.0)
    calls: list[str] = []

    async def _empty(code: str, _f: str, _t: str) -> list[VendorBar]:
        calls.append(code)
        return []          # 벤더가 그 구간을 아예 안 가졌다

    kw = dict(gap_from=GAP_FROM, window_to=WINDOW_TO, corpus_start_after=dt.date(2025, 1, 1))
    await history_backfill(tmp_path, fetch_adjusted_daily=_empty, dry_run=False, **kw)
    assert calls == ["005930"]
    assert read_probe(tmp_path) == {"005930": None}, "배운 것을 안 적었다"

    await history_backfill(tmp_path, fetch_adjusted_daily=_empty, dry_run=False, **kw)
    assert calls == ["005930"], "두 번째 런이 같은 헛 호출을 반복했다"
