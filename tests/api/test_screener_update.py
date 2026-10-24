import asyncio
from datetime import datetime
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

from hoga.api import screener as _screener_mod, screener_daily_ingest as _ingest
from hoga.api.calendar import TradingDayUnavailableError
from hoga.api.error_codes import UpstreamCode
from hoga.api.screener_store import append_rows, last_raw_date, read_status, write_status
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
    pl.DataFrame(
        {
            "code": [codes[0]],
            "date": ["2026-06-26"],
            "open": [1.0],
            "high": [1.0],
            "low": [1.0],
            "close": [1.0],
            "volume": [1],
        }
    ).with_columns(pl.col("date").str.to_date()).write_parquet(sdir / "daily_unadjusted.parquet")
    pl.DataFrame({"code": codes}).write_parquet(sdir / "stocks.parquet")
    return sdir


def _patch_update_env(monkeypatch):
    """20260627 갭 1거래일 + creds 있음 + 캐퍼시티 fake 직결 + 스로틀 0.
    now=16:00 이후 → 오늘(20260627)이 D6 컷오프를 지나 확정 거래일로 갭에 포함된다."""
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27, 16, 0))
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda _f, _t: ["20260627"])
    monkeypatch.setattr("hoga.api.trading_days.trading_days", lambda _: ["20260627"])
    # PR-F(#1042) 칼 컷오버 — 자격·거버너 모두 키움이다.
    monkeypatch.setattr(_kiwoom_runtime, "ensure_rest_client", lambda *_a, **_k: object())
    monkeypatch.setattr(_kiwoom_runtime, "ensure_scheduler", lambda *_a, **_k: object())
    monkeypatch.setattr(_screener_mod, "_PROGRESS_MIN_INTERVAL_S", 0.0)


def test_last_date_and_append(tmp_path: Path):
    p = tmp_path / "u.parquet"
    pl.DataFrame(
        {
            "code": ["000001"],
            "date": ["2026-05-13"],
            "open": [1.0],
            "high": [1.0],
            "low": [1.0],
            "close": [1.0],
            "volume": [1],
        }
    ).with_columns(pl.col("date").str.to_date()).write_parquet(p)
    assert last_raw_date(p) == "20260513"
    append_rows(
        p,
        pl.DataFrame(
            {
                "code": ["000001"],
                "date": ["2026-05-14"],
                "open": [2.0],
                "high": [2.0],
                "low": [2.0],
                "close": [2.0],
                "volume": [2],
            }
        ).with_columns(pl.col("date").str.to_date()),
    )
    assert last_raw_date(p) == "20260514"


def test_append_is_idempotent_on_code_date(tmp_path: Path):
    p = tmp_path / "u.parquet"
    base = pl.DataFrame(
        {
            "code": ["000001"],
            "date": ["2026-05-13"],
            "open": [1.0],
            "high": [1.0],
            "low": [1.0],
            "close": [1.0],
            "volume": [1],
        }
    ).with_columns(pl.col("date").str.to_date())
    base.write_parquet(p)
    dup = pl.DataFrame(
        {
            "code": ["000001"],
            "date": ["2026-05-14"],
            "open": [2.0],
            "high": [2.0],
            "low": [2.0],
            "close": [2.0],
            "volume": [2],
        }
    ).with_columns(pl.col("date").str.to_date())
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
    assert not sp.exists()  # 원본은 rename 격리됨
    assert list(tmp_path.glob("status.json.corrupt-*"))  # 백업 남음


def test_append_rows_atomic_leaves_no_tmp(tmp_path: Path):
    # 원자적 기록: 성공 후 .tmp 잔여물 없음 + 데이터 정상(#6).
    p = tmp_path / "u.parquet"
    pl.DataFrame(
        {
            "code": ["000001"],
            "date": ["2026-05-13"],
            "open": [1.0],
            "high": [1.0],
            "low": [1.0],
            "close": [1.0],
            "volume": [1],
        }
    ).with_columns(pl.col("date").str.to_date()).write_parquet(p)
    append_rows(
        p,
        pl.DataFrame(
            {
                "code": ["000002"],
                "date": ["2026-05-13"],
                "open": [2.0],
                "high": [2.0],
                "low": [2.0],
                "close": [2.0],
                "volume": [2],
            }
        ).with_columns(pl.col("date").str.to_date()),
    )
    assert pl.read_parquet(p).height == 2
    assert not list(tmp_path.glob("*.tmp"))  # tempfile→os.replace 후 잔여 없음


