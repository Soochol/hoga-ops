import asyncio
from datetime import datetime
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

from hoga.api import screener as _screener_mod
from hoga.api.screener_store import DailyBar, append_rows, last_raw_date, read_status, write_status
from hoga.live import kiwoom_access as _kiwoom_access, kiwoom_rest_runtime as _kiwoom_runtime


async def _fake_page_fetch(_client):
    """페이크가 러너에 넘기는 페이지 팩토리 — 거버너 경로만 지나게 한다."""
    from hoga.live.kiwoom_rest import Page

    return Page(rows=[], cont=False, next_key="")


@pytest.fixture(autouse=True)
def _reset_update_job():
    _screener_mod.reset_update_job_for_tests()
    yield
    _screener_mod.reset_update_job_for_tests()


class _BusStub:
    def __init__(self):
        self.events = []

    def publish(self, evt):
        self.events.append(evt)


def _seed_archive(tmp_path: Path, codes: list[str]) -> Path:
    """daily_unadjusted(last=20260626) + stocks.parquet 시드."""
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame({"code": [codes[0]], "date": ["2026-06-26"], "open": [1.0], "high": [1.0],
                  "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
                  pl.col("date").str.to_date()).write_parquet(sdir / "daily_unadjusted.parquet")
    pl.DataFrame({"code": codes}).write_parquet(sdir / "stocks.parquet")
    return sdir


def _patch_update_env(monkeypatch):
    """20260627 갭 1거래일 + creds 있음 + 캐퍼시티 fake 직결 + 스로틀 0.
    now=16:00 이후 → 오늘(20260627)이 D6 컷오프를 지나 확정 거래일로 갭에 포함된다."""
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27, 16, 0))
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda _f, _t: ["20260627"])
    # PR-F(#1042) 칼 컷오버 — 자격·거버너 모두 키움이다.
    monkeypatch.setattr(
        _kiwoom_runtime, "ensure_rest_client", lambda *_a, **_k: object()
    )
    monkeypatch.setattr(_kiwoom_runtime, "ensure_scheduler", lambda *_a, **_k: object())
    monkeypatch.setattr(_screener_mod, "_PROGRESS_MIN_INTERVAL_S", 0.0)


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
    assert _screener_mod._gap_trading_days(
        "20260601", "20260601", now=datetime(2026, 6, 1, 16, 0)) == []
    assert calls == []  # short-circuited, never hit the calendar


def test_gap_trading_days_delegates_when_gap(monkeypatch):
    # next day after 20260529 = 20260530; today 20260601 → delegates to the calendar.
    # now ≥ 16:00 → today(20260601) is a confirmed session and stays in the gap.
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: [f, t])
    assert _screener_mod._gap_trading_days(
        "20260529", "20260601", now=datetime(2026, 6, 1, 16, 0)) == ["20260530", "20260601"]


def test_gap_excludes_today_before_eod_cutoff(monkeypatch):
    """D6: 16:00 KST 전에는 오늘(미확정) 일봉을 갭에서 제외 — 장중 미확정 저장 방지."""
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: ["20260627"])
    days = _screener_mod._gap_trading_days(
        "20260626", "20260627", now=datetime(2026, 6, 27, 12, 0))
    assert days == []


def test_gap_includes_today_after_eod_cutoff(monkeypatch):
    """D6: 16:00 KST 이후에는 오늘이 확정 — 갭에 포함."""
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: ["20260627"])
    days = _screener_mod._gap_trading_days(
        "20260626", "20260627", now=datetime(2026, 6, 27, 16, 0))
    assert days == ["20260627"]


def test_gap_keeps_past_days_but_drops_today_before_cutoff(monkeypatch):
    """장중이라도 과거 확정 거래일은 남기고 오늘만 드롭."""
    monkeypatch.setattr(_screener_mod, "trading_days_in_range",
                        lambda f, t: ["20260626", "20260627"])
    days = _screener_mod._gap_trading_days(
        "20260625", "20260627", now=datetime(2026, 6, 27, 9, 30))
    assert days == ["20260626"]


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
    monkeypatch.setattr(app_mod, "start_today_promoter", async_noop)

    with TestClient(app_mod.create_app(tmp_path)) as client:
        assert client.get("/health").status_code == 200

    assert calls == []


