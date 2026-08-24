# 최대벽 강도 pane — 구현 계획

**작성:** 2026-08-24 · **상태:** 계획(코드 미착수) · **대상:** `/live` 캔들 차트

> 앞선 검토 문서 `2026-08-24-peak-wall-indicator-pane.md` 의 **옵션 A/B 구도는 폐기**한다.
> 그 문서는 pane 을 "히트맵에서 값을 새로 파생하는 별도 지표"로 봤고, 그 전제가 틀렸다.
> 아래 §0 이 확정 정의이며, 그 정의 아래에서는 데이터 조달 문제 자체가 없다.

---

## 0. 정의 (확정)

**pane 은 새 지표가 아니라 기존 「당일 최대벽」의 다른 표현이다.**

- 세는 대상은 기존 지표와 **완전히 같다** — 「체결된 벽」(그 벽이 관측된 1분 안에 체결이
  그 가격을 친 벽, ADR-0156). 오버레이가 고른 그 벽들이고, 다시 판정하지 않는다.
- pane 이 그리는 값:

  ```
  계단(t) = max{ 벽ᵢ.qty : 벽ᵢ 가 선 시각 ≤ t }      (거래일 경계에서 리셋)
  ```

- 단조 증가 계단이다. 새 봉에서 더 큰 벽이 서면 그때 올라가고, 아니면 유지한다.
- **계단의 마지막 높이 = 캔들 pane 에 그려진 수평선의 값.** 두 표면이 같은 계산 결과를
  나눠 쓰므로 어긋날 수 없다.

pane 이 새로 말해 주는 것은 값이 아니라 **연혁**이다 — 오늘의 최대벽이 언제 갱신됐는가.

### 이 정의가 지우는 것들

앞 문서가 길게 다룬 caveat 는 전부 **자기가 만든 문제**였고, 여기서 사라진다:

| 앞 문서의 caveat | 이 정의에서 |
|---|---|
| `all_*` vs `traded_*` 축 비대칭 | 없음 — 오버레이가 고른 벽을 그대로 쓴다 |
| `intraMax` 축 불일치 | 없음 — 오버레이의 `intraMax` 가 그대로 적용된 결과를 받는다 |
| `depth_heatmap` 슬라이스 게이트 결합 | 없음 — 히트맵을 안 쓴다 |
| payload +230KB/일 | 없음 — 새 wire 가 없다 |
| 봉 굵기별 재집계 정의 | 없음 — 오버레이가 이미 그 봉으로 계산했다 |

---

## 1. 설계 결정

### 1.1 pane 은 오버레이의 **종속 표현**이다

따라서 오버레이에 건 모든 필터가 pane 에 **자동으로** 적용된다 — 색·「체결된 벽 표시
개수」·분봉 MA 필터·일봉 MA 필터·보이는 영역 시간 컷오프·`intraMax`. 필터로 걸러져
수평선에서 사라진 벽은 계단에서도 사라져야 하고, 같은 배열을 읽으므로 그것이 공짜로 된다.

**설정은 「pane 표시」 토글 하나만 새로 만든다.** 나머지 노브는 만들지 않는다.

### 1.2 on/off 규칙은 기존 눈(hidden) 규칙을 따른다

`usePeakWallRender` 는 `segments` 를 **`enabled` 기준으로만** 계산하고 `hidden` 은 보지
않는다(레전드가 값을 유지해야 하므로 — 그 파일의 ⚠ 불변식). pane 도 같은 소스를 읽으므로
자연히 이렇게 된다:

| 오버레이 상태 | 수평선 | pane 계단 |
|---|---|---|
| `enabled` off | 없음 | **없음** (셀 값도 없음) |
| `enabled` on + `hidden`(눈 끔) | 없음 | **있음** |
| `enabled` on | 있음 | 있음 |

"선은 지우고 pane 만 보고 싶다" 는 **눈 끄기**로 이미 표현된다. 새 노브가 필요 없다.

### 1.3 매도·매수는 한 pane 안의 두 계단

오버레이가 방향별 독립 토글이므로 pane 도 그대로 따른다 — 매도만 켜면 계단 하나.
색은 `askPeakColor` / `bidPeakColor` 를 **그대로 재사용**한다(선과 pane 이 한 지표로 읽히게).

