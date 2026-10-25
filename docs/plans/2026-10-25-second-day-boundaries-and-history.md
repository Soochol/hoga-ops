# 초봉 날짜 구분선과 연속 과거 자동 채움

2026-10-25 요청의 날짜 구분선을 구현한 뒤, 사용자가 승인한 개선안 1~3과
읽던 시점·배율 보존을 구현한다. 초기 표시 밀도 조정은 후속 검토로 남긴다.

## 날짜 구분선 — 구현

초봉도 공통 `LiveChartRoot`를 쓰지만 구분선 시각 계산과 `DayBoundaryOverlay` 마운트가
모두 `isMinuteTimeframe`으로 제한돼 있었다. 두 조건을 D/W/M을 제외한 장중 봉으로
바꿔 1·5·10·30초에도 기존 primitive를 사용한다. 별도 렌더러·새 설정·색은 만들지 않는다.

- 거래일 N개에 최대 N-1개의 선. 첫 거래일 앞에는 긋지 않는다.
- 09:00 정각이 아니라 새 거래일의 첫 실제 렌더 봉에 선을 세운다. 미관측 시작 구간을
  임의로 채우지 않으며 개장 정각의 축 좌표가 없어서 선이 사라지는 문제를 피한다.
- 캔들·거래량·보조지표 pane마다 같은 1px 점선·테마 토큰을 사용한다.
- 팬·줌의 위치 계산은 캔들과 같은 캔버스 패스에 남긴다. 날짜 라벨은 시간축이 소유한다.
- D/W/M은 제외한다. 조회·수집·초봉 설정 저장·배율 정책은 그대로다.

## 과거 자동 채움 — 변경 전 조사

분봉은 화면 왼쪽 부족분으로 `fillBudgetSteps`를 계산해 fill 루프가 여러 청크를
이어 조회한다(`useViewportBackfill`의 left_pan·settle_loop). 원래 데이터가 없어서
화면이 비는 경우의 제한된 복구 경로도 있다. 무제한 조회는 아니며 요청 예산과 하한을 따른다.
초기 분봉 표시 목표도 창 너비 자동 계산이 아니라 기본 300봉이다.

초봉은 다음 두 경로로 구분된다.

1. `SecondChartWindow`는 최초 관측 240봉이 모일 때까지 이전 구간·저장 날짜를 자동으로
   추가 조회한다. 저장뷰·명시적 기간·주기 전환에는 필요한 시작 시각까지 확보한다.
2. 일반 팬·줌의 `usePagedChartHistory`는 `pagesPerGesture: 1`이다. 초기 allowance는 0이며
   입력 한 번에서 한 페이지만 읽고, 화면 왼쪽이 계속 비어도 다음 입력을 기다린다.
   한 페이지의 시간 폭은 240×주기이고 관측 봉이 적으면 실제 추가 봉 수는 더 적다.

따라서 초봉의 과거 자동 로딩 자체는 존재한다. 분봉과 다른 부분은 최초 표시 목표와
팬·줌 이후의 화면 부족 범위를 연속으로 채우는 정책이다. 최초 240봉을 화면에 맞춰
표시하는 현재 동작을 「창 폭을 보고 충분한 과거를 확보하는 동작」과 구분해야 한다.

## 연속 자동 채움 — 후속 승인으로 구현

우선순위는 과거 팬·축소 후의 화면 부족분 채움이다.

1. `usePagedChartHistory`의 초봉 전용 `fillViewport`로 입력 후 안정된 화면의 왼쪽
   부족분과 기존 50봉 여유를 고정한다. 150ms 동안 팬·휠 범위 갱신을 기다린다.
2. 실제 prepend한 축 슬롯만 목표에서 차감하고 완료까지 순차 조회한다. 빈/드문 체결
   페이지로 커서만 전진해도 이어가며, 요청 토큰과 `cancelRefetch: false`로 중복을 막는다.
   폴링·뷰포트 복원 이벤트가 목표를 새로 만들거나 늘리지 않는다.
3. 기존 소스의 이전 관측 날짜·64페이지·데이터 끝·명시적 저장/선택 구간 하한을 따른다.
   오류에는 멈추고 기존 버튼으로 실패 페이지를 재시도한다. 날짜 목록 조회 오류도
   데이터 끝으로 표시하지 않고 별도 재시도한다. 끝/선택 시작/한도는 기존 보조 글씨다.