def test_gap_trading_days_no_gap_short_circuits(monkeypatch):
    # next day after 20260601 (=20260602) > today 20260601 → [] WITHOUT calling the calendar.
    calls = []
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: calls.append((f, t)) or ["x"])
    assert _screener_mod._gap_trading_days("20260601", "20260601", now=datetime(2026, 6, 1, 16, 0)) == []
    assert calls == []  # short-circuited, never hit the calendar


def test_gap_trading_days_delegates_when_gap(monkeypatch):
    # next day after 20260529 = 20260530; today 20260601 → delegates to the calendar.
    # now ≥ 16:00 → today(20260601) is a confirmed session and stays in the gap.
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: [f, t])
    assert _screener_mod._gap_trading_days("20260529", "20260601", now=datetime(2026, 6, 1, 16, 0)) == [
        "20260530",
        "20260601",
    ]


def test_gap_excludes_today_before_eod_cutoff(monkeypatch):
    """D6: 16:00 KST 전에는 오늘(미확정) 일봉을 갭에서 제외 — 장중 미확정 저장 방지."""
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: ["20260627"])
    days = _screener_mod._gap_trading_days("20260626", "20260627", now=datetime(2026, 6, 27, 12, 0))
    assert days == []


def test_gap_includes_today_after_eod_cutoff(monkeypatch):
    """D6: 16:00 KST 이후에는 오늘이 확정 — 갭에 포함."""
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: ["20260627"])
    days = _screener_mod._gap_trading_days("20260626", "20260627", now=datetime(2026, 6, 27, 16, 0))
    assert days == ["20260627"]


def test_gap_keeps_past_days_but_drops_today_before_cutoff(monkeypatch):
    """장중이라도 과거 확정 거래일은 남기고 오늘만 드롭."""
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda f, t: ["20260626", "20260627"])
    days = _screener_mod._gap_trading_days("20260625", "20260627", now=datetime(2026, 6, 27, 9, 30))
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

    async def fake_start_update(data_dir, *, bus=None, repair_history=False):
        calls.append((data_dir, bus, repair_history))
        return {"running": True, "done": 0, "total": 5}

    monkeypatch.setattr(screener_mod, "start_update", fake_start_update)

    app = FastAPI()
    app.include_router(screener_mod.build_router(data_dir=tmp_path, bus=None))

    with TestClient(app) as client:
        resp = client.post("/api/screener/update")

    assert resp.status_code == 200
    assert resp.json() == {"running": True, "done": 0, "total": 5}
    assert calls == [(tmp_path, None, False)]


async def test_trigger_update_fetches_daily_rows_through_capacity_scheduler(tmp_path: Path, monkeypatch):
    from types import SimpleNamespace

    from hoga.live import kiwoom_daily_candles
    from hoga.util.timeenc import KST

    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    calls = []

    async def fake_run_update(data_dir, *, codes, fetch, days, now, progress=None):
        assert codes == ["005930"] and days == ["2026-06-27"]
        await fetch(codes[0], datetime(2026, 6, 27).date(), datetime(2026, 6, 27).date(), 0)
        return 1

    async def capacity(scheduler, *, key, api_id, priority, fetch_fn, client):
        calls.append((key, api_id, priority))
        return await fetch_fn(client)

    async def daily(client, code, first, last, *, adjust, adjusted_as_of, run_page):
        assert not adjust and adjusted_as_of is None
        await run_page(_fake_page_fetch, 0)
        candle = SimpleNamespace(
            t_ms=int(datetime(2026, 6, 27, tzinfo=KST).timestamp() * 1000), open=1, high=2, low=1, close=2, volume=10
        )
        return SimpleNamespace(candles=[candle], source_rows=[{"dt": "20260627", "trde_qty": "10"}], violations=[])

    monkeypatch.setattr(_ingest, "run", fake_run_update)
    monkeypatch.setattr(_kiwoom_access, "run_with_capacity", capacity)
    monkeypatch.setattr(kiwoom_daily_candles, "fetch_daily_candles", daily)
    assert await _screener_mod.trigger_update(tmp_path) == 1
    assert len(calls) == 1
    assert calls[0][0][:2] == ("daily-ingest", "005930")
    assert calls[0][1:] == ("ka10081", "background")


# --- start_update: 사전 체크 skip reason 4종 -------------------------------


async def test_start_update_not_seeded_reason(tmp_path: Path):
    assert await _screener_mod.start_update(tmp_path) == {"running": False, "updated": 0, "reason": "not_seeded"}


