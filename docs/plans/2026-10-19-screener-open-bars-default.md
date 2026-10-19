# 스크리너 진행 중 봉 항상 포함

2026-10-19 사용자 요청: 진행 중 봉 포함을 기본으로 적용하고 선택 체크박스를 제거한다.
기준/head: `0d17d51b2db431c1a88d809b8e1a7ae8aaaf5a34`,
작업 브랜치: `codex/screener-open-bars-default`. 최종 fetch 시 main의 추가 변경은 없었다.

## 적용

- 주기별 9개 조건의 공통 캔들 편집기와 기간내 신고거래량 편집기에서 체크박스를 제거했다.
  기존 조회 시점 누적값 안내는 유지한다.
- 저장 조건 목록(페이지·드로어 공용), 저장본 로드, 로컬 초안 복원과 편집 진입에서
  `include_open_bar=false`를 true로 전환한다. 조건 ID·주기·숫자·날짜는 유지한다.
  서버 저장본은 명시적으로 저장할 때 true가 기록된다. 기존 일봉 과거 수집 경로는 유지한다.
- 이전 완료봉 전용 요청의 결과 스냅샷은 복원하지 않는다. API와 요청 키는 기존 false 지원을
  유지하므로 이전 결과를 새 요청의 근거로 오인하지 않는다.
- 과거 false 조건으로 제외한 발생 건에 true 조건의 조회 키도 연결한다. 저장 제외 ID와
  원래 조건·날짜·분봉 시각은 바꾸지 않으며 기존 ID로 복원하면 두 키 모두 해제된다.
  다른 주기·문턱으로 제외 범위를 넓히지 않는다.

진행 중 봉의 종가·이평·등락률은 장중에 충족/해제될 수 있다. 주·월 거래량은 해당 주·월의
조회 시점 누적값을 비교한다. KRX 정규장·코퍼스·REST 갱신 범위는 기존과 같다.

## 검증

- `npx vitest run src/screener src/state/screenerPanel.test.ts src/pages/Screener.test.tsx`:
  **39파일, 348 passed**. 9개 조건의 구 저장값 전환, 초안·앵커 복원, 결과 스냅샷 폐기를 포함한다.
- `npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- `E2E_DATA_DIR=/tmp/hoga-open-bars-e2e-data-332 npx playwright test screener trading-themes --reporter=line`:
  **19 passed**, 1.4분. 구 false 저장본을 시드한 9개 조건의 편집·저장·새로고침·조회와
  드로어의 구 저장본 조회, CSV 근거를 확인했다. 넓은 화면·768px 화면을 시각 확인했다.
  E2E 기동 단계의 최종 `vite build`도 통과했다(2.51초, 기존 청크 크기 안내).
- `uv run --extra dev pytest -q`로 다음 관련 파일 **271 passed**, 6개 경고:
  `test_screener_occurrence_exclusions.py`, `test_screener_bar_threshold.py`,
  `test_screener_bar_price.py`, `test_screener_bar_volume.py`, `test_screener_runner.py`,
  `test_screener_scan.py`, `test_screener_history.py`, `test_screener_history_trade_value.py`,
  `test_rest_wire_schema_contract.py`, `test_frontend_static.py`.
  이후 기존 HTTP 제외/복원 검사를 구 false 제외 조건에도 매개변수화한 최종
  `test_screener_occurrence_exclusions.py`: **20 passed**. 관련 결과와 후속 검증을 함께 사용한다.
- 최종 `uv run --extra dev ruff check .`: 위반 0건. `git diff --check` 통과.

실행 환경은 이전 단계와 동일하다(CPython 3.14.7, uv 0.11.8, Ruff 0.15.13,
Node 24.13.1, npm 11.8.0, Vite 8.0.16, Chrome 155.0.8059.84).
의존성·lockfile·검증 설정은 변경하지 않았다. E2E는 단일 워커와 빈 벤더 자격증명,
20332/21332 및 별도 데이터 경로를 사용했다. 종료 후 두 테스트 포트가 비어 있고
사용자 5173/8000 서버가 유지됨을 확인했다. 실제 장중 공급자 대조는 수행하지 않았다.

입력 지문은 이전 단계와 같은 경로순 `path + NUL + SHA256(content)` 연결 방식이다.
backend는 hoga·tests·Python/의존성/Ruff 설정, frontend는 frontend/의 추적·비무시 파일이다.

- backend 764파일: `9e26d89eaf19dcab753137c3614a9aa128ee3e19ced7dcb0e135312b2ec3d9ff`
- frontend 1,745파일: `5da4d2d1c896de71438b566a3531f3434b12d057abea40810ad663989d3774db`
