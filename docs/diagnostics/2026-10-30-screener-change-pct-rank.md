# 당일 등락률 순위 검증 — 2026-10-30

HEAD 및 fetch한 origin/main: `31e3200e034ea4f89c38e741096dc47d6ee67044` (차이 0).
기존 당일 거래대금 순위 변경을 포함한 미커밋 작업 트리에서 확인했다.

입력 SHA-256: `2ebe26e588c198db3d6e72e9e23ba9dbc6ad8aa86cc15e9065f13e7439ef800a`.
상대경로 + NUL + 파일 바이트 + NUL을 정렬해 해시했다. hoga/, tests/(픽스처 포함),
frontend/src/, frontend/tests/와 pyproject·uv/npm lockfile·Ruff·Python 버전·Vite·
Playwright·TypeScript 설정을 포함한다. __pycache__/pyc는 제외했다.
환경: Python 3.14.7, Node v24.13.1, 기존 워크트리별 lockfile 설치.

## 최종 검사

- `uv run --extra dev ruff check .`: 통과.
- `uv run --extra dev pytest -q tests/api/test_screener_rankings.py tests/api/test_screener_scan.py tests/api/test_screener_series.py tests/api/test_screener_runner.py tests/api/test_screener_history.py tests/unit/live/test_ranking_pagination.py tests/unit/api/test_rest_wire_schema_contract.py --tb=short`: 159 통과. 기존 join_asof sortedness 경고 5건.
- REST wire 필드를 임시 불일치시켜 검사 실패를 확인한 뒤 원복했다. `uv run --extra dev pytest -q tests/unit/api/test_rest_wire_schema_contract.py --tb=short`: 12 재통과.
- frontend `npm run typecheck`: 앱·단위·E2E 프로젝트 모두 통과.
- frontend `npx vitest run src/screener/conditions/change_pct_rank.test.tsx src/screener/conditions/trade_value_rank.test.tsx src/screener/catalog.test.tsx src/screener/ResultTable.test.tsx src/screener/ScreenerDrawer.test.tsx src/pages/Screener.test.tsx src/screener/useScreenerMonitor.test.tsx src/screener/HistoryCollection.test.tsx`: 131 통과.
- frontend `npx playwright test tests/e2e/screener-trade-value-rank.spec.ts --reporter=line`: 공통 근거 컴포넌트 변경 후 통과(등락률 테스트와 함께 실행한 세션의 거래대금 1건).
- frontend `npx playwright test tests/e2e/screener-change-pct-rank.spec.ts --reporter=line`: 1 통과. 추가·정수 검증·200 저장·재진입·venue 전달·순위/등락률/시각 모달·Escape·좁은 화면·오류 안내 검증. 이 실행의 프로덕션 Vite 빌드도 통과.
- `git diff --check`: 통과.

## 검증 범위와 한계

기존·분리 계산 정책의 AND/OR, ETF 후처리 후 시장 순위 유지, 미참조 순위 무호출,
키움 API 종류별 최대 상한 공유, 두 종류 순위의 서로 다른 조회 시각 보존, HTTP 저장과
응답 직렬화, 결측·비유한 등락률 오류를 확인했다. 순위 단독 조회는 OHLCV overlay를
요청하지 않는다. 한 종목에서 거래대금·등락률 근거를 각각 열고 부호를 보존하는지 확인했다.

모의 ka10027 200행 페이지로 상위 200위는 1콜, 300위는 2콜을 각각 공용 거버너로
통과시켰다. sort_tp=1·통합 거래소 요청, 접미 코드 정규화·ETF/스코프 전 위치 보존을
확인했다. 실계정 호출과 토큰 발급은 하지 않았다. 실제 순위는 페이지 사이 변할 수 있다.
공식 근거: https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/국내주식/순위정보/get_domestic_prev_day_change_rate_top.py

E2E는 빈 자격증명과 워크트리 전용 포트 20383/21383·data/dist 경로를 사용했다.
검증 서버는 종료됐고 사용자 8000/5173 서버는 유지했다. 운영 반영은 수행하지 않았다.
