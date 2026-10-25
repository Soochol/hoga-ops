# 초봉 구간 이동·저장·관측 체결강도 — 구현·검증 기록

2026-10-25 사용자의 「좋아 다음」과 「재개」에 따라 공통 분석 도구 1·2단계에
이어 후속 범위를 구현했다. 이전 기록은
[초봉 공통 분석 도구](2026-10-25-second-chart-analysis-tools.md)에 보존한다.

다음 요청의 초봉 주기 전환 시점 보존과 최신 검증은
[주기 전환 구현 기록](2026-10-25-second-timeframe-viewport.md)을 따른다.

## 동작과 데이터 경계

- 분봉 도구 행의 `초봉으로 확대`는 화면 오른쪽 봉을 연다. 선택된 측정 도형의
  같은 버튼은 두 끝점 사이를 연다. 같은 그룹·Code의 기존 초봉 창을 재사용하며
  없으면 5초봉 창을 만든다. 고정 종목과 다른 그룹의 종목·창은 교체하지 않는다.
- 오늘부터 과거 페이지를 걷는 대신 선택 날짜·시각을 직접 요청한다. 버킷의 양 끝은
  API의 배타적 상한에 맞추며 정규장 필터로 전체가 제외되면 빈 관측으로 표시한다.
  기존 64페이지 예산과 부분 조회 안내·재시도를 사용한다. 구간은 비영속 창 런타임이다.
- 초봉의 현재 가시 기간·주기·뷰포트를 기존 저장뷰 API로 저장한다. 드로어와
  `/live?view=`는 저장된 초 주기를 복원하고 현재 창의 `seconds` 지표 설정을 쓴다.
  KRX 고정을 유지하며 KRX 외 새 저장은 이유를 알리고 비활성화한다. 초봉에는
  hogaplay 커버리지/누락 수집 UI나 2년 보존 제한을 적용하지 않는다.
- 저장뷰에서 측정 구간으로 이동하면 초봉은 명시적 구간을 먼저 표시하면서 KRX
  원천을 유지한다. 초봉 구간 해제만으로 원래 저장뷰 선택을 지우지 않는다.
- 체결강도는 활성 항목이 요청한 `include_prices`의 방향별 1초 가격 셀을 표시 주기로
  합산한다. 방향 0은 제외한다. 조회된 이력에 체결강도를 추가하면 모든 기존 페이지를
  가격 셀로 보강하며 읽던 봉을 최신 페이지로 교체하지 않는다. 숨긴 뒤에도 이력은 유지한다.
- 초 단위 호가·프로그램을 만들거나 분봉을 보간하지 않는다. 완전한 장 시작 기준을
  보장하지 않는 초봉에서 체결강도/거래량의 당일 누적선은 제공하지 않는다.
- backend wire·수집기·저장 파일은 변경하지 않았다. 기존 API의 seconds timeframe과
  관측 체결 조회를 사용한다. 실제 공급자 연결·설치·배포는 이번 검증에 포함하지 않았다.

## main 통합