async def test_start_update_no_gap_reason(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    # A checked daily ledger, rather than a global last row, means there is no work.
    from hoga.util.atomic_write import atomic_write_json

    atomic_write_json(_ingest.root(tmp_path) / "status.json", {"checked_on": "2026-06-26"})
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 26))
    assert await _screener_mod.start_update(tmp_path) == {"running": False, "updated": 0, "reason": "no_gap"}


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        (UpstreamCode.TRADING_DAYS_UNAVAILABLE, "calendar_source_missing"),
        (UpstreamCode.TRADING_DAYS_STALE, "calendar_coverage_behind"),
    ],
)
async def test_start_update_splits_the_two_calendar_failures(
    tmp_path: Path,
    monkeypatch,
    code,
    expected,
):
    """달력 실패 둘은 **서로 다른 사유**로 나간다.

    뭉치면 화면만 보고 조치를 고를 수 없다 — 소스 결여는 배포를, 커버리지 부족은
    스케줄러를 봐야 한다. 한 값으로 되돌리면 이 파라미터 두 줄이 같은 값을 기대하게
    되어 실패한다.
    """
    _seed_archive(tmp_path, ["005930"])
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27))

    def boom(_f, _t):
        raise TradingDayUnavailableError(code)

    monkeypatch.setattr(_screener_mod, "trading_days_in_range", boom)
    assert await _screener_mod.start_update(tmp_path) == {"running": False, "updated": 0, "reason": expected}


async def test_start_update_unexpected_calendar_error_reads_as_source_missing(
    tmp_path: Path,
    monkeypatch,
):
    """`TradingDayUnavailableError` 밖의 예외도 사용자 조치는 소스 결여와 같다.

    다만 **traceback 을 남긴다** — 그게 진짜 배포 사고와 이 갈래를 사후에 가르는
    유일한 단서다(`log.exception`).
    """
    _seed_archive(tmp_path, ["005930"])
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27))

    def boom(_f, _t):
        raise RuntimeError("달력 코드의 버그")

    monkeypatch.setattr(_screener_mod, "trading_days_in_range", boom)
    assert await _screener_mod.start_update(tmp_path) == {
        "running": False,
        "updated": 0,
        "reason": "calendar_source_missing",
    }


async def test_start_update_creds_missing_reason(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27, 16, 0))
    monkeypatch.setattr(_screener_mod, "trading_days_in_range", lambda _f, _t: ["20260627"])
    monkeypatch.setattr("hoga.api.trading_days.trading_days", lambda _: ["20260627"])
    monkeypatch.setattr(_kiwoom_runtime, "ensure_rest_client", lambda *_a, **_k: None)
    assert await _screener_mod.start_update(tmp_path) == {"running": False, "updated": 0, "reason": "creds_missing"}


# --- job 수명주기 -----------------------------------------------------------


async def test_start_update_spawns_job_and_clears_progress_on_finish(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    gate = asyncio.Event()
    started = asyncio.Event()
    calls = []

    async def gated_run_update(data_dir, *, codes, fetch, days, now, progress=None):
        calls.append(codes)
        started.set()
        await gate.wait()
        return 1

    monkeypatch.setattr(_ingest, "run", gated_run_update)

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
    write_status(sdir / "status.json", last_raw_date="20260626", universe_size=1, derive_ms=1, now_ms=1)
    # days_behind 는 no-gap 단락(달력 미호출)으로 고정.
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 26))

    app = FastAPI()
    app.include_router(_screener_mod.build_router(data_dir=tmp_path, bus=None))

    monkeypatch.setattr(_screener_mod, "_progress", _screener_mod._UpdateProgress(done=3, total=10, started_ms=123))
    with TestClient(app) as client:
        body = client.get("/api/screener/status").json()
    assert body["updating"] == {"done": 3, "total": 10, "started_ms": 123, "phase": None}

    monkeypatch.setattr(_screener_mod, "_progress", None)
    with TestClient(app) as client:
        body = client.get("/api/screener/status").json()
    assert body["updating"] is None


# --- 진행/종결 이벤트 --------------------------------------------------------


