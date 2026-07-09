# 호가 잔량 히트맵 — "분봉 내 최댓값 기준" 토글 + 실시간 ratchet 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox tracking.

**Goal:** 호가 잔량 히트맵에 "분봉 내 최댓값 기준"(그 분에서 총잔량이 가장 컸던 스냅샷의 10호가 분포, 캔들 고가 직관) 토글을 추가하고, 과거일(백엔드 쿼리)·오늘(라이브 SSE ratchet) 모두 지원한다. 겸사겸사 종가 모드 오늘 버킷도 SSE per-tick 실시간화한다.

**Architecture:** 기존 `ratio` 지표의 `imb_max`(단일 스냅샷 argmax 선택) + `price_level_hits`(라이브 오늘 + sidecar 과거 병합) 패턴을 그대로 미러. 백엔드는 종가 대표와 최대총잔량 대표 두 40컬럼 struct를 한 쿼리에서 산출해 나란히 실어 보내고(ADR-0076 "close+max on wire, client render switch"), 프론트가 토글로 고른다. 라이브는 `IncrementalHogaBucketer`에 새 `depthByBucket` 맵을 추가해 SSE ob 틱마다 종가(최신)·최대(총잔량 peak) 스냅샷을 보존.

**핵심 선례 (읽고 따를 것):**
- 백엔드 종가+max 동시산출: `hoga/tables/snapshots.py::query_bucketed_ratio` (rep_key + `arg_min(struct_pack(b,a), struct_pack(neg_imb, ts))`)
- 라이브 ratchet: `frontend/src/live/buildLiveBundle.ts::IncrementalHogaBucketer.appendOb` (imb_max 쌍 교체)
- 라이브 병합: `frontend/src/live/useLiveBundle.ts` `livePriceLevelHits` + `mergePriceLevelHits`
- 토글 UI: `chartPrefs.ts` `askPeakIntraMax` (label '분봉 내 최댓값 기준') + `AskPeakConfig` `<IndicatorPrefRows toggleKeys>`
- 필드 선택 배선: `chart/projectors/quoteTotals.ts` `intraMax ? p.bid_max : p.bid_total`

---

## Task 1: 백엔드 — 쿼리에 최대총잔량 대표행 추가

**Files:**
- Modify: `hoga/tables/snapshots.py` — `DepthHeatmapRow`에 max 필드 4개 추가, `query_bucketed_depth_heatmap`에 두 번째 arg_max
- Test: `tests/test_tables_snapshots.py`

`DepthHeatmapRow`에 `ask_prices_max/ask_qtys_max/bid_prices_max/bid_qtys_max: tuple[int,...]` 추가. 쿼리는 기존 `rep`(종가) 옆에 `rep_max = arg_max(struct_pack(40 cols), struct_pack(is_pre := ..., total := (_BID_Q_SUM + _ASK_Q_SUM)))` 추가.

**설계 근거:** 복합키 struct(is_pre 1차, total 2차)를 쓴다 — `is_pre*1e8 + total` 산술은 total이 1억주 초과 시 오버플로우로 티어링이 깨진다(상한가 종목). `imb_max`가 이미 struct 정렬키(`struct_pack(neg_imb, ts)`)를 쓰는 선례. is_pre 1차라 연속거래 스냅샷이 auction보다 항상 우선, 그중 total 최대가 선택됨. 완전-auction 버킷은 auction 중 total 최대로 폴백(종가의 last-in-bucket 폴백과 동일 정신).

- [ ] **Step 1: Write failing test** — 같은 버킷에 스냅샷 3개: 이른(작은 total), 중간(가장 큰 total), 늦은(중간 total). 종가=늦은 스냅샷, max=중간 스냅샷임을 검증.
```python
def test_query_bucketed_depth_heatmap_max_total_snapshot(tmp_path):
    from hoga.tables.snapshots import query_bucketed_depth_heatmap
    import duckdb
    path = tmp_path / "snapshots.parquet"
    # 기존 _ob/_write 헬퍼로 3 스냅샷 (같은 분 버킷, deep book):
    #   seq1 ts=32_400_100: 각 레벨 qty=100 (total=2000)
    #   seq2 ts=32_400_200: 각 레벨 qty=500 (total=10000) ← 최대총잔량
    #   seq3 ts=32_400_300: 각 레벨 qty=300 (total=6000)  ← 종가(마지막)
    rows = query_bucketed_depth_heatmap(duckdb.connect(), path=path, bucket_ms=60000)
    r = rows[0]
    assert r.ask_qtys[0] == 300       # 종가 = 마지막 스냅샷
    assert r.ask_qtys_max[0] == 500   # max = 총잔량 최대 스냅샷
    assert len(r.ask_prices_max) == 10 and len(r.bid_qtys_max) == 10
```
주: 기존 `query_bucketed_depth_heatmap` 테스트의 fixture 헬퍼(`_ob`/`_write_snapshots`)를 그대로 차용. 3 스냅샷 모두 deep book(레벨4..10>0)로 연속거래 분류.

