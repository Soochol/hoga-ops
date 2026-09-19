# Live 캔들 호버 성능 개선 계획

작성일: 2026-09-19. 조사 기준: `8a16a20824542cdc354efbed1f0d715dc8b0b18b`.
상태: **0·1단계 및 2단계의 구독 최적화 구현·측정 완료.**
결과: [구현·검증 보고서](../research/2026-09-19-live-hover-implementation.md).
일봉 따라가기 JS 90.8% 감소, 차트 단독 일봉/분봉 45.2%/34.9% 감소.
로컬 범례·라벨 캐시 및 전체 데이터 복사 제거는 목표 달성 후 조건부 후속으로 남긴다.

## 대상과 보존할 동작

사용자 재현 조건은 **차트 3개, 캔들 정보 툴팁 OFF, 일봉과 분봉 모두 호버 시 버벅임**이다.
측정 보고서: [호버 성능 측정](../research/2026-09-19-live-hover-performance.md).

커서 동기화를 끄거나 갱신 간격을 길게 만드는 것을 해결책으로 삼지 않는다.
현재 일봉→분봉의 당일 마지막 봉, 분봉→일봉의 날짜 매칭, 창 그룹/종목 게이트,
범위 밖 안내, 포인터 이탈/창 제거 시 소유자별 정리, 분봉 사이드바 throttle을 보존한다.
ADR-0044의 분봉 spot 조회와 ADR-0059의 직전 봉 대비 수치도 유지한다.

## 0. 프로그램·일별투자자 창의 호버 렌더 경로 — 추가 조사 후 최우선

사용자의 추가 제보를 반영해 **차트 3개 + 프로그램 일별 창 + 일별투자자 창**을
실제 페이지에 열어 재측정했다. [추가 측정](../research/2026-09-19-live-hover-data-windows.md).
빠른 이동에서는 스크롤/API 요청이 없어도 표의 포맷팅이 수만 회 발생했고,
일봉에서 450ms씩 머물러 따라가기를 발동하면 50ms 이상 작업이 반복 재현됐다.
아래 1단계의 포맷터 작업과 이 범위를 첫 구현 묶음으로 삼는다.

대상:
- `frontend/src/live/workspace/DataWindow.tsx`의 `InvestorDailyPane`, `ProgramWindow`
- `frontend/src/live/workspace/InvestorDailyWindow.tsx`, `InvestorDailySummaryCell.tsx`
- `frontend/src/sidebar/ProgramTradeSummaryCard.tsx`의 `ProgramDailySummary`
- `frontend/src/live/investorDailySummary.ts`의 `formatInvestorK`

구현:
1. 일별 데이터 창은 ms 단위 커서 대신 **그룹 게이트된 YYYYMMDD**를 구독한다.
   같은 날짜의 분봉 사이 이동은 표를 다시 렌더하지 않도록 한다.
   프로그램 당일 누적 보기는 시간 커서가 필요하므로 daily/intraday 소비 경로를 분리한다.
2. 투자자 표의 데이터/표시 설정 기반 행 모델·셀 문자열을 안정화한다.
   날짜 하이라이트 변경으로 60행 전체의 숫자·title·aria-label을 다시 만들지 않는다.
   memo 행에는 매 렌더 새로 만든 values 객체/콜백을 넘기지 않는다.
3. 따라가기의 `cursorTarget` 초기화/300ms 타이머 완료가 표 전체 재렌더를
   일으키지 않게 제어 상태를 분리하거나 행 memo로 범위를 제한한다.
   데이터 도착, 전체 기간의 표시 행 확장, 안내 문구 갱신은 그대로 지원한다.
4. 프로그램 `rows=[...points].sort(...).slice(...)`와 합계를 데이터·기간 기준으로 memo한다.
   현재는 매 렌더 새 rows가 effect deps에 들어가 **같은 날짜의 분봉 이동에도
   300ms 타이머를 취소/재예약**한다. 안정화 후 날짜가 실제 바뀔 때만 debounce한다.
5. `formatInvestorK`의 `Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })`와
   요약 셀의 en-US 정수·금액 옵션을 각각 재사용한다. 기존 K 임계값, 유니코드 마이너스,
   부호, exact title/aria-label, null 표현을 보존한다. ko-KR 캐시만으로는 이 경로가 해결되지 않는다.

회귀 및 성능 기준:
- 동일 날짜 분봉 60회 이동에서 데이터/설정 변경이 없다면 표 숫자 재포맷팅은 0회가 목표.
- 날짜 변경 때 강조 변경은 이전/새 행에 한정하고 표 셀 데이터 문자열은 재계산하지 않는다.
- 프로그램 같은 날짜 커서 이벤트가 300ms보다 촘촘해도 최초 날짜 따라가기는 지연되지 않아야 한다.
- 450ms dwell 시나리오를 유지하며 연동/따라가기 ON 상태의 JS 중앙값 50% 이상 감소 목표.
  고정 fixture에서 반복되던 50ms 이상 작업을 제거했는지 3회 이상 확인한다.
