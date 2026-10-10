# 「분봉으로」 이후 3분봉이 2개만 보이는 현상 조사

조사일: 2026-10-10 KST. 제품 소스 기준: `7f1d4dcb4`.
사용자 조건: 일봉·주봉 창의 「분봉으로」 버튼, 3분봉, 일반 벤더 조회.

## 확인한 결과와 한계

**첫 응답이 일부 캔들만 포함할 때 그 작은 봉 수로 초기 줌이 고정되고,
재조회로 전체 데이터가 채워져도 화면에는 2개 봉만 남는 조건을 재현했다.**
실제 Chrome, 앱의 데이터 훅·차트·버튼을 사용했으며, 벤더 응답만 mock했다.
부분 응답에 `rate_limit` 경고를 넣은 조건이 3회 모두 재현됐다.
실제 사용자 세션의 네트워크 응답은 확보하지 않았으므로, 사용자가 본 사건이
반드시 이 부분 응답 경로였다고 단정하지 않는다.

| 시점 | 전체 캔들 | 화면 안 캔들 | 화면 논리 폭 | 봉 간격 |
| --- | ---: | ---: | ---: | ---: |
| 점프 첫 부분 응답 | 2 | 2 | 14 | 약 53.07 px |
| 제한 경고 재조회 후 | 768 | 2 | 14 | 약 53.07 px |

두 번째 시점에서 조회는 성공했고 전체 봉은 존재한다. 차트의 화면 폭이 처음에
2개 봉 + 우측 여백 12칸으로 잡혀 이후에도 유지된다. 화면은 왼쪽에 2개 봉만
보이고 대부분이 빈 공간이다. [재조회 후 스크린샷](after-refetch.png)과
[3회 계측](partial-repeated.json)에 같은 결과가 남아 있다.

## 재현 절차

1. 날짜를 2026-10-01 17:00 KST로 고정한 별도 테스트 브라우저에서 KRX 일반 조회,
   같은 그룹의 일봉·3분봉 창을 연다. 실제 사용자의 저장 설정과 개발 서버는 사용하지 않는다.
2. 일봉의 화면 우측 날짜를 2026-09-29로 잡고 「분봉으로」를 누른다.
3. 첫 `/api/live/past-candles` 응답에서 3분봉 2개만 반환한다. 나머지 조회 실패는
   `data_warnings`의 `kind: rate_limit`, `reason: rate_limit_aborted`로 표현한다.
   fixture는 마감 동시호가로 두 봉이 하나로 접히지 않도록 15:15·15:18 봉을 사용한다.
4. 첫 응답 직후 전체 캔들 수 2와 논리 범위 `[0, 14]`를 확인한다.
5. 브라우저 시계를 61초 진행해 실제 React Query 재조회 타이머를 발화시킨다.
   같은 조회에 정상 전체 응답을 반환한다. 모의 시계의 시간을 진행한 것이며
   수동으로 차트 위치나 줌을 수정하지 않는다.
6. 전체 캔들은 768개, 논리 범위는 `[766, 780]`가 된다. 화면 안에는 2개만 있다.

## 원인

- `frontend/src/live/useTimeframeJump.ts:264`는 과거 목적지를 `asOfDate`로 세운다.
  `:265`의 요청 번호가 들어간 `viewSeg`는 차트를 재생성해 초기 배치를 다시 실행한다.
- `frontend/src/api/livePastCandles.ts:566`의 `isWalkingHistory`는 정상적인
  **오늘 우선 시드**에만 켜진다. 과거 점프는 `todayFirst`가 꺼지고,
  blocking 경고도 이 신호를 끈다. 부분 봉이 존재하면 `:579`의 `isLoading`도 false다.
- `frontend/src/live/useLiveBundle.ts:1793`은 위 신호로
  `isInitialMinuteHistoryPending`을 만든다. 이번 부분 응답에서는 false다.
- `frontend/src/live/LiveChartRoot.tsx:1673`은 pending이 false면
  `Math.min(totalBars, 300)`으로 최초 표시 봉 수를 정한다. 2개 봉이면 2가 된다.
  우측 여백은 최소 12칸이므로 화면 대부분이 여백으로 잡힌다.
- `:1680`에서 최초 배치가 완료됐다고 기록하고, `:1660`에서 이후 봉 수 증가의
  줌 재배치를 건너뛴다. 데이터 갱신의 위치 보존은 논리 폭 14를 유지한다.
  따라서 768개를 받아도 마지막 2개만 보이는 상태가 유지된다.

추가 fetch는 별도 실패가 아니라 제한 경고를 회복하는 경로다.
`frontend/src/api/livePastCandles.ts:255`의 재조회 정책과 `:514` 부근의
실패 응답 병합 기준선 보호가 재시도를 살려 둔다. venue 세션 중에는
`frontend/src/live/liveVenuePolicy.ts:110`에 따라 60초 간격으로 재조회한다.
이번 계측에서 부분 응답과 정상 응답의 요청 구간은 모두 `20260922..20260929`였다.

백엔드도 성공한 날짜의 봉과 실패 날짜의 경고를 한 응답으로 돌려줄 수 있다.
`hoga/live/live_candle_backfill.py:484`의 날짜별 봉 수집과 경고 추가가 그 구조다.
다만 실제 사건에서 봉이 정확히 2개만 반환된 이유까지 이 조사로 확인한 것은 아니다.

## 대조 조건과 별도 발견

