# 초봉 주기 전환 시점 보존 — 후속 구현·검증 기록

2026-10-25 사용자의 「다음」에 따라 원래 제안에 남아 있던 「같은 시점을 유지하며
주기 전환」을 보완했다. 앞선 1~3단계 도구·설정·저장뷰 구현은 유지한다.

## 변경

- 기존 화면은 timeframe을 key로 다시 마운트해, 과거를 팬한 뒤 주기를 바꾸면
  최신 240봉부터 시작했다. 이제 store action이 차트 제거 전에 창별 뷰포트를 읽고
  일회성 런타임으로 전달한다. 툴바·키보드·메뉴 모두 같은 경로다.
- 우측 실제 시각을 조회 시작점으로 쓰고 좌측 시각까지 필요한 관측을 확보한다.
  표시 폭은 시간 구간을 유지하도록 바꾼다. 연속 봉은 주기 비율, 밤·휴일·드문 체결은
  새 관측 인덱스를 사용한다. 미관측 봉을 만들지 않고 기존 64페이지 예산을 유지한다.
- 부분적으로 보이는 가장자리 봉을 매번 폭에 추가해 반복 전환에서 줌이 커지는 문제를
  막았다. 새 주기의 봉 경계로 옮길 수 있는 범위 안에서 시각을 유지한다.
- 5→10→30→1초 반복 전환에서 범위를 제한한 과거의 마지막 봉을 live edge로
  오인하지 않는다. 최신 추종 가능 여부와 로드된 봉의 오른쪽 끝을 구분하므로 과거
  끝의 여백도 유지한다. 여백은 앵커 봉 이후의 전체 논리 거리를 새 주기로 환산한다.
  최신 복귀는 기존 날짜 칩으로 제한 조회를 해제한다.
- 저장/명시적 이동 구간 안의 팬·줌도 전달한다. 이후 새 분봉→초봉 명령은 이전 전환
  위치를 대체한다. 빠른 전환에는 직전 유효 위치를 유지하고 종목·시장 변경에는
  이전 위치를 승계하지 않는다. 전달값과 등록 함수는 영속 설정에 포함하지 않는다.

## 기준과 검증

- 최신 main `8d93eafb66ca2985bea25bbf7c41fd8b02cf4f8c`를 반영했다. 추가된
  #2285는 Electron 서버 관리 기능으로 이번 프론트엔드 변경과 구현 파일이 겹치지
  않으며 DESIGN.md의 양쪽 기록도 보존했다. Electron 실행·설치·서버 조작은 하지 않았다.
- 검증은 같은 워크트리의 frontend/에서 무자격으로 실행한다. E2E worker 1,
  backend 20054/frontend 21054, `/tmp/hoga-e2e-data-54`·`/tmp/hoga-e2e-dist-54`.
  사용자 서버 5173/8000은 변경하지 않는다. Node v24.13.1, npm 11.8.0,
  Python 3.14.7, Chrome 156.0.8078.47, Vitest 4.1.7과 기존 lockfile을 사용한다.
- 실제 벤더 연결은 검증하지 않는다. 시세는 관측일 두 날짜의 모의 응답이며,
  창 id별 `window.__liveCharts`에서 실제 캔들 시각·가시 폭을 대조한다.
- 최종 입력 SHA-256:
  `b1759fb24452949d71116c8d6ac3c1255764d942282fcc87d397404b042b2f99` (2,275파일).
  frontend/src·frontend/tests·tests/fixtures·hoga와 frontend package/lock·TS/Vite/
  Vitest/Playwright/Tailwind/PostCSS 설정, 루트 pyproject.toml·uv.lock·.python-version을
  경로순으로 정렬해 `경로 + NUL + 내용 + NUL`로 해시했다. 문서·산출물·로그는 제외한다.
- `npm run typecheck`: 앱·단위·E2E 세 TypeScript 프로젝트 통과.
- `npx vitest run src/state/workspace src/live/workspace src/live/LiveChartRoot src/api/secondHistory.test.ts src/live/remainingPerformance.test.tsx src/studyViews --maxWorkers=8`:
  **92파일·1,281테스트 통과**. 창 상태/비영속 전달·종목 격리·캡처 등록 수명·
  부분 봉·일자 공백·여백·기존 차트/저장뷰를 포함한다.
