# 거래원 궤적 today-aware 디스크 seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` latest 거래원 궤적을 '최근 15분'에서 '당일 전체'로 — `date==today & source==kis_live`일 때 `/api/brokers/series`가 parquet(승격분)+라이브 버퍼(미승격 꼬리)를 서버에서 봉합.

**Architecture:** 집계 로직을 순수 함수 `series_entries_from_rows`로 공용화하고, parquet 행과 버퍼 스냅샷 두 소스가 `(broker, ts_unix, signed_net)` 튜플로 그것을 먹인다. today 봉합은 unix-ms 공간에서 seam=max(parquet ts) concat(qty_today 누적이라 오프셋 불요). 라우트는 async로 버퍼를 await + DuckDB를 to_thread.

**Tech Stack:** Python(FastAPI, DuckDB, pydantic) 백엔드 / React+TS(@tanstack/react-query) 프론트. pytest / vitest. TDD.

**검증 메모:** 브라우저 스모크(라이브 거래원 틱 09:00~)는 **장중 이월**(Task 8). 그 전까지 **유닛 테스트가 유일 안전망** — 특히 Task 2의 net-동치 판별 테스트와 Task 3의 ts_ms→unix 테스트가 봉합 정확성의 린치핀.

---

## File Structure

- `hoga/tables/brokers.py` — (수정) `series_entries_from_rows`(추출), `broker_rows_from_snapshots`(신규), `query_day_series_today`(신규). live-import 없이 순수 유지(버퍼 스냅샷은 plain dict 주입).
- `hoga/api/routes.py` — (수정) `brokers_series` async 전환 + `build_router(engine, *, get_buffer=None)` + source/today 게이트 + `_compute_series` to_thread.
- `hoga/api/app.py:218` — (수정) `build_router(engine, get_buffer=live_get_buffer)`.
- `frontend/src/api/brokerSeries.ts` — (수정) today-inclusive freshness.
- `frontend/src/live/LiveSidebar.tsx` — (수정) latest 모드 거래원 소스를 day 훅으로.
- 테스트: `tests/unit/api/test_broker_series_seam.py`(신규, 백엔드), `frontend/src/api/brokerSeries.test.ts`(freshness), `frontend/src/live/LiveSidebar.test.tsx`(latest 소스).

---

## Task 1: `series_entries_from_rows` 추출 (집계 공용화, 동작 보존)

**Files:**
- Modify: `hoga/tables/brokers.py` (현 `query_day_series` 본문 124-186)
- Test: `tests/unit/api/test_broker_series_seam.py` (Create)

- [ ] **Step 1: 추출 함수의 failing 테스트**

```python
# tests/unit/api/test_broker_series_seam.py
from hoga.tables.brokers import series_entries_from_rows


def test_series_entries_collapses_aliases_and_ranks_top10():
    # 같은 firm의 두 raw 별칭이 같은 ts에서 합산되고, top-10이 |final_net| desc.
    rows = [
        ("신한투자증권", 1000, 50),
        ("신한증권", 1000, 30),   # 별칭 → canonical 합산 = 80
        ("키움증권", 1000, -20),
        ("신한투자증권", 2000, 120),
    ]
    entries = series_entries_from_rows(rows)
    by = {e.broker: e for e in entries}
    assert by["신한투자증권"].points[0].net == 80   # 1000ts 별칭 합산
    assert by["신한투자증권"].final_net == 120        # 마지막 점
    assert by["신한투자증권"].dominant_side == "buy"
    assert by["키움증권"].dominant_side == "sell"
    assert [e.broker for e in entries][0] == "신한투자증권"  # |120| 최상위
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/api/test_broker_series_seam.py::test_series_entries_collapses_aliases_and_ranks_top10 -q`
Expected: FAIL — `ImportError: cannot import name 'series_entries_from_rows'`

- [ ] **Step 3: 함수 추출 + query_day_series 재배선**

`hoga/tables/brokers.py`의 `query_day_series` 본문에서 "canonical collapse → group → entries → top-10" 꼬리를 순수 함수로 추출. `query_day_series`는 SQL 결과를 이 함수에 넘긴다(동작 동일, ts 인코딩 무관).