- [ ] **Step 2: Run test → FAIL** (`AttributeError: ask_qtys_max` 또는 필드 없음)
Run: `uv run --extra dev pytest tests/test_tables_snapshots.py -k max_total_snapshot -v`

- [ ] **Step 3: Implement** — `DepthHeatmapRow`에 4필드 추가. 쿼리 SELECT에 추가:
```python
# 총잔량 최대 스냅샷 대표(is_pre 1차, total 2차 복합키) — 분봉 내 최댓값 토글용.
# is_pre*1e8+total 산술은 total 오버플로 위험 → struct 정렬키(imb_max 선례).
arg_max(struct_pack({struct_body}),
        struct_pack(is_pre := (CASE WHEN ({pre_auction_pred}) THEN 1 ELSE 0 END),
                    total := ({_BID_Q_SUM}) + ({_ASK_Q_SUM}))) AS rep_max
```
`keyed` CTE의 SELECT에 `is_pre` 계산 컬럼을 명시하거나 인라인. 언패킹에서 `rep_max`의 40컬럼을 `*_max` 필드로 추출.
주: `_BID_Q_SUM`/`_ASK_Q_SUM`는 모듈에 이미 존재(`::BIGINT` 캐스트 포함). `struct_pack` 필드명 충돌 없게 확인.

- [ ] **Step 4: Run test → PASS**
- [ ] **Step 5: 기존 테스트 무회귀** — `uv run --extra dev pytest tests/test_tables_snapshots.py -q`
- [ ] **Step 6: Commit** — `feat(snapshots): depth heatmap 최대총잔량 대표행 추가 (분봉 내 최댓값)`

---

## Task 2: 백엔드 — 모델 + 슬라이스 + wire 필드

**Files:**
- Modify: `hoga/api/models.py` — `DepthHeatmapPoint`에 `asks_max/bids_max` 추가
- Modify: `hoga/api/bundle.py` — `build_depth_heatmap_slice`에서 max 매핑
- Test: `tests/hoga/api/test_range_models.py`, `tests/hoga/api/test_bundle.py`

- [ ] **Step 1: Write failing test** — DepthHeatmapPoint가 `asks_max/bids_max` 받고 기본 []; build_depth_heatmap_slice가 row의 max 필드를 [[p,q],...]로 매핑.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement**
```python
# models.py DepthHeatmapPoint
    asks_max: list[list[int]] = Field(default_factory=list)
    bids_max: list[list[int]] = Field(default_factory=list)
# bundle.py build_depth_heatmap_slice — out.append(DepthHeatmapPoint(...))에 추가
    asks_max=[[p, q] for p, q in zip(r.ask_prices_max, r.ask_qtys_max)],
    bids_max=[[p, q] for p, q in zip(r.bid_prices_max, r.bid_qtys_max)],
```
- [ ] **Step 4: PASS + 무회귀** — `uv run --extra dev pytest tests/hoga/api/test_bundle.py tests/hoga/api/test_range_models.py -q`
- [ ] **Step 5: Commit** — `feat(models): DepthHeatmapPoint.asks_max/bids_max`

---

## Task 3: 프론트 — wire 타입 + 도메인 변환

**Files:**
- Modify: `frontend/src/api/types.ts` — `DepthHeatmapPointWire`에 `asks_max?/bids_max?`
- Modify: `frontend/src/live/depthHeatmapWire.ts` — `DepthHeatmapPoint`에 `asksMax/bidsMax`, `depthHeatmapFromWire` 매핑
- Test: `frontend/src/live/depthHeatmapWire.test.ts`