### 1.4 계단 입력은 「표시 개수」와 분리해 항상 top-3 (2026-08-24 변경)

~~계단의 단수는 표시 개수를 따른다~~ — **폐기**. 계단의 뜻은 "그 시점까지 체결된 벽 중
최대" 의 running max 인데, 표시 개수 1 로 자르면 그날 1등 벽이 선 시점 이전의 갱신
이력이 통째로 사라진다 — 1등이 오후에 선 날은 **오전에 선이 없다가 오후에 생겼다**
(사용자 보고). 그래서 계단 입력(`stepSegments`)은 wire 가 실어 오는 체결된 벽
**top-3 전부**를 쓰고, 표시 개수는 그리기(수평선) 전용으로 남는다. 필터(MA·시간
컷오프·intraMax)는 여전히 공유한다.

~~남은 한계: top-3~~ → **wire 확장 완료(2026-08-24 후속)**. top-3 은 최종 크기순이라
벽이 장중에 커지는 날은 오전 기록이 구조적으로 잘렸다(실보고 2회). 백엔드가
`traded_record_peaks`/`traded_record_max_peaks`(시간순 prefix maxima, cap 128,
`_peak_record_sequence`)를 싣고, 계단 입력은 **기록 ∪ top-3**(stepHistory 모드)다.
기록은 봉 무관이라 1분 캐시 모델에 실려 굵은 봉 재집계가 건드리지 않는다
(ask_peak/bid_peak KIND_VERSIONS 8→9). **오늘 라이브 꼬리만 top-3 폴백** — 접속
이후 이벤트만 보는 클라이언트는 완전한 기록을 모르므로, 오늘의 완전한 기록은
서버 상태(ask_peak_state) 확장 후속.

---

## 2. 데이터 흐름

문제는 하나뿐이다: **`LiveChartRoot` 가 계산한 세그먼트를 pane 프로젝터까지 어떻게
내려보내는가.** pane series 의 `data(bundle, axis, ctx)` 는 번들과 축만 받는다.

리포에 이미 그 패턴이 있다 — **창 스코프 레지스트리**(`createWindowScopedRegistry`).
`dailyMaSeriesRegistry` 가 "차트가 만든 것을 다른 표면(레전드)이 읽는" 같은 모양이다.

```
LiveChartRoot
  ├ usePeakWallRender('ask') ──┐
  ├ usePeakWallRender('bid') ──┤   (이미 존재 — 변경 없음)
  │                            ↓
  │              useMemo: buildPeakWallStepPoints(segments, candles, axis)   ← 여기서 1회
  │                            ↓
  │              peakWallStepsRegistry.register(scope, side, {points, color})
  │                            ↓
  └ RangeSeriesPane(PEAK_WALL_SPEC)
       └ useContext: useWindowScopeId() + 레지스트리 구독
            └ data: (ctx) => ctx.points          ← pass-through, 계산 없음
```

**⚠ 레지스트리에 넣는 것은 세그먼트가 아니라 이미 투영된 계단 포인트다.**
`usePeakWallRender` 의 `built` memo 는 deps 에 `visibleTimeCutoff` 를 갖는데 그것이
**보이는 영역 기반**이라(`askVisibleTimeCutoffForRender`) 팬·줌마다 바뀔 수 있다.
세그먼트를 넣으면 팬 한 번이 스토어 쓰기 → 구독자 재렌더 → 프로젝터 재계산으로
이어진다. 계단을 `LiveChartRoot` 에서 `useMemo` 로 한 번 만들어 넣으면 pane 은
그리기만 한다. (`axis` 자체는 `useMemo` 라 팬으로 새로 만들어지지 않는다 — 팬은
lightweight-charts 내부 상태다. 바뀌는 것은 cutoff 쪽이다.)

**왜 레지스트리인가**: pane spec 은 모듈 상수라 props 로 내려줄 수 없고, `useContext` 는
훅이므로 스토어를 구독할 수 있다. 창 스코프가 필요한 이유는 `windowScopedRegistry` 의
주석 그대로다 — 고정 키를 쓰면 창 B 의 마운트가 창 A 의 값을 덮어쓴다.

### 2.1 계단 계산 (순수 함수, 새 파일)