```python
def series_entries_from_rows(
    rows: "Iterable[tuple[str, int, int]]",
) -> list["BrokerSeriesEntry"]:
    """`(broker_raw, ts_ms, signed_net)` 행 → BrokerSeriesEntry top-10.

    canonical 정규화 후 같은 (firm, ts)를 합산하고, 브로커별 시계열로 묶어
    |final_net| desc, final_net desc로 최대 10개. ts_ms 인코딩 무관(HHMMSSmmm·
    unix 양쪽) — 호출부가 단위를 일관되게 넣는다.
    """
    from hoga.api.models import BrokerSeriesEntry, BrokerSeriesPoint
    from hoga.broker_names import canonical

    collapsed: dict[tuple[str, int], int] = {}
    for raw_broker, ts_ms, net in rows:
        key = (canonical(raw_broker), int(ts_ms))
        collapsed[key] = collapsed.get(key, 0) + int(net)

    by_broker: dict[str, list[BrokerSeriesPoint]] = {}
    for (broker, ts_ms), net in sorted(collapsed.items()):
        by_broker.setdefault(broker, []).append(BrokerSeriesPoint(ts_ms=ts_ms, net=net))

    entries = [
        BrokerSeriesEntry(
            broker=broker,
            final_net=points[-1].net,
            dominant_side="buy" if points[-1].net >= 0 else "sell",
            points=points,
        )
        for broker, points in by_broker.items()
    ]
    entries.sort(key=lambda e: (-abs(e.final_net), -e.final_net))
    return entries[:10]
```

`query_day_series`는 SQL 후 `return series_entries_from_rows((b, int(t), int(n)) for b, t, n in rows)`로 축약(기존 collapsed/by_broker/entries 블록 제거). `Iterable` import 확인.

- [ ] **Step 4: 통과 확인 + 기존 회귀**

Run: `uv run pytest tests/unit/api/test_broker_series_seam.py -q && uv run pytest tests/unit -k broker -q`
Expected: PASS (기존 query_day_series 테스트 그린 유지 — 동작 보존)

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/brokers.py tests/unit/api/test_broker_series_seam.py
git commit -m "refactor(brokers): series_entries_from_rows 추출 — parquet·버퍼 집계 공용화 (#9)"
```

---

## Task 2: `broker_rows_from_snapshots` + net 동치 판별 테스트 (린치핀)

**Files:**
- Modify: `hoga/tables/brokers.py`
- Test: `tests/unit/api/test_broker_series_seam.py`

- [ ] **Step 1: failing 테스트 (튜플 변환 + 양측 합산)**

```python
from hoga.tables.brokers import broker_rows_from_snapshots


def test_broker_rows_from_snapshots_signs_and_collapses():
    snaps = [
        {"t_ms": 111, "buy_top": [{"name": "키움증권", "qty": 100}],
         "sell_top": [{"name": "키움증권", "qty": 40}]},   # 양측 → +100-40=+60
        {"t_ms": 222, "buy_top": [{"name": "미래에셋증권", "qty": 70}], "sell_top": []},
        {"t_ms": 333, "buy_top": [], "sell_top": []},        # 빈 스냅샷 무시
    ]
    rows = sorted(broker_rows_from_snapshots(snaps))
    assert ("미래에셋증권", 222, 70) in rows
    # 같은 (broker, ts)는 series_entries_from_rows가 합산하므로 여기선 분리 방출 허용.
    net_111 = sum(n for b, t, n in rows if t == 111)
    assert net_111 == 60
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/api/test_broker_series_seam.py::test_broker_rows_from_snapshots_signs_and_collapses -q`
Expected: FAIL — ImportError.

- [ ] **Step 3: 구현**

```python
def broker_rows_from_snapshots(
    snapshots: "Iterable[dict]",
) -> list[tuple[str, int, int]]:
    """라이브 버퍼 broker 스냅샷 → `(broker_raw, t_ms, signed_net)` 행.

    한 스냅샷 내 buy=+qty / sell=−qty. qty는 KIS 회원사 누적 거래량(qty_today와
    동일 의미)이라 점이 그 시각까지의 누적net 그 자체 — query_day_series의
    `SUM(CASE side ... qty_today ...)`와 동일. canonical 합산은 series_entries_from_rows가.
    """
    rows: list[tuple[str, int, int]] = []
    for snap in snapshots:
        t_ms = int(snap.get("t_ms") or 0)
        for e in snap.get("buy_top") or []:
            name = e.get("name")
            if isinstance(name, str) and name:
                rows.append((name, t_ms, int(e.get("qty") or 0)))
        for e in snap.get("sell_top") or []:
            name = e.get("name")
            if isinstance(name, str) and name:
                rows.append((name, t_ms, -int(e.get("qty") or 0)))
    return rows
