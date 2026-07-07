import polars as pl
from pathlib import Path
from fastapi.testclient import TestClient
from datetime import datetime
from hoga.api.screener_store import last_raw_date, append_rows, write_status, read_status
from hoga.api.screener_store import DailyBar
from hoga.api import screener as _screener_mod


def test_last_date_and_append(tmp_path: Path):
    p = tmp_path / "u.parquet"
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
                  "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
                  pl.col("date").str.to_date()).write_parquet(p)
    assert last_raw_date(p) == "20260513"
    append_rows(p, pl.DataFrame({"code": ["000001"], "date": ["2026-05-14"], "open": [2.0],
        "high": [2.0], "low": [2.0], "close": [2.0], "volume": [2]}).with_columns(
        pl.col("date").str.to_date()))
    assert last_raw_date(p) == "20260514"


def test_append_is_idempotent_on_code_date(tmp_path: Path):
    p = tmp_path / "u.parquet"
    base = pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
                         "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
                         pl.col("date").str.to_date())
    base.write_parquet(p)
    dup = pl.DataFrame({"code": ["000001"], "date": ["2026-05-14"], "open": [2.0], "high": [2.0],
                        "low": [2.0], "close": [2.0], "volume": [2]}).with_columns(
                        pl.col("date").str.to_date())
    append_rows(p, dup)
    append_rows(p, dup)  # 같은 (code,date) 두 번 → 한 행만
    got = pl.read_parquet(p)
    assert got.filter((pl.col("code") == "000001") & (pl.col("date") == pl.date(2026, 5, 14))).height == 1


def test_status_roundtrip(tmp_path: Path):
    sp = tmp_path / "status.json"
    write_status(sp, last_raw_date="20260514", universe_size=2, derive_ms=3, now_ms=100)
    s = read_status(sp)
    assert s.last_raw_date == "20260514" and s.schema_version == 1


def test_status_none_last_raw_date_roundtrips(tmp_path: Path):
    # 빈/NULL-date 아카이브: last_raw_date()=None 을 써도 ValidationError 없이 표현(#13).
    sp = tmp_path / "status.json"
    write_status(sp, last_raw_date=None, universe_size=0, derive_ms=1, now_ms=1)
    s = read_status(sp)
    assert s is not None and s.last_raw_date is None


def test_read_status_quarantines_corrupt(tmp_path: Path):
    # 부분쓰기/수동편집으로 손상된 status.json → 격리 + None(not_seeded), 500 금지(#7).
    sp = tmp_path / "status.json"
    sp.write_text('{"schema_version":1,"last_raw_date"')  # 잘린 JSON
    assert read_status(sp) is None
    assert not sp.exists()                                 # 원본은 rename 격리됨
    assert list(tmp_path.glob("status.json.corrupt-*"))    # 백업 남음


def test_append_rows_atomic_leaves_no_tmp(tmp_path: Path):
    # 원자적 기록: 성공 후 .tmp 잔여물 없음 + 데이터 정상(#6).
    p = tmp_path / "u.parquet"
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
                  "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
                  pl.col("date").str.to_date()).write_parquet(p)
    append_rows(p, pl.DataFrame({"code": ["000002"], "date": ["2026-05-13"], "open": [2.0],
        "high": [2.0], "low": [2.0], "close": [2.0], "volume": [2]}).with_columns(
        pl.col("date").str.to_date()))
    assert pl.read_parquet(p).height == 2
    assert not list(tmp_path.glob("*.tmp"))                # tempfile→os.replace 후 잔여 없음


def test_gap_trading_days_no_gap_short_circuits(monkeypatch):
    # next day after 20260601 (=20260602) > today 20260601 → [] WITHOUT calling the calendar.
    calls = []
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: calls.append((f, t)) or ["x"])
    assert _screener_mod._gap_trading_days("20260601", "20260601") == []
    assert calls == []  # short-circuited, never hit the calendar


def test_gap_trading_days_delegates_when_gap(monkeypatch):
    # next day after 20260529 = 20260530; today 20260601 → delegates to the calendar.
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: [f, t])
    assert _screener_mod._gap_trading_days("20260529", "20260601") == ["20260530", "20260601"]


