import datetime as dt

import polars as pl
import pytest

from hoga.api import screener_store
from hoga.api.screener_store import DailyBar


@pytest.mark.asyncio
async def test_run_update_appends_and_derives(tmp_path):
    sd = tmp_path / "screener"; sd.mkdir()
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
        "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sd / "daily_unadjusted.parquet")
    async def fake_fetch(code, frm, to) -> list[DailyBar]:   # async — matches real adapter
        return [DailyBar(code=code, date=dt.date(2026, 5, 14),
                         open=2.0, high=2.0, low=2.0, close=2.0, volume=2)]
    n = await screener_store.run_update(sd, codes=["000001"], fetch_one=fake_fetch,
                                        trading_days=["20260514"], now_ms=100)
    assert n == 1
    assert (sd / "daily_adjusted.parquet").exists()
    assert screener_store.read_status(sd / "status.json").last_raw_date == "20260514"


@pytest.mark.asyncio
async def test_run_update_counts_distinct_appended_dates_not_requested(tmp_path):
    # #9: gap=2 거래일이지만 상류가 1일치만 반환 → 반환값은 실제 추가된 distinct date
    # 수(1), 요청 거래일 수(len(trading_days)=2)로 과대보고하지 않는다.
    sd = tmp_path / "screener"; sd.mkdir()
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
        "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sd / "daily_unadjusted.parquet")
    async def fake_fetch(code, frm, to) -> list[DailyBar]:
        return [DailyBar(code=code, date=dt.date(2026, 5, 14),
                         open=2.0, high=2.0, low=2.0, close=2.0, volume=2)]  # 2일 요청, 1일만 반환
    n = await screener_store.run_update(sd, codes=["000001"], fetch_one=fake_fetch,
                                        trading_days=["20260514", "20260515"], now_ms=100)
    assert n == 1


def test_fetch_concurrency_defaults_to_three(monkeypatch):
    from hoga.api import screener_store

    monkeypatch.delenv("HOGA_SCREENER_FETCH_CONCURRENCY", raising=False)

    assert screener_store.fetch_concurrency_from_env() == 3


def test_fetch_concurrency_accepts_valid_range(monkeypatch):
    from hoga.api import screener_store

    monkeypatch.setenv("HOGA_SCREENER_FETCH_CONCURRENCY", "1")
    assert screener_store.fetch_concurrency_from_env() == 1

    monkeypatch.setenv("HOGA_SCREENER_FETCH_CONCURRENCY", "8")
    assert screener_store.fetch_concurrency_from_env() == 8


def test_fetch_concurrency_falls_back_for_invalid_values(monkeypatch):
    from hoga.api import screener_store

    for value in ["0", "9", "-1", "abc", ""]:
        monkeypatch.setenv("HOGA_SCREENER_FETCH_CONCURRENCY", value)
        assert screener_store.fetch_concurrency_from_env() == 3


# ── 미확정(장전) 스냅샷 방어 — 2026-06-18 사고 ────────────────────────────────
#
# 그날 코퍼스는 3541 종목 **전부** `o=h=l=c`(전일 종가) 에 거래량 0 이었다. 정규장
# 시작 전 스냅샷이 그날 일봉으로 굳은 것이고, 갱신기가 `last_raw_date` 다음날부터만
# 긁으므로 **두 달간(6/18~8/20) 자가치유되지 않았다**.
#
# EOD 컷오프(`_gap_trading_days` 의 16시 규칙)는 **요청 범위**만 좁힌다 — 상류가 미확정
# 봉을 실어 보내면 못 막는다. 그래서 **저장 직전에 응답을 검증**한다.

def _bars(date: dt.date, n: int, *, zero: int) -> list[DailyBar]:
    """`n` 종목 중 `zero` 개가 거래량 0 인 하루치."""
    return [
        DailyBar(code=f"{i:06d}", date=date, open=1.0, high=1.0, low=1.0, close=1.0,
                 volume=0 if i < zero else 100)
        for i in range(n)
    ]


def test_drop_unconfirmed_days_drops_premarket_snapshot():
    # 실측 비율 재현: 3541 중 3164 = 89.4%
    rows = _bars(dt.date(2026, 6, 18), 3541, zero=3164)
    kept, dropped = screener_store.drop_unconfirmed_days(rows)
    assert kept == []
    assert dropped == [dt.date(2026, 6, 18)]


def test_drop_unconfirmed_days_keeps_normal_day():
    """정상일 기저선은 v=0 이 평균 3.4% · 최대 ~7% 다 — 오차단하면 안 된다."""
    rows = _bars(dt.date(2026, 6, 17), 3542, zero=248)   # 7.0%
    kept, dropped = screener_store.drop_unconfirmed_days(rows)
    assert len(kept) == 3542
    assert dropped == []


def test_drop_unconfirmed_days_is_per_date_not_per_batch():
    """멀티데이 캐치업에서 하루가 부실하다고 **정상인 날까지** 버리면 갱신이 멎는다."""
    rows = _bars(dt.date(2026, 6, 17), 100, zero=3) + _bars(dt.date(2026, 6, 18), 100, zero=90)
    kept, dropped = screener_store.drop_unconfirmed_days(rows)
    assert dropped == [dt.date(2026, 6, 18)]
    assert {b.date for b in kept} == {dt.date(2026, 6, 17)}
    assert len(kept) == 100