async def test_progress_events_published_per_code_with_terminal_finished(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930", "000660", "035420"])
    _patch_update_env(monkeypatch)
    bus = _BusStub()

    async def fake_run(data_dir, *, codes, fetch, days, now, progress):
        for done in range(1, len(codes) + 1):
            progress(done, len(codes))
        return len(days)

    monkeypatch.setattr(_ingest, "run", fake_run)
    assert await _screener_mod.trigger_update(tmp_path, bus=bus) == 1
    progress = [e for e in bus.events if e["type"] == "screener_update_progress"]
    assert progress[0] == {"type": "screener_update_progress", "done": 0, "total": 3}
    assert [e["done"] for e in progress] == [0, 1, 2, 3]
    assert bus.events[-1] == {"type": "screener_update_finished", "updated": 1, "total": 3, "reason": None}


async def test_finished_event_on_failure(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    bus = _BusStub()

    async def failing_run_update(data_dir, *, codes, fetch, days, now, progress=None):
        raise RuntimeError("commit exploded")

    monkeypatch.setattr(_ingest, "run", failing_run_update)

    with pytest.raises(RuntimeError, match="commit exploded"):
        await _screener_mod.trigger_update(tmp_path, bus=bus)
    assert bus.events[-1] == {"type": "screener_update_finished", "updated": 0, "total": 1, "reason": "error"}
    assert _screener_mod._progress is None


# --- 단일-flight + 취소 격리 -------------------------------------------------


async def test_concurrent_triggers_join_single_job(tmp_path: Path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    gate = asyncio.Event()
    started = asyncio.Event()
    calls = []

    async def gated_run_update(data_dir, *, codes, fetch, days, now, progress=None):
        calls.append(codes)
        started.set()
        await gate.wait()
        return 4

    # _plan_update 의 to_thread 홉을 제거해 t2 가 sleep(0) 한 틱에 join 지점까지
    # 도달하게 — 게이트 해제 전에 확실히 같은 job 에 합류한다(결정적 시퀀싱).
    async def instant_plan(data_dir):
        return _screener_mod._UpdatePlan(sdir=tmp_path / "screener", codes=["005930"], days=["20260627"])

    monkeypatch.setattr(_ingest, "run", gated_run_update)
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

    async def gated_run_update(data_dir, *, codes, fetch, days, now, progress=None):
        started.set()
        await gate.wait()
        return 7

    monkeypatch.setattr(_ingest, "run", gated_run_update)

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

    async def hung_run_update(data_dir, *, codes, fetch, days, now, progress=None):
        started.set()
        await asyncio.Event().wait()  # 외부 cancel 만이 끝낼 수 있다
        return 0

    monkeypatch.setattr(_ingest, "run", hung_run_update)

    res = await _screener_mod.start_update(tmp_path, bus=bus)
    assert res["running"] is True
    await started.wait()

    await _screener_mod.shutdown_update_job()
    assert _screener_mod._progress is None
    assert bus.events[-1] == {"type": "screener_update_finished", "updated": 0, "total": 1, "reason": "cancelled"}


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


async def test_nightly_recheck_can_use_known_past_dates_when_today_calendar_is_stale(tmp_path, monkeypatch):
    _seed_archive(tmp_path, ["005930"])
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 27, 22, 0))

    def stale(*args):
        raise TradingDayUnavailableError(code=UpstreamCode.TRADING_DAYS_STALE)

    monkeypatch.setattr(_screener_mod, "trading_days_in_range", stale)
    monkeypatch.setattr("hoga.api.trading_days.trading_days", lambda _: ["20260626"])
    monkeypatch.setattr(_kiwoom_runtime, "ensure_rest_client", lambda *_: object())
    plan = await _screener_mod._plan_update(tmp_path)
    assert isinstance(plan, _screener_mod._UpdatePlan)
    assert plan.days == ["2026-06-26"]  # no inferred Saturday bar


def test_history_repair_has_a_separate_http_entrypoint(tmp_path, monkeypatch):
    from fastapi import FastAPI

    calls = []

    async def start(data_dir, *, bus=None, repair_history=False):
        calls.append(repair_history)
        return {"running": True, "done": 0, "total": 3}

    monkeypatch.setattr(_screener_mod, "start_update", start)
    app = FastAPI()
    app.include_router(_screener_mod.build_router(data_dir=tmp_path, bus=None))
    with TestClient(app) as client:
        assert client.post("/api/screener/update").json() == {"running": True, "done": 0, "total": 3}
        assert client.post("/api/screener/repair-history").json() == {"running": True, "done": 0, "total": 3}
    assert calls == [False, True]


async def test_clicks_and_scheduler_share_preflight_and_never_schedule_deep_repair(tmp_path, monkeypatch):
    from hoga.api import screener_refresh

    entered, release_plan, collecting, release_collection = (asyncio.Event() for _ in range(4))
    plans, collections, repairs = [], [], []

    async def plan(data_dir):
        plans.append(data_dir)
        entered.set()
        await release_plan.wait()
        return _screener_mod._UpdatePlan(tmp_path, ["005930"], ["2026-06-29"])

    async def collect(data_dir, plan, *, bus):
        collections.append(plan.codes)
        collecting.set()
        await release_collection.wait()
        return 1

    async def repair(*args, **kwargs):
        repairs.append(1)
        raise AssertionError("An ordinary refresh must never request historical repair")

    monkeypatch.setattr(_screener_mod, "_plan_update", plan)
    monkeypatch.setattr(_screener_mod, "_run_eod_update", collect)
    monkeypatch.setattr(screener_refresh, "run_refresh", repair)
    scheduled = asyncio.create_task(_screener_mod.trigger_update(tmp_path))
    await entered.wait()
    clicks = [asyncio.create_task(_screener_mod.start_update(tmp_path)) for _ in range(20)]
    release_plan.set()
    results = await asyncio.gather(*clicks)
    await collecting.wait()
    assert all(r == {"running": True, "done": 0, "total": 1} for r in results)
    assert len(plans) == len(collections) == 1 and repairs == []
    release_collection.set()
    assert await scheduled == 1 and repairs == []


@pytest.mark.parametrize(("attempts", "reason"), [(1, "retry_wait"), (2, "daily_limit")])
async def test_refresh_click_explains_retry_budget_without_fetch_or_reset(tmp_path, monkeypatch, attempts, reason):
    from hoga.util.atomic_write import atomic_write_json
    from hoga.util.timeenc import KST

    _seed_archive(tmp_path, ["005930"])
    clock = datetime(2026, 6, 29, 22, 1, tzinfo=KST)
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: clock)
    path = _ingest.root(tmp_path) / "status.json"
    atomic_write_json(path, {"checked_on": "2026-06-29", "last_attempt_at": clock.isoformat(),
                             "attempts_today": attempts, "failed_codes": 1})
    before = path.read_bytes()
    assert await _screener_mod.start_update(tmp_path) == {"running": False, "updated": 0, "reason": reason}
    assert _screener_mod._job_task is None and path.read_bytes() == before