```ts
/** 세그먼트 → 봉별 계단. 세그먼트의 peakTime(가상초)이 "그 벽이 선 시각"이다. */
export function buildPeakWallStepPoints(
  segments: readonly PeakWallSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
): LineData<Time>[]
```

- 세그먼트를 `peakTime` 오름차순으로 정렬
- 캔들을 훑으며 running max, **거래일이 바뀌면 리셋**
- 거래일 판정은 `axis.segments` 로 한다(`legendCursorDate` 와 같은 규약)
- 동률은 **먼저 도달한 것을 유지**(strict `>`) — `foldAskPeak` 의 규약 미러

`peakTime` 은 `buildPeakWallSegments` 가 이미 **캔들 버킷에 스냅**해 만든 값이라
(`snapPeakMsToCandle`), 계단이 오르는 x 가 정확히 그 봉 위에 놓인다. 좌표 변환을
다시 하지 않는다 — `peakWallRankArrows` 가 같은 이유로 `axis.toReal` 역변환을 안 쓴다.

### 2.2 오늘분은 이미 포함된다

**코드로 확인함**: `LiveChartRoot` 의 `renderDayAskPeaks` 는
`deriveDayAskPeaksIncrementalAsOf(..., todayAskPeakInput, ...)` 의 결과이고, 그 배열이
그대로 `usePeakWallRender({ peaks: renderDayAskPeaks })` 로 들어간다(`LiveChartRoot.tsx`
의 해당 호출부). pane 은 그 **하류**를 읽으므로 오늘 계단이 실시간으로 올라간다 —
별도 배선이 없다. (앞 문서에서 "오늘분 배선이 필요하다"고 적은 것은 히트맵 파생
전제에서만 참이었다.)

---

## 3. 작업 단계

한 PR 로 묶기엔 표면이 넓다. **세 PR** 로 나눈다. 각 단계가 독립적으로 초록이고, 중간에
멈춰도 사용자에게 보이는 것이 깨지지 않는다.

### PR 0 — 프로토타입 제거 (먼저)

프로토타입은 `PaneId` 를 늘리지 않으려고 `'peak-wall-prototype'` 이라는 **가짜 이름을
캐스팅으로** `GATED` 에 넣어 뒀다. PR 1 이 진짜 `'peak-wall'` 을 추가하면 둘이 공존하며
`GATED` 를 읽는 사람을 혼란시킨다. **먼저 지운다.**

- `chart/projectors/PROTOTYPE-peakWall.ts`
- `live/PROTOTYPE-PeakWallVariantSwitcher.tsx` + `LivePage.tsx` 의 import·마운트 2줄
- `live/paneSpecsForTimeframe.ts` 의 `GATED` 프로토타입 항목 + import
- `vite.config.ts` 의 `PROTO_API_PROXY` 블록
- `live/PROTOTYPE-peak-wall-series.html`

### PR 1 — 계단 계산 + pane 마운트 (핵심)

pane 이 뜨고 계단이 그려진다. **설정 UI 는 없지만 store 키는 여기서 만든다** — 게이트가
읽을 것이 없으면 PR 1 이 자기 완결이 아니다. 기본값 `false`, 확인은 브라우저 콘솔에서
store 를 직접 켜거나 기본값을 일시적으로 뒤집어서 한다.

1. `chart/peakWallSteps.ts` — `buildPeakWallStepPoints` (순수, 테스트 포함)
2. `live/indicators/peakWallStepsRegistry.ts` — 창 스코프 레지스트리
3. `live/indicators/peakWallPaneSpec.ts` — `PEAK_WALL_SPEC` (Line ×2, `useContext` 가
   레지스트리 구독). ⚠ **chart/projectors 가 아니다** — `useContext` 가 창 스코프와
   레지스트리(둘 다 live/)를 구독하는데 chart/ 는 live/ 에 런타임 의존하지 않는다는
   규칙이 있다(`RangeSeriesPane` 의 onLegendReady 가 콜백인 이유와 동일).
4. `chart/drawing/types.ts` — `PaneId` 에 `'peak-wall'` 추가
5. `chart/paneOrder.ts` — `CANONICAL_PANE_ORDER` + `PANE_DISPLAY_NAME` (`'최대벽'`)
   ⚠ 둘 다 안 하면 컴파일 실패한다(`_exhaustive` 가드 · `Record<PaneId, string>`)
