# 스크리너 갱신 안내 검증 — 2026-11-01 KST

기준/head: `66fa16870678186043436e4b888ac7700265d144` (origin/main fast-forward 반영), 그 위 작업 트리 변경.

## 변경 및 범위

- 서버 종료 시 취소 메시지 `server_shutdown`을 이벤트와 과거 복구 보고서에 보존한다.
- 기존 `cancelled` 기록은 원인을 소급 단정하지 않고 갱신 미완료·중단으로 표시한다.
- 페이지·드로어의 지난 결과에 원래 KST 날짜·시각을 표시한다.
- 서버 작업의 `automatic`을 상태 응답·시작 응답·진행 이벤트로 전달한다. 같은 작업에 합류한 클릭은 시작 경로를 바꾸지 않는다.
- 버튼 옆에 자동·수동 진행과 완료 후 갱신 가능 안내를 두고 접근성 설명으로 연결한다.

## 검증

- `uv run --extra dev ruff check .`: 통과.
- `uv run --extra dev pytest -q tests/api/test_screener_refresh.py tests/api/test_screener_update.py tests/unit/api/test_rest_wire_schema_contract.py -m 'not wallclock'`: 60 통과. 기존 Polars sortedness 경고 12개.
- `npm run typecheck`: 앱·단위·E2E TypeScript 검사 통과.
- `npx vitest run src/pages/Screener.test.tsx src/screener/useScreenerUpdateSync.test.tsx src/screener/ScreenerUpdateProgress.test.tsx src/screener/ScreenerUpdateFeedbackText.test.tsx`: 4파일 67 통과.
- `npx playwright test screener-refresh.spec.ts --reporter=line`: 3 통과. 이 실행의 Vite production build도 통과.
- `git diff --check`: 통과.

최초 백엔드 검사에서 새 `automatic` 필드·스케줄러 시작 경로에 대한 기존 기대값 2개가 실패했다. 실제 wire 결과와 스케줄러 시작 경로를 확인하는 기대값으로 갱신한 뒤 60개 전체 재검사 통과.

스크린샷을 직접 확인했다: [자동 갱신 진행](automatic-progress.png), [서버 종료 결과 및 시각](shutdown-result.png).
E2E는 재접속 뒤 자동 진행·버튼 비활성 사유, 진행 중 이전 결과 숨김, 종료 뒤 버튼 재활성화와 원래 결과 시각을 검증한다.

## 입력·환경

입력 지문은 정렬한 경로와 각 파일 SHA-256을 연결해 SHA-256으로 계산했다. 백엔드는 hoga·tests 전체와 Python 의존성·설정, 프런트는 src·tests 전체와 frontend 최상위 설정·lockfile을 포함한다.

- Backend SHA-256: `4690f9a8a06337c8748d0168bb0dadf73217fbb170872daaca755a5f49ea6c3e (880 files)`
- Frontend SHA-256: `7151cbc826fab127b1f263bcf7a6a72a56697f9031d32afc512d04a40d55bae9 (2102 files)`
- Python 3.14.7, uv 0.11.8, Node v24.13.1, npm 11.8.0.
- pytest 9.0.3, Ruff 0.15.13, Vitest 4.1.7, Vite 8.0.16.
- 워크트리 전용 `.venv`·`frontend/node_modules` 사용. 빈 `.env`로 메인 자격증명 상속 차단.
- E2E slot 367: backend 20367 / frontend 21367, data `/tmp/hoga-e2e-data-367`, dist `/tmp/hoga-e2e-dist-367`. 기존 Playwright 자격증명 차단 설정 유지.
- 실제 사용자 서버·앱은 재시작하거나 배포하지 않았다. 테스트 완료 뒤 E2E 포트 두 개가 비어 있음을 확인했다.