- [ ] **Step 1: Write failing test** — fromWire가 `asks_max`→`asksMax` 변환, 없으면 [].
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement**
```typescript
// types.ts DepthHeatmapPointWire
  asks_max?: [number, number][];
  bids_max?: [number, number][];
// depthHeatmapWire.ts DepthHeatmapPoint
  asksMax: DepthHeatmapLevel[];
  bidsMax: DepthHeatmapLevel[];
// fromWire map
  asksMax: levels(p.asks_max ?? []),
  bidsMax: levels(p.bids_max ?? []),
```
- [ ] **Step 4: PASS + tsc 0**
- [ ] **Step 5: Commit** — `feat(live): depthHeatmap wire에 asksMax/bidsMax`

---

## Task 4: 프론트 — 토글 pref + Config + 셀빌드 선택

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts` — `depthHeatmapIntraMax` 키
- Modify: `frontend/src/live/indicators/DepthHeatmapConfig.tsx` — `<IndicatorPrefRows toggleKeys={['depthHeatmapIntraMax']} />`
- Modify: `frontend/src/live/DepthHeatmapOverlay.tsx` — `intraMax` pref 읽어 셀빌드에 asksMax/bidsMax 선택
- Test: `frontend/src/live/DepthHeatmapOverlay.test.ts`, chartPrefs 관련 테스트

- [ ] **Step 1: chartPrefs 키 추가** (기존 `askPeakIntraMax` 미러):
```typescript
depthHeatmapIntraMax: { label: '분봉 내 최댓값 기준', default: false, category: 'indicator-modal' },
```
주: chartPrefs의 정확한 구조/타입(Record exhaustive 여부)을 확인해 4개 IntraMax 키와 동일하게 추가.

- [ ] **Step 2: buildDepthHeatmapCells에 intraMax 인자** — Write failing test:
```typescript
it('intraMax=true면 asksMax/bidsMax를 소스로 셀 빌드', () => {
  const pts = [{ tMs: 1000, asks:[{price:10,qty:100}], bids:[{price:9,qty:100}],
                 asksMax:[{price:10,qty:900}], bidsMax:[{price:9,qty:900}] }];
  const cells = buildDepthHeatmapCells(pts, axis, 0, 2000, style, /*intraMax*/ true);
  // max 소스라 qty=900이 기준 → visibleMax=900
  ...
});
```
`buildDepthHeatmapCells` 시그니처에 `intraMax: boolean` 추가, 내부에서 `const asks = intraMax ? pt.asksMax : pt.asks` 등. `visibleMaxQty`도 동일 소스 기준으로.

- [ ] **Step 3: FAIL → Implement → PASS**
`DepthHeatmapOverlay` 컴포넌트에서 `const intraMax = useActivePrefs((p) => p.depthHeatmapIntraMax)` 읽어 useMemo deps + buildDepthHeatmapCells/visibleMaxQty에 전달. `visibleMaxQty`도 intraMax 소스로 계산하도록 시그니처 확장(또는 오버레이에서 소스 배열을 미리 스위칭).
주: `visibleMaxQty(points, from, to)`가 asks/bids를 훑으므로, intraMax 소스를 반영하려면 인자 추가 또는 points를 미리 매핑. 정규화 기준도 max 소스로 일치시켜야 "화면 내 최대"가 max 분포 기준이 됨.

- [ ] **Step 4: tsc 0 + vitest** (overlay + chartPrefs)
- [ ] **Step 5: Commit** — `feat(indicators): 호가 잔량 히트맵 '분봉 내 최댓값' 토글`

---

## Task 5: 프론트 라이브 — IncrementalHogaBucketer depth ratchet

**Files:**
- Modify: `frontend/src/live/buildLiveBundle.ts` — `depthByBucket` 맵 + appendOb ratchet + snapshot 반환에 depth 추가
- Test: `frontend/src/live/buildLiveBundle.test.ts` (또는 해당 빌더 테스트)

`IncrementalHogaBucketer`에 per-bucket depth 상태 추가. 각 continuous ob 틱(`s.t_ms <= threshold`, `s.asks && s.bids` 가드)마다:
- **종가**: 그 버킷의 close 스냅샷 = 최신 틱의 asks/bids (매 틱 덮어씀)
- **최대**: `curTotal = s.total_bid_qty + s.total_ask_qty`가 버킷 running max보다 크면(strict `>`) 그 틱의 asks/bids로 max 스냅샷 교체

- [ ] **Step 1: Write failing test** — 한 버킷에 ob 틱 3개(총잔량 100/900/300 순) 주입 후 snapshot의 depth_heatmap 오늘 버킷이 close=마지막(300틱 분포), max=900틱 분포임을 검증. 빌더가 `s.asks/s.bids` 없으면 스킵.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — 상태 맵:
```typescript
private depthByBucket = new Map<number, {
  close: { asks: OrderbookLevel[]; bids: OrderbookLevel[] };
  max: { asks: OrderbookLevel[]; bids: OrderbookLevel[]; total: number };
}>();
private depthOrder: number[] = [];
```
appendOb 루프의 continuous 분기에 ratchet 추가(imb_max 로직 옆). snapshot()이 `depthHeatmapToday: DepthHeatmapPoint[]` 반환(bucket t → tMs, close→asks/bids, max→asksMax/bidsMax). `ms_from_midnight` 변환 불필요 — bucket t가 이미 unix ms.
주: reset()에서 depthByBucket/depthOrder도 clear. auction-only 버킷은 close/max 미생성(스킵) — 백엔드 폴백과 미세 차이 있으나 오늘 라이브는 연속거래만 관심.

- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** — `feat(live): IncrementalHogaBucketer에 depth heatmap 버킷 ratchet`

---

## Task 6: 프론트 라이브 — useLiveBundle 병합

**Files:**
- Modify: `frontend/src/live/buildLiveBundle.ts` — `HogaSeries` 타입/`createIncrementalHogaSeriesBuilder`에 `depth_heatmap_today` 노출
- Modify: `frontend/src/live/useLiveBundle.ts` — 오늘 라이브 depth를 sidecar 과거와 병합해 bundle에 주입
- Test: `frontend/src/live/useLiveBundle.test.tsx`

`price_level_hits` 병합 패턴 미러. `HogaSeries`에 `depth_heatmap_today: DepthHeatmapPoint[]` 추가(빌더 snapshot에서). `useLiveBundle`의 `bundle` useMemo(price_level_hits merge 옆)에서:
```typescript
depth_heatmap: mergeDepthHeatmapToday(chartBundle.depth_heatmap, hogaSeries.depth_heatmap_today),
```
`mergeDepthHeatmapToday(past, today)` = t_ms 기준 today가 past를 덮어쓰고(오늘 버킷) 나머지 past 유지, 오름차순. (`api/range.ts`의 depth_heatmap uniqueBy latest-wins와 동일 규약.)

- [ ] **Step 1: Write failing test** — sidecar 과거 버킷 + 라이브 오늘 버킷 → merged bundle.depth_heatmap이 오늘 버킷은 라이브 값, 과거는 sidecar 값.
- [ ] **Step 2: FAIL → Implement → PASS**
주: `bundle` useMemo deps에 hogaSeries 이미 포함(quote_ratio 등). depth_heatmap_today가 hogaSeries에 들어가면 deps 자동. churn 가드는 overlay attach effect(deps=[series])가 이미 처리.

- [ ] **Step 4: tsc 0 + vitest (live)**
- [ ] **Step 5: Commit** — `feat(live): 오늘 depth heatmap 라이브 ratchet을 sidecar 과거와 병합`

---

## Task 7: 전체 검증 + 시각 QA

- [ ] tsc `-b --force` 0 errors
- [ ] `cd frontend && npx vitest run` 전체 green
- [ ] `npm run build` 성공
- [ ] 백엔드 `uv run --extra dev pytest tests/hoga/api/test_bundle.py tests/test_tables_snapshots.py tests/hoga/api/test_range_models.py -q`
- [ ] 시각 QA(:5174 프록시 도그푸드, 005930/20260708): 종가 vs 분봉내최댓값 토글 시 셀 분포/강도 변화 확인. 장중이면 오늘 버킷 실시간 ratchet 관찰(불가하면 과거일로 토글 동작만).
- [ ] Commit + PR

---

## Self-Review 노트
- **타입 일관성:** BE `ask_prices_max`(tuple) → wire `asks_max`([p,q][]) → FE `asksMax`({price,qty}[]). 토글 pref `depthHeatmapIntraMax`. 라이브 `depth_heatmap_today`.
- **정규화 상호작용:** intraMax 토글 시 `visibleMaxQty`도 max 소스 기준이어야 "화면 내 최대"가 일관(Task 4에서 처리).
- **핵심 함정:** ①복합키 struct(오버플로 회피) ②라이브 asks/bids optional 가드 ③병합은 price_level_hits 패턴(computedChartBundle 아니라 bundle useMemo — ob deps) ④overlay churn 가드 유지.
- **라이브 auction 폴백:** 오늘 라이브는 연속거래 틱만 ratchet(백엔드 폴백과 미세 차이, 수용).
