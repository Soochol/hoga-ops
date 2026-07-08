# 호가 잔량 히트맵 (Depth Heatmap) 지표 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각 분봉 캔들 시점의 10호가 매수·매도 잔량 분포를 캔들 pane 뒤에 색상 강도(불투명도) 셀로 렌더하는 보조지표를 추가한다.

**Architecture:** 기존 "당일 최대 매물대(trade-volume-poc)" 지표의 end-to-end 파이프라인을 그대로 미러링한다. 백엔드는 `/api/range`에 `depth_heatmap_enabled` 옵트인 파라미터 + `RangeBundle.depth_heatmap` 필드를 추가하고, DuckDB로 버킷별 대표(마지막 연속거래) 스냅샷의 10단계 가격·잔량을 뽑는다. 프론트는 `ISeriesPrimitive`(zOrder='bottom')로 캔들 아래 셀을 그리고, `MAStylePicker` 재활용 Config + Zustand persist로 색·불투명도를 저장한다. 강도는 **보이는 논리 범위 내 최대 잔량**으로 정규화(감마 0.65)한다.

**Tech Stack:** Python 3.12 / FastAPI / DuckDB / Pydantic (backend), React / TypeScript / Zustand / lightweight-charts / fancy-canvas (frontend). 테스트: pytest(`uv run --extra dev pytest`), vitest(`cd frontend && npx vitest run`).

**핵심 미러 대상 (읽고 패턴 따를 것):**
- 백엔드 쿼리: `hoga/tables/snapshots.py` `query_bucketed_ratio` (버킷 대표 선택 SQL — `rep_key`/`arg_max(struct_pack(...))`)
- 백엔드 빌더/모델: `hoga/api/bundle.py` `build_range_bundle` 루프의 `trade_volume_pocs` 처리, `hoga/api/models.py` `TradeVolumePoc`/`RangeBundle`
- 프론트 프리미티브: `frontend/src/chart/TradeVolumePocPrimitive.ts`
- 프론트 오버레이: `frontend/src/live/TradeVolumePocOverlay.tsx`
- 프론트 Config/스토어/영속: `AskPeakConfig.tsx`, `state/livePage.ts`, `state/liveIndicatorsPersistence.ts`

---

## File Structure

**Backend (created/modified):**
- `hoga/tables/snapshots.py` — Modify: `DepthHeatmapRow` dataclass + `query_bucketed_depth_heatmap()` 쿼리 함수 추가
- `hoga/api/models.py` — Modify: `DepthHeatmapPoint` 모델 + `RangeBundle.depth_heatmap` 필드 추가
- `hoga/api/bundle.py` — Modify: `build_depth_heatmap_slice()` 빌더 + `build_range_bundle` 배선(파라미터·루프·리턴)
- `hoga/api/routes.py` — Modify: `depth_heatmap_enabled` 쿼리 파라미터 배선

**Frontend (created/modified):**
- `frontend/src/chart/DepthHeatmapPrimitive.ts` — Create: 셀 렌더 프리미티브
- `frontend/src/live/depthHeatmapAlpha.ts` — Create: α 매핑 + visibleMax 순수함수
- `frontend/src/live/DepthHeatmapOverlay.tsx` — Create: 프리미티브 부착 + visible-range 정규화 React 오버레이
- `frontend/src/live/depthHeatmapWire.ts` — Create: wire→도메인 변환
- `frontend/src/live/indicators/DepthHeatmapConfig.tsx` — Create: 설정 패널
- `frontend/src/api/types.ts` — Modify: `DepthHeatmapPointWire` 타입 + `RangeBundle.depth_heatmap` 필드
- `frontend/src/api/rangeRequest.ts` — Modify: `depth_heatmap_enabled` 파라미터
- `frontend/src/api/range.ts` — Modify: 멀티데이 병합(버킷 t_ms 키 dedup)
- `frontend/src/state/liveIndicatorsPersistence.ts` — Modify: 기본값·타입·검증 병합
- `frontend/src/state/livePage.ts` — Modify: 상태 필드·액션·persist selector
- `frontend/src/live/indicators/IndicatorPanel.tsx` — Modify: 카탈로그 항목 + 토글 + Config 라우팅
- `frontend/src/live/LiveChartRoot.tsx` — Modify: 오버레이 렌더 배선

---

## Task 1: 백엔드 — 버킷 대표 스냅샷 10단계 쿼리

**Files:**
- Modify: `hoga/tables/snapshots.py` (add after `query_bucketed_ratio`, ~line 920)
- Test: `tests/test_tables_snapshots.py`

`query_bucketed_ratio`의 `rep_key`/`arg_max(struct_pack(...))` 관용구를 재사용해, 버킷별 대표(마지막 연속거래) 스냅샷의 10단계 `ask_pN/ask_qN/bid_pN/bid_qN`을 뽑는다. 총잔량 대신 40개 레벨 컬럼을 하나의 struct로 묶어 반환한다.

- [ ] **Step 1: Write the failing test**

`tests/test_tables_snapshots.py`에 추가. 기존 `query_bucketed_ratio` 테스트에서 쓰는 fixture/헬퍼(스냅샷 parquet 작성)를 그대로 재사용한다 — 파일 상단에서 `query_bucketed_ratio`를 import하는 방식과 동일하게 `query_bucketed_depth_heatmap`을 import.

```python
def test_query_bucketed_depth_heatmap_picks_last_continuous_snapshot(tmp_path):
    # 같은 버킷에 스냅샷 2건: 이른 것(qty 100대) + 늦은 것(qty 900대).
    # 대표 = 마지막 연속거래 스냅샷이므로 늦은 것의 잔량이 나와야 한다.
    from hoga.tables.snapshots import query_bucketed_depth_heatmap
    import duckdb

    path = tmp_path / "snapshots.parquet"
    _write_snapshots(  # 이 파일의 기존 헬퍼 (query_bucketed_ratio 테스트가 쓰는 것)
        path,
        rows=[
            _snapshot_row(ts_ms=90000000, ask_base=1000, ask_q=100, bid_base=999, bid_q=100),
            _snapshot_row(ts_ms=90005000, ask_base=1000, ask_q=900, bid_base=999, bid_q=900),
        ],
    )
    con = duckdb.connect()
    rows = query_bucketed_depth_heatmap(con, path=path, bucket_ms=60000)
    assert len(rows) == 1
    row = rows[0]
    assert len(row.ask_prices) == 10 and len(row.ask_qtys) == 10
    assert len(row.bid_prices) == 10 and len(row.bid_qtys) == 10
    assert row.ask_qtys[0] == 900  # 늦은 스냅샷의 잔량
    assert row.bid_qtys[0] == 900
```

주: `_write_snapshots` / `_snapshot_row` / `_snapshot_base`의 정확한 이름은 파일 내 기존 `query_bucketed_ratio` 테스트를 열어 그대로 차용한다. fixture가 다른 시그니처면 그 시그니처에 맞춰 위 두 스냅샷(이른/늦은, 잔량 다름, 같은 분 버킷)을 구성하면 된다.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/test_tables_snapshots.py::test_query_bucketed_depth_heatmap_picks_last_continuous_snapshot -v`
Expected: FAIL — `ImportError: cannot import name 'query_bucketed_depth_heatmap'`

- [ ] **Step 3: Add the dataclass + query function**

`hoga/tables/snapshots.py`에서 `query_bucketed_ratio`(끝 ~line 919) 바로 아래에 추가. `ORDERBOOK_LEVELS`, `hhmmssms_to_intra_ms_sql`, `_DEEP_BOOK_SQL`, `_last_continuous_intra_ms`는 이 모듈에 이미 존재한다.

```python
@dataclass(frozen=True)
class DepthHeatmapRow:
    """버킷 대표(마지막 연속거래) 스냅샷의 10단계 매도/매수 가격·잔량.

    ``bucket_intra_ms``는 LINEAR ms-from-midnight (NOT raw HHMMSSmmm, NOT unix
    ms) — 호출자가 ``ms_from_midnight_to_unix_ms(date, bucket_intra_ms)``로 unix
    변환. QuoteRatioRow.bucket_intra_ms와 동일 규약. 대표 선택 규칙도
    query_bucketed_ratio와 동일(is_pre DESC, ts_ms DESC).

    ``ask_prices``/``ask_qtys``는 index 0 = 최우선(best) 호가. 완전-auction
    버킷은 대표가 없어도 last-in-bucket으로 폴백(정규화는 프론트가 담당하므로
    표시상 문제 없음 — 총잔량 지표처럼 0으로 지울 필요 없다).
    """

    bucket_intra_ms: int
    ask_prices: tuple[int, ...]
    ask_qtys: tuple[int, ...]
    bid_prices: tuple[int, ...]
    bid_qtys: tuple[int, ...]