```

- [ ] **Step 4: 린치핀 — 버퍼net == parquet net 동치 (advisor critical #2)**

브라우저 검증 이월이라 봉합 연속성을 유닛으로 못박는다: 같은 broker payload를 (a) `broker_rows_from_snapshots`로, (b) promote→parquet→`query_day_series`로 통과시켜 signed net이 같음을 단언.

```python
def test_buffer_net_equals_parquet_net_for_same_tick(tmp_path):
    from hoga.tables.brokers import query_day_series, write_brokers_parquet, BrokerRow
    import duckdb
    payload_buy = [{"name": "키움증권", "qty": 100}, {"name": "미래에셋증권", "qty": 30}]
    payload_sell = [{"name": "키움증권", "qty": 40}]
    # (a) 버퍼 경로
    rows = broker_rows_from_snapshots(
        [{"t_ms": 93000000, "buy_top": payload_buy, "sell_top": payload_sell}]
    )
    buf_entries = {e.broker: e.final_net for e in series_entries_from_rows(rows)}
    # (b) promote→parquet 경로: 같은 payload를 BrokerRow로(promote.py:189-208 매핑 그대로
    #     qty_today=qty, qty_delta=0), 쓰고 query_day_series로 읽음.
    brows = (
        [BrokerRow(ts_ms=93000000, seq=1, side="sell", rank=i, broker=e["name"],
                   qty_today=e["qty"], qty_delta=0) for i, e in enumerate(payload_sell, 1)]
        + [BrokerRow(ts_ms=93000000, seq=1, side="buy", rank=i, broker=e["name"],
                     qty_today=e["qty"], qty_delta=0) for i, e in enumerate(payload_buy, 1)]
    )
    path = tmp_path / "brokers.parquet"
    write_brokers_parquet(brows, path)
    con = duckdb.connect()
    pq_entries = {e.broker: e.final_net for e in query_day_series(con, path=path)}
    assert buf_entries == pq_entries   # 봉합 연속성의 직접 증거
```

(주의: `write_brokers_parquet` import 경로·시그니처는 tables/brokers.py:107 확인 후 정합. con 인자 순서 동일.)

- [ ] **Step 5: 통과 확인**

Run: `uv run pytest tests/unit/api/test_broker_series_seam.py -q`
Expected: PASS (동치 테스트 그린 = qty→qty_today 직매핑 확인. RED로 떨어지면 promote 매핑이 바뀐 신호 → 설계 재검토).

- [ ] **Step 6: Commit**

```bash
git add hoga/tables/brokers.py tests/unit/api/test_broker_series_seam.py
git commit -m "feat(brokers): broker_rows_from_snapshots + net 동치 판별 테스트 (#9 린치핀)"
```

---

## Task 3: `query_day_series_today` 봉합 (parquet+버퍼, 파일부재 가드, unix-ms)

**Files:**
- Modify: `hoga/tables/brokers.py`
- Test: `tests/unit/api/test_broker_series_seam.py`

- [ ] **Step 1: failing 테스트들 (봉합 경계·파일부재·unix·연속)**

```python
from hoga.tables.brokers import query_day_series_today
import duckdb
from hoga.tables.brokers import write_brokers_parquet, BrokerRow
from hoga.api.timeenc import hhmmssms_to_unix_ms

DATE = "20260608"

def _pq(tmp_path, rows):
    p = tmp_path / "brokers.parquet"; write_brokers_parquet(rows, p); return p

def test_today_merges_parquet_then_buffer_tail(tmp_path):
    # parquet: 키움 09:30(ts encoded) net +100 ; 버퍼 꼬리 09:35 net +150
    enc_0930 = 93000000  # HHMMSSmmm
    pq = _pq(tmp_path, [BrokerRow(ts_ms=enc_0930, seq=1, side="buy", rank=1,
                                  broker="키움증권", qty_today=100, qty_delta=0)])
    unix_0930 = hhmmssms_to_unix_ms(DATE, enc_0930)
    buf = [{"t_ms": unix_0930 + 300_000, "buy_top": [{"name": "키움증권", "qty": 150}],
            "sell_top": []}]
    con = duckdb.connect()
    entries = query_day_series_today(con, pq, date=DATE, buffer_snapshots=buf)
    pts = {e.broker: e.points for e in entries}["키움증권"]
    assert pts[0].ts_ms == unix_0930 and pts[0].net == 100      # parquet, unix-ms
    assert pts[-1].ts_ms == unix_0930 + 300_000 and pts[-1].net == 150  # 버퍼 꼬리