def test_lifespan_does_not_run_screener_recovery_on_startup(tmp_path: Path, monkeypatch):
    from hoga.api import app as app_mod

    calls = []

    async def fake_trigger_update(data_dir, *, bus=None):
        calls.append(data_dir)
        return 0

    async def async_noop(**_kw):
        return None

    monkeypatch.setattr(app_mod._screener_module, "trigger_update", fake_trigger_update)
    monkeypatch.setattr(app_mod, "start_scheduler", lambda data_dir: [])
    monkeypatch.setattr(app_mod, "start_live_stream", async_noop)
    monkeypatch.setattr(app_mod, "start_live_stream_watchdog", async_noop)
    monkeypatch.setattr(app_mod, "start_today_promoter", async_noop)

    with TestClient(app_mod.create_app(tmp_path)) as client:
        assert client.get("/health").status_code == 200

    assert calls == []


def test_manual_screener_update_still_calls_trigger_update(tmp_path: Path, monkeypatch):
    from fastapi import FastAPI
    from hoga.api import screener as screener_mod

    calls = []

    async def fake_trigger_update(data_dir, *, bus=None):
        calls.append((data_dir, bus))
        return 2

    monkeypatch.setattr(screener_mod, "trigger_update", fake_trigger_update)

    app = FastAPI()
    app.include_router(screener_mod.build_router(data_dir=tmp_path, bus=None))

    with TestClient(app) as client:
        resp = client.post("/api/screener/update")

    assert resp.status_code == 200
    assert resp.json() == {"updated": 2}
    assert calls == [(tmp_path, None)]


async def test_trigger_update_fetches_daily_rows_through_capacity_scheduler(tmp_path: Path, monkeypatch):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame({
        "code": ["005930"],
        "date": ["2026-06-26"],
        "open": [1.0],
        "high": [1.0],
        "low": [1.0],
        "close": [1.0],
        "volume": [1],
    }).with_columns(pl.col("date").str.to_date()).write_parquet(sdir / "daily_unadjusted.parquet")
    pl.DataFrame({"code": ["005930"]}).write_parquet(sdir / "stocks.parquet")

    scheduler = object()
    calls = []

    async def fake_run_update(sdir, *, codes, fetch_one, trading_days, now_ms):
        assert codes == ["005930"]
        assert trading_days == ["20260627"]
        rows = await fetch_one("005930", "20260627", "20260627")
        return len(rows)

    async def fake_run_with_capacity(
        scheduler_arg,
        *,
        data_dir,
        key,
        endpoint,
        priority,
        fetch_fn,
        cooldown_scope=None,
    ):
        calls.append({
            "scheduler": scheduler_arg,
            "data_dir": data_dir,
            "key": key,
            "endpoint": str(endpoint),
            "priority": priority,
            "cooldown_scope": cooldown_scope,
        })
        return await fetch_fn(object())

    async def fake_kis_fetch_one(_client, code, frm, to):
        return [DailyBar(code, datetime(2026, 6, 27).date(), 1.0, 2.0, 1.0, 2.0, 10)]

    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27))
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda _f, _t: ["20260627"])
    monkeypatch.setattr(_screener_mod.screener_store, "run_update", fake_run_update)
    monkeypatch.setattr(_screener_mod.kis_access, "has_rest_capacity", lambda data_dir: True)
    monkeypatch.setattr(_screener_mod, "ensure_kis_capacity_scheduler", lambda data_dir: scheduler)
    monkeypatch.setattr(_screener_mod.kis_access, "run_with_capacity", fake_run_with_capacity)
    monkeypatch.setattr(_screener_mod, "_kis_fetch_one", fake_kis_fetch_one)

    assert await _screener_mod.trigger_update(tmp_path) == 1
    assert calls == [{
        "scheduler": scheduler,
        "data_dir": tmp_path,
        "key": ("screener-update", "005930", "20260627", "20260627"),
        "endpoint": "screener-daily",
        "priority": "background",
        "cooldown_scope": "screener-daily",
    }]