- E2E 서버 준비의 `npx vite build`: 3,376모듈 빌드 통과. 기존 큰 청크 안내는 유지한다.
- 실제 브라우저 검증은 다음 8개 스펙을 worker 1로 실행해 **30건 통과**했다:
  `second-timeframe-viewport.spec.ts`, `second-chart-navigation.spec.ts`,
  `second-chart-tools.spec.ts`, `second-candles.spec.ts`, `second-chart-updates.spec.ts`,
  `trade-scroll-navigation.spec.ts`, `trade-cursor-spot.spec.ts`, `study-view-groups.spec.ts`.
  실행 명령:
  `npx playwright test tests/e2e/second-timeframe-viewport.spec.ts tests/e2e/second-chart-navigation.spec.ts tests/e2e/second-chart-tools.spec.ts tests/e2e/second-candles.spec.ts tests/e2e/second-chart-updates.spec.ts tests/e2e/trade-scroll-navigation.spec.ts tests/e2e/trade-cursor-spot.spec.ts tests/e2e/study-view-groups.spec.ts --reporter=list`.
- 새 스펙은 5→10→30→1초의 실제 양 끝 시각·논리 폭, 과거 끝 여백·최신 복귀,
  밤 사이 구간, 선택 기간 안의 줌과 새 이동 명령의 우선순위를 검사한다.
  `/browse` 설치는 없어 별도 대화형 탐색 대신 저장소 Playwright E2E를 사용한다.
- `git diff --check`: 통과. E2E 종료 후 전용 포트가 비었음을 확인했다.

## 최종 검토의 저장뷰 명령 우선순위 보완

다음 진행 요청의 전체 검토에서 같은 Code의 다른 초봉 저장뷰를 열 때
`setChartTimeframe`이 만든 이전 뷰포트가 새 저장 구간보다 우선할 수 있음을 확인했다.
명시적 `setSecondChartRange`의 설정과 해제 모두 일회성 `secondViewport`를 제거하도록
보완했다. 새 저장뷰 열기는 기존처럼 종목→봉→구간 순서이며 새 저장 기간이 우선한다.

수정 전 `openSavedRange.test.ts`의 저장뷰·구간 설정·해제 세 사례가 모두 실패함을
확인했다. 수정 후 전체 관련 단위·E2E를 재검증하며 별도 최종 입력과 결과를 아래에 기록한다.

- 검토 기준/base: `8d93eafb66ca2985bea25bbf7c41fd8b02cf4f8c`. 새 fetch에서
  origin/main과 같음을 확인했고 열린 PR #1927·#1726은 이번 변경 파일과 겹치지 않는다.
- 최종 검토 입력 SHA-256:
  `7d4590bc457a0298c1ffc63fefdec78877ba8b422018528f6338cd6cd755f10f` (2,276파일).
  위와 같은 경로 집합·정렬·NUL 구분 알고리즘이며 새 `openSavedRange.test.ts`를 포함한다.
- 위 관련 단위 명령: **93파일·1,284테스트 통과**. 새 실패 재현 3건도 포함한다.
- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- E2E 서버 준비의 `npx vite build`: 통과. 같은 8개 E2E 명령 **31건 통과**.
  새 브라우저 사례는 같은 Code의 다른 날짜·30초 저장뷰 열기가 이전 5초 팬 위치를
  대체하고 새 저장 기간·4봉 배율로 착석하는지 확인한다.
- 실행 환경·lockfile·무자격 서버 격리는 위와 같다. `git diff --check`도 통과했다.

## PR·머지 전 결과 재사용 확인

2026-10-25 사용자 요청 `pr merge pull`에 따라 최신 main을 다시 fetch했다.
base는 `8d93eafb66ca2985bea25bbf7c41fd8b02cf4f8c`로 동일하고, 위 2,276파일을
다시 해시한 결과도 `7d4590bc457a0298c1ffc63fefdec78877ba8b422018528f6338cd6cd755f10f`로
일치했다. Node/npm/Python/Chrome 버전과 의존성·검사 설정도 위 기록과 같다.
추가 변경은 이 문서의 전달 기록뿐이며 검사 입력에서 제외된다. 따라서 마지막 타입·빌드·
93파일 1,284개 단위 검사·31건 E2E 통과를 현재 PR 코드의 근거로 재사용한다.
검증은 격리된 모의 시세를 사용했으며 벤더 상태 변화에 의존하지 않는다.
열린 PR #1927·#1726은 이번 파일과 겹치지 않고, `git diff --check`도 다시 통과했다.