def query_bucketed_depth_heatmap(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    bucket_ms: int,
    session_close_ms: int | None = None,
) -> list[DepthHeatmapRow]:
    """버킷별 대표 스냅샷의 10단계 가격·잔량을 방출한다.

    대표 = 마지막 연속거래 스냅샷(query_bucketed_ratio와 동일 정의). 40개 레벨
    컬럼을 하나의 struct_pack으로 묶어 arg_max(rep_key)로 한 물리 행에서 함께
    가져온다 — 총잔량 대신 개별 레벨을 보존하는 것만 다르다. Empty parquet → [].
    """
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    last_continuous_ms: int | None = None
    if session_close_ms is not None:
        last_continuous_ms = _last_continuous_intra_ms(
            con, path=path, session_close_ms=session_close_ms
        )
    if last_continuous_ms is None:
        pre_auction_pred = "TRUE"
    else:
        pre_auction_pred = f"({intra_ms_expr} <= {last_continuous_ms})"

    level_cols = []
    for i in range(1, ORDERBOOK_LEVELS + 1):
        level_cols.append(f"ask_p{i} := ask_p{i}")
        level_cols.append(f"ask_q{i} := ask_q{i}")
        level_cols.append(f"bid_p{i} := bid_p{i}")
        level_cols.append(f"bid_q{i} := bid_q{i}")
    struct_body = ", ".join(level_cols)

    rows = con.execute(
        f"""
        WITH keyed AS (
          SELECT ({intra_ms_expr} // {bucket_ms}) AS bucket,
                 ((CASE WHEN ({pre_auction_pred}) THEN 1 ELSE 0 END) * 100000000
                   + ({intra_ms_expr})) AS rep_key,
                 {", ".join(f"ask_p{i}, ask_q{i}, bid_p{i}, bid_q{i}" for i in range(1, ORDERBOOK_LEVELS + 1))}
          FROM read_parquet(?)
        )
        SELECT bucket * {bucket_ms} AS bucket_intra_ms,
               arg_max(struct_pack({struct_body}), rep_key) AS rep
        FROM keyed
        GROUP BY bucket
        ORDER BY bucket
        """,
        [str(path)],
    ).fetchall()
    out: list[DepthHeatmapRow] = []
    for r in rows:
        rep = r[1]
        out.append(
            DepthHeatmapRow(
                bucket_intra_ms=int(r[0]),
                ask_prices=tuple(int(rep[f"ask_p{i}"]) for i in range(1, ORDERBOOK_LEVELS + 1)),
                ask_qtys=tuple(int(rep[f"ask_q{i}"]) for i in range(1, ORDERBOOK_LEVELS + 1)),
                bid_prices=tuple(int(rep[f"bid_p{i}"]) for i in range(1, ORDERBOOK_LEVELS + 1)),
                bid_qtys=tuple(int(rep[f"bid_q{i}"]) for i in range(1, ORDERBOOK_LEVELS + 1)),
            )
        )
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/test_tables_snapshots.py::test_query_bucketed_depth_heatmap_picks_last_continuous_snapshot -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -m "feat(snapshots): 버킷 대표 10단계 잔량 쿼리 query_bucketed_depth_heatmap"
```

---

## Task 2: 백엔드 — DepthHeatmapPoint 모델 + RangeBundle 필드

**Files:**
- Modify: `hoga/api/models.py` (add `DepthHeatmapPoint` near `TradeVolumePoc` ~line 607; add field to `RangeBundle` ~line 671)
- Test: `tests/test_api_models.py` (기존 모델 테스트 파일; 없으면 `tests/test_api_bundle.py`에 인라인)

- [ ] **Step 1: Write the failing test**

```python
def test_depth_heatmap_point_defaults_and_shape():
    from hoga.api.models import DepthHeatmapPoint, RangeBundle
    pt = DepthHeatmapPoint(
        t_ms=1_700_000_000_000,
        asks=[[1000, 500], [1010, 300]],
        bids=[[990, 400], [980, 200]],
    )
    assert pt.asks[0] == [1000, 500]
    # RangeBundle 기본값은 빈 리스트여야 한다(옵트인 미요청 시).
    bundle = RangeBundle(
        code="005930", from_date="20260101", to_date="20260101", bucket_ms=60000,
    )
    assert bundle.depth_heatmap == []
```

주: `RangeBundle` 생성에 필요한 필수 필드는 기존 `tests/`의 RangeBundle 생성 예시를 그대로 참고해 채운다(위 4개로 부족하면 기존 테스트의 최소 생성자 인자를 복사).

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/test_api_models.py::test_depth_heatmap_point_defaults_and_shape -v`
Expected: FAIL — `ImportError: cannot import name 'DepthHeatmapPoint'`

- [ ] **Step 3: Add the model + bundle field**

`hoga/api/models.py`, `TradeVolumePoc`(~line 607) 부근에 추가:

```python
class DepthHeatmapPoint(BaseModel):
    """한 분봉 버킷의 대표 스냅샷 10호가 잔량 분포.

    ``t_ms``는 버킷 시작 unix ms (bucket_ms 정렬, ApiCandle.ts_ms와 동일 축).
    ``asks``/``bids``는 각 최대 10단계 ``[price, qty]`` — asks는 가격 오름차순
    (index 0 = 최우선 매도), bids는 가격 내림차순(index 0 = 최우선 매수).
    잔량 0 단계는 프론트에서 렌더 스킵되므로 그대로 실어 보낸다.
    """

    t_ms: int
    asks: list[list[int]] = Field(default_factory=list)
    bids: list[list[int]] = Field(default_factory=list)
```

`RangeBundle`(~line 671, `bid_peaks` 필드 옆)에 필드 추가:

```python
    depth_heatmap: list["DepthHeatmapPoint"] = Field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/test_api_models.py::test_depth_heatmap_point_defaults_and_shape -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/test_api_models.py
git commit -m "feat(models): DepthHeatmapPoint + RangeBundle.depth_heatmap 필드"
```

---

## Task 3: 백엔드 — build_depth_heatmap_slice 빌더

**Files:**
- Modify: `hoga/api/bundle.py` (add `build_depth_heatmap_slice` near `build_trade_volume_poc_slice` ~line 831)
- Test: `tests/test_api_bundle.py`

버킷 대표 쿼리 결과를 `DepthHeatmapPoint` 리스트로 변환. `ms_from_midnight_to_unix_ms`로 시간 변환(총잔량/호가비 빌더와 동일). trade-volume-poc와 달리 캐시는 이번 슬라이스에선 생략(당일 폴 dedup은 TODAY_TTL로 별도 태스크; 우선 정확성 확보). 매도벽 쿼리 같은 무거운 non-equi join이 아니라 단일 GROUP BY라 PEAK_SLICE_GUARD 불필요.

- [ ] **Step 1: Write the failing test**

```python
def test_build_depth_heatmap_slice_converts_rows_to_points(monkeypatch):
    from hoga.api import bundle as bundle_mod
    from hoga.tables.snapshots import DepthHeatmapRow

    # query_bucketed_depth_heatmap을 스텁: 버킷 1개, 10단계 채움.
    def fake_query(con, *, path, bucket_ms, session_close_ms=None):
        return [
            DepthHeatmapRow(
                bucket_intra_ms=34_200_000,  # 09:30 in linear ms
                ask_prices=tuple(1000 + 10 * i for i in range(10)),
                ask_qtys=tuple(500 - 10 * i for i in range(10)),
                bid_prices=tuple(990 - 10 * i for i in range(10)),
                bid_qtys=tuple(400 - 10 * i for i in range(10)),
            )
        ]
    monkeypatch.setattr(bundle_mod.snapshots_tbl, "query_bucketed_depth_heatmap", fake_query)

    points = bundle_mod.build_depth_heatmap_slice(
        engine=_fake_engine_with_snapshots(),  # 기존 bundle 테스트의 엔진 헬퍼 차용
        code="005930", date="20260102", bucket_ms=60000, source="hogaplay",
        session_open_ms=90000000, session_close_ms=153000000,
    )
    assert len(points) == 1
    pt = points[0]
    assert len(pt.asks) == 10 and pt.asks[0] == [1000, 500]
    assert len(pt.bids) == 10 and pt.bids[0] == [990, 400]
    # t_ms는 unix ms (버킷 intra_ms → 그날 unix). 축은 ApiCandle.ts_ms와 동일.
    assert pt.t_ms > 1_000_000_000_000
```