def test_today_buffer_point_at_seam_is_dropped(tmp_path):
    enc = 93000000
    pq = _pq(tmp_path, [BrokerRow(ts_ms=enc, seq=1, side="buy", rank=1,
                                  broker="키움증권", qty_today=100, qty_delta=0)])
    seam_unix = hhmmssms_to_unix_ms(DATE, enc)
    buf = [{"t_ms": seam_unix, "buy_top": [{"name": "키움증권", "qty": 999}], "sell_top": []}]
    con = duckdb.connect()
    pts = query_day_series_today(con, pq, date=DATE, buffer_snapshots=buf)[0].points
    assert [p.net for p in pts] == [100]   # seam 동률 버퍼 점 제외(parquet 권위)

def test_today_no_parquet_file_uses_buffer_only(tmp_path):
    # advisor critical #1: 첫 승격 전 파일 부재 → read_parquet raise 회피, 버퍼만.
    missing = tmp_path / "nope" / "brokers.parquet"
    buf = [{"t_ms": 111, "buy_top": [{"name": "키움증권", "qty": 70}], "sell_top": []}]
    con = duckdb.connect()
    entries = query_day_series_today(con, missing, date=DATE, buffer_snapshots=buf)
    assert entries[0].broker == "키움증권" and entries[0].final_net == 70

def test_today_empty_buffer_equals_parquet_only(tmp_path):
    enc = 93000000
    pq = _pq(tmp_path, [BrokerRow(ts_ms=enc, seq=1, side="buy", rank=1,
                                  broker="키움증권", qty_today=100, qty_delta=0)])
    con = duckdb.connect()
    entries = query_day_series_today(con, pq, date=DATE, buffer_snapshots=[])
    assert entries[0].points[0].ts_ms == hhmmssms_to_unix_ms(DATE, enc)  # unix 변환됨
    assert entries[0].final_net == 100
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/api/test_broker_series_seam.py -k today -q`
Expected: FAIL — ImportError.

- [ ] **Step 3: 구현**

```python
def query_day_series_today(
    con: "duckdb.DuckDBPyConnection",
    path: "Path",
    *,
    date: str,
    buffer_snapshots: "Iterable[dict]",
) -> list["BrokerSeriesEntry"]:
    """today 봉합: parquet(승격분, ts≤seam) + 버퍼 꼬리(ts>seam)를 unix-ms 공간에서.

    parquet 행은 HHMMSSmmm → hhmmssms_to_unix_ms로 변환 후 합치므로 반환 entries의
    points.ts_ms는 **이미 unix-ms**(라우트는 today 경로에서 재변환 금지).
    파일 부재(첫 승격 전)면 DuckDB 읽기 생략 → 버퍼만(seam=None).
    """
    from hoga.api.timeenc import hhmmssms_to_unix_ms

    parquet_rows: list[tuple[str, int, int]] = []
    seam_ms: int | None = None
    if path.exists():
        raw = con.execute(
            """
            SELECT broker, ts_ms,
                   SUM(CASE WHEN side = 'buy' THEN qty_today ELSE -qty_today END) AS net
            FROM read_parquet(?) GROUP BY broker, ts_ms
            """,
            [str(path)],
        ).fetchall()
        for b, enc_ts, net in raw:
            unix_ts = hhmmssms_to_unix_ms(date, int(enc_ts))
            parquet_rows.append((b, unix_ts, int(net)))
            seam_ms = unix_ts if seam_ms is None else max(seam_ms, unix_ts)

    tail_rows = [
        (b, t, n)
        for (b, t, n) in broker_rows_from_snapshots(buffer_snapshots)
        if seam_ms is None or t > seam_ms
    ]
    return series_entries_from_rows(parquet_rows + tail_rows)
