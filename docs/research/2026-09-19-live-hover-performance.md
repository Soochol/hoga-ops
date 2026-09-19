# Live 캔들 호버 성능 측정

후속: [구현 및 전후 측정 완료](2026-09-19-live-hover-implementation.md). 아래는 수정 전 조사 기록이다.

2026-09-19 · 기준 커밋 `8a16a20824542cdc354efbed1f0d715dc8b0b18b`

## 추가 조사 안내

사용자의 프로그램·일별투자자 창 제보를 반영한 [추가 측정](2026-09-19-live-hover-data-windows.md)에서
날짜 따라가기의 전체 표 재렌더와 50ms 이상 작업을 재현했다. **최종 우선순위는 추가 보고서와
플랜 0단계를 따른다.** 아래는 데이터 창을 제외한 차트 3개 자체의 측정이다.

## 결론

사용자가 알려준 **차트 3개, 캔들 정보 툴팁 OFF**로 실제 `/live` 페이지를 측정했다.
가장 일관된 개선은 **숫자 포맷터 재사용**이었다. 프로덕션 빌드의 60회 봉간 호버에서
JavaScript 실행 시간 중앙값이 일봉 **381.90 → 215.61ms(-43.5%)**, 분봉
**426.10 → 319.27ms(-25.1%)**로 감소했다. 실행 순서를 뒤집고 입력 간 추가 rAF 대기를
없앤 재검증에서도 일봉 **-24.7%**, 분봉 **-22.4%**였다.

이는 격리 브라우저에서의 실험 결과이며 제품 수정의 확정 개선율은 아니다.
기본 CPU 속도에서는 50ms 초과 long task와 25ms 초과 프레임 간격이 관측되지 않았다.
**따라서 사용자가 겪은 버벅임의 유일 원인을 확정하거나 해결되었다고 선언할 수 없다.**
4배 CPU 감속에서는 분봉 frame interval p95가 **50.0 → 33.4ms**로 개선되어,
CPU 여유가 적은 상황에서 체감 차이로 이어질 가능성은 확인했다.

최초 코드 조사에서 우선 의심했던 `series.data()` 전체 복사는 실제로 O(n)이지만,
이번 분봉 호버의 지배적인 비용은 아니었다. 툴팁 비용 또한 사용자 조건에서는 제외한다.

구현 제안: [개선 계획](../plans/2026-09-19-live-hover-performance.md).

## 환경과 방법

- Linux, headless Google Chrome **153.0.8010.52**, viewport 1800×1000.
- 사용자 서버 5173/8000을 건드리지 않고 이 워크트리의 별도 서버 **127.0.0.1:5197** 사용.
- 실제 앱 React 컴포넌트와 lightweight-charts **5.2.0** 사용. 렌더러 stub이 아니다.
- 백엔드는 기동하지 않았다. 캔들/기본 API는 고정 fixture, WS는 격리했다.
  다른 API는 503으로 응답하므로 실시간 시세·호가·투자자 데이터 부하는 포함하지 않는다.
- 고영(098460), 일봉 2026-01-01~09-18 평일 **187개**,
  분봉은 마지막 30평일 ×390개 = **11,700개** wire fixture.
  월~금 fixture는 거래소 휴일을 정교하게 모델링하지 않는다. 목적은 반복 가능한 렌더 부하이다.
- 같은 종목·같은 그룹의 세 창을 나란히 배치한다. 한 번은 모두 D, 한 번은 모두 1m.
  실제 사용자 화면의 혼합 봉 배치·추가 지표·그리기·백필 깊이는 아직 미확인이다.
- 표시 범위는 chart timeScale의 **실제 마지막 캔들 logical index**를 기준으로
  `[last-100, last-5]`. 빈 미래 영역에 마우스가 들어가지 않도록 했다.
- 60회 실제 Playwright `page.mouse.move`, 같은 궤적·3회 반복. 중앙값과 범위를 저장했다.
  기본 시나리오는 move 후 rAF 1회 대기(관측상 약 30회/초)이고,
  별도 fast 시나리오는 추가 대기 없이 CDP mouse move를 연속 수행했다.
- CDP `Performance.getMetrics` 전후 차이로 ScriptDuration/TaskDuration/LayoutDuration,
  rAF로 frame interval, PerformanceObserver로 50ms 초과 long task 수집.