def test_manual_update_route_delegates_to_start_update(tmp_path: Path, monkeypatch):
    from fastapi import FastAPI

    from hoga.api import screener as screener_mod

    calls = []

    async def fake_start_update(data_dir, *, bus=None):
        calls.append((data_dir, bus))
        return {"running": True, "done": 0, "total": 5}

    monkeypatch.setattr(screener_mod, "start_update", fake_start_update)

    app = FastAPI()
    app.include_router(screener_mod.build_router(data_dir=tmp_path, bus=None))

    with TestClient(app) as client:
        resp = client.post("/api/screener/update")

    assert resp.status_code == 200
    assert resp.json() == {"running": True, "done": 0, "total": 5}
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
        scheduler_arg, *, key, api_id, priority, fetch_fn, client,
    ):
        # 계정 차원(data_dir·endpoint·cooldown_scope)은 사라졌다 — 키움 유량은
        # TR별이라 고를 계정이 없다(#1015). 버킷 키는 api_id 다.
        calls.append({
            "scheduler": scheduler_arg, "key": key,
            "api_id": api_id, "priority": priority,
        })
        return await fetch_fn(client)

    async def fake_daily_fetch_one(_client, code, frm, to, *, run_page=None):
        if run_page is not None:
            # 진짜 경로와 같은 계약: 페이지 I/O 는 러너를 지난다(ADR-0137). 이 호출이
            # 없으면 페이크가 거버너를 건너뛰어 유량 검증이 조용히 죽는다.
            await run_page(_fake_page_fetch, 0)
        return [DailyBar(code, datetime(2026, 6, 27).date(), 1.0, 2.0, 1.0, 2.0, 10)]

    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27, 16, 0))
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda _f, _t: ["20260627"])
    monkeypatch.setattr(_screener_mod.screener_store, "run_update", fake_run_update)
    monkeypatch.setattr(
        _kiwoom_runtime, "ensure_rest_client", lambda *_a, **_k: object()
    )
    monkeypatch.setattr(_kiwoom_runtime, "ensure_scheduler", lambda *_a, **_k: scheduler)
    monkeypatch.setattr(_kiwoom_access, "run_with_capacity", fake_run_with_capacity)
    monkeypatch.setattr(_screener_mod, "_daily_fetch_one", fake_daily_fetch_one)

    assert await _screener_mod.trigger_update(tmp_path) == 1
    assert calls == [{
        "scheduler": scheduler,
        # 끝의 0 은 **페이지 인덱스** — 거버너 단위가 walk 전체가 아니라 페이지다.
        "key": ("screener-update", "005930", "20260627", "20260627", 0),
        "api_id": "ka10081",
        "priority": "background",
    }]


# --- start_update: 사전 체크 skip reason 4종 -------------------------------


async def test_start_update_not_seeded_reason(tmp_path: Path):
    assert await _screener_mod.start_update(tmp_path) == {
        "running": False, "updated": 0, "reason": "not_seeded"}


async def test_start_update_no_gap_reason(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    # last=20260626, today=20260626 → next day > today → 갭 없음(달력 호출 없이).
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 26))
    assert await _screener_mod.start_update(tmp_path) == {
        "running": False, "updated": 0, "reason": "no_gap"}


async def test_start_update_calendar_unavailable_reason(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27))

    def boom(_f, _t):
        raise RuntimeError("KIS holiday endpoint down")

    monkeypatch.setattr(_screener_mod, "trading_days_in_range", boom)
    assert await _screener_mod.start_update(tmp_path) == {
        "running": False, "updated": 0, "reason": "calendar_unavailable"}


async def test_start_update_creds_missing_reason(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27, 16, 0))
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda _f, _t: ["20260627"])
    monkeypatch.setattr(_kiwoom_runtime, "ensure_rest_client", lambda *_a, **_k: None)
    assert await _screener_mod.start_update(tmp_path) == {
        "running": False, "updated": 0, "reason": "creds_missing"}


# --- job 수명주기 -----------------------------------------------------------