```

`Path`/`duckdb` 타입 import(파일 상단 TYPE_CHECKING 또는 기존 import) 확인.

- [ ] **Step 4: 통과 확인 (전 today 케이스)**

Run: `uv run pytest tests/unit/api/test_broker_series_seam.py -q`
Expected: PASS (merge·seam경계·파일부재·버퍼빈 4케이스 + 앞 태스크 전부)

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/brokers.py tests/unit/api/test_broker_series_seam.py
git commit -m "feat(brokers): query_day_series_today 봉합 — parquet+버퍼 꼬리, 파일부재 가드 (#9)"
```

---

## Task 4: 라우트 async 전환 + 게이트 + to_thread

**Files:**
- Modify: `hoga/api/routes.py` (brokers_series 192-221, build_router 90)
- Modify: `hoga/api/app.py:218`
- Test: `tests/unit/api/test_broker_series_seam.py`

- [ ] **Step 1: failing 테스트 (today=merged / past=무변경 / hogaplay·무버퍼=parquet-only)**

```python
# TestClient 기반 라우트 테스트. 가짜 get_buffer로 버퍼 주입.
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hoga.api.routes import build_router
# (engine·parquet fixture는 기존 라우트 테스트 헬퍼 재사용 — tests/unit/api/conftest 확인)

def test_route_today_kis_live_merges_tail(broker_engine_today, monkeypatch):
    # date==오늘 & source kis_live & 버퍼 주입 → 꼬리 병합. now_kst를 오늘로 고정.
    class FakeBuf:
        async def get_series(self, code):
            return {"brokers": [{"t_ms": <오늘 09:35 unix>, "buy_top": [...], "sell_top": []}]}
    app = FastAPI(); app.include_router(build_router(broker_engine_today, get_buffer=lambda: FakeBuf()))
    r = TestClient(app).get("/brokers/series", params={"code": "...", "date": "<오늘>", "source_pref": "kis_live"})
    # 병합 결과에 꼬리 ts 포함 확인.

def test_route_past_date_unchanged(broker_engine_past):
    app = FastAPI(); app.include_router(build_router(broker_engine_past, get_buffer=lambda: ...))
    # 과거 날짜 → query_day_series 경로(버퍼 미접근), 기존 응답과 동일.

def test_route_no_buffer_is_parquet_only(broker_engine_today):
    app = FastAPI(); app.include_router(build_router(broker_engine_today))  # get_buffer=None
    # today라도 버퍼 미배선 → parquet-only, 500 안 남.
```

(구체 fixture·종목·날짜는 기존 `tests/unit/api`의 broker series 테스트 패턴을 따라 채움 — `<...>`는 그 헬퍼로 실제 값 대입. 플래너가 conftest 확인 후 확정.)

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/api/test_broker_series_seam.py -k route -q`
Expected: FAIL (build_router에 get_buffer 인자 없음 / 동기 핸들러).

- [ ] **Step 3: 구현**

`routes.py` 상단에 상수:
```python
from hoga.api.sources import SourceName
from hoga.collector.orchestrator import now_kst
import asyncio

_LIVE_CAPTURE_SOURCE: SourceName = "kis_live"
```

`build_router(engine: QueryEngine)` → `build_router(engine: QueryEngine, *, get_buffer=None)`.

`brokers_series`를 async로, 게이트 + to_thread 헬퍼:
```python
    @router.get("/brokers/series", response_model=BrokerSeriesResponse)
    async def brokers_series(
        code: Code, date: StockDate, source_pref: SourceName = Query("hogaplay"),
    ) -> BrokerSeriesResponse:
        sd_dir, source = _resolved_parquet_dir(engine, date, code, source_pref)
        if sd_dir is None:
            return BrokerSeriesResponse(date=date, brokers=[], source=source)
        path = sd_dir / "brokers.parquet"

        use_tail = (
            date == now_kst().strftime("%Y%m%d")
            and source == _LIVE_CAPTURE_SOURCE
            and get_buffer is not None
            and get_buffer() is not None
        )
        buffer_snapshots: list[dict] = []
        if use_tail:
            try:
                buffer_snapshots = (await get_buffer().get_series(code)).get("brokers") or []
            except Exception:  # noqa: BLE001 — 버퍼 일시 오류는 parquet-only 폴백(500 금지)
                _log.exception("brokers.series.buffer_read_failed code=%s", code)
                use_tail = False

        def _compute() -> list:
            if use_tail:
                return brokers_tbl.query_day_series_today(
                    engine.conn, path, date=date, buffer_snapshots=buffer_snapshots
                )
            raw = brokers_tbl.query_day_series(engine.conn, path=path)
            return [
                e.model_copy(update={"points": [
                    p.model_copy(update={"ts_ms": hhmmssms_to_unix_ms(date, p.ts_ms)})
                    for p in e.points]})
                for e in raw
            ]

        entries = await asyncio.to_thread(_compute)
        return BrokerSeriesResponse(date=date, brokers=entries, source=source)