추가 요청의 시각·배율 보존: 응답 설치 직전의 시각 앵커·논리 범위를 캡처해 prepend
인덱스 차이만큼 옮긴다. 기존 `useSecondViewport`로 봉 간격도 보존한다. 대기 중 팬·줌을
덮어쓰지 않으며 빈 화면에 맞춘 재확대나 fitContent는 하지 않는다. 새 입력이 없으면
원래 채움 목표를 초과해 늘리지 않는다. 미국 차트의 기본 3페이지 예산은 유지한다.

초기 표시 밀도를 통일하려면 그다음 창의 실제 plot 폭과 기본 봉 간격으로 목표 봉 수를
정하는 방식을 검토한다. 현재 240봉은 최소 기준으로 두고 넓은 화면의 필요량을 추가
확보할 수 있다. 화면을 줄일 때 읽던 구간을 자동 축소하거나 초기화하지 않는다.
단순히 고정 240을 300으로 바꾸는 것만으로는 팬·축소 후 중단되는 원인이 해결되지 않는다.

## 날짜 구분선 단계의 검증 기록

기준/base: `4d74b1915f714165408e2c7f1cf6d2e4d8ab2c4d`. 최종 검증 전 fetch에서
origin/main의 추가 변경이 없음을 확인했다. 백엔드·API 계약·의존성은 변경하지 않았다.

- 수정 전 새 렌더러 검사에서 분봉은 통과, 초봉 4종은 모두 구분선 primitive 부재로 실패했다.
- 수정 후 렌더러·primitive·세션 경계·페이지 정책 단위 검사 5파일·225건 통과.
  one-page gesture 정책은 빈 범위에서도 추가 입력 전까지 1페이지에서 멈춤을 확인했다.
- 기존 초봉 E2E 3건과 새 구분선 E2E 1건, 합계 4건 통과. 실제 창 id별 차트 핸들에서
  거래일 경계 x를 구하고 캔들·거래량 캔버스의 테마 색 픽셀을 검사한다. 두 팬/줌 범위에서
  모두 선을 확인했고 생성한 스크린샷도 검토했다. 첫 봉은 14:30:20으로 개장 정각이 아니다.
- 앱·단위·E2E 타입 검사 및 빌드 결과와 최종 입력 지문은 아래에 기록한다.
- 시세 API는 모의 응답이다. 실제 벤더·운영 앱을 조사한 것으로 해석하지 않는다.
  `/browse` 설치가 없어 저장소 Playwright E2E로 검증했다. E2E worker 1·무자격·
  backend 20054/frontend 21054·`/tmp/hoga-e2e-data-54`를 사용하고 사용자 서버는 건드리지 않았다.

최종 입력 SHA-256: `c8a7e152585404dfaaf480d4e8db0116616c2ad91f4781fff4f9a933a7731063`
(2,277파일). frontend/src·frontend/tests·tests/fixtures·hoga와 frontend package/lock·
TS/Vite/Vitest/Playwright/Tailwind/PostCSS 설정, 루트 pyproject.toml·uv.lock·.python-version을
경로순으로 정렬해 `경로 + NUL + 내용 + NUL`로 해시했다. 문서·산출물·로그는 제외한다.
Node v24.13.1, npm 11.8.0, Python 3.14.7, Chrome 156.0.8078.47, Vitest 4.1.7,
Vite 8.0.16을 사용했다. 이 변경에서 의존성·lockfile·검증 설정은 수정하지 않았다.

실행 명령은 frontend/ 기준이다.

- `npx vitest run src/live/LiveChartRoot.test.tsx src/chart/DayBoundaryOverlay.test.tsx src/chart/DayBoundaryPrimitive.test.ts src/chart/sessionSpans.test.ts src/live/usePagedChartHistory.test.tsx`: 5파일·225건 통과.
- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과. 이후 추가한 단위 검사에 대해
  `npx tsc -p tsconfig.test.json --noEmit`도 다시 통과했다. 앱과 E2E 검사 입력은 동일하다.
- `npm run build`: 앱 타입 검사·Vite 빌드 통과. 기존 큰 청크 안내는 유지된다.
- `npx playwright test tests/e2e/second-day-boundaries.spec.ts tests/e2e/second-candles.spec.ts --reporter=list`: 4건 통과.
  이 결과 후 변경은 단위 테스트와 문서뿐이며 E2E 앱/스펙/픽스처/설정은 동일하다.
