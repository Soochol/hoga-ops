# Ratio 패널 극단값 필터 — 사용자 설정 노출

**상태:** Implemented (2026-05-24, worktree `feat+frontend4`)
**범위:** 프론트엔드 단일 PR — backend 변경 없음
**관련:** `frontend/src/chart/projectors/ratio.ts`, `CONTEXT.md "Auction Window"`, ADR-0010 (linear ms-from-midnight bucketing)

---

## 1. 문제

`/replay` 페이지의 Ratio 패널은 `quoteImbalance(bid_total, ask_total)`을 표시한다 (`ask/bid - 1` 또는 부호 반전, 0 = 균형). 차트 Y축 라벨은 `1 + |raw|`로 렌더되어 "한쪽이 다른 쪽의 몇 배인지"를 직관적으로 보여준다.

실제 데이터에는 한쪽 호가가 100배 이상인 극단적 imbalance 포인트가 가끔 등장한다 (예: 거래 정지 직전 호가, 매우 얇은 호가창). 이런 outlier 하나가 lightweight-charts의 오토스케일을 점령해 평소 의미 있는 시그널(±2 정도)이 한 줄로 짓눌리고, 분석가가 가장 보고 싶은 패턴이 사라진다.

이전 단계에서 임계값 100을 하드코딩하여 마스킹을 추가했으나(`feat+frontend4` 직전 커밋), 사용자마다 종목·시기·관심 패턴에 따라 적절한 임계값이 다르고, outlier 자체를 보고 싶을 때도 있다. 사용자 선택권을 노출하는 것이 옳다.

## 2. 결정

탭별(`ChartViewPrefs`) 설정에 **boolean 토글 + 정수 임계값** 두 prefs를 추가한다:

- `ratioOutlierFilterEnabled: boolean` (기본 `true`) — 기존 하드코딩 동작 유지
- `ratioOutlierThreshold: number` (기본 `100`, 범위 `[2, 10000]`, 정수) — 차트 라벨 단위 (`max(ask/bid, bid/ask)`)

마스킹 조건: `enabled && (1 + |raw|) >= threshold` → 해당 포인트의 `value`를 0으로 치환 (auction window 마스크와 동일한 패턴, 데이터 포인트 제거가 아님).

설정은 SettingsModal의 "차트" 카테고리에 토글(자동 렌더)과 임계값 입력 row를 나란히 배치한다. 토글이 꺼지면 임계값 입력은 dim + disabled 상태로 보존 (값은 잃지 않음).

## 3. 데이터 흐름

```
사용자 입력 → SettingsModal RatioOutlierThresholdRow
            → useTabsStore.setRatioOutlierThreshold(activeTabId, n)
            → store mutation (Map<tabId, ChartViewPrefs>)
            → debounce 250ms → localStorage 'replay.tabs.v1'
            
RatioPane render →   useActivePrefs(p => p.ratioOutlierFilterEnabled)
                  →  useActivePrefs(p => p.ratioOutlierThreshold)
                  →  projectRatio(bundle, axis, ctx)
                  →  per-point: isExtreme check → 0 or raw
                  →  BaselineSeries.setData(...)
```

## 4. 컴포넌트 / 모듈

| 파일 | 역할 |
|---|---|
| `frontend/src/state/chartPrefs.ts` | `CHART_TOGGLES`에 새 toggle 엔트리, `ChartViewPrefs`에 numeric 필드, 범위 상수 (`RATIO_OUTLIER_THRESHOLD_MIN/MAX/DEFAULT`) |
| `frontend/src/state/tabs.ts` | `setRatioOutlierThreshold` setter (스토어 boundary에서 clamp) |
| `frontend/src/state/tabsPersistence.ts` | `mergePrefs`에서 범위·타입 검증; 잘못된 값은 default로 fallback |
| `frontend/src/replay/SettingsModal.tsx` | `RatioOutlierThresholdRow` 컴포넌트 (draft state + commit on blur/Enter, `MovingAverageRow` 패턴 차용) |
| `frontend/src/chart/projectors/ratio.ts` | `RatioPaneContext` 타입 도입, `useRatioContext`가 3개 필드 selector로 구독, `projectRatio`가 ctx 객체 받음 |

### 4.1 타입 변경 (Breaking — 단일 PR 내 자체 처리)

`projectRatio`와 `RATIO_SPEC`의 컨텍스트가 `boolean` → `RatioPaneContext`로 바뀐다. 호출처는 `chart/RangeSeriesPane`가 `useContext` 결과를 그대로 넘기는 단일 진입점뿐이므로 외부 영향 없음. 테스트 5개 (3개 기존 + 2개 신규)가 새 시그니처로 업데이트됨.