주: `_fake_engine_with_snapshots` / 엔진 헬퍼는 `tests/test_api_bundle.py`에서 `build_trade_volume_poc_slice` 또는 `build_ask_bid_peak_slices` 테스트가 쓰는 헬퍼를 그대로 차용한다. `snapshots_tbl` 심볼이 `bundle.py`에서 어떤 이름으로 import됐는지 확인해(`grep -n "snapshots" hoga/api/bundle.py`) monkeypatch 경로를 맞춘다.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/test_api_bundle.py::test_build_depth_heatmap_slice_converts_rows_to_points -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'build_depth_heatmap_slice'`

- [ ] **Step 3: Add the builder**

`hoga/api/bundle.py`, `build_trade_volume_poc_slice`(~line 831) 부근에 추가. 파일 상단 import에 `DepthHeatmapPoint`를 추가한다(기존 `from hoga.api.models import ...` 블록에). `ms_from_midnight_to_unix_ms`가 어떤 이름으로 import됐는지 `grep -n "ms_from_midnight_to_unix_ms\|from hoga.api.timeenc" hoga/api/bundle.py`로 확인 후 사용.

```python
def build_depth_heatmap_slice(
    engine: QueryEngine,
    *,
    code: str,
    date: str,
    bucket_ms: int,
    source: str = "hogaplay",
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> list[DepthHeatmapPoint]:
    """버킷별 대표 스냅샷의 10호가 잔량 분포를 DepthHeatmapPoint 리스트로.

    query_bucketed_depth_heatmap은 LINEAR intra_ms를 주므로
    ms_from_midnight_to_unix_ms(date, intra)로 unix 변환 — 호가비/총잔량 빌더와
    동일 규약. 잔량 0 단계도 그대로 실어 보낸다(프론트가 스킵)."""
    try:
        path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    except (FileNotFoundError, StockDateNotFound):
        return []
    if not path_obj.exists():
        return []
    rows = snapshots_tbl.query_bucketed_depth_heatmap(
        engine.conn,
        path=path_obj,
        bucket_ms=bucket_ms,
        session_close_ms=session_close_ms,
    )
    out: list[DepthHeatmapPoint] = []
    for r in rows:
        t_ms = ms_from_midnight_to_unix_ms(date, r.bucket_intra_ms)
        out.append(
            DepthHeatmapPoint(
                t_ms=t_ms,
                asks=[[p, q] for p, q in zip(r.ask_prices, r.ask_qtys)],
                bids=[[p, q] for p, q in zip(r.bid_prices, r.bid_qtys)],
            )
        )
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --extra dev pytest tests/test_api_bundle.py::test_build_depth_heatmap_slice_converts_rows_to_points -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py tests/test_api_bundle.py
git commit -m "feat(bundle): build_depth_heatmap_slice — 버킷 대표 10호가 분포 변환"
```

---

## Task 4: 백엔드 — build_range_bundle 배선 + 라우트 파라미터

**Files:**
- Modify: `hoga/api/bundle.py` (`build_range_bundle` 시그니처 ~line 1005, 루프 ~line 1081, 리턴 ~line 1305)
- Modify: `hoga/api/routes.py` (`api_range` 파라미터 ~line 306, 호출 ~line 360)
- Test: `tests/test_api_bundle.py`

- [ ] **Step 1: Write the failing test**

```python
def test_range_bundle_includes_depth_heatmap_when_enabled(fake_engine_with_capture):
    # 캡처 있는 단일 거래일 fixture로 build_range_bundle 호출.
    from hoga.api.bundle import build_range_bundle
    bundle = build_range_bundle(
        fake_engine_with_capture.engine,
        code=fake_engine_with_capture.code,
        from_date=fake_engine_with_capture.date,
        to_date=fake_engine_with_capture.date,
        bucket_ms=60000,
        mode="sidecar",
        depth_heatmap_enabled=True,
    )
    assert len(bundle.depth_heatmap) > 0
    assert all(len(p.asks) <= 10 for p in bundle.depth_heatmap)


def test_range_bundle_omits_depth_heatmap_when_disabled(fake_engine_with_capture):
    from hoga.api.bundle import build_range_bundle
    bundle = build_range_bundle(
        fake_engine_with_capture.engine,
        code=fake_engine_with_capture.code,
        from_date=fake_engine_with_capture.date,
        to_date=fake_engine_with_capture.date,
        bucket_ms=60000,
        mode="sidecar",
        depth_heatmap_enabled=False,
    )
    assert bundle.depth_heatmap == []
```

주: `fake_engine_with_capture` fixture는 기존 `test_api_bundle.py`가 `trade_volume_poc`/`ask_peaks`를 검증할 때 쓰는 "실제 캡처 fixture 로드" 헬퍼를 그대로 사용한다. 해당 fixture 이름/구조를 파일에서 확인해 맞춘다.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --extra dev pytest tests/test_api_bundle.py -k depth_heatmap -v`
Expected: FAIL — `TypeError: build_range_bundle() got an unexpected keyword argument 'depth_heatmap_enabled'`

- [ ] **Step 3: Wire the bundle builder**

`hoga/api/bundle.py` `build_range_bundle`:

시그니처(~line 1008, `trade_volume_poc_enabled` 옆)에 추가:
```python
    depth_heatmap_enabled: bool = True,
```

include 게이트(~line 1046, `include_trade_volume_pocs` 옆)에 추가:
```python
    include_depth_heatmap = include_optional_sidecar_slices and depth_heatmap_enabled
```

누적 리스트 선언(~line 1075, `trade_volume_pocs: list[TradeVolumePoc] = []` 옆)에 추가:
```python
    depth_heatmap: list[DepthHeatmapPoint] = []
```

루프 안에서 `trade_volume_poc` 슬라이스를 계산·append하는 지점을 찾아(`grep -n "build_trade_volume_poc_slice\|trade_volume_pocs.append\|trade_volume_pocs\.extend\|include_trade_volume_pocs" hoga/api/bundle.py`) 그 바로 뒤에 다음을 추가. `session_open_ms`/`session_close_ms`가 루프에서 어떤 지역 변수명으로 이미 계산돼 있는지 확인해(총잔량/peak 슬라이스가 쓰는 값) 그대로 넘긴다:
```python
        if include_depth_heatmap:
            depth_heatmap.extend(
                build_depth_heatmap_slice(
                    engine,
                    code=code,
                    date=d,
                    bucket_ms=bucket_ms,
                    source=source,
                    session_open_ms=session_open_ms,
                    session_close_ms=session_close_ms,
                )
            )
```

리턴 `RangeBundle(...)`(~line 1305, `bid_peaks=bid_peaks,` 옆)에 추가:
```python
        depth_heatmap=depth_heatmap,
```

`_empty_range_bundle`(~line 956)도 `ask_peaks=[]` 옆에 `depth_heatmap=[]`을 추가(Pydantic 기본값이 있어 생략해도 되지만 명시).

- [ ] **Step 4: Wire the route parameter**

`hoga/api/routes.py` `api_range`:

파라미터(~line 309, `trade_volume_poc_enabled` 옆)에 추가:
```python
        depth_heatmap_enabled: bool = Query(True),
```

`build_range_bundle(...)` 호출(~line 363, `trade_volume_poc_enabled=trade_volume_poc_enabled,` 옆)에 추가:
```python
                depth_heatmap_enabled=depth_heatmap_enabled,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/test_api_bundle.py -k depth_heatmap -v`
Expected: PASS (both)

- [ ] **Step 6: Full backend regression**

Run: `uv run --extra dev pytest tests/test_api_bundle.py tests/test_tables_snapshots.py tests/test_api_models.py -q`
Expected: PASS (기존 테스트 무회귀)

- [ ] **Step 7: Commit**

```bash
git add hoga/api/bundle.py hoga/api/routes.py tests/test_api_bundle.py
git commit -m "feat(range): depth_heatmap 슬라이스 배선 + depth_heatmap_enabled 파라미터"
```

---

## Task 5: 프론트 — wire 타입 + 요청 파라미터 + 멀티데이 병합

**Files:**
- Modify: `frontend/src/api/types.ts` (`DepthHeatmapPointWire` + `RangeBundle.depth_heatmap`)
- Modify: `frontend/src/api/rangeRequest.ts` (`depth_heatmap_enabled`)
- Modify: `frontend/src/api/range.ts` (병합)
- Test: `frontend/src/api/range.depthHeatmap.test.ts`

- [ ] **Step 1: Add wire type**

`frontend/src/api/types.ts`, `TradeVolumePocWire` 부근 + `RangeBundle`(~line 598) 안:
```typescript
export type DepthHeatmapPointWire = {
  t_ms: number;
  asks: [number, number][];
  bids: [number, number][];
};
```
`RangeBundle` 타입(`trade_volume_pocs?` 옆, ~line 604)에 추가:
```typescript
  depth_heatmap?: DepthHeatmapPointWire[];
```

- [ ] **Step 2: Add request param**

`frontend/src/api/rangeRequest.ts`. 먼저 input 구조분해(`depthHeatmapEnabled`)를 `tradeVolumePocEnabled` 옆에 추가하고(해당 파일 상단의 input 디스트럭처링 확인), 파라미터 추가(~line 122, `addBoolParam(params, 'trade_volume_poc_enabled', ...)` 옆):
```typescript
  addBoolParam(params, 'depth_heatmap_enabled', depthHeatmapEnabled);
```
`RangeRequestInput` 타입에도 `depthHeatmapEnabled?: boolean;`를 추가(파일 내 해당 타입 정의 위치에).

- [ ] **Step 3: Write the failing merge test**

`frontend/src/api/range.depthHeatmap.test.ts` 생성. 병합 함수 이름은 `api/range.ts`에서 `mergeRangeBundles`(또는 유사)로 export된 것을 확인해 사용:
```typescript
import { describe, it, expect } from 'vitest';
import { mergeRangeBundles } from './range';

describe('depth_heatmap merge', () => {
  it('버킷 t_ms 단위로 dedup하고 오름차순 정렬한다', () => {
    const prev = { depth_heatmap: [{ t_ms: 100, asks: [], bids: [] }] };
    const next = { depth_heatmap: [{ t_ms: 100, asks: [[1, 2]], bids: [] }, { t_ms: 200, asks: [], bids: [] }] };
    const merged = mergeRangeBundles(prev as never, next as never, [] as never);
    expect(merged.depth_heatmap!.map((p) => p.t_ms)).toEqual([100, 200]);
    // 같은 t_ms는 next가 이긴다(latest-wins).
    expect(merged.depth_heatmap!.find((p) => p.t_ms === 100)!.asks).toEqual([[1, 2]]);
  });
});
```
주: `mergeRangeBundles` 시그니처(인자 개수·nextDates 위치)를 실제 파일에서 확인해 호출을 맞춘다.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api/range.depthHeatmap.test.ts`
Expected: FAIL — `depth_heatmap` undefined

- [ ] **Step 5: Add the merge**

`frontend/src/api/range.ts`, `trade_volume_pocs` 병합(~line 362) 옆에 추가. depth_heatmap은 **날짜가 아니라 버킷 t_ms 단위**이므로 `outsideCoveredDates`가 아니라 `uniqueBy`로 t_ms dedup(next 우선). `uniqueBy(items, keyFn, cmpFn)`가 뒤 항목을 우선하는지 앞을 우선하는지 확인 — `ask_peaks`처럼 `[...previous, ...next]` 순서로 넣고 uniqueBy가 마지막(next)을 남기면 그대로, 아니면 `[...next, ...previous]`로 순서를 뒤집는다:
```typescript
    depth_heatmap: uniqueBy(
      [...(previous.depth_heatmap ?? []), ...(next.depth_heatmap ?? [])],
      (p) => String(p.t_ms),
      (a, b) => a.t_ms - b.t_ms,
    ),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/api/range.depthHeatmap.test.ts`
Expected: PASS. 같은 t_ms에서 next가 이기지 않으면 배열 순서를 뒤집고 재실행.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/rangeRequest.ts frontend/src/api/range.ts frontend/src/api/range.depthHeatmap.test.ts
git commit -m "feat(api): depth_heatmap wire 타입·요청 파라미터·버킷 병합"
```

---

## Task 6: 프론트 — α 매핑 순수함수

**Files:**
- Create: `frontend/src/live/depthHeatmapAlpha.ts`
- Test: `frontend/src/live/depthHeatmapAlpha.test.ts`

강도 정규화 로직을 프리미티브/오버레이에서 분리한 순수함수로. `α = maxOpacity × (qty / visibleMax)^0.65`, 경계 방어.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { levelAlpha, visibleMaxQty } from './depthHeatmapAlpha';
import type { DepthHeatmapPoint } from './depthHeatmapWire';

describe('depthHeatmapAlpha', () => {
  it('qty=visibleMax면 α=maxOpacity, qty=0이면 α=0', () => {
    expect(levelAlpha(1000, 1000, 0.7)).toBeCloseTo(0.7, 5);
    expect(levelAlpha(0, 1000, 0.7)).toBe(0);
  });
  it('감마 0.65로 중간값을 들어올린다 (선형보다 크다)', () => {
    const a = levelAlpha(500, 1000, 1);
    expect(a).toBeCloseTo(Math.pow(0.5, 0.65), 5);
    expect(a).toBeGreaterThan(0.5);
  });
  it('visibleMax=0이면 0 (0나눗셈 방어)', () => {
    expect(levelAlpha(100, 0, 0.7)).toBe(0);
  });
  it('visibleMaxQty는 보이는 범위 내 모든 레벨의 최대 잔량', () => {
    const points: DepthHeatmapPoint[] = [
      { tMs: 100, asks: [{ price: 10, qty: 300 }], bids: [{ price: 9, qty: 900 }] },
      { tMs: 200, asks: [{ price: 11, qty: 500 }], bids: [{ price: 8, qty: 100 }] },
    ];
    expect(visibleMaxQty(points, 0, 250)).toBe(900);
    expect(visibleMaxQty(points, 150, 250)).toBe(500); // tMs=100 제외
    expect(visibleMaxQty(points, 0, 50)).toBe(0);       // 아무것도 안 보임
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/depthHeatmapAlpha.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`frontend/src/live/depthHeatmapAlpha.ts`:
```typescript
import type { DepthHeatmapPoint } from './depthHeatmapWire';

const GAMMA = 0.65;

/** 한 호가 레벨의 불투명도. qty/visibleMax를 감마 보정 후 maxOpacity 스케일. */
export function levelAlpha(qty: number, visibleMax: number, maxOpacity: number): number {
  if (visibleMax <= 0 || qty <= 0) return 0;
  const ratio = Math.min(1, qty / visibleMax);
  return maxOpacity * Math.pow(ratio, GAMMA);
}

/** 보이는 unix-ms 범위 [fromMs, toMs] 내 모든 매수·매도 레벨 잔량의 최댓값. */
export function visibleMaxQty(
  points: readonly DepthHeatmapPoint[],
  fromMs: number,
  toMs: number,
): number {
  let max = 0;
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    for (const lvl of pt.asks) if (lvl.qty > max) max = lvl.qty;
    for (const lvl of pt.bids) if (lvl.qty > max) max = lvl.qty;
  }
  return max;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/depthHeatmapAlpha.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/depthHeatmapAlpha.ts frontend/src/live/depthHeatmapAlpha.test.ts
git commit -m "feat(live): depthHeatmap α 매핑 순수함수 (감마 0.65 + visibleMax)"
```

---

## Task 7: 프론트 — wire→도메인 변환

**Files:**
- Create: `frontend/src/live/depthHeatmapWire.ts`
- Test: `frontend/src/live/depthHeatmapWire.test.ts`

`tradeVolumePocWire.ts` 미러. `[price, qty]` 튜플 배열을 `{price, qty}` 객체 배열로.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { depthHeatmapFromWire } from './depthHeatmapWire';

describe('depthHeatmapFromWire', () => {
  it('wire 튜플을 도메인 객체로 변환한다', () => {
    const out = depthHeatmapFromWire([
      { t_ms: 100, asks: [[1000, 500], [1010, 300]], bids: [[990, 400]] },
    ]);
    expect(out).toEqual([
      { tMs: 100, asks: [{ price: 1000, qty: 500 }, { price: 1010, qty: 300 }], bids: [{ price: 990, qty: 400 }] },
    ]);
  });
  it('null/undefined는 빈 배열', () => {
    expect(depthHeatmapFromWire(null)).toEqual([]);
    expect(depthHeatmapFromWire(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/depthHeatmapWire.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`frontend/src/live/depthHeatmapWire.ts`:
```typescript
import type { DepthHeatmapPointWire } from '../api/types';

export type DepthHeatmapLevel = { price: number; qty: number };
export type DepthHeatmapPoint = {
  tMs: number;
  asks: DepthHeatmapLevel[];
  bids: DepthHeatmapLevel[];
};

function levels(pairs: readonly [number, number][]): DepthHeatmapLevel[] {
  return pairs.map(([price, qty]) => ({ price, qty }));
}

export function depthHeatmapFromWire(
  points: readonly DepthHeatmapPointWire[] | null | undefined,
): DepthHeatmapPoint[] {
  return (points ?? []).map((p) => ({
    tMs: p.t_ms,
    asks: levels(p.asks),
    bids: levels(p.bids),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/depthHeatmapWire.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/depthHeatmapWire.ts frontend/src/live/depthHeatmapWire.test.ts
git commit -m "feat(live): depthHeatmap wire→도메인 변환"
```

---

## Task 8: 프론트 — DepthHeatmapPrimitive (셀 렌더)

**Files:**
- Create: `frontend/src/chart/DepthHeatmapPrimitive.ts`
- Test: `frontend/src/chart/DepthHeatmapPrimitive.test.ts`

`TradeVolumePocPrimitive.ts` 구조를 그대로 따르되, 세그먼트 대신 "셀" 배열을 그린다. 각 셀 = 한 버킷 × 한 호가 레벨. 셀 지오메트리는 오버레이가 미리 계산해 넘긴다(프리미티브는 좌표 변환 + fillRect만). y 높이는 1틱(인접 레벨 가격차)으로, 오버레이가 `halfTick`을 함께 넘긴다.

- [ ] **Step 1: Write the failing test**

프리미티브는 캔버스 draw라 단위 테스트가 얕다. 셀 데이터 setter/getter와 zOrder만 검증:
```typescript
import { describe, it, expect } from 'vitest';
import { DepthHeatmapPrimitive } from './DepthHeatmapPrimitive';

describe('DepthHeatmapPrimitive', () => {
  it('setCells가 셀을 저장하고 zOrder를 반영한다', () => {
    const prim = new DepthHeatmapPrimitive({ zOrder: 'bottom' });
    prim.setCells([
      { time: 100 as never, price: 1000, halfTick: 50, fillColor: 'rgba(240,68,82,0.5)' },
    ]);
    expect(prim.cellsData().length).toBe(1);
    expect(prim.zOrder()).toBe('bottom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/chart/DepthHeatmapPrimitive.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`frontend/src/chart/DepthHeatmapPrimitive.ts` — `TradeVolumePocPrimitive.ts`를 복사·개명. `draw`에서 셀마다 x = `timeToCoordinate(time)` 중심 ± 반슬롯, y = `priceToCoordinate(price)` ± `priceToCoordinate(price±halfTick)`로 높이 산출. 슬롯 폭은 `chart.timeScale().options().barSpacing`으로 근사:
```typescript
import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi,
  ISeriesPrimitive, PrimitivePaneViewZOrder, SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export type DepthHeatmapCell = {
  time: Time;
  price: number;
  halfTick: number;   // 셀 y 반높이(가격 단위)
  fillColor: string;
};

export type DepthHeatmapPrimitiveOptions = { zOrder?: PrimitivePaneViewZOrder };

class DepthHeatmapRenderer implements IPrimitivePaneRenderer {
  private readonly source: DepthHeatmapPrimitive;
  constructor(source: DepthHeatmapPrimitive) { this.source = source; }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chartApi();
    const series = this.source.seriesApi();
    const cells = this.source.cellsData();
    if (!chart || !series || cells.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const timeScale = chart.timeScale();
      // 셀 가로폭 = barSpacing(논리→px)의 약 90%; 좌우 대칭.
      const barSpacing = timeScale.options().barSpacing;
      const halfW = Math.max(1, (barSpacing * 0.9) / 2);
      for (const cell of cells) {
        const x = timeScale.timeToCoordinate(cell.time);
        const yMid = series.priceToCoordinate(cell.price);
        const yEdge = series.priceToCoordinate(cell.price + cell.halfTick);
        if (x === null || yMid === null || yEdge === null) continue;
        const cellHalfH = Math.abs(yMid - yEdge);
        const left = (x - halfW) * hr;
        const width = Math.max(1, halfW * 2 * hr);
        const top = (yMid - cellHalfH) * vr;
        const height = Math.max(1, cellHalfH * 2 * vr);
        ctx.fillStyle = cell.fillColor;
        ctx.fillRect(left, top, width, height);
      }
    });
  }
}

class DepthHeatmapPaneView implements IPrimitivePaneView {
  private readonly source: DepthHeatmapPrimitive;
  private readonly rendererRef: DepthHeatmapRenderer;
  constructor(source: DepthHeatmapPrimitive) {
    this.source = source;
    this.rendererRef = new DepthHeatmapRenderer(source);
  }
  renderer(): IPrimitivePaneRenderer { return this.rendererRef; }
  zOrder(): PrimitivePaneViewZOrder { return this.source.zOrder(); }
}

export class DepthHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private cells: readonly DepthHeatmapCell[] = [];
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private readonly paneView: DepthHeatmapPaneView;
  private readonly paneZOrder: PrimitivePaneViewZOrder;

  constructor(options: DepthHeatmapPrimitiveOptions = {}) {
    this.paneZOrder = options.zOrder ?? 'bottom';
    this.paneView = new DepthHeatmapPaneView(this);
  }
  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart; this.series = param.series; this.requestUpdate = param.requestUpdate;
  }
  detached(): void { this.chart = null; this.series = null; this.requestUpdate = undefined; }
  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return [this.paneView]; }
  setCells(cells: readonly DepthHeatmapCell[]): void { this.cells = cells; this.requestUpdate?.(); }
  cellsData(): readonly DepthHeatmapCell[] { return this.cells; }
  chartApi(): IChartApi | null { return this.chart; }
  seriesApi(): ISeriesApi<SeriesType> | null { return this.series; }
  zOrder(): PrimitivePaneViewZOrder { return this.paneZOrder; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/chart/DepthHeatmapPrimitive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/DepthHeatmapPrimitive.ts frontend/src/chart/DepthHeatmapPrimitive.test.ts
git commit -m "feat(chart): DepthHeatmapPrimitive — 캔들 뒤 호가 잔량 셀 렌더"
```

---

## Task 9: 프론트 — 스토어 상태·액션·영속

**Files:**
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts` (기본값·타입·병합 검증)
- Modify: `frontend/src/state/livePage.ts` (state·action·persist selector)
- Test: `frontend/src/state/liveIndicatorsPersistence.test.ts` (기존 파일에 케이스 추가)

`tradeVolumePoc`의 색+불투명도 저장 패턴을 그대로 미러. 필드: `depthHeatmapEnabled`, `depthHeatmapBidColor`, `depthHeatmapAskColor`, `depthHeatmapMaxOpacity`.

- [ ] **Step 1: Write the failing persistence test**

`liveIndicatorsPersistence.test.ts`에 추가(기존 `mergeLiveIndicatorPrefs` 테스트 스타일):
```typescript
it('depthHeatmap 기본값을 채운다', () => {
  const merged = mergeLiveIndicatorPrefs({});
  expect(merged.depthHeatmapEnabled).toBe(false);
  expect(merged.depthHeatmapBidColor).toBe('#F04452');
  expect(merged.depthHeatmapAskColor).toBe('#3485FA');
  expect(merged.depthHeatmapMaxOpacity).toBeCloseTo(0.7, 5);
});
it('depthHeatmap 잘못된 색/불투명도는 기본값으로 폴백', () => {
  const merged = mergeLiveIndicatorPrefs({
    depthHeatmapBidColor: 'not-a-hex', depthHeatmapMaxOpacity: 5,
  } as never);
  expect(merged.depthHeatmapBidColor).toBe('#F04452');
  expect(merged.depthHeatmapMaxOpacity).toBeCloseTo(0.7, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts`
Expected: FAIL — `depthHeatmapEnabled` undefined

- [ ] **Step 3: Add defaults, type, merge**

`frontend/src/state/liveIndicatorsPersistence.ts`:

기본값(~line 72, `TRADE_VOLUME_POC_DEFAULT_OPACITY` 옆):
```typescript
export const DEPTH_HEATMAP_DEFAULT_BID_COLOR = '#F04452';
export const DEPTH_HEATMAP_DEFAULT_ASK_COLOR = '#3485FA';
export const DEPTH_HEATMAP_DEFAULT_MAX_OPACITY = 0.7;
```

`PersistedIndicators` 타입(~line 128, `tradeVolumePocOpacity: number;` 옆):
```typescript
  depthHeatmapEnabled: boolean;
  depthHeatmapBidColor: string;
  depthHeatmapAskColor: string;
  depthHeatmapMaxOpacity: number;
```

`mergeLiveIndicatorPrefs`(~line 217) 안에서 `tvpColor`/`tvpBandPct` 계산 옆에 추가하고 반환 객체에 실어준다. `HEX_COLOR` 정규식은 이미 파일에 있다:
```typescript
  const dhBidColor = typeof obj?.depthHeatmapBidColor === 'string'
    && HEX_COLOR.test(obj.depthHeatmapBidColor as string)
    ? (obj.depthHeatmapBidColor as string) : DEPTH_HEATMAP_DEFAULT_BID_COLOR;
  const dhAskColor = typeof obj?.depthHeatmapAskColor === 'string'
    && HEX_COLOR.test(obj.depthHeatmapAskColor as string)
    ? (obj.depthHeatmapAskColor as string) : DEPTH_HEATMAP_DEFAULT_ASK_COLOR;
  const dhOpacityRaw = obj?.depthHeatmapMaxOpacity;
  const dhMaxOpacity = typeof dhOpacityRaw === 'number' && dhOpacityRaw >= 0.2 && dhOpacityRaw <= 1
    ? dhOpacityRaw : DEPTH_HEATMAP_DEFAULT_MAX_OPACITY;
```
반환 객체에 추가:
```typescript
    depthHeatmapEnabled: typeof obj?.depthHeatmapEnabled === 'boolean' ? obj.depthHeatmapEnabled : false,
    depthHeatmapBidColor: dhBidColor,
    depthHeatmapAskColor: dhAskColor,
    depthHeatmapMaxOpacity: dhMaxOpacity,
```

- [ ] **Step 4: Run persistence test to verify it passes**

Run: `cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the Zustand store**

`frontend/src/state/livePage.ts`. `state/liveIndicatorsPersistence`에서 3개 기본값 상수를 import(파일 상단 import 블록, `TRADE_VOLUME_POC_DEFAULT_OPACITY` 옆). 스토어 타입(액션 시그니처 ~line 157, `setTradeVolumePocStyle` 옆)에 추가:
```typescript
  depthHeatmapEnabled: boolean;
  depthHeatmapBidColor: string;
  depthHeatmapAskColor: string;
  depthHeatmapMaxOpacity: number;
  setDepthHeatmapEnabled: (enabled: boolean) => void;
  setDepthHeatmapStyle: (patch: { bidColor?: string; askColor?: string; maxOpacity?: number }) => void;
```

초기 state는 persist된 값에서 온다 — `mergeLiveIndicatorPrefs` 결과를 초기 state로 펼치는 지점(`tradeVolumePocColor: persisted.tradeVolumePocColor` 같은 라인들)을 찾아 그 옆에 4개 필드를 동일 방식으로 추가:
```typescript
  depthHeatmapEnabled: persisted.depthHeatmapEnabled,
  depthHeatmapBidColor: persisted.depthHeatmapBidColor,
  depthHeatmapAskColor: persisted.depthHeatmapAskColor,
  depthHeatmapMaxOpacity: persisted.depthHeatmapMaxOpacity,
```

persist selector(~line 278, `tradeVolumePocOpacity: s.tradeVolumePocOpacity,` 옆)에 추가:
```typescript
    depthHeatmapEnabled: s.depthHeatmapEnabled,
    depthHeatmapBidColor: s.depthHeatmapBidColor,
    depthHeatmapAskColor: s.depthHeatmapAskColor,
    depthHeatmapMaxOpacity: s.depthHeatmapMaxOpacity,
```

액션 구현(~line 506, `setTradeVolumePocStyle` 옆). `set`으로 부분 갱신하는 기존 스타일 그대로:
```typescript
  setDepthHeatmapEnabled: (enabled) => {
    set({ depthHeatmapEnabled: enabled });
  },
  setDepthHeatmapStyle: (patch) => {
    set((s) => ({
      depthHeatmapBidColor: patch.bidColor ?? s.depthHeatmapBidColor,
      depthHeatmapAskColor: patch.askColor ?? s.depthHeatmapAskColor,
      depthHeatmapMaxOpacity: patch.maxOpacity === undefined ? s.depthHeatmapMaxOpacity : patch.maxOpacity,
    }));
  },
```
주: 기존 `setTradeVolumePocEnabled`가 persist를 어떻게 트리거하는지(예: 별도 `persist()` 호출) 확인해 동일 패턴을 따른다. 대부분 Zustand persist 미들웨어가 selector 기반이라 `set`만으로 저장된다.

- [ ] **Step 6: Full store/persistence regression**

Run: `cd frontend && npx vitest run src/state/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/state/livePage.ts
git commit -m "feat(state): depthHeatmap 상태·액션·영속(색 2종+최대 불투명도)"
```

---

## Task 10: 프론트 — DepthHeatmapOverlay (부착 + 정규화)

**Files:**
- Create: `frontend/src/live/DepthHeatmapOverlay.tsx`
- Test: `frontend/src/live/DepthHeatmapOverlay.test.ts` (셀 빌드 순수함수만 테스트)

`TradeVolumePocOverlay.tsx` 미러. 셀 빌드는 순수함수 `buildDepthHeatmapCells`로 분리해 테스트한다. visible-range 변경 시 visibleMax 재계산 → 셀 재빌드. `bundle.candles` 식별자 churn 함정 주의: 프리미티브 attach effect의 deps는 `[series]`만, 셀 갱신 effect의 deps는 빌드된 `cells`만.

- [ ] **Step 1: Write the failing cell-builder test**

```typescript
import { describe, it, expect } from 'vitest';
import { buildDepthHeatmapCells } from './DepthHeatmapOverlay';
import type { DepthHeatmapPoint } from './depthHeatmapWire';

const axis = { toVirtual: (ms: number) => ms } as never; // 항등 축

describe('buildDepthHeatmapCells', () => {
  const points: DepthHeatmapPoint[] = [
    { tMs: 60000, asks: [{ price: 1010, qty: 900 }], bids: [{ price: 1000, qty: 300 }] },
  ];
  it('레벨당 셀 1개, 매도=askColor 매수=bidColor, α는 visibleMax 정규화', () => {
    const cells = buildDepthHeatmapCells(points, axis, 0, 120000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(cells.length).toBe(2);
    const ask = cells.find((c) => c.price === 1010)!;
    const bid = cells.find((c) => c.price === 1000)!;
    // visibleMax=900 → 매도(qty900)=full α, rgb=파랑(52,133,250)
    expect(ask.fillColor).toBe('rgba(52, 133, 250, 1)');
    // 매수(qty300) α = (300/900)^0.65 ≈ 0.487, rgb=빨강(240,68,82)
    expect(bid.fillColor).toMatch(/^rgba\(240, 68, 82, 0\.4[0-9]+\)$/);
  });
  it('halfTick은 인접 레벨 가격차의 절반 (단일 레벨은 폴백)', () => {
    const cells = buildDepthHeatmapCells(points, axis, 0, 120000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(cells[0].halfTick).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/DepthHeatmapOverlay.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement overlay + builder**

`frontend/src/live/DepthHeatmapOverlay.tsx`. `hexToRgba`는 `TradeVolumePocOverlay.tsx`의 것을 복사. halfTick은 한 포인트 내 인접 레벨 최소 가격차의 절반(단일 레벨/동일가는 안전 폴백):
```typescript
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import { DepthHeatmapPrimitive, type DepthHeatmapCell } from '../chart/DepthHeatmapPrimitive';
import type { DepthHeatmapPoint } from './depthHeatmapWire';
import { levelAlpha, visibleMaxQty } from './depthHeatmapAlpha';

function hexToRgba(hex: string, opacity: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  const alpha = Math.max(0, Math.min(1, opacity));
  if (!match) return `rgba(128, 128, 128, ${alpha})`;
  const raw = match[1];
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function halfTickFor(prices: number[]): number {
  let minGap = Infinity;
  const sorted = [...prices].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap)) return 0.5; // 단일 레벨 폴백(가격 단위 최소)
  return minGap / 2;
}

type StyleOpts = { bidColor: string; askColor: string; maxOpacity: number };

/** 보이는 범위 [fromMs,toMs] 내 포인트를 레벨당 셀로. α는 visibleMax 정규화. */
export function buildDepthHeatmapCells(
  points: readonly DepthHeatmapPoint[],
  axis: VirtualAxis,
  fromMs: number,
  toMs: number,
  style: StyleOpts,
): DepthHeatmapCell[] {
  const vmax = visibleMaxQty(points, fromMs, toMs);
  if (vmax <= 0) return [];
  const out: DepthHeatmapCell[] = [];
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    const time = (axis.toVirtual(pt.tMs) / 1000) as Time;
    const allPrices = [...pt.asks, ...pt.bids].map((l) => l.price);
    const halfTick = halfTickFor(allPrices);
    for (const lvl of pt.asks) {
      if (lvl.qty <= 0) continue;
      out.push({ time, price: lvl.price, halfTick, fillColor: hexToRgba(style.askColor, levelAlpha(lvl.qty, vmax, style.maxOpacity)) });
    }
    for (const lvl of pt.bids) {
      if (lvl.qty <= 0) continue;
      out.push({ time, price: lvl.price, halfTick, fillColor: hexToRgba(style.bidColor, levelAlpha(lvl.qty, vmax, style.maxOpacity)) });
    }
  }
  return out;
}

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  points: readonly DepthHeatmapPoint[];
};

function DepthHeatmapOverlay({ paneSeries, axis, points }: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const enabled = useLivePageStore((s) => s.depthHeatmapEnabled);
  const bidColor = useLivePageStore((s) => s.depthHeatmapBidColor);
  const askColor = useLivePageStore((s) => s.depthHeatmapAskColor);
  const maxOpacity = useLivePageStore((s) => s.depthHeatmapMaxOpacity);
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);

  // 보이는 unix-ms 범위. timeScale 이벤트 구독으로 갱신 → visibleMax 재계산 트리거.
  const [range, setRange] = useState<{ from: number; to: number }>({ from: -Infinity, to: Infinity });

  // 프리미티브 부착: deps=[series]만 (bundle 파생값 금지 — 식별자 churn 함정).
  useEffect(() => {
    if (!series) return undefined;
    const primitive = new DepthHeatmapPrimitive({ zOrder: 'bottom' });
    series.attachPrimitive(primitive);
    primitiveRef.current = primitive;
    return () => {
      try { series.detachPrimitive(primitive); } catch { /* torn down */ }
      primitiveRef.current = null;
    };
  }, [series]);

  // visible time range 구독. axis는 unix↔virtual 항등이 아닐 수 있으니 virtual→unix 역변환은
  // 생략하고, points를 virtual로 필터하도록 range도 virtual 기준으로 다룬다 — 단순화를 위해
  // 여기서는 전체 범위를 쓰고, 실제 클리핑은 buildDepthHeatmapCells의 fromMs/toMs로 위임.
  // (LiveChartRoot가 이미 visible-range 훅을 갖고 있으면 그 값을 prop으로 받아 대체 가능.)
  useEffect(() => {
    if (!series) return undefined;
    // lightweight-charts timeScale 구독은 LiveChartRoot 공통 훅과 중복될 수 있음 —
    // 우선 전체 범위로 두고, Task 11에서 LiveChartRoot의 visibleRange를 prop 주입해 좁힌다.
    setRange({ from: -Infinity, to: Infinity });
    return undefined;
  }, [series, points]);

  const cells = useMemo(
    () => buildDepthHeatmapCells(points, axis, range.from, range.to, { bidColor, askColor, maxOpacity }),
    [points, axis, range.from, range.to, bidColor, askColor, maxOpacity],
  );

  useEffect(() => {
    primitiveRef.current?.setCells(enabled ? cells : []);
  }, [enabled, cells]);

  return null;
}

export default memo(DepthHeatmapOverlay);
```

주: visible-range 정규화의 정밀 배선은 Task 11에서 `LiveChartRoot`의 기존 visible-range 소스를 prop으로 주입해 완성한다. 이 태스크에서는 전체 범위로 렌더가 동작(정규화는 전체 데이터 max 기준)하는 것까지 확보한다 — 셀 빌더 순수함수 테스트가 정규화 정확성을 커버한다.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/DepthHeatmapOverlay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/DepthHeatmapOverlay.tsx frontend/src/live/DepthHeatmapOverlay.test.ts
git commit -m "feat(live): DepthHeatmapOverlay — 셀 빌드+프리미티브 부착"
```

---

## Task 11: 프론트 — LiveChartRoot 배선 + 타임프레임 게이트

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (props, 게이트, 렌더, visible-range 주입)
- Modify: `frontend/src/live/buildLiveBundle.ts` + `buildIndexBundle.ts` (depth_heatmap 기본값)
- Test: `frontend/src/live/LiveChartRoot.test.tsx` (스모크: 지표 on 시 오버레이 마운트)

- [ ] **Step 1: Wire bundle plumbing defaults**

`buildIndexBundle.ts`(~line 53, `ask_peaks: []` 옆)와 `buildLiveBundle.ts`(~line 523, `ask_peaks: pastBundle?.ask_peaks ?? []` 옆)에 `depth_heatmap` 기본값을 추가해 타입 정합을 맞춘다:
```typescript
    depth_heatmap: [],
```
(buildLiveBundle은 `depth_heatmap: pastBundle?.depth_heatmap ?? [],`)

- [ ] **Step 2: Write the failing smoke test**

`LiveChartRoot.test.tsx`에 케이스 추가(기존 `shouldShowTradeVolumePocOverlay` 스타일). 게이트 순수함수를 export해 테스트:
```typescript
import { shouldShowDepthHeatmapOverlay } from './LiveChartRoot';

it('depthHeatmap 게이트: 분봉 + enabled + 데이터 있을 때만', () => {
  expect(shouldShowDepthHeatmapOverlay('1m', true, 5)).toBe(true);
  expect(shouldShowDepthHeatmapOverlay('1m', false, 5)).toBe(false);
  expect(shouldShowDepthHeatmapOverlay('1m', true, 0)).toBe(false);
  expect(shouldShowDepthHeatmapOverlay('D', true, 5)).toBe(false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx -t depthHeatmap`
Expected: FAIL — `shouldShowDepthHeatmapOverlay` 미정의

- [ ] **Step 4: Add gate + props + render**

`LiveChartRoot.tsx`:

DepthHeatmapOverlay import(~line 63, `TradeVolumePocOverlay` import 옆):
```typescript
import DepthHeatmapOverlay from './DepthHeatmapOverlay';
import { depthHeatmapFromWire } from './depthHeatmapWire';
```

Props 타입(~line 235, `tradeVolumePocs?` 옆). 상위에서 이미 `bundle`을 넘기면 bundle에서 파생 가능 — 기존 `tradeVolumePocs` prop이 어디서 오는지 확인해 동일 소스에서 `depth_heatmap`을 뽑는다. 여기서는 wire 배열을 prop으로:
```typescript
  depthHeatmap?: readonly import('../api/types').DepthHeatmapPointWire[];
```

게이트 함수(`shouldShowTradeVolumePocOverlay` ~line 265 옆). 분봉 판정은 기존 지표들이 쓰는 `isMinuteTimeframe`/`BASE`포함 헬퍼를 재사용(파일에서 확인):
```typescript
export function shouldShowDepthHeatmapOverlay(
  timeframe: LiveTimeframe,
  enabled: boolean,
  pointCount: number,
): boolean {
  const isMinute = timeframe.endsWith('m'); // '1m'..'30m'; D/W/M 제외
  return isMinute && enabled && pointCount > 0;
}
```

컴포넌트 본문에서 wire→도메인 변환 + 게이트 계산(`showTradeVolumePocOverlay` 계산부 ~line 1601 옆):
```typescript
  const depthHeatmapPoints = useMemo(() => depthHeatmapFromWire(depthHeatmap), [depthHeatmap]);
  const depthHeatmapEnabledStore = useLivePageStore((s) => s.depthHeatmapEnabled);
  const showDepthHeatmapOverlay = shouldShowDepthHeatmapOverlay(
    timeframe, depthHeatmapEnabledStore, depthHeatmapPoints.length,
  );
```

렌더(`{showTradeVolumePocOverlay && (` 블록 ~line 1701 옆):
```typescript
          {showDepthHeatmapOverlay && (
            <DepthHeatmapOverlay
              paneSeries={paneSeries}
              axis={axis}
              points={depthHeatmapPoints}
            />
          )}
```

`depthHeatmap` prop 실인자: `tradeVolumePocs`를 넘기는 상위 호출부(LivePage 등)를 찾아 `depthHeatmap={bundle.depth_heatmap}`를 동일하게 넘긴다.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx -t depthHeatmap`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/buildLiveBundle.ts frontend/src/live/buildIndexBundle.ts frontend/src/live/LiveChartRoot.test.tsx
git commit -m "feat(live): LiveChartRoot에 depthHeatmap 오버레이 배선 + 분봉 게이트"
```

---

## Task 12: 프론트 — 요청 파라미터 실배선 (지표 on → depth_heatmap_enabled=true)

**Files:**
- Modify: rangeRequest 호출부 (LivePage/데이터 훅) — `depthHeatmapEnabled: store.depthHeatmapEnabled` 주입
- Test: 해당 훅/빌더 테스트 또는 `rangeRequest.test.ts`

`depth_heatmap_enabled`가 항상 true면 매 fetch가 무거워진다. 지표 off일 땐 false를 보내 백엔드 계산을 건너뛴다(기존 `tradeVolumePocEnabled` 주입 지점과 동일).

- [ ] **Step 1: Find the injection site**

Run: `grep -rn "tradeVolumePocEnabled" frontend/src --include=*.ts --include=*.tsx | grep -v test`
`buildRangeRequest`/`rangeRequestFromStore` 같은 호출부에서 `tradeVolumePocEnabled: s.tradeVolumePocEnabled`를 넘기는 지점을 찾는다.

- [ ] **Step 2: Add the failing test**

`rangeRequest.test.ts`(있으면)에 추가:
```typescript
it('depthHeatmapEnabled=false면 depth_heatmap_enabled=false 파라미터', () => {
  const url = buildRangeRequest({ /* ...필수 필드... */, depthHeatmapEnabled: false });
  expect(url).toContain('depth_heatmap_enabled=false');
});
```
주: `buildRangeRequest`의 실제 export 이름·필수 필드는 `rangeRequest.ts`에서 확인해 맞춘다.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api/rangeRequest.test.ts -t depth_heatmap`
Expected: FAIL

- [ ] **Step 4: Inject the store value**

Step 1에서 찾은 호출부에 `depthHeatmapEnabled: s.depthHeatmapEnabled,`를 `tradeVolumePocEnabled` 옆에 추가.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/api/rangeRequest.test.ts -t depth_heatmap`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/rangeRequest.ts frontend/src/api/rangeRequest.test.ts <호출부 파일>
git commit -m "feat(api): 지표 활성 시에만 depth_heatmap_enabled=true 전송"
```

---

## Task 13: 프론트 — DepthHeatmapConfig 설정 패널 + IndicatorPanel 등록

**Files:**
- Create: `frontend/src/live/indicators/DepthHeatmapConfig.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx` (카탈로그·토글·Config 라우팅)
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

- [ ] **Step 1: Create the config panel**

`AskPeakConfig.tsx`의 `MAStylePicker` 사용 패턴 미러. 색 2종 + 불투명도 슬라이더:
```typescript
import { useLivePageStore } from '../../state/livePage';
import MAStylePicker from './MAStylePicker';

/** 호가 잔량 히트맵 상세 설정 — 매수/매도 색(MAStylePicker) + 최대 불투명도. */
export default function DepthHeatmapConfig() {
  const bidColor = useLivePageStore((s) => s.depthHeatmapBidColor);
  const askColor = useLivePageStore((s) => s.depthHeatmapAskColor);
  const maxOpacity = useLivePageStore((s) => s.depthHeatmapMaxOpacity);
  const setStyle = useLivePageStore((s) => s.setDepthHeatmapStyle);
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        호가 잔량 히트맵 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        각 분봉 시점의 10호가 매수·매도 잔량을 캔들 뒤 색상 강도로 표시합니다. 강도는 화면에
        보이는 범위의 최대 잔량 기준으로 정규화됩니다. 분봉 차트에서만 표시됩니다.
      </p>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">매수 색상</span>
          <MAStylePicker color={bidColor} lineWidth={2} onChange={(p) => p.color && setStyle({ bidColor: p.color })} label="매수 색상" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">매도 색상</span>
          <MAStylePicker color={askColor} lineWidth={2} onChange={(p) => p.color && setStyle({ askColor: p.color })} label="매도 색상" />
        </div>
      </div>
      <div className="border-b border-border my-3" />
      <div>
        <label htmlFor="dh-opacity" className="text-sm text-fg mb-2 block">
          최대 불투명도 <span className="text-fg-dim text-xs">{Math.round(maxOpacity * 100)}%</span>
        </label>
        <input
          id="dh-opacity"
          type="range" min={0.2} max={1} step={0.05} value={maxOpacity}
          onChange={(e) => setStyle({ maxOpacity: Number(e.target.value) })}
          className="w-full"
        />
      </div>
    </div>
  );
}
```
주: `MAStylePicker`의 `onChange`가 `{color, lineWidth}` 패치를 주는지 확인(`AskPeakConfig`에선 `setStyle` 직결). lineWidth를 무시하고 color만 쓰려면 위처럼 래핑. 만약 MAStylePicker가 두께 UI 없이 color만 필요로 하는 더 단순한 색 선택기가 있으면 그걸 우선 사용.

- [ ] **Step 2: Register in IndicatorPanel — write failing test**

`IndicatorPanel.test.tsx`에 추가:
```typescript
it('호가 잔량 히트맵 카테고리가 10호가 그룹에 렌더된다', () => {
  render(<IndicatorPanel onClose={() => {}} timeframe="1m" />);
  expect(screen.getByText('호가 잔량 히트맵')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/live/indicators/IndicatorPanel.test.tsx -t 호가 잔량 히트맵`
Expected: FAIL — 텍스트 없음

- [ ] **Step 4: Register catalog + toggle + config routing**

`IndicatorPanel.tsx`:

`CategoryId` union(~line 40 부근, `'bid-peak'` 옆)에 `| 'depth-heatmap'` 추가.

`CATEGORIES` 배열(~line 60, `bid-peak` 항목 옆)에 추가:
```typescript
  { id: 'depth-heatmap', label: '호가 잔량 히트맵', group: 'hoga' },
```

토글 셀렉터(컴포넌트 상단, `tradeVolumePocEnabled` 옆):
```typescript
  const depthHeatmapEnabled = useLivePageStore((s) => s.depthHeatmapEnabled);
  const setDepthHeatmapEnabled = useLivePageStore((s) => s.setDepthHeatmapEnabled);
```

지표 리스트의 체크박스 토글 배선(다른 hoga 지표가 `enabled`/`setEnabled`를 렌더 맵에 어떻게 연결하는지 확인 — 대개 `id → {enabled, setEnabled}` 매핑 객체가 있다). 그 매핑에 `'depth-heatmap': { enabled: depthHeatmapEnabled, setEnabled: setDepthHeatmapEnabled }`를 추가.

우측 Config 라우팅(선택된 카테고리 → Config 컴포넌트 switch/맵). `DepthHeatmapConfig` import 후 `case 'depth-heatmap': return <DepthHeatmapConfig />;`(또는 맵 방식) 추가:
```typescript
import DepthHeatmapConfig from './DepthHeatmapConfig';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/live/indicators/IndicatorPanel.test.tsx -t 호가 잔량 히트맵`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/indicators/DepthHeatmapConfig.tsx frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "feat(indicators): 호가 잔량 히트맵 Config + IndicatorPanel 등록"
```

---

## Task 14: 전체 검증 + 타입체크 + 수동 QA

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: Frontend typecheck**

Run: `cd frontend && npx tsc -b`
Expected: 0 errors. depth_heatmap 관련 타입 불일치가 나면 해당 태스크로 돌아가 수정.

- [ ] **Step 2: Frontend full test**

Run: `cd frontend && npx vitest run`
Expected: PASS (신규 + 기존 무회귀)

- [ ] **Step 3: Frontend build**

Run: `cd frontend && npm run build`
Expected: 성공

- [ ] **Step 4: Backend full test**

Run: `uv run --extra dev pytest tests/test_api_bundle.py tests/test_tables_snapshots.py tests/test_api_models.py tests/test_routes.py -q`
Expected: PASS

- [ ] **Step 5: 수동 QA (dev 서버 + /browse)**

백엔드·프론트 dev 서버 기동(CLAUDE.md의 hot-reload 커맨드) 후:
```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
# 종목 선택 → 지표 패널 열기 → '호가 잔량 히트맵' 토글 on
$B screenshot /tmp/depth-heatmap.png
```
확인 항목:
- 셀이 캔들 **뒤**에 그려지는가(캔들 몸통이 셀 위에 보임 — z순서).
- 큰 벽이 시간축을 가로지르는 진한 띠로 보이는가.
- 매수=빨강, 매도=파랑인가. 색·불투명도 변경이 즉시 반영되는가.
- D/W/M 전환 시 셀이 사라지는가(게이트).
- 팬/줌 시 정규화가 갱신되는가(전체범위 기준이면 일정; Task 11 visible-range 주입 완료 시 보이는 범위 기준).

- [ ] **Step 6: 최종 커밋 (필요 시 QA 수정 반영)**

```bash
git add -A
git commit -m "test(depth-heatmap): 전체 검증 통과 + QA 반영"
```

---

## Self-Review 노트

- **Spec 커버리지:** 목적(색상 강도 셀)·매수빨강/매도파랑·옵션 색 커스텀·분봉 게이트·구간 마지막 스냅샷·화면 내 max 정규화·캔들 뒤 렌더 — 전부 태스크에 매핑됨.
- **타입 일관성:** wire=`t_ms/asks/bids`(snake+튜플) ↔ 도메인=`tMs/asks/bids`(camel+객체). 프리미티브 셀=`{time, price, halfTick, fillColor}`. 스토어 필드 4종 이름이 persistence/store/config/overlay 전반에서 동일(`depthHeatmap{Enabled,BidColor,AskColor,MaxOpacity}`).
- **알려진 스코프 축소:** Task 10의 visible-range 정규화는 초기엔 전체 범위(전체 데이터 max) 기준으로 동작하고, Task 11에서 LiveChartRoot의 실제 visible-range를 prop 주입해 "화면 내 max"로 좁힌다. 순수함수 `visibleMaxQty`가 이미 범위 인자를 받으므로 주입만 하면 됨. LiveChartRoot에 기존 visible-range 훅이 없으면 timeScale `subscribeVisibleTimeRangeChange`로 오버레이 내에서 구독(단, deps=[series]만).
- **라이브 SSE 갱신:** 당일 진행 버킷은 trade-volume-poc와 동일하게 주기적 sidecar re-fetch로 갱신(별도 SSE 틱 프리펜드 미도입 — POC 파이프라인과 동일 수준). 필요 시 후속.