- `git diff --check`: 통과. 자동 채움의 런타임은 변경하지 않았으며 개선안은 제안 상태다.

## 연속 채움 단계의 검증 기록

기준/base는 같은 `4d74b1915f714165408e2c7f1cf6d2e4d8ab2c4d`이며 최종 검사 전
fetch한 origin/main과 일치한다. 백엔드·wire 계약·의존성·검증 설정은 변경하지 않는다.

- 단위 검사: 한 입력의 연속 조회·대기 중 팬/줌·고정 목표·빈/희소 페이지·중복 방지·
  오류/하한/차트 교체/해제 중단을 검증한다. 소스에서 63→64페이지와 선택 하한 도달 후
  추가 호출이 없음을 검사한다. 기존 3페이지·명시적 1페이지 정책도 유지한다.
- 새 E2E: 한 실제 포인터 입력으로 240→960봉을 두 거래일에 걸쳐 확보한다. 관측된
  동일 봉의 픽셀 위치·인접 봉 거리·barSpacing·논리 폭을 응답 전후 비교한다. HTTP 대기
  중 팬/줌한 경우도 유지하고 고정 목표에서 멈추며, 새 입력으로 데이터 끝까지 이어간다.
  선택 구간 하한과 실패 후 수동 재시도도 확인한다.
- 최초 E2E에서는 위 두 뷰포트 검사가 통과했으나 하한 검사의 canvas locator 클릭이
  위쪽 canvas 레이어에 막혀 타임아웃됐다. 같은 plot 좌표의 실제 마우스 입력으로 고쳤다.
- 최종 명령·결과·입력 지문은 아래에 덧붙인다.

최종 입력 SHA-256: `9d28cbf266388ada8a5402df543f8d1a55fc77f1991881b278f4da0d5206bd70`
(2,278파일). 위 날짜 구분선 단계와 같은 경로·정렬·NUL 구분 해시 규칙과 도구 버전이다.
검사 후 fetch에서도 HEAD와 origin/main은 위 base와 일치한다. 아래 명령은 frontend/ 기준이다.

- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- `npx vitest run src/live/usePagedChartHistory.test.tsx src/api/secondHistory.test.ts src/live/LiveChartRoot.test.tsx src/live/workspace/SecondChartWindow.viewport.test.tsx src/live/workspace/secondChartViewport.test.ts src/live/workspace/secondTimeframeViewport.test.ts src/chart/DayBoundaryOverlay.test.tsx src/chart/DayBoundaryPrimitive.test.ts src/chart/sessionSpans.test.ts`: 9파일·256건 통과.
- `npm run build`: 통과. 기존 큰 청크 안내 외 실패 없음.
- `npx playwright test tests/e2e/second-history-fill.spec.ts tests/e2e/second-day-boundaries.spec.ts tests/e2e/second-candles.spec.ts tests/e2e/second-timeframe-viewport.spec.ts tests/e2e/second-chart-updates.spec.ts tests/e2e/us-stock-minute-history.spec.ts --reporter=list`: 30건 통과.
  새 연속 채움 4건뿐 아니라 구분선·초봉 4주기·주기 전환·1만 봉 갱신·미국 분봉의
  실제 휠·응답 시점 배율/픽셀 보존과 cursor history를 함께 검증했다.
- `git diff --check`: 통과.

로그는 `/tmp/hoga-second-fill-final-{types,unit,build,e2e}.log`에 기록했다. 시세는 모의
응답이며 실제 벤더·운영 Electron 앱 확인은 아니다. 같은 격리 E2E 환경(무자격·worker 1·
backend 20054/frontend 21054·`/tmp/hoga-e2e-data-54`)을 사용했다. 종료 후 두 E2E 포트는
비었고 사용자 5173/8000의 기존 프로세스는 그대로다. 최종 검사 후 변경은 이 검증 문서뿐이다.

PR·병합 단계에서도 origin/main은 같은 base이고, 재계산한 검사 입력 지문은 위의
`9d28cbf266388ada8a5402df543f8d1a55fc77f1991881b278f4da0d5206bd70`와 일치한다.
동일 환경에서 완료한 위 타입·단위·빌드·E2E 결과를 현재 PR head에 재사용한다.
열린 PR #1927·#1726과 수정 파일이 겹치지 않음을 확인했다. 검증 이후 런타임·테스트·
픽스처·의존성·검증 설정에는 추가 변경이 없고 PR 설명에도 base·지문·결과를 연결한다.