async def test_start_update_spawns_job_and_clears_progress_on_finish(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    gate = asyncio.Event()
    started = asyncio.Event()
    calls = []

    async def gated_run_update(sdir, *, codes, fetch_one, trading_days, now_ms):
        calls.append(codes)
        started.set()
        await gate.wait()
        return 1

    monkeypatch.setattr(_screener_mod.screener_store, "run_update", gated_run_update)

    res = await _screener_mod.start_update(tmp_path)
    assert res == {"running": True, "done": 0, "total": 1}
    assert _screener_mod._progress is not None
    assert _screener_mod._progress.total == 1
    await started.wait()  # job 코루틴이 run_update 에 도달할 때까지

    # 진행 중 재-POST: 재계획 없이 현재 진행 상태로 join.
    res2 = await _screener_mod.start_update(tmp_path)
    assert res2 == {"running": True, "done": 0, "total": 1}
    assert calls == [["005930"]]  # run_update 는 1회만

    gate.set()
    assert await _screener_mod._job_task == 1
    assert _screener_mod._progress is None  # finally 가 태스크 done 전에 클리어


def test_status_route_exposes_updating(tmp_path: Path, monkeypatch):
    from fastapi import FastAPI

    sdir = tmp_path / "screener"
    sdir.mkdir()
    write_status(sdir / "status.json", last_raw_date="20260626",
                 universe_size=1, derive_ms=1, now_ms=1)
    # days_behind 는 no-gap 단락(달력 미호출)으로 고정.
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 26))

    app = FastAPI()
    app.include_router(_screener_mod.build_router(data_dir=tmp_path, bus=None))

    monkeypatch.setattr(_screener_mod, "_progress",
                        _screener_mod._UpdateProgress(done=3, total=10, started_ms=123))
    with TestClient(app) as client:
        body = client.get("/api/screener/status").json()
    assert body["updating"] == {"done": 3, "total": 10, "started_ms": 123}

    monkeypatch.setattr(_screener_mod, "_progress", None)
    with TestClient(app) as client:
        body = client.get("/api/screener/status").json()
    assert body["updating"] is None


# --- 진행/종결 이벤트 --------------------------------------------------------