6. ~~`chart/paneSpecs.ts` — `PANE_SPECS` 삽입~~ **하지 않는다.** `PANE_SPECS` 에 넣으면
   all-base 캐시 시드(`ALL_BASE_KEY`)가 어긋나 `=== PANE_SPECS` identity 계약이 깨진다
   (프로토타입 실측: 관련 테스트 16건 실패). 투자자 pane 과 같은 **`GATED` append** 로
   마운트하고, 표시 위치는 `CANONICAL_PANE_ORDER` 의 자리(quote-totals 뒤)가 정한다.
7. `live/paneSpecsForTimeframe.ts` — `GATED` 에 append 1항목(게이트 포함)
8. `state/liveIndicatorsPersistence.ts` — `peakWallPaneEnabled` (기본 `false`)
9. `live/indicators/indicatorPaneProfiles.ts` — `IndicatorPanePrefs` 7→8키 +
   `INDICATOR_PANE_PREF_KEYS` + `pickPanePrefs` + `resolvePaneToggles`
   (`legendToggleKey` 의 타입 `PanePrefKey` 가 **이 파일에서** 온다 — PR 3 이 이 키를 쓴다)
10. `live/LiveChartRoot.tsx` — 계단을 `useMemo` 로 만들어 레지스트리에 등록하는 effect

### PR 2 — 설정 UI + 프리셋

사용자가 켤 수 있게 된다(PR 1 은 store 를 손으로 건드려야 켜졌다).

- 확인 완료 사항 둘(PR 1 에서 조사):
  - **프리셋 enable 키는 자동이 아니다** — `live/presets/presetFlags.ts` 의
    `PRESET_INDICATOR_FLAG_KEYS` 가 손 나열이라 `peakWallPaneEnabled` 를 pane 토글
    절에 직접 추가해야 프리셋이 나른다.
  - `paneTogglesOverride` 전달은 **불필요** — 유일 소비처(`ChartWindow`)가
    `hogaPanes` 만 넘기고, 인덱스 창 억제는 게이트의 `hogaAllowed` 가 이미 처리한다.

11. `live/indicators/PeakWallsConfig.tsx` — 매도/매수 서브탭 **바깥** 공용 섹션에 토글 1개
12. `live/indicators/IndicatorPanel.tsx` — `CATEGORIES` 는 **건드리지 않는다**
    (pane 이 「당일 최대벽」 항목에 종속이므로 새 nav 항목 없음)
    → 단 `IndicatorPanel.paneNames.test.ts` 의 "모든 pane 이 패널 항목을 갖는다" 가드가
      이 pane 을 잡는다. **가드를 끄지 말고** 예외 1건을 사유와 함께 등록한다:
      "이 pane 은 독립 지표가 아니라 「당일 최대벽」의 표현이라 자체 nav 항목이 없다."
13. 프리셋 — `normalizeBooleanByTimeframe` 의 allowedKeys 가 10번 배열을 쓰므로 자동.
    **#1543 의 프리셋 enable 키 목록을 직접 열어 확인할 것**(자동이라고 가정하지 말 것)

### PR 3 — 레전드 + 마감