- 등록된 MA/일봉MA/pane legend 시리즈의 `data()`와 DOM rect 읽기를 계측했다.
  `dataRows`는 **계측된 호출의 반환 행 수 합**이며 전체 앱의 모든 할당량은 아니다.
- 툴팁 0개, 크로스헤어 이벤트, 비어 있지 않은 커서 발행을 테스트로 확인했다.
  기본 생산 측정에서는 봉간 호버의 cursor update가 각 run당 60회였다.
- 생산 빌드는 QA 핸들만 노출하는 진단용 Vite plugin/entry를 추가했다.
  React는 production이며 제품 소스 파일은 수정하지 않았다. 순정 배포 파일과 바이트 동일하지는 않다.
- CPU profile을 수집한 초기 개발모드 run은 탐색용이다. 아래 숫자는 profiler 없이
  별도로 실행한 production run이며, 빌드와 측정을 동시에 실행하지 않았다.

## 프로덕션, 3창, 툴팁 OFF, 기본 CPU 속도

각 값은 **60회 입력 한 run의 3회 중앙값**, 단위 ms이다. FPS나 단일 이벤트 지연이 아니다.

| 조건 | 일봉 JS | 분봉 JS | 일봉 main-thread task | 분봉 main-thread task |
|---|---:|---:|---:|---:|
| baseline | 381.90 | 426.10 | 814.69 | 773.30 |
| 전체 `data()` 복사 우회 | 340.19 | 430.60 | 770.22 | 785.85 |
| 숫자 포맷터 재사용 | **215.61** | **319.27** | **600.59** | **681.93** |
| 고저 라벨 OFF | 289.54 | 346.77 | 620.27 | 713.61 |
| 나머지 두 창을 다른 그룹으로 분리 | 221.13 | 330.36 | 467.46 | 597.48 |
| 같은 봉 안에서 Y만 이동 | 140.44 | 211.62 | 295.37 | 368.65 |

모든 조건에서 frame interval p95 16.7~16.8ms, 25ms 초과 0회, long task 0회였다.
고저 라벨/그룹 변경은 원인 분리를 위한 기능 축소 실험이며 제품 해결책이 아니다.
동기화 그룹 분리로 줄어든 비용 전체를 “불필요한 렌더”라고 해석해서도 안 된다.
여기에는 원래 필요한 다른 두 창의 크로스헤어/범례 갱신도 포함된다.

### 실행 순서와 입력 빈도 재검증

위 순서에서는 baseline이 먼저여서 JIT/워밍업에 따른 편향이 있을 수 있다.
별도 브라우저에서 **format-cache 먼저, baseline 나중**, 추가 rAF 대기 없이 재실행했다.

| 조건 | 일봉 JS | 분봉 JS |
|---|---:|---:|
| baseline | 254.56 | 323.31 |
| format-cache | 191.59 | 251.02 |
| 감소 | **24.7%** | **22.4%** |

빠른 입력에서는 분봉 cursor update가 양 조건 모두 56회/60입력으로 coalesce됐다.
따라서 이 표의 절대값을 기본 입력 표와 직접 비교하지 않는다. 같은 표 안의 A/B만 비교한다.
이 조건에서도 frame p95 16.7~16.8ms, 25ms 초과 프레임과 long task는 0회였다.

### 4배 CPU 감속 — 느린 환경의 여유 확인

추가 rAF 대기가 있는 기본 궤적으로 format-cache → baseline 순서, 각각 3회 실행했다.
감속값은 사용자 하드웨어의 실측 사양을 뜻하지 않는다.

| 조건 | 일봉 JS | 분봉 JS | 일봉 frame p95 | 분봉 frame p95 |
|---|---:|---:|---:|---:|
| baseline | 1,116.72 | 1,306.58 | 33.4 | **50.0** |
| format-cache | 903.48 | 1,056.38 | 33.4 | **33.4** |

25ms 초과 frame interval은 3회 합계 일봉 **103/363 → 82/362**,
분봉 **77/362 → 47/362**였다. long task 수는 각각 적고 흔들렸으므로
long task 제거를 개선 근거로 삼지 않는다. rAF 간격은 입력 지연/INP 자체도 아니다.

## 비용 경로와 해석

### 숫자 포맷팅: 구현 우선순위 1