- 기존 커서 따라가기 OFF 의미는 스크롤 제어다. 성능 개선을 위해 하이라이트 의미를 바꾸지 않는다.
- 데이터가 이미 있는 날짜는 추가 API 요청 0. 없는 과거 날짜는 한 페이지씩 조회하며,
  커서 변경/이탈 후 추가 페이지 예약 중단과 프로그램 스크롤의 무한조회 방지를 검증한다.

## 1. 숫자 포맷터 재사용 — 차트 경로

대상:
- `frontend/src/util/koreanNumber.ts`
- `frontend/src/chart/projectors/candle.ts`
- 필요할 때 `frontend/src/chart/HighLowLabelsPrimitive.ts`의 정수 가격 표기

모듈 단위 `Intl.NumberFormat('ko-KR')` 인스턴스를 재사용한다.
`formatKoreanInt`의 기존 `Math.round`는 그대로 두고, 캔들 가격축 formatter도 동일한
공유 함수를 호출하도록 한다. 소수/부호 옵션이 다른 formatter는 일괄 변경하지 않는다.

측정의 `format-cache`는 브라우저 안에서 **ko-KR + 옵션 없는** `toLocaleString`만
일시적으로 캐시 포맷터로 치환한 상한 실험이다. 실제 구현에서 전역 prototype을
수정하지 않는다. 정확한 개선율은 위 좁은 코드 변경 후 다시 측정한다.

검증:
- 양수/음수/0/-0/소수 반올림/큰 가격/NaN/Infinity에서 기존 문자열과 동일함을 확인한다.
- 일봉·분봉 OHLC, MA, 거래량, 가격축 표시가 동일해야 한다.
- 3창·툴팁 OFF, 두 봉 종류의 동일한 호버 시나리오에서 ScriptDuration 중앙값을 비교한다.
  목표는 각각 **20% 이상 감소**, 나머지 시나리오에서 5% 초과 악화가 없는 것이다.
  달성 수치가 아니라 구현 후 통과 기준이다.

## 2. 동기화 구독과 범례 갱신의 범위 축소

대상:
- `frontend/src/live/useCursorSyncResolution.ts`
- `frontend/src/live/PaneLegendOverlay.tsx`
- `frontend/src/live/CandleTooltip.tsx`
- 필요할 때 `frontend/src/chart/CursorSyncCrosshair.tsx`

현재 훅은 전역 cursor 값을 먼저 구독한 후 그룹·발행자 게이트를 검사한다.
selector 단계에서 자기 창/다른 그룹/비활성 소비자에 대해 안정적인 빈 결과를 반환한다.
일봉 소비자는 같은 날짜의 같은 캔들로 해석되면 결과 참조를 유지한다.
툴팁 OFF에서는 훅 호출 규칙을 유지하면서 enabled 조건으로 커서 구독 결과를 고정한다.

범례의 같은 봉 내 Y 이동은 표시 값이 같을 때 렌더를 생략한다. 단순히 `param.time`만
비교하면 정지 커서 아래의 라이브 값 갱신을 놓친다. 시점과 표시 값/데이터 변경 신호를
함께 사용하고, 레이아웃 갱신(크기·pane 순서·보이는 범위)은 별도 경로로 유지한다.

검증:
- 다른 그룹/자기 발행/툴팁 OFF에 대해 렌더 횟수 계측으로 불필요한 갱신이 사라졌는지 확인한다.
- 같은 봉 60회 이동 중 범례 값 변경이 없으면 추가 값 렌더는 0회가 목표다.
- 같은 시점에 가격/거래량/MA 데이터가 바뀌면 범례는 갱신되어야 한다.
- D→D, 1m→1m, D→1m, 1m→D 및 같은 그룹/다른 그룹/다른 종목을 테스트한다.
- 기존 `useCursorSyncResolution`, `CursorSyncCrosshair`, `PaneLegendOverlay`,
  `LiveChartRoot.drawingHover`, 커서 소유자 정리 테스트를 회귀 검증한다.

## 3. 고저 라벨의 측정·계산 비용 축소

대상:
- `frontend/src/live/HighLowLabelsHost.tsx`
- `frontend/src/live/legendAvoidRects.ts`
- `frontend/src/live/visibleExtremes.ts`
- `frontend/src/chart/HighLowLabelsPrimitive.ts`

`pointermove` detail hit test를 rAF로 합치고, pane rect는 리사이즈·레이아웃 변화 시
갱신한다. 범례 DOM 텍스트가 바뀌었다는 이유만으로 모든 행을 재측정하지 않도록
실제 행 크기/배치 변화 감지로 좁힌다. 폰트 로드, 행 추가/삭제, 창 리사이즈는 놓치지 않는다.

`computeVisibleExtremes`는 현재 그릴 때마다 로드된 캔들 전체를 순회한다.
정렬된 실 시각으로 가시 구간을 이진 탐색한 다음 그 구간만 훑는 방식 또는
데이터·axis·가시범위별 캐시를 검토한다. 실제 축의 세션 간 간극/오프축 봉/경계 봉
포함 규칙을 확인한 뒤 변경한다. `computePriorDaysExtremes`도 켜진 경우에만 같은 원칙을 적용한다.

