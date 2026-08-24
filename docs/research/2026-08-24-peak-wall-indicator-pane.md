# 당일 최대벽 — 보조 지표 pane 추가 검토 및 제안

**작성:** 2026-08-24 · **상태:** ⚠ **폐기 — 전제가 틀렸다** · **대상:** `/live` 캔들 차트

> **이 문서의 옵션 A/B 구도는 폐기됐다.** pane 을 "히트맵에서 값을 새로 파생하는 별도
> 지표"로 본 것이 틀렸다 — 「당일 최대벽」은 **체결된 벽만** 찾는 지표이고, pane 은 그
> 값을 시간축으로 펼친 **같은 지표의 다른 표현**이다. 그 정의 아래에서는 데이터 조달
> 문제 자체가 없고(오버레이가 이미 계산해 둔 값을 쓴다), 이 문서가 길게 다룬 축
> 비대칭·payload·슬라이스 게이트 caveat 는 전부 자기가 만든 문제였다.
>
> **현행 문서: [2026-08-24-peak-wall-pane-implementation-plan.md](2026-08-24-peak-wall-pane-implementation-plan.md)**
>
> 아래는 §1(현재 기능 조사)·§2(pane 이 답할 질문)만 여전히 유효하다. §3 이후는 읽지 말 것.

---

## 0. 요약

현재 「당일 최대벽」은 **캔들 pane 위의 오버레이**다 — 거래일마다 그날 최대벽 가격에
수평선 1~3개. 이 문서는 **그 기능을 그대로 두고**, 그 아래에 시간축 pane 하나를
추가하는 안을 검토한다.

**권고: 「최대벽 강도(Peak Wall Strength)」 pane 을 옵션 A(프론트 파생)로 v1 구현.**

- wire 변경 0 · 백엔드 변경 0 — 필요한 데이터가 이미 번들에 온다(`depth_heatmap`)
- 오늘분도 실시간 — `depth_heatmap_today` 가 SSE `live.ob` 로 이미 만들어진다
- 단, **세 가지 비대칭**을 문서화하고 UI 로 드러내야 한다(§3.1 caveat)

정합이 완전해야 한다고 판단되면 옵션 B(전용 wire)로 승격한다. pane 이름·토글 키가
그대로라 승격 비용은 프로젝터 교체 한 곳이다.

---

## 1. 현재 기능 — 무엇을 건드리지 않는가

이 제안은 아래 전부를 **변경하지 않는다.**

### 1.1 데이터 경로 두 갈래

| 구간 | 소스 | 계산 위치 |
|---|---|---|
| 과거일 | `RangeBundle.ask_peaks` / `bid_peaks` (거래일당 1행) | 백엔드 `query_day_ask_bid_peak_dual*` |
| 오늘 | SSE `live.ob` 폴드 | 프론트 래칫 `useDayAskPeaks` / `reduceDayAskPeak` |

양쪽이 같은 술어를 쓴다 — 연속거래 호가창 AND `sessionOpenMs` 이후
(`isIndicatorEligibleBook` ↔ `_book_indicator_eligible_sql`, ADR-0062 v3).

### 1.2 값의 축 네 갈래

`AskPeak` / `BidPeak` 한 행이 실어 나르는 축:

- `price`/`qty`/`t_ms` — **버킷 종가 대표(rep)** 위에서의 당일 max
- `max_*` — **모든 유효 스냅샷(cont)** 위에서의 당일 max (Intra-Bar Max, ADR-0076)
- `traded_*` — **동일분 터치** 벽(ADR-0156)의 랭킹 top-3 → UI 의 「체결된 벽」
- `all_*` — 터치 무관 전체 벽 → 「보이는 영역 최대벽」의 원천

### 1.3 렌더 표면 다섯

`usePeakWallRender` 가 단일 소스로 계산하고 표면들이 나눠 쓴다:

1. 수평 세그먼트 선(`PeakWallSegmentsPrimitive`)
2. 최대벽이 걸린 시점의 점
3. 도킹 라벨(`PeakWallDockedLabelsPrimitive`) — `가격, 잔량`
4. 순위 화살표(`PeakWallRankArrowsPrimitive`) — 앵커는 그 봉의 고가/저가
5. Pane 레전드 값(`peakWallVisibleRanking`)

### 1.4 필터·노브

`intraMax` · 보이는영역 시간 컷오프 · 분봉 MA 필터 · 일봉 MA 필터 ·
「체결된 벽 표시 개수」 1~3 · 선 색/두께 · 눈(hidden).

---

## 2. 새 pane 이 답해야 할 질문

오버레이는 **"그날 최대벽이 어느 가격에 있었나"** 를 답한다. 답하지 못하는 것:

| 질문 | 현재 | pane 이 답한다 |
|---|---|---|
| 그 벽이 하루 중 **언제** 두꺼워졌나 | 점 1개(최대 순간)만 | 시간축 곡선 전체 |
| 지금 걸린 벽이 그날 최대의 **몇 %** 인가 | 없음 | 라이브 값 vs 래칫선 |
| 매도벽과 매수벽 중 **어느 쪽이 두꺼운가** | 두 수평선의 y 위치만(비교 불가) | 같은 y 축의 두 라인 |
| 벽이 **소진**되는 과정 | 없음 | 곡선 하강 |
| 한 단계에 **몰렸나** 고르게 퍼졌나 | 없음 | 최대벽/총잔량 비율 모드 |

마지막 항목이 특히 의미가 있다. 총잔량 pane 은 10단계 **합**을 그리는데, 같은 합이라도
한 단계에 몰린 것과 열 단계에 퍼진 것은 완전히 다른 상황이다. 그 구별이 지금 어느
표면에도 없다.

---

## 3. 데이터 조달 — 옵션 두 개

### 3.1 옵션 A — 프론트 파생 (권고, v1)

봉마다 `depth_heatmap` 의 사다리에서 `max(qty)` 를 뽑으면 그 봉의 최대 단계 잔량이다.

```
과거일: RangeBundle.depth_heatmap[].asks / .bids     (버킷 대표 스냅샷 10단계)
오늘  : LiveBundle.depth_heatmap_today[]             (SSE live.ob 로 프론트가 버킷팅)
```

**정합의 근거 — 표본이 같다.** `query_bucketed_depth_heatmap` 의 대표 =
"버킷의 마지막 유효 스냅샷"이고, 최대벽 계산의 `rep` 프레임 =
`ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY ts_ms DESC, seq DESC) = 1` 로 같은 행이다.
술어도 같은 `_book_indicator_eligible_sql`. 따라서

> pane 곡선의 **당일 최댓값** = 오버레이가 그리는 `all_*` 계열 벽의 `qty`

가 성립한다. 이것이 이 옵션의 **판별식**이다 — 구현 후 `/browse` 로 두 숫자를 대조하면
파생이 옳은지 한 번에 판정된다.

> ⚠ **`all_*` 이지 도킹 라벨이 아니다.** 오버레이가 그리는 선과 도킹 라벨의 **기본 축은
> 「체결된 벽」(`traded_*`)** 이다(`expandBaselinePeaks` 가 `traded_peaks` 를 먼저 쓴다).
> 그날 최대 벽이 그 1분 안에 터치되지 않았다면 `traded` rank-1 ≠ `all` rank-1 이고,
> 그때 pane 최댓값과 도킹 라벨은 **정당하게 다르다**. 대조는 반드시 `all_*` 쪽 표면
> (또는 wire 값)으로 한다 — §7.2 참조.