```

`_log`(module logger) 존재 확인, 없으면 `import logging; _log = logging.getLogger(__name__)` 추가.

`app.py:218`: `app.include_router(build_router(engine, get_buffer=live_get_buffer))`.

- [ ] **Step 4: 통과 + 전체 회귀**

Run: `uv run pytest tests/unit/api/test_broker_series_seam.py -q && uv run pytest tests/unit -q`
Expected: PASS (라우트 today/past/무버퍼 + 백엔드 전체)

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/brokers.py hoga/api/routes.py hoga/api/app.py tests/unit/api/test_broker_series_seam.py
git commit -m "feat(brokers): /api/brokers/series today-aware seam (async+to_thread, source 게이트) (#9)"
```

---

## Task 5: 프론트 today-inclusive freshness

**Files:**
- Modify: `frontend/src/api/brokerSeries.ts`
- Test: `frontend/src/api/brokerSeries.test.ts` (Create 또는 기존)

- [ ] **Step 1: failing 테스트**

```typescript
import { brokerSeriesFreshness } from './brokerSeries';
describe('brokerSeriesFreshness', () => {
  it('today-inclusive → 60s refetch', () => {
    expect(brokerSeriesFreshness('20260608', '20260608')).toEqual({ staleTime: 60_000, refetchInterval: 60_000 });
  });
  it('past → no refetch', () => {
    expect(brokerSeriesFreshness('20260601', '20260608')).toEqual({ staleTime: Infinity, refetchInterval: false });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/api/brokerSeries.test.ts`
Expected: FAIL — `brokerSeriesFreshness` 미정의.

- [ ] **Step 3: 구현** (range.ts:36 `rangeFreshnessOptions`와 동형)

```typescript
/** today 포함이면 60초 refetch(승격 cadence보다 짧아 꼬리 전진), 과거면 Infinity.
 *  range.ts rangeFreshnessOptions의 거래원판 — seam 사이징 불변식과 정합. */
export function brokerSeriesFreshness(
  date: string | null,
  todayKst: string | null,
): { staleTime: number; refetchInterval: number | false } {
  const includesToday = !!(date && todayKst && date >= todayKst);
  return includesToday
    ? { staleTime: 60_000, refetchInterval: 60_000 }
    : { staleTime: Infinity, refetchInterval: false };
}
```