@pytest.mark.asyncio
async def test_run_update_leaves_dropped_day_as_gap_for_retry(tmp_path):
    """**버린 날짜가 갭으로 남는 것까지가 설계다.**

    저장하지 않으면 `last_raw_date` 가 그 날짜를 넘지 않으므로 다음 갱신이 같은 날을
    자동으로 다시 요청한다 — 별도 재시도 큐가 필요 없다. 반대로 저장해 버리면 6/18 처럼
    영구 고착된다(행이 있으면 갭이 아니므로 다시는 안 긁힌다).
    """
    sd = tmp_path / "screener"; sd.mkdir()
    pl.DataFrame({"code": ["000000"], "date": ["2026-06-17"], "open": [1.0], "high": [1.0],
        "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sd / "daily_unadjusted.parquet")

    async def premarket_fetch(code, frm, to) -> list[DailyBar]:
        # 장전 스냅샷: 전일 종가에 거래량 0
        return [DailyBar(code=code, date=dt.date(2026, 6, 18),
                         open=1.0, high=1.0, low=1.0, close=1.0, volume=0)]

    n = await screener_store.run_update(
        sd, codes=[f"{i:06d}" for i in range(10)], fetch_one=premarket_fetch,
        trading_days=["20260618"], now_ms=100)

    assert n == 0, "부실한 날은 추가된 거래일로 세지 않는다"
    # last_raw_date 가 6/17 에 머물러야 다음 갱신이 6/18 을 갭으로 다시 잡는다.
    assert screener_store.last_raw_date(sd / "daily_unadjusted.parquet") == "20260617"


# ── 종목 fetch 실패 — 배치 전멸 금지 + 부분 커밋 금지 ─────────────────────────
#
# 2026-09-03 사고: `ka10081` 이 종목 하나에 `1700`(유량 초과)을 돌려줬는데
# `asyncio.gather` 에 `return_exceptions` 가 없어 **4,330 종목 배치가 통째로** 죽었다.
# 게다가 gather 는 형제를 취소하지 않아 "실패" 후에도 고아 fetch 가 3분간 계속 돌며
# 같은 유량을 갉아먹었다.
#
# 고치는 방향이 둘로 갈린다는 점이 중요하다. 실패를 **그냥 skip** 하면 배치는 살지만
# 그날이 부분 저장되고, `last_raw_date` 가 그 날짜를 넘어가 빠진 종목이 **영구 구멍**이
# 된다(`drop_unconfirmed_days` 가 봉인한 "한 번 저장되면 영원히 안 고쳐진다"와 같은
# 실패 모드). 그래서 계약은 **1회 재시도 + 그래도 실패면 날짜 통째로 보류**다.

def _seed_one_day(tmp_path):
    """5/13 한 줄이 이미 있는 코퍼스."""
    sd = tmp_path / "screener"; sd.mkdir()
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
        "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sd / "daily_unadjusted.parquet")
    return sd


def _bar(code: str) -> DailyBar:
    return DailyBar(code=code, date=dt.date(2026, 5, 14),
                    open=2.0, high=2.0, low=2.0, close=2.0, volume=2)


@pytest.mark.asyncio
async def test_run_update_retries_a_failed_code_and_commits_every_row(tmp_path):
    """종목 하나가 한 번 실패해도 배치가 죽지 않고 **재시도로 온전히** 커밋된다."""
    sd = _seed_one_day(tmp_path)
    attempts: dict[str, int] = {}

    async def flaky(code, frm, to) -> list[DailyBar]:
        attempts[code] = attempts.get(code, 0) + 1
        if code == "000002" and attempts[code] == 1:
            raise RuntimeError("유량 초과[1700]")
        return [_bar(code)]

    n = await screener_store.run_update(
        sd, codes=["000001", "000002"], fetch_one=flaky,
        trading_days=["20260514"], now_ms=100)

    assert n == 1
    assert attempts["000002"] == 2, "실패한 종목은 1회 재시도해야 한다"
    assert attempts["000001"] == 1, "성공한 종목을 다시 부르면 유량 낭비다"
    saved = pl.read_parquet(sd / "daily_unadjusted.parquet")
    got = set(saved.filter(pl.col("date") == dt.date(2026, 5, 14))["code"].to_list())
    assert got == {"000001", "000002"}, f"재시도분까지 저장돼야 한다 — got {got}"


@pytest.mark.asyncio
async def test_run_update_refuses_partial_commit_when_a_code_keeps_failing(tmp_path):
    """끝까지 실패하는 종목이 있으면 **그날을 통째로 보류**한다(부분 커밋 금지).

    저장하지 않으면 `last_raw_date` 가 그 날짜를 넘지 않으므로 갭으로 남아 다음 갱신이
    자동 재시도한다 — `drop_unconfirmed_days` 와 같은 계약이다.
    """
    sd = _seed_one_day(tmp_path)
    before = pl.read_parquet(sd / "daily_unadjusted.parquet")

    async def one_always_fails(code, frm, to) -> list[DailyBar]:
        if code == "000002":
            raise RuntimeError("유량 초과[1700]")
        return [_bar(code)]

    with pytest.raises(RuntimeError, match="fetch 실패"):
        await screener_store.run_update(
            sd, codes=["000001", "000002"], fetch_one=one_always_fails,
            trading_days=["20260514"], now_ms=100)

    after = pl.read_parquet(sd / "daily_unadjusted.parquet")
    assert after.equals(before), "부분 커밋 금지 — 파케이가 그대로여야 한다"
    assert not (sd / "status.json").exists(), "status 도 전진하면 안 된다"