봉 굵기도 어긋나지 않는다. 과거일 heatmap 은 요청 `bucket_ms` 로 버킷팅하고
(`query_bucketed_depth_heatmap`), **오늘분도 같다** — `bucketDepthHeatmap(sseOb, bucketMs, …)`
가 차트 타임프레임을 그대로 받는다(`buildLiveBundle.ts`, 주석의 "per minute" 은 1분 기본
케이스를 서술한 것). `reaggregate_peak_rep` 의 N분 rep 정의("창 안에서 rep 가 존재하는
마지막 1분 버킷의 rep")도 같은 스냅샷으로 수렴한다.

> **프로토타입으로 실증됨** — `frontend/src/live/PROTOTYPE-peak-wall-series.html`
> (단일 HTML, 더블클릭으로 실행). 시나리오 「안 닿은 벽」이 축 갈림을(pane 2.9만 vs
> 체결된 벽 9천), 「5분봉의 함정」이 재집계 방식 차이를(A 2.5만 vs B 4.9만) 재현한다.
> 「잡음 틱 무시」는 무효 봉·사다리 없는 틱이 값에 기여하지 않음을 보인다.

동률 tie-break 만 미세하게 다르다: heatmap 은 `arg_max(rep_key = intra_ms)`, 최대벽은
`ORDER BY ts_ms DESC, seq DESC`. 같은 `intra_ms` 에 스냅샷이 둘 이상이면 대표가 갈릴 수
있다(리포가 이미 아는 rep 비결정성 — `query_bucketed_ratio` 의 differential 주석 참조).
**정합 테스트는 이 동률을 허용해야 한다.**

**⚠ caveat 네 가지 — 전부 UI 로 드러내야 한다**

1. **`intraMax` 축은 일치하지 않는다.**
   heatmap `asks_max` = "버킷 내 **총잔량**이 최대였던 스냅샷의 사다리"이고,
   최대벽 `max_*` = "**모든 유효 스냅샷** 중 단계 최대"다. 정의가 다르므로 v1 pane 은
   **rep(종가 대표) 축만 그린다**. 오버레이의 intraMax 토글과 연동하지 말 것 —
   연동하면 두 표면이 같은 이름 아래 다른 숫자를 말한다.

2. **「체결된 벽」(터치 필터)은 heatmap 에 없다.**
   터치 판정은 체결틱이 필요한데 heatmap 은 호가만 싣는다. v1 pane 은 **터치 무관 전체
   벽** 축이다. 오버레이의 기본 축은 「체결된 벽」이므로 레전드에 축 이름을 적어
   구별시킨다.

3. **슬라이스 게이트가 남의 지표에 물려 있다.**
   `depth_heatmap` 은 `depthHeatmapEnabled` → `depth_heatmap_enabled=false` 로 요청에서
   빠진다(`api/rangeSlices.ts`). 사용자가 **무관한** 「호가 잔량 히트맵」 지표를 끄면
   pane 데이터가 조용히 사라진다. pane 토글이 그 슬라이스 요구에 **OR 로 참여**해야 한다.

4. **payload (추정 — 실측 아님).** 포인트당 4배열 × 10단계 × `[price, qty]` ≈ 600B →
   1분봉 하루 391포인트 ≈ **230KB/일**. heatmap 지표를 이미 켠 사용자에게는 추가 비용
   0 이지만, pane 만 켠 사용자는 이 비용을 새로 낸다. 전용 wire(§3.2)의 약 10배다.
   dev 서버(:8000)로 2026-08-19·20·21 을 조회했으나 전부 빈 응답(166B)이라 실측하지
   못했다 — **구현 전에 데이터 있는 종목·거래일로 한 번 재실측할 것.**

### 3.2 옵션 B — 전용 wire 시계열

백엔드에 재료가 **이미 있다**: `PeakRepRow`(1분 rep 행, 캐시 직렬화용)와
`reaggregate_peak_rep`(굵은 봉 재집계). 여기서 봉당 스칼라를 뽑아 새 필드로 싣는다.

```python
class PeakWallSeriesPoint(BaseModel):
    t_ms: int
    ask_qty: int; ask_price: int; ask_touched: bool
    bid_qty: int; bid_price: int; bid_touched: bool
```

- 장점: **모든 축**(rep/cont/터치)이 오버레이와 정확히 일치. payload ≈ 20KB/일.
- 비용: ADR-0004 손 미러 + 4층 wire 계약 테스트 + 슬라이스 등록 + `cacheKind` +
  `backendGate` + routes Query 플래그.

### 3.3 판정

**A → 필요하면 B.** A 의 caveat 1·2 는 "pane 이 오버레이보다 축이 좁다"는 것이지
"틀리다"가 아니다. 좁은 축이 실제 사용에서 걸릴 때 B 로 승격하면 되고, 그때 바뀌는 것은
프로젝터의 데이터 소스 한 곳뿐이다(pane 이름·토글 키·레전드·설정 UI 전부 유지).

---

## 4. UI 제안

`DESIGN.md` 준수. 새 색·새 폰트·새 nav 없음.

> **UI 프로토타입** — `?peakWallProto=A|B|C` 로 `/live` 안에 실제 pane 을 띄워 3안을
> 비교한다(`chart/projectors/PROTOTYPE-peakWall.ts` + `live/PROTOTYPE-PeakWallVariantSwitcher.tsx`).
> A = 두 라인 + 래칫 점선 · B = 대칭 히스토그램 · C = 총잔량 대비 집중도(%).
> 아래 4.1 은 A 를 전제로 쓴 초안이며, **판정 결과로 바뀔 수 있다**.

### 4.1 pane 자체

| 항목 | 값 | 근거 |
|---|---|---|
| `name` (영속 키) | `peak-wall` | ADR-0028 — **한 번 정하면 개명 불가** |
| canonical 위치 | `quote-totals` 바로 뒤 | 호가 계열 묶음, 총잔량 옆이 읽기 좋다 |
| `stretch` | 0.3 | 총잔량 pane 과 동급 |
| 게이트 | `hogaAllowed(tf, t) && t.peakWallPaneEnabled === true` | 지표가 이미 분봉 전용 · **opt-in** |
| 시리즈 | Line ×2 (매도/매수) | 히스토그램은 두 방향이 겹쳐 안 읽힌다 |
| 색 | `askPeakColor` / `bidPeakColor` **재사용** | 선과 pane 이 같은 지표로 읽히게 |
| 래칫선 | 각 방향 당일 누적 max 계단선(점선, 같은 색 60% 불투명) | 이 선이 오버레이 수평선과 **같은 숫자** |

래칫선이 UI 의 핵심이다. pane 곡선이 그 점선에 닿는 순간이 곧 그날 최대벽이 선 순간이고,
그 값은 오버레이의 **「보이는 영역 최대벽」(`all_*`) 축과 같은 숫자**다.

⚠ 오버레이의 **기본 축은 「체결된 벽」(`traded_*`)** 이므로, 최대 벽이 그 분에 터치되지
않은 날에는 래칫선 값과 캔들 pane 의 수평선·도킹 라벨이 **정당하게 다르다**. 이 차이는
버그가 아니라 축의 차이이고, 레전드 툴팁(§4.2)이 그것을 말한다.

### 4.2 레전드

```
최대벽   ■ 매도 1.8만   ■ 매수 9.2천        ← legendTitle: '최대벽'
```

- 값 포맷은 `formatQtyCompact` — 오버레이 도킹 라벨과 **같은 함수**를 쓴다
  (`peakLegendValues.formatPriceQty` 가 이미 그 규율을 지킨다 · #839 의 교훈)
- `legendToggleKey: 'peakWallPaneEnabled'` — 레전드 ✕ 가 pane 을 끈다
- 축 표기: 제목 옆 `ⓘ` 툴팁에 "종가 대표 · 터치 무관" 을 적어 §3.1 caveat 1·2 를 드러낸다

### 4.3 설정 UI — **새 nav 항목을 만들지 않는다**

P1-8 이 매도/매수 두 항목을 「당일 최대벽」 하나로 **의도적으로 합쳤다**. 그 결정을 존중해
`PeakWallsConfig` 안에 둔다. 단 pane 은 방향 공용(한 pane 에 두 라인)이므로
**매도|매수 서브탭 바깥, 공용 섹션**에 놓는다 — 탭 안에 넣으면 같은 노브가 두 번 나온다.

```
┌─ 당일 최대벽 ─────────────────────────────────┐
│ 차트에 보이는 거래일마다 …(기존 설명)          │
│                                               │
│ ── 보조 pane ──────────────────────────────   │  ← 신설 공용 섹션
│ [토글] 최대벽 강도 pane 표시          ( off ) │
│        봉마다 한 호가 단계에 걸린 최대 잔량을 │
│        아래 pane 에 그립니다                  │
│   표시값   [ 잔량 ] [ 총잔량 대비 % ]         │  ← 세그먼트 컨트롤
│   [체크] 당일 최대 래칫선 표시                │
│                                               │
│ ── 방향별 설정 ────────────────────────────   │
│ [ 매도 | 매수 ]                               │  ← 기존 서브탭 (그대로)
│ [토글] 매도 최대벽 표시                       │
│ 체결된 벽  [색][두께]                         │
│ … (기존 IndicatorPrefRows)                    │
└───────────────────────────────────────────────┘
```

「총잔량 대비 %」 모드는 §2 의 마지막 질문("몰렸나 퍼졌나")을 답한다.
분모는 같은 봉의 `quote_ratio` 총잔량이라 추가 데이터가 필요 없다.

### 4.4 자동으로 따라오는 것

pane 공통 기반이 이미 있어 별도 작업이 필요 없다:

- 폴딩 (`paneFolding` · `FoldedPaneNotice`)
- 레전드 ↑/↓ 순서 이동 (`movePaneBeside`)
- 높이 조절 (`PaneStretchMap`)
- 창 간 크로스헤어·줌 동기화 (`cursorSync`)
- 드로잉 바인딩 (`PaneId` 가 곧 드로잉 영속 키)

---

## 5. 구현 시 손댈 곳

### 프론트 (옵션 A 기준)

0. `chart/projectors/peakWall.ts` 의 계산부는 **프로토타입의 `PeakWallSeries` 모듈을
   그대로 옮긴다** — `peakOfLadder` / `seriesFromHeatmap` / `ratchet` /
   `reaggregateLastWithData`. 동률 strict `>` 규약(먼저 도달 유지)이 `foldAskPeak` 미러라
   같이 옮긴다. 대조군 `reaggregateMax` 는 버린다(§3.1 실증에서 탈락).
1. `chart/drawing/types.ts` — `PaneId` 에 `'peak-wall'` 추가
2. `chart/paneOrder.ts` — `CANONICAL_PANE_ORDER` 에 추가
   ⚠ 안 하면 `_exhaustive` 가드가 **컴파일 실패**시킨다(의도된 강제)
3. `chart/projectors/peakWall.ts` — **신규**. `PaneSpec` + 프로젝터.
   `makePastCachedProjector` 로 과거/당일 분리 캐시(틱당 풀 재투영 방지),
   `bundleKind` 는 `'hoga'` (호가 그릇 — heatmap 슬라이스를 읽으므로)
4. `chart/paneSpecs.ts` — `PANE_SPECS` 에 삽입
5. `live/paneSpecsForTimeframe.ts` — `GATE_BY_NAME` 에 게이트 1줄
6. `live/indicators/indicatorPaneProfiles.ts` — `IndicatorPanePrefs` ·
   `INDICATOR_PANE_PREF_KEYS` · `pickPanePrefs` · `resolvePaneToggles` (7→8키)
7. `state/liveIndicatorsPersistence.ts` — 기본 false + 정규화 + 색/모드 pref
8. **프리셋** — #1543 이 프리셋에 창별 지표를 실었다. `normalizeBooleanByTimeframe` 의
   `allowedKeys` 가 위 6번 배열을 쓰므로 자동이지만, 프리셋 enable 키 목록을 **직접 확인**할 것
9. `live/indicators/PeakWallsConfig.tsx` — §4.3 UI
10. `api/rangeSlices.ts` — `depth_heatmap` 슬라이스 요구에 pane 토글 **OR**
    (§3.1 caveat 3 — 안 하면 남의 토글로 데이터가 사라진다)

### 테스트 (기존이 움직인다)

- `live/LiveChartRoot.paneToggles.test.tsx` — pane 마운트/언마운트
- `live/indicators/IndicatorPanel.paneNames.test.ts` — pane 이름 표
- `live/paneSpecsForTimeframe.test.ts` — 게이트(분봉 전용 · opt-in)
- 신규: 프로젝터 순수 테스트 + **정합 테스트**
  (같은 픽스처에서 pane 당일 max === 오버레이 `all_*` qty)

### 옵션 B 로 갈 때 추가

11. `hoga/api/models.py` 새 wire model + `frontend/src/api/types.ts` 손 미러 (ADR-0004)
12. `tests/unit/api/test_rest_wire_schema_contract.py` — `EXPECTED_REST_WIRE_FIELDS` 갱신
13. `past_indicators_cache.py` — 새 `cacheKind`
14. `routes.py` Query 플래그 + `bundle.py` `backendGate` + `rangeSlices.ts` 슬라이스 등록

---

## 6. 하지 말아야 할 것

- ❌ **오버레이를 pane 으로 대체하지 않는다.** 벽의 요점은 "가격 축 위 어디에
  걸렸나"이고, 그건 캔들 pane 에서만 읽힌다. pane 은 y 축이 잔량이라 가격 정보를
  통째로 잃는다. 두 표면은 서로 다른 질문에 답한다.
- ❌ **히트맵과 중복이 아니다.** 히트맵은 가격×시간 밀도이고 pane 은 "최대 단계 하나"의
  시간축 강도다. 다만 둘 다 켜면 정보 중복감이 있으므로 **기본 off**.
- ❌ **새 nav 항목 금지** (§4.3).
- ❌ **`intraMax` 토글 연동 금지** (§3.1 caveat 1).

---

## 7. 검증 계획

1. **red-check** — 정합 테스트에 가짜 값을 넣어 실패 메시지를 눈으로 확인 후 되돌린다.
   한 번도 빨개진 적 없는 가드는 아무것도 증명하지 않는다.
2. **`/browse` 대조 — 축을 반드시 `all_*` 로 고정한다.**
   pane 의 당일 최댓값을 `ask_peaks[].all_qty` / `bid_peaks[].all_qty` **wire 값**
   (또는 「보이는 영역 최대벽」 레전드 — `peakWallVisibleRanking` 이 `all` 을 소스로 쓴다)과
   대조한다.
   ❌ **도킹 라벨과 대조하지 말 것** — 라벨의 기본 축은 「체결된 벽」(`traded_*`)이라,
   그날 최대 벽이 그 1분 안에 터치되지 않았으면 **정상인데도 다르게** 나온다.
   이걸 실패로 읽으면 존재하지 않는 버그를 쫓게 된다.
   동률(`intra_ms` 충돌)로 대표가 갈리는 경우는 허용한다(§3.1 끝).
3. **게이트 회귀** — 「호가 잔량 히트맵」 지표를 끈 채 pane 만 켜서 데이터가 살아 있는지
   (§3.1 caveat 3 의 red-check).
4. 로컬 검증:

```bash
cd frontend && npm run typecheck && npx vitest run && npx vite build
```

```bash
uv run --extra dev ruff check . && uv run --extra dev pytest -q -m 'not wallclock'
```

프론트를 만졌으므로 Playwright e2e 도 로컬에서 직접 돌린다.