`useBrokerSeriesForDay`가 이 freshness를 react-query 옵션에 적용(현 staleTime:Infinity 하드코딩 → `brokerSeriesFreshness(date, todayKst)`로). todayKst 소스는 기존 훅이 쓰는 KST today 유틸 재사용(useRange/useLiveBundle 참조).

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/api/brokerSeries.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/brokerSeries.ts frontend/src/api/brokerSeries.test.ts
git commit -m "feat(brokers): brokerSeriesFreshness — today-inclusive 60s refetch (#9)"
```

---

## Task 6: LiveSidebar latest → day 훅 전환

**Files:**
- Modify: `frontend/src/live/LiveSidebar.tsx:59,77-79`
- Test: `frontend/src/live/LiveSidebar.test.tsx`

- [ ] **Step 1: failing 테스트** — latest 모드에서 거래원 카드가 day 시리즈(useBrokerSeriesForDay) 데이터를 받음을 핀(기존 LiveSidebar.test.tsx 패턴: useBrokerSeriesForDay mock → BrokerTrajectoryTable에 그 series가 전달되는지).

```typescript
it('latest 모드 거래원 카드는 day 시리즈를 쓴다(15분 버퍼 집계 아님)', () => {
  vi.mocked(useBrokerSeriesForDay).mockReturnValue({ brokers: [{ broker: '키움증권', final_net: 100, dominant_side: 'buy', points: [{ts_ms: 1, net: 100}] }] } as any);
  render(<LiveSidebar code="005930" live={emptyLive} />);  // cursorMs null = latest
  // BrokerTrajectoryTable에 day 시리즈가 전달됨을 단언(mock prop capture).
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/LiveSidebar.test.tsx`
Expected: FAIL — latest가 아직 aggregateBrokerSeries(SSE) 사용.

- [ ] **Step 3: 구현**

`LiveSidebar.tsx`: latest 모드 `brokerSeriesForCard`를 `useBrokerSeriesForDay(code, todayKst)` 결과로. 현 59행 `latestBrokerSeries = aggregateBrokerSeries(broker)` 대신 day 훅 사용. spot 분기(`useLiveBrokersAtCursor`)·`brokerCursorMs`(latest=최신 ts)는 유지. `broker.length===0` 가드는 day 훅 로딩 상태로 대체(undefined→로딩).

```tsx
const dayBrokers = useBrokerSeriesForDay(code, todayKst);  // 신규
// ...
const brokerSeriesForCard = isSpot ? spotBrokers : dayBrokers?.brokers;
```

(todayKst 소스·useBrokerSeriesForDay 시그니처는 기존 /replay 사용처와 동일하게. aggregateBrokerSeries는 제거하지 않음 — YAGNI, 후속 audit.)

- [ ] **Step 4: 통과 + tsc + 회귀**

Run: `cd frontend && npx vitest run src/live/LiveSidebar.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc 0

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveSidebar.tsx frontend/src/live/LiveSidebar.test.tsx
git commit -m "feat(live): latest 거래원 카드를 day 시리즈로 — 당일 전체 궤적 (#9)"
```

---

## Task 7: 최종 검증 + 회귀 스윕

- [ ] **Step 1: 백엔드 전체** — `uv run pytest tests/unit -q` (그린)
- [ ] **Step 2: 프론트 전체** — `cd frontend && npx vitest run && npx tsc --noEmit` (그린, 0)
- [ ] **Step 3: ruff** — `uv run ruff check hoga/tables/brokers.py hoga/api/routes.py hoga/api/app.py` (신규 위반 0; baseline 외)
- [ ] **Step 4: 최종 코드 리뷰** — diff 전체를 spec과 대조(접근 B·게이트·인코딩·파일부재 가드·동치 테스트 존재 확인).

---

## Task 8: 브라우저 실측 (장중 이월 — 비범위, 별도 세션)

**장 마감이라 지금 실행 불가.** 평일 09:00–15:30 한 세션에서:
- [ ] /live 거래원 궤적이 **09:00부터** 그려짐(스파크라인이 당일 전체 span).
- [ ] ~60초 내 꼬리 전진(refetch), 봉합점(seam) 근처 **불연속·중복 없음**.
- [ ] 종목 전환·다일 경계에서 day 스왑 정상.
- [ ] 회귀: /replay 거래원 카드 무영향(과거 날짜 = parquet-only 경로).

(이 Task는 구현 PR 머지와 무관하게 다음 장중에 수행 — PR 본문에 "browser-verify pending (market-hours)" 명시.)

---

## Self-Review (writing-plans)

**1. Spec coverage:** 집계 공용화(T1)·버퍼 튜플+동치(T2)·today 봉합+파일부재+unix(T3)·라우트 게이트+async/to_thread(T4)·프론트 freshness(T5)·latest 전환(T6)·검증(T7)·브라우저 이월(T8) — spec 전 섹션 매핑됨. source 게이트(T4)·재시작 견고(설계상 parquet+JSONL, 코드 변경 불요)·net 연속(T2 린치핀)·seam 중복제거(T3) 커버.

**2. Placeholder scan:** T4·T6의 `<...>`/fixture 미정값은 기존 `tests/unit/api`·`LiveSidebar.test.tsx` 헬퍼에서 실제 대입(플래너가 conftest 확인) — 의도된 "기존 패턴 따름"이지 TBD 아님. 핵심 프로덕션 코드·린치핀 테스트는 완전 명시.

**3. Type consistency:** `series_entries_from_rows`(rows)→entries, `broker_rows_from_snapshots`(snapshots)→tuples, `query_day_series_today`(con,path,*,date,buffer_snapshots)→entries(unix-ms), `build_router(engine,*,get_buffer=None)`, `brokerSeriesFreshness(date,todayKst)` — 태스크 간 시그니처 일관.

**비범위:** 접근 A 클라이언트 봉합, SSE broker 전송 제거, aggregateBrokerSeries 삭제, 브라우저 실측(이월).