### 4.2 영속성

`tabsPersistence.mergePrefs`에 단일 if 블록 추가:
- `typeof p.ratioOutlierThreshold === 'number'` && finite && in `[MIN, MAX]` → `Math.floor` 후 저장
- 그 외 모든 케이스 (없음/문자열/NaN/범위 밖) → `DEFAULT_PREFS.ratioOutlierThreshold` (= 100) fallback

토글은 `CHART_TOGGLES` 등록만으로 자동 처리 (기존 패턴).

## 5. UI

```
┌─ 차트 ──────────────────────────────────────────────────┐
│                                                         │
│ 호가비 동시호가 마스킹                          [●━━━]  │
│ 15:20–15:30 KST 동시호가 구간의 호가비를 0…             │
│                                                         │
│ 호가비 극단값 필터                              [●━━━]  │
│ 한쪽 호가가 임계 배수를 넘으면 그 시점의…               │
│                                                         │
│ 호가비 극단값 임계 배수                         [100]   │
│ 한쪽 호가가 다른 쪽의 이 배수 이상이면…  (2–10,000)     │
│                                                         │
│ Volume Profile                            [전체│일별]   │
│ 전체 기간 합산 / 날짜별 분리                            │
└─────────────────────────────────────────────────────────┘
```

- 토글 OFF 상태: 임계값 row가 `opacity-50 + disabled` — 발견성을 위해 사라지지 않음
- 임계값은 정수, 범위 외 / 빈값 / NaN은 commit 시 이전 값으로 revert (MovingAverageRow와 동일)
- 한국어 label + description, 범위는 description에 명시 (`2–10,000`)

## 6. 의미론 — "이상" 처리

사용자 요청: "100 **이상**이면 0으로 필터링". 한국어 "이상"은 포함적이므로 `>=` 사용:

```ts
const isExtreme =
  ctx.outlierFilterEnabled && 1 + Math.abs(raw) >= ctx.outlierThreshold;
```

즉 threshold = 100 → `ask/bid` 또는 `bid/ask`가 정확히 100이면 마스킹. 이전 단계의 하드코딩(`> 100`)에서 미세하게 강해진 동작이지만 실용적 차이 없음 (값이 연속).

## 7. 테스트

`frontend/src/chart/projectors/ratio.test.ts`:
- 기존 3개 테스트를 새 `RatioPaneContext` 시그니처로 업데이트
- 신규 1: `outlierFilterEnabled=true`일 때 threshold 미만/같음/초과 케이스
- 신규 2: `outlierFilterEnabled=false`일 때 outlier가 그대로 통과

기존 624개 테스트 모두 통과. typecheck `tsc --noEmit` 클린.

## 8. 비결정 사항 — 의도적 제외

- **그래프 위에 outlier 표시 (제거된 포인트 가시화)**: 마스킹된 포인트를 별도 마커로 표시할 수 있으나, "오토스케일을 잡아먹지 말라"는 본질을 흐림. v2에서 검토.
- **종목별 임계값**: 종목별 차이(우량주 vs 동전주)가 크지만 현재 prefs는 탭 단위까지만. 종목별 prefs는 별도 ADR 필요.
- **백엔드 사전 필터**: raw 데이터를 backend에서 자르면 분석 가능성 손실. projector 레이어가 옳음.
- **연속 outlier 클러스터의 보간**: 마스킹 후 `value=0`이 일자 라인을 만드는데, BaselineSeries의 기존 처리(보간 없음, 0 baseline 통과)로 충분. 인지적 노이즈 미미.

## 9. 검증

1. `http://localhost:5173/replay` → 설정(⚙️) → "차트" 탭 → 새 토글 + 입력 보임
2. 토글 켠 채 임계값 50으로 낮추면 Ratio 패널의 작은 스파이크도 마스킹됨 (오토스케일이 더 좁은 범위로 줄어듦)
3. 토글 끄면 입력이 dim 처리되고 모든 outlier가 다시 그려짐 (오토스케일이 다시 압축됨)
4. 페이지 새로고침 후에도 설정 유지 (localStorage 라운드트립)
5. 새 탭 열면 default (`enabled=true`, `threshold=100`)로 시작

## 10. 변경 파일 요약

```
frontend/src/state/chartPrefs.ts          +18 -1
frontend/src/state/tabs.ts                +21 -0
frontend/src/state/tabsPersistence.ts     +16 -0
frontend/src/replay/SettingsModal.tsx     +83 -1
frontend/src/chart/projectors/ratio.ts    +21 -7
frontend/src/chart/projectors/ratio.test.ts  +44 -8
```