기존 기준 `cf51438a22c5ebf483c6c563467fa56ef475487c`에서 최신 main
`cd3a4f3523df606a734f425e226a51c23f82477a`를 반영했다. 체결창 스크롤 탐색
(#2284)의 커서 발행·유효 venue·정규장 필터·미조회 초봉의 `loadAt`을 공통
렌더러에 유지했다. 기존 기본 history query key도 유지한다. 최종 검증 전 fetch에서
HEAD와 origin/main이 위 SHA로 같음을 확인했다.

## 검증 입력과 실행 환경

- HEAD/base: `cd3a4f3523df606a734f425e226a51c23f82477a` + 현재 미커밋 변경.
- 최종 관련 입력 SHA-256: `32505f6c1f1d1ebcd1af7b240eec0d38bddf642a801d6034cb532f4485336e6b`
  (2,272파일). Git의 tracked/nonignored 파일 중 존재하는 frontend/src·frontend/tests·
  tests/fixtures·hoga, frontend package/lock·TS/Vite/Vitest/Playwright·Tailwind/PostCSS
  설정, 루트 pyproject.toml·uv.lock·.python-version을 경로순으로 정렬하여
  `경로 + NUL + 내용 + NUL`로 해시했다. 문서·빌드 결과·검증 로그는 제외했다.
- 전체 단위·E2E·3종 타입 검사 시점 입력은
  `89707951cb2496af9f3cfb7427a03ab47803e0f9980ac3776e8b1384f7ea215c`다.
  이후 변경은 `remainingPerformance.test.tsx`의 가짜 query client에 `getQueryData`
  메서드 하나를 추가한 것뿐이다. 앱 소스·E2E·의존성·환경·설정은 동일하다.
- Node v24.13.1, npm 11.8.0, Python 3.14.7, Chrome 156.0.8078.47,
  Vitest 4.1.7. 의존성은 워크트리 전용이며 lockfile은 변경하지 않았다.
- E2E worker 1, 무자격, backend 20054/frontend 21054,
  `/tmp/hoga-e2e-data-54`·`/tmp/hoga-e2e-dist-54`. 사용자 서버 5173/8000은
  변경하지 않았다. 시세 API는 모의 응답이고 저장뷰 생성·재조회는 실제 격리 백엔드다.
- 이전 E2E 실패 원인은 고정 그룹 이름 충돌·저장뷰 칩 문구 단언·기존 그룹 선택기의
  폐기된 native select 조작·빈 saved-range 시세 픽스처였다. 각각 독립 이름·현행
  UI 선택·실제 봉 픽스처와 준비 상태 대기로 보완했다. 실패 결과는 통과로 재사용하지 않는다.

## 최종 검사

명령은 모두 `frontend/`에서 실행한다.

- `npm run typecheck`: 앱·단위·E2E 세 TypeScript 프로젝트 통과.
- `npx vitest run src/studyViews src/api/secondHistory.test.ts src/live/LiveChartRoot.test.tsx src/live/LiveChartRoot.drawingHover.test.tsx src/live/LiveChartRoot.paneToggles.test.tsx src/live/workspace/SecondChartWindow.viewport.test.tsx src/live/workspace/secondChartNavigation.test.ts src/live/workspace/secondsIndicatorSettings.test.tsx --maxWorkers=8`: 23파일·371테스트 통과.
- E2E 서버 준비의 `npx vite build`: 3,375모듈 빌드 통과. 기존 큰 청크 안내는 유지된다.
- `npx vitest run --maxWorkers=8`: 712파일·9,084테스트 실행. 711파일·9,083테스트가
  통과했고 성능 테스트 1건이 가짜 query client의 새 메서드 부재로 실패했다.
  테스트 대역만 보완한 후 `npx vitest run src/live/remainingPerformance.test.tsx src/api/secondHistory.test.ts`:
  2파일·9테스트 통과. 1만 봉에 대한 60회 tail 갱신에서 과거 배열 추가 읽기 0회와
  과거 2페이지의 체결량 보강·숨김 후 이력 보존 조건을 유지한다. 수정 영향 밖 711파일의
  통과 결과는 위 입력 비교에 따라 재사용한다. 전체 실행 자체를 전부 통과했다고 기록하지 않는다.
- 마지막 테스트 대역 변경 후 `npx tsc -p tsconfig.test.json --noEmit` 통과.
  앱·E2E 타입과 빌드는 입력이 같아 직전 통과 결과를 재사용한다.
- `npx playwright test tests/e2e/second-chart-navigation.spec.ts tests/e2e/second-chart-tools.spec.ts tests/e2e/second-candles.spec.ts tests/e2e/second-chart-updates.spec.ts tests/e2e/trade-scroll-navigation.spec.ts tests/e2e/trade-cursor-spot.spec.ts tests/e2e/study-view-groups.spec.ts --reporter=list`: **27건 통과**.
  분봉 버튼·실제 측정 속성 버튼·저장/딥링크·KRX 고정·관측 체결량·과거 480봉 보존·
  기존 도구/설정 분리·1만 봉 업데이트·1/5/10/30초 전환·체결창 커서/스크롤을 포함한다.
- 생성된 저장뷰·좁은 도구 모음 스크린샷도 확인했다. 차트 핸들은 창 id별로 읽는다.
  `/browse` 설치가 없어 별도 대화형 탐색은 하지 않았고 저장소 Playwright E2E로 검증했다.
- `git diff --check`: 통과. 격리 E2E 서버는 실행 종료 후 전용 포트가 비었음을 확인했다.