async def test_progress_events_published_per_code_with_terminal_finished(
        tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930", "000660", "035420"])
    _patch_update_env(monkeypatch)
    bus = _BusStub()

    async def fake_run_with_capacity(scheduler_arg, *, key, api_id, priority,
                                     fetch_fn, client):
        return await fetch_fn(client)

    async def fake_daily_fetch_one(_client, code, frm, to, *, run_page=None):
        if run_page is not None:
            # 진짜 경로와 같은 계약: 페이지 I/O 는 러너를 지난다(ADR-0137). 이 호출이
            # 없으면 페이크가 거버너를 건너뛰어 유량 검증이 조용히 죽는다.
            await run_page(_fake_page_fetch, 0)
        return [DailyBar(code, datetime(2026, 6, 27).date(), 1.0, 2.0, 1.0, 2.0, 10)]

    async def fake_run_update(sdir, *, codes, fetch_one, trading_days, now_ms):
        for c in codes:
            await fetch_one(c, trading_days[0], trading_days[-1])
        return len(trading_days)

    monkeypatch.setattr(_kiwoom_access, "run_with_capacity", fake_run_with_capacity)
    monkeypatch.setattr(_screener_mod, "_daily_fetch_one", fake_daily_fetch_one)
    monkeypatch.setattr(_screener_mod.screener_store, "run_update", fake_run_update)

    assert await _screener_mod.trigger_update(tmp_path, bus=bus) == 1

    progress = [e for e in bus.events if e["type"] == "screener_update_progress"]
    assert progress[0] == {"type": "screener_update_progress", "done": 0, "total": 3}
    dones = [e["done"] for e in progress]
    assert dones == sorted(dones)          # 단조 증가
    assert dones[-1] == 3                  # 마지막 종목은 스로틀 무관 무조건 발행
    assert bus.events[-1] == {"type": "screener_update_finished",
                              "updated": 1, "total": 3, "reason": None}


async def test_finished_event_on_failure(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    bus = _BusStub()

    async def failing_run_update(sdir, *, codes, fetch_one, trading_days, now_ms):
        raise RuntimeError("commit exploded")

    monkeypatch.setattr(_screener_mod.screener_store, "run_update", failing_run_update)

    with pytest.raises(RuntimeError, match="commit exploded"):
        await _screener_mod.trigger_update(tmp_path, bus=bus)
    assert bus.events[-1] == {"type": "screener_update_finished",
                              "updated": 0, "total": 1, "reason": "error"}
    assert _screener_mod._progress is None


# --- 단일-flight + 취소 격리 -------------------------------------------------


async def test_concurrent_triggers_join_single_job(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    gate = asyncio.Event()
    started = asyncio.Event()
    calls = []

    async def gated_run_update(sdir, *, codes, fetch_one, trading_days, now_ms):
        calls.append(codes)
        started.set()
        await gate.wait()
        return 4

    # _plan_update 의 to_thread 홉을 제거해 t2 가 sleep(0) 한 틱에 join 지점까지
    # 도달하게 — 게이트 해제 전에 확실히 같은 job 에 합류한다(결정적 시퀀싱).
    async def instant_plan(data_dir):
        return _screener_mod._UpdatePlan(
            sdir=tmp_path / "screener", codes=["005930"], days=["20260627"])

    monkeypatch.setattr(_screener_mod.screener_store, "run_update", gated_run_update)
    monkeypatch.setattr(_screener_mod, "_plan_update", instant_plan)

    t1 = asyncio.create_task(_screener_mod.trigger_update(tmp_path))
    await started.wait()
    t2 = asyncio.create_task(_screener_mod.trigger_update(tmp_path))
    await asyncio.sleep(0)  # t2: instant_plan → _ensure_job join → shield await
    gate.set()
    assert await t1 == 4
    assert await t2 == 4
    assert len(calls) == 1  # job 은 하나만 돌았다


async def test_awaiter_cancellation_does_not_kill_job(tmp_path: Path, monkeypatch):
    """disconnect 수정 핀: awaiter 취소(≒브라우저 이탈)가 공유 job 을 못 죽인다."""
    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    gate = asyncio.Event()
    started = asyncio.Event()

    async def gated_run_update(sdir, *, codes, fetch_one, trading_days, now_ms):
        started.set()
        await gate.wait()
        return 7

    monkeypatch.setattr(_screener_mod.screener_store, "run_update", gated_run_update)

    t = asyncio.create_task(_screener_mod.trigger_update(tmp_path))
    await started.wait()
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t

    job = _screener_mod._job_task
    assert job is not None and not job.done()  # job 은 계속 진행
    gate.set()
    assert await job == 7
    assert _screener_mod._progress is None


async def test_shutdown_update_job_cancels_and_publishes(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    bus = _BusStub()
    started = asyncio.Event()

    async def hung_run_update(sdir, *, codes, fetch_one, trading_days, now_ms):
        started.set()
        await asyncio.Event().wait()  # 외부 cancel 만이 끝낼 수 있다
        return 0

    monkeypatch.setattr(_screener_mod.screener_store, "run_update", hung_run_update)

    res = await _screener_mod.start_update(tmp_path, bus=bus)
    assert res["running"] is True
    await started.wait()

    await _screener_mod.shutdown_update_job()
    assert _screener_mod._progress is None
    assert bus.events[-1] == {"type": "screener_update_finished",
                              "updated": 0, "total": 1, "reason": "cancelled"}


# ── wire model 계약 (ADR-0004 · 동결선 배치 4) ────────────────────────────────


def test_update_response_keeps_the_discriminated_union_shape():
    """프론트는 `/screener/update` 를 **판별 유니온**으로 받는다:

        {running: true, done, total} | {running: false, updated: 0, reason}

    한 pydantic 모델로 두 가지를 담으므로 반대편 가지의 필드가 전부 optional 인데,
    기본 직렬화면 그것들이 `null` 로 실려 유니온 판별이 깨진다. 라우트의
    `response_model_exclude_none=True` 가 그걸 막는다 — **모델만 봐서는 안 보이는
    설정**이라 여기서 결과를 직접 잰다.
    """
    from hoga.api.screener import ScreenerUpdateResponse

    for payload in (
        {"running": True, "done": 3, "total": 10},
        {"running": False, "updated": 0, "reason": "no_gap"},
    ):
        got = ScreenerUpdateResponse.model_validate(payload).model_dump(exclude_none=True)
        assert got == payload, "다른 가지의 키가 새어 나오면 프론트 유니온 판별이 깨진다"


def test_status_response_keeps_meaningful_nulls():
    """`days_behind: null`(신선도 불명)과 `updating: null`(갱신 job 없음)은 **값 있는
    null** 이다 — 지우면 "모른다" 와 "0" 을 구별할 수 없다.

    그래서 status 라우트에는 `exclude_none` 을 걸지 않았다. 반대 방향의 회귀
    (누군가 update 를 따라 여기에도 붙이는 것)를 막는다.
    """
    from hoga.api.screener import ScreenerStatusResponse

    got = ScreenerStatusResponse.model_validate(
        {"status": "ok", "last_raw_date": "20260806", "days_behind": None, "updating": None}
    ).model_dump()

    assert got["days_behind"] is None
    assert got["updating"] is None
    assert "status" in got