`util/koreanNumber.ts`의 `formatKoreanInt`와 `chart/projectors/candle.ts:26`의 가격축
formatter가 `Math.round(...).toLocaleString('ko-KR')`를 반복 호출한다.
초기 개발 CPU profile에서도 두 함수가 눈에 띄었고, 생산 A/B에서 재사용 효과를 확인했다.
실험에서는 옵션 없는 ko-KR 숫자 변환만 cached Intl.NumberFormat으로 바꿨다.
다른 locale/옵션은 원래 함수를 그대로 호출했고, 반올림/-0/NaN/Infinity 등 문자열 동등성도 확인했다.

실제 구현은 전역 prototype 치환 대신 공유 formatter를 사용해야 한다.
실험이 영향을 준 호출 면적보다 실제 코드 변경 범위가 좁으면 개선폭도 작을 수 있다.

### 고저 라벨: 두 봉 모두 비용 증가에 기여

`HighLowLabelsHost`는 pointermove마다 pane rect를 읽고, 범례 DOM 변화를 감시해
행 rect를 다시 측정한다. 고저 라벨 OFF에서 rect 읽기가 일봉 **840→240**,
분봉 **480→240**회/60입력으로 줄었다. JS도 일봉 24.2%, 분봉 18.6% 감소했다.
이는 라벨 호스트와 canvas primitive를 함께 껐을 때의 효과다. DOM 읽기 하나만의 효과가 아니다.

추가로 `visibleExtremes.computeVisibleExtremes`는 매 draw에서 **로드된 전체 캔들**에
`axis.contains`/`axis.toVirtual`을 적용한다. 깊은 분봉에서 최적화할 여지가 있다.

### 동기화·범례: 필요한 갱신과 불필요한 갱신을 분리해야 한다

`useCursorSyncResolution`은 전역 cursor를 먼저 구독하고 그룹·자기 발행 조건을
나중에 검사한다. `CandleTooltip`도 OFF 상태에서 이 훅을 호출한다.
`PaneLegendOverlay`는 같은 봉 안 Y 이동에도 rAF `tick()`을 예약한다.
따라서 selector 단계의 필터와 의미가 같은 값의 렌더 생략이 다음 개선 후보이다.
이번 측정은 React 컴포넌트별 render count를 직접 수집하지 않았으므로,
이 작업의 정확한 기여도는 구현 전후 render count와 CPU profile로 추가 확인해야 한다.

### 전체 데이터 복사: 존재는 확인, 주원인 판정은 보류

5.2.0 `SeriesApi.data()` 구현은 `rows.map(seriesCreator)`다.
일봉 baseline에서 계측된 반환 행 누계는 91,072개지만 직접 data() 시간 중앙값은
약 5.2ms/run이었다. 전체 복사 우회의 총 JS 차이를 모두 복사 비용 절감이라고 볼 수 없다.
분봉 정상 호버에서는 계측된 `data()` 반환 행 누계가 **0**이었고 복사 우회로 개선되지 않았다.
현재 param.seriesData를 읽는 경로와 빈 보조지표 fallback이 포함된 결과이며,
다른 배치/동기화 상태/결측/더 깊은 데이터에서 전체 복사 문제가 없다는 뜻은 아니다.

## 증거, 재실행, 한계

- [기본 생산 raw](2026-09-19-hover-evidence/production-three.json) /
  [요약](2026-09-19-hover-evidence/production-three-summary.json)
- [빠른 입력 raw](2026-09-19-hover-evidence/production-three-fast.json) /
  [요약](2026-09-19-hover-evidence/production-three-fast-summary.json)
- [4배 감속 raw](2026-09-19-hover-evidence/production-three-4x.json) /
  [요약](2026-09-19-hover-evidence/production-three-4x-summary.json)
- [하네스와 재실행 안내](2026-09-19-hover-evidence/README.md)

초기 탐색은 2창·툴팁 ON/OFF였다. 이후 사용자 답변을 받아 위 3창·툴팁 OFF 측정을
새로 실행했다. 빈 미래 공간을 지나던 분봉 예비 run은 폐기했다.
개발모드 탐색 수치와 사용자 조건의 생산 수치를 섞어 결론을 내리지 않았다.

통제된 데이터로 CPU 비용과 일부 개선 가능성은 검증했지만, 사용자 화면의 실제
지표 조합·혼합 타임프레임·호가 stream·그리기 개수·하드웨어·브라우저까지 재현한 것은 아니다.
최종 구현 후 그 실제 조건으로 확인해야 한다. 이 작업에서는 제품 소스를 변경하지 않았다.