async def test_completed_click_uses_same_pipeline_as_scheduler_and_preserves_data(tmp_path, monkeypatch):
    from hoga.api import screener_refresh

    _seed_archive(tmp_path, ["005930"])
    _patch_update_env(monkeypatch)
    before = (tmp_path / "screener/daily_unadjusted.parquet").read_bytes()
    calls = []

    async def run(data_dir, *, codes, fetch, days, now, progress):
        calls.append((codes, days, now))
        return 0

    async def unexpected_repair(*args, **kwargs):
        raise AssertionError("Unexpected historical repair")

    monkeypatch.setattr(_ingest, "run", run)
    monkeypatch.setattr(screener_refresh, "run_refresh", unexpected_repair)
    assert (await _screener_mod.start_update(tmp_path))["running"]
    await _screener_mod._job_task
    assert await _screener_mod.trigger_update(tmp_path) == 0
    assert len(calls) == 2 and calls[0] == calls[1]
    assert (tmp_path / "screener/daily_unadjusted.parquet").read_bytes() == before


async def test_daytime_click_reserves_a_daily_attempt_for_night_check(tmp_path, monkeypatch):
    from hoga.util.atomic_write import atomic_write_json
    from hoga.util.timeenc import KST

    _seed_archive(tmp_path, ["005930"])
    path = _ingest.root(tmp_path) / "status.json"
    atomic_write_json(path, {"checked_on": "2026-06-29", "last_attempt_at": "2026-06-29T10:00:00+09:00",
                             "attempts_today": 1, "failed_codes": 1})
    monkeypatch.setattr(_screener_mod, "now_kst", lambda: datetime(2026, 6, 29, 16, tzinfo=KST))
    before = path.read_bytes()
    assert await _screener_mod.start_update(tmp_path) == {
        "running": False, "updated": 0, "reason": "finalization_wait"}
    assert _screener_mod._job_task is None and path.read_bytes() == before
    # At 22:00 the same completed daytime attempt no longer blocks admission.
    assert _screener_mod._recent_update_reason(tmp_path, datetime(2026, 6, 29, 22, tzinfo=KST)) is None
