# 전 대상 당일 분봉 검색 — 구현 검증

2026-11-01 KST. 최종 기준/base SHA: `d924692a7f3a3f58b352603746c2c5ee5dd5d5ae`. 이 기준 위 작업 트리 변경을 검증했다.
작업 중 main의 주말 공급자 순위 폴백 #2371을 fast-forward로 반영했다. DESIGN·드로어 충돌은 양쪽 안내를 유지해 해소하고 새 `RankEvaluation.historical`·평가 상한을 분봉 실행에도 반영했다.

## 구현 범위

- 거래일 당일·주말/휴장일 마지막 거래일 선택, 장전 당일 대기. 달력 미확인 평일을 추정하지 않는다.
- 하루치 첫 응답만 사용하며 이전 거래일을 비교 봉으로 보충하지 않는다. 봉 부족·범위 충돌은 보류한다.
- 조회 한 번으로 legacy/v2 모두 전체 대상을 64종목씩 처리한다. 같은 종목·주기의 조건들은 자료를 공유한다.
- 판정·발생 근거·정렬 상한/N+1·보조 메타데이터를 누적하고 체크포인트에서 재개한다. 원본 분봉 영구 캐시는 추가하지 않았다.
- 새 계산 정책에서 확실한 AND 탈락 후보만 사전 제외하고 OR 후보를 유지한다. 최종 충족·미충족·미확인을 구분한다.
- 장중 진행 봉은 실제 관측값과 관측 시각을 보존한다. 완료봉·저장/공급자 순위의 과거 상한과 구분한다.
- 초기 제외 목록 복원이 전 대상 결과를 제한된 조회로 덮어쓰지 않는다. 명시적인 제외·복원 재검색은 전체 실행을 사용한다.
- 중복 상세를 접힌 한 곳으로 합치고 결과 영역에 거래일·처리 수·판정·일치·보류/실패를 표시한다.
- 앞선 갱신 피드백 개선(서버 종료 사유·지난 결과 시각·버튼 비활성 안내)도 보존했다.

## 통과한 검사

- `uv run --extra dev ruff check .`: 통과.
- `uv run --extra dev pytest -q tests/api/test_screener*.py tests/unit/api/test_rest_wire_schema_contract.py tests/unit/live/test_ranking_session_history.py -m 'not wallclock'`: **1,560 통과**, 65.18초. 기존 Polars sortedness 경고 66개.
- `npm run typecheck`: 앱·단위·E2E 타입 검사 통과.
- `npx vitest run src/screener src/pages/Screener.test.tsx src/api/screenerRuns.test.ts src/api/screener.test.ts src/rightrail/RankingDrawer.test.tsx`: **60파일·612 통과**, 7.65초.
- `npx playwright test screener-full-minute-scan.spec.ts screener-refresh.spec.ts screener-automatic-preparation.spec.ts ranking-session.spec.ts --reporter=line`: 통합 실행에서 9 통과. 나머지 1개는 새 서버 실행 경로의 정상 보류 문구를 이전 `/scan`의 문구로 찾던 기대값을 갱신했다.
- `npx playwright test ranking-session.spec.ts --grep 'screener distinguishes' --reporter=line`: 수정한 1개 통과, 11.0초. 나머지 9개는 변경 없는 제품 코드·시나리오의 위 결과를 재사용한다.
- `npx playwright test screener-bar-volume.spec.ts --grep 'open-minute crossing' --reporter=line`: 범위 제한 실시간 감시 시나리오 1개 통과. 기존 인라인 입력 대신 현재 조건 카드 요약을 검사하도록 셀렉터를 갱신했다.
- 각 E2E의 Vite production build 통과. `git diff --check` 통과.

## 핵심 회귀 증거

130종목·같은 주기의 조건 2개·공용 캐시 1항목으로 강제 퇴거하는 모의 공급자 검사에서 legacy/v2 모두 130종목 판정 완료·130회 요청을 확인했다. 이전 날짜가 같은 응답에 있어도 발생 근거에 포함되지 않는다.
64종목 처리 후 중단·캐시 제거·새 실행 소유자 복구에서도 처음 64종목을 재조회하지 않고 총 130회 요청으로 완료했다.
장전 공급자 호출 0회, 당일 100봉 부족 시 이전 날짜 호출 0회와 판정 보류, AND/OR의 확정/보류 및 안전한 후보 제외, 실제 진행 봉 관측값 평가를 확인했다.
새 HTTP 응답의 `minute_date`·`bar_coverage.trading_date`를 실제 라우터 직렬화로 확인했다.

브라우저에서는 조회 한 번·새로고침 후 같은 작업 재연결·전체 종료·상세 사유·드로어 공유·제외 목록 복원 시 결과 유지와 기존 갱신 버튼 동작을 확인했다.
스크린샷을 직접 확인했다: [결과 화면](minute-complete-wide.png), [좁은 화면](minute-complete-narrow.png), [우측 패널](minute-drawer.png).

## 입력 지문과 환경

정렬한 경로와 파일 SHA-256을 연결해 SHA-256으로 계산했다. 백엔드는 hoga·tests 전체와 Python 의존성·설정, 프런트는 src·tests 전체와 frontend 최상위 설정·lockfile을 포함한다.

- Backend: `bbc941e9c804c896455c36f2ae12cccbb241e6c139f48993dbaf47137996f2b4` (882파일)
- Frontend: `1e2033b661196f64b5918c09a338dc80dd2e3cdb57f450c813ff937499ea798f` (2104파일)
- Python 3.14.7, uv 0.11.8, Node v24.13.1, npm 11.8.0.
- pytest 9.0.3, Ruff 0.15.13, Vitest 4.1.7, Vite 8.0.16.
- 워크트리 전용 `.venv`·`frontend/node_modules`, 빈 `.env`, Playwright의 기존 빈 벤더 자격증명 설정을 사용했다.
- E2E slot 367: backend 20367 / frontend 21367, data `/tmp/hoga-e2e-data-367`, dist `/tmp/hoga-e2e-dist-367`.

실자격증명 요청·구독 확대·운영 서버 재시작·앱 배포는 수행하지 않았다. 실제 공급자의 전 대상 완료 시간이나 일정 배수의 속도 개선은 아직 측정하지 않았다.