14. `PaneSpec.legendTitle: '최대벽'`, 셀 `매도`/`매수`, 값 포맷은 `formatQtyCompact`
    (오버레이 도킹 라벨과 **같은 함수** — #839 의 규율)
15. `legendToggleKey: 'peakWallPaneEnabled'` — 레전드 ✕ 가 pane 을 끈다
16. 거래일 경계 처리(§5.4)와 `stretch` 값(§5.3)을 실제 화면에서 확정
17. **`PaneLegendOverlay` 의 `LEGEND_CELL_PANES` 에 `'peak-wall'` 추가** — cells 행은
    등록만으로는 안 보이고 이 화이트리스트(차트 밀집도 정책)에 있어야 그려진다.
    계획이 몰랐고 실화면 도그푸딩이 잡았다. ⚠ 이 목록에 넣으면 그 pane 의
    `lastValueVisible` 을 **같이 꺼야 한다**(이중 판독면 — spec 이 이미 끔).

---

## 4. 테스트

### 새로 쓰는 것

- `chart/peakWallSteps.test.ts` — 계단 순수 함수
  - 단조 증가(작은 벽이 뒤에 와도 안 내려감)
  - 거래일 경계 리셋
  - 동률 시 먼저 도달한 것 유지
  - 세그먼트 0개 → 빈 배열
  - **⚠ red-check 필수**: 리셋을 지우면 빨개지는지 눈으로 확인. 다른 트리거가 먼저
    걸리면 대상 코드를 지워도 통과한다(`feedback_reset_trigger_test_must_move_one_variable`)
- **정합 테스트** — 계단의 마지막 값 === 그날 오버레이 세그먼트의 `qty` 최댓값.
  이것이 "두 표면이 같은 값을 말한다"의 기계적 보증이다.

### 움직이는 기존 것

- `live/LiveChartRoot.paneToggles.test.tsx` — pane 마운트/언마운트
- `live/paneSpecsForTimeframe.test.ts` — 게이트(분봉 전용 · opt-in)
- `chart/paneOrder.test.ts` — canonical 순서 배열 4곳이 하드코딩이라 갱신 필요
- `live/indicators/IndicatorPanel.paneNames.test.ts` — 위 12번 예외

### 로컬 검증 (CI 없음)

```bash
cd frontend && npm run typecheck && npx vitest run && npx vite build
```

프론트를 만졌으므로 Playwright e2e 도 로컬에서 직접 돌린다.

---

## 5. 위험·미결

1. **레지스트리 등록 타이밍.** `LiveChartRoot` 의 등록 effect 가 pane 의 첫 data 투영보다
   늦으면 첫 프레임이 빈다. 등록을 렌더 중(`useMemo` 아님, effect)에 하되, 빈 첫 프레임이
   실제로 보이는지 확인한다. 보이면 ctx 에 "아직 없음" 을 명시적으로 표현해 프로젝터가
   빈 배열을 내게 한다(깜빡임보다 낫다).

2. **재렌더 팬아웃.** §2 에서 이미 1차 설계로 흡수했다(레지스트리에 계단 포인트를
   넣는다). 남는 위험은 그래도 팬마다 스토어 쓰기가 한 번 일어난다는 것 —
   `visibleTimeCutoff` 가 보이는 영역 기반이라 그렇다. 계단 포인트가 실제로 안 바뀌는
   팬이라면 **얕은 비교 후 같으면 등록을 건너뛴다**. 60fps 팬에서 측정하고, 측정 전에
   최적화하지 않는다.

3. **`stretch` 값.** 계단은 대부분 평평해 0.3(총잔량 pane 과 동급)이 과할 수 있다.
   프로토타입 실측에서 하루에 계단이 1~2번 올랐다. 0.2 로 시작해 보고 판단한다.

4. **거래일 경계의 수직 낙하.** ~~whitespace 로 끊는다~~ → **해결됨(PR 3 실화면 검증)**:
   lwc LineSeries 는 whitespace 를 **무시하고 선을 이어 그린다**(setData 후
   `series.data()` 에서도 사라짐). 실제로 끊는 것은 `maskOutgoingConnector` +
   `LINE_HIDDEN_COLOR` 이고, WithSteps 의 수직 선분은 **도착점 색**을 쓰므로 경계
   양쪽 두 점(이전 날 마지막 + 새 날 첫 점)을 모두 투명으로 해야 한다.

5. **pane 이름은 개명 불가**(ADR-0028). `peak-wall` 로 확정한다.

6. **`gh pr list` 를 착수 전 · 작업 중간 · PR 직전 세 번** 확인한다. 병행 세션이 같은
   영역을 건드리면 이 계획의 파일 목록이 통째로 충돌한다.

---

## 6. 하지 않는 것

- ❌ 오버레이를 pane 으로 **대체**하지 않는다 — 벽의 요점은 "어느 가격"이고 그건 캔들
  pane 에서만 읽힌다.
- ❌ pane 에 **독자 필터를 만들지 않는다** — 만드는 순간 두 표면이 갈릴 수 있게 된다.
- ❌ 새 nav 항목을 만들지 않는다(P1-8 이 매도·매수를 하나로 합친 결정).
- ❌ `depth_heatmap` 을 쓰지 않는다 — 그 경로는 정의가 다른 값을 만든다.