정상 전체 응답에 200ms 지연을 넣고 3분봉의 점프 날짜를 번갈아 누르는 7회
행렬에서는 2개 봉 화면이 나오지 않았다. 기록한 화면 내 봉 수는 130~300개였다.
[대조 계측](normal-matrix.json)에 요청 구간과 프레임별 봉 수가 있다.

같은 날짜로 다시 점프하는 경우 별도 배치 일관성 문제도 확인했다. 조회 범위를
넓힌 뒤 같은 목적지로 다시 누르면 `viewSeg`는 바뀌지만 `asOfDate`는 같아서
`useTimeframeJump.ts:282`의 조회 범위 리셋이 실행되지 않는다. 기존
`historicalFromDate`가 남아 `LiveChartRoot.tsx:1632`의 초기 배치 건너뛰기
분기로 들어간다. 정상 데이터에서는 줌이 달라졌지만, 이것만으로 2개 봉 화면이
재현된 것은 아니므로 주 원인과 분리한다.

## 수정 방향

최초 응답에 봉이 있다는 사실과 초기 조회가 완결됐다는 사실을 구분해야 한다.
조회가 부분 실패했거나 초기 이력이 아직 채워지는 중이면 그 작은 봉 수로
최종 줌을 확정하지 않는다. 일반 300봉 화면을 예약하거나, 초기 완결 시점에
한 번 다시 배치하되 그 사이 사용자 팬·줌 입력이 있었다면 그 입력을 보존한다.
실제로 전체 데이터가 2개뿐인 종목의 정상 초기 배치와 구분해야 한다.

같은 날짜 재점프의 조회 범위 리셋은 점프 명령 번호와 차트 초기화의 일관성을
별도로 검토해야 한다. 모든 데이터 갱신마다 300봉을 적용하면 사용자 스크롤을
되돌리는 부작용이 있으므로 그 방식으로 수정하지 않는다.

## 검증과 재실행

- 위 부분 응답 재현: Playwright 3회 모두 동일 결과.
- 기존 `useTimeframeJump.test.tsx`, `livePastCandles.test.tsx`: 92개 통과.
- 최초 조사에서는 제품 코드 수정 없이 진단용 소스와 계측만 보관했다. 후속 수정은 아래에 기록한다.

진단 하네스는 버그의 현상 자체를 단언하므로 제품 회귀 테스트로 등록하지 않았다.
워크트리 루트에서 아래 두 파일을 임시 위치로 복사한 뒤 실행할 수 있다.
포트 21988이 비어 있어야 하며, 실패해도 사용자 서버에 재접속하지 않는다.
모든 캔들 조회는 mock한다.

```sh
cp docs/diagnostics/2026-10-10-minute-jump-two-bars/reproduce.spec.ts.txt frontend/tests/e2e/jump-investigation.spec.ts
cp docs/diagnostics/2026-10-10-minute-jump-two-bars/playwright.config.ts.txt frontend/playwright.jump-investigation.config.ts
cd frontend
npx playwright test --config playwright.jump-investigation.config.ts --repeat-each=3
```


## 후속 수정 및 검증

사용자 요청에 따라 초기 부분 응답의 줌 고정을 수정했다.

- `useLiveBundle`은 최초 조회의 blocking 경고가 남아 있으면 초기 이력이
  미완료임을 표시한다. 재시도 중의 일시적인 로딩도 같은 상태로 유지한다.
- `LiveChartRoot`는 작은 부분 봉 수로 줌을 확정하지 않고 정상 분봉 범위를
  예약한다. 실패한 최초 조회가 완료되면 정상 범위를 한 번 복구한다.
  그 사이 사용자가 드래그하거나 줌을 조작했다면 재배치를 생략한다.
- 기존 오늘 우선 시드의 정상 이력 추가는 원래의 픽셀 위치 보존 경로를 유지한다.
- 초기 예약 여백에서 추가 백필을 시작하지 않는다. 이전 날짜의 지연된
  소스 교체 재배치가 초기 복구 또는 사용자의 조작 상태를 덮어쓰지 않게 한다.
- 모든 데이터를 받은 결과가 실제로 2개 봉뿐이면 기존 작은 데이터의 초기
  배치는 그대로 동작한다.

검증 결과:

- 관련 Vitest 6개 파일, 463개 테스트 통과.
- `live-viewport-preservation.spec.ts`의 6개 시나리오를 Chrome에서
  각각 3회 반복해 총 18회 통과. API만 mock하며 실제 차트와 입력을 사용한다.
- 3분봉 부분 응답 2개 → 전체 768개에서 조작이 없으면 화면에 300개 봉이 보인다.
  드래그·휠 줌을 했으면 재조회 전후 봉 간격·논리 폭·같은 봉의 픽셀 위치가 유지된다.
- 기존 1분·15분 오늘 우선 시드, 새로고침·분봉 점프·누른 채 드래그도 통과했다.
- 프론트엔드·단위 테스트·E2E TypeScript 검사 통과.
- 변경 파일 ESLint에는 기존 오류가 남아 있다. HEAD와 규칙별 개수를 대조했으며
  이번 변경으로 추가된 오류·경고는 없다.

수정 검증용 mock 전용 설정은 `fix.playwright.config.ts.txt`에 보관했다.
위의 최초 조사 재현 하네스는 수정 전 증거이고, 현재 동작 검증에는 사용하지 않는다.

```sh
cp docs/diagnostics/2026-10-10-minute-jump-two-bars/fix.playwright.config.ts.txt frontend/playwright.jump-investigation.config.ts
cd frontend
npx playwright test --config playwright.jump-investigation.config.ts --repeat-each=3
rm playwright.jump-investigation.config.ts
```
