# 호가 잔량 히트맵 (Depth Heatmap) 지표 — 설계

**날짜:** 2026-07-08
**상태:** 사용자 승인 완료 (설계 단계)
**대상:** `/live` 캔들 pane 보조지표 신규 추가

## 목적

각 분봉 캔들 시점의 10호가 매수·매도 잔량 분포를 캔들 pane 위에 색상 강도(불투명도)로
표현한다. 매수 = 빨강(`#F04452` 기본), 매도 = 파랑(`#3485FA` 기본) — KRX 색 컨벤션
(`--price-up`/`--price-down`)과 일치. 큰 호가벽은 시간축을 가로지르는 진한 띠로 나타나
벽의 생성·유지·소멸이 한눈에 보인다.

승인된 목업: 대화 중 위젯으로 제시 (분봉 슬롯별 20셀 — 매도 10단계 위, 매수 10단계 아래,
잔량 비례 알파, 캔들이 셀 위에 그려짐).

## 확정된 결정 (사용자 Q&A)

| 질문 | 결정 |
|---|---|
| 분봉당 대표 스냅샷 | **구간 마지막 스냅샷** (캔들 종가와 대응) |
| 강도 정규화 기준 | **화면(보이는 범위) 내 최대 잔량** + 감마 보정 `(q/max)^0.65` |
| 지원 타임프레임 | **분봉 전체 (1~30분)** — D/W/M에서는 자동 비활성 |
| 캔들과 겹침 처리 | **캔들 뒤 배경** (`zOrder: 'bottom'`) |
| 색상 | 기본 매수 빨강/매도 파랑, `MAStylePicker` 32색 그리드로 커스텀 |

## 아키텍처

### 1. 백엔드 — RangeBundle 신규 필드

기존 호가 기반 지표 8종과 동일한 옵트인 패턴.

- **요청:** `GET /api/range?...&depth_heatmap_enabled=true` (`hoga/api/routes.py`)
- **응답:** `RangeBundle.depth_heatmap: list[DepthHeatmapPoint]` (`hoga/api/models.py`, 기본 `[]`)

```
DepthHeatmapPoint:
  t_ms: int                  # 버킷 시작 (bucket_ms 정렬)
  asks: list[[price, qty]]   # 최대 10단계, 가격 오름차순
  bids: list[[price, qty]]   # 최대 10단계, 가격 내림차순
```

- **쿼리:** `snapshots` 테이블에서 버킷별 `max(t_ms)` 스냅샷 1건 선택 후 10단계
  가격·잔량 추출 (버킷 그룹핑 — UNBOUNDED 윈도우 없음, ADR-0085 계열 폭주 위험 없음).
  빌더는 `hoga/api/bundle.py`에 기존 `build_ask_bid_peak_slices()` 옆에 추가.
- **캐시:** 과거 날짜 `PastIndicatorsCache`, 당일 TTL dedup — peak 빌더와 동일 관용구.
- **커버리지:** 캡처가 없는 날짜는 빈 결과. 기존 8종과 동일한 특성이며 상태바
  호가 캡처 공백일 warn 칩(PR #486)이 그대로 이 지표에도 해당한다.
- **버킷 경계:** 스냅샷이 하나도 없는 버킷은 포인트 자체를 생략 (셀 없음 = 데이터 없음).

### 2. 프론트 — DepthHeatmapPrimitive

- `frontend/src/live/indicators/DepthHeatmapPrimitive.ts` — lightweight-charts
  `ISeriesPrimitive`, paneView `zOrder: 'bottom'`으로 캔들 시리즈 아래에 렌더.
- **셀 지오메트리:** x = 해당 버킷 슬롯 전체 폭(`timeToCoordinate` + barSpacing),
  y = `priceToCoordinate(price)` 중심, 높이 = 1틱 (인접 레벨 가격차로 산출, 상장가
  틱 규칙 하드코딩 없음). `useBitmapCoordinateSpace`로 DPR 대응.
- **색:** `fillStyle = rgba(색, α)`, `α = maxOpacity × (qty / visibleMax)^0.65`.
  사용자 색은 hex로 저장(기존 MA/peak 색과 동일 — 테마 비추종은 수용된 한계).
- **visibleMax:** 보이는 논리 범위 내 모든 레벨 qty의 최대값. 팬/줌(visible range
  변경 구독) 시 재계산 — 기존 "보이는 영역 최대벽" 훅 패턴 재사용.
- **라이브 갱신:** 당일 진행 중 버킷은 SSE 틱의 현재 10호가로 마지막 포인트를 교체.
  bundle.candles 식별자 churn 함정 주의 — 구독 effect deps에 bundle 파생 memo를 넣지
  않는다 (기존 크로스헤어 오버레이 교훈).
- **타임프레임 게이트:** 분봉(1~30분)에서만 데이터 요청·렌더. D/W/M 전환 시 요청 자체를
  끈다 (`depth_heatmap_enabled=false`).

### 3. 옵션 UI

- `IndicatorPanel.tsx` `CATEGORIES` hoga 그룹에 `depth-heatmap` — "호가 잔량 히트맵" 추가.
- `frontend/src/live/indicators/DepthHeatmapConfig.tsx`:
  - 표시 토글
  - 매수 색상 / 매도 색상 — `MAStylePicker` 재활용 (기본 `#F04452` / `#3485FA`)
  - 최대 불투명도 슬라이더 (기본 0.7, 범위 0.2~1.0) — `tradeVolumePocOpacity` 관용구
- 상태: `useLivePageStore`에 `depthHeatmapEnabled`, `depthHeatmapBidColor`,
  `depthHeatmapAskColor`, `depthHeatmapMaxOpacity` 추가, 기본값은
  `liveIndicatorsPersistence.ts`, localStorage persist.

## 기각한 대안

- **프론트 원시 스냅샷 직접 집계:** 스냅샷은 초 단위라 페이로드 수십 배, 기존 지표
  캐시 계층 미활용 → 기각.
- **캔들별 max 정규화:** 벽의 시계열 비교 불가 → 화면 전체 max 채택 (사용자 확정).
- **캔들 옆 반칸 렌더:** 밀도 저하 → 캔들 뒤 배경 채택 (사용자 확정).

## 에러 처리

- 캡처 공백일: 빈 배열 → 셀 없음 (에러 아님).
- 10단계 미만 스냅샷(장 초반 등): 있는 단계만 렌더.
- visibleMax가 0(빈 범위): 렌더 스킵.

## 테스트

- **백엔드 pytest** (`uv run --extra dev pytest`): 버킷 마지막 스냅샷 선택(버킷 내 다중
  스냅샷 → 마지막 채택), 빈 버킷 생략, 캡처 공백일 빈 결과, enabled=false 시 미계산.
- **프론트 vitest** (`cd frontend && npx vitest run`): α 매핑 순수함수(감마·maxOpacity·
  0-max 경계), 타임프레임 게이트, `LiveChartRoot.test.tsx` 통합 스모크.
- **수동 QA:** `/browse`로 셀-캔들 z순서, 벽 띠 가시성, 팬 시 정규화 재계산 확인.