검증: 극값 동률의 첫 발생, 직전일 제외, 오른쪽 기준 종가, 장외 봉, 과거 백필,
팬/줌 및 라벨 충돌 회피 결과 동일성. 고저 라벨 OFF는 원인 분리 실험일 뿐 해결책이 아니다.

## 4. 범례 전체 데이터 복사 제거 — 조건부 후속 작업

`legendRows.readSeriesValue`의 fallback/동기화 경로는 `series.data()` 뒤에 이진 탐색을
한다. lightweight-charts 5.2.0의 `data()`는 전체 행을 새 객체로 변환하므로 O(n)이다.
다만 이번 실제 호버 측정에서 이 경로는 항상 지배적이지 않았다. 1~3단계보다 먼저
전면 캐시 계층을 도입할 근거는 부족하다.

후속 측정에서 이 경로가 유의미하면 차트 전역 logical index를 이용하는 `dataByIndex`
조회 또는 series 쓰기 경로가 제공하는 읽기 전용 snapshot/index를 도입한다.
series별 배열 인덱스를 chart logical index로 오인하지 않는다. whitespace의 정확 일치
실패와 기존 최신값 fallback 의미를 그대로 보존한다. 단순 영구 `data()` 캐시는 금지한다:
setData/update/백필/series 교체와 해제의 무효화가 필요하다.

검증: O(n) 전체 `data()` 호출이 호버 횟수에 비례하지 않음을 호출 횟수로 검사하고,
다른 시간축/결측/오프축 데이터/라이브 tail 갱신을 포함한다.

## 구현 순서와 완료 기준

1. 0단계의 일별 데이터 창 렌더 범위와 en-US 포맷터, 1단계의 차트 포맷터를 작은 변경으로 나눠 구현하고 각각 같은 벤치마크로 검증한다.
2. 남은 비용을 다시 프로파일링하고 구독/범례 갱신을 줄인다.
3. 라벨 비용이 여전히 의미 있으면 가시 범위 계산과 DOM 측정을 줄인다.
4. 전체 데이터 복사는 별도 증거가 있을 때 최적화한다.

사용자 조건의 차트 3개·툴팁 OFF와 프로그램/일별투자자 창을 기본으로, 한 창/세 창, 같은 봉/봉간 이동,
일봉/분봉/혼합 배치, 기본 데이터/깊은 백필, 라이브 틱 동시 수신을 비교한다.
같은 브라우저·해상도·데이터·입력 횟수에서 3회 이상 반복하고 median/range를 기록한다.
CPU throttle과 native, 개발/프로덕션 수치를 섞지 않는다. 대조군 실행 순서를 바꿔 확인한다.

제품 변경 후 저장소 요구 검증인 `npm run typecheck`, `npx vitest run`, `npx vite build`,
`npx playwright test`를 수행한다. 벤치마크 시간 임계치를 일반 CI 기능 테스트의
불안정한 통과 조건으로 넣지 않고, 호출/렌더 횟수 같은 결정적 회귀 검사를 별도로 둔다.

사용자 화면의 버벅임 해소 판정은 실제 3창 배치와 지표·백필량·라이브 틱 조건으로
최종 확인한다. 격리 fixture에서 long task가 없다는 사실만으로 해결되었다고 선언하지 않는다.


## 구현 기록

- 일별투자자/프로그램 일별 창은 그룹별 날짜를 구독한다. 당일 누적 프로그램의 분봉 시각 구독은 유지한다.
- 투자자·프로그램 숫자 셀과 누적 셀 JSX는 데이터/표시 설정으로 memo하고, 행은 날짜 강조 boolean과 안정된 셀 참조로 memo한다.
- 프로그램 rows/totals 참조를 안정화해 동일 날짜의 반복 렌더가 300ms 따라가기 타이머를 재시작하지 않는다.
- ko-KR 가격·수량·억 표기 및 en-US 투자자 K·exact 표기의 Intl.NumberFormat을 재사용한다.
- 동기화 훅은 게이트/날짜 스냅이 끝난 결과를 구독한다. 툴팁 OFF는 enabled=false로 구독 결과를 고정한다.
- 단위 회귀 검사: 날짜 강조/따라가기 타이머에서 투자자 숫자 재포맷팅 0회, 실제 데이터 변경 시 재포맷.
  프로그램은 100ms 간격의 같은 날짜 이벤트 중에도 최초 300ms에 스크롤한다.
- 문자열 호환성(음수·-0·반올림·NaN·Infinity), 같은 날짜 동기화 렌더 생략 및 정지 커서의 데이터 갱신을 검사한다.

최종 수치·검증 결과·남은 조건부 최적화 판단은 위 구현 보고서에 기록했다. 단위 7,576개와 관련 E2E 9개는 통과했으며, 전체 E2E의 별도 실패 10건도 숨기지 않고 기록했다.
