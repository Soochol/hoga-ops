# 당일 거래대금 순위 검증 — 2026-10-30

기준 HEAD와 origin/main: `31e3200e034ea4f89c38e741096dc47d6ee67044`.
작업 트리의 미커밋 변경을 검증했다. 마지막 fetch에서 main과 차이 없음.

입력 SHA-256: `6174f2c7a1ab442d2a150ec37564e86f3b6f9cc520650d7c65c615800dd2ce7f`.
정렬한 상대경로 + NUL + 파일 바이트 + NUL을 이어 해시했다. 범위는 hoga/,
tests/(픽스처 포함), frontend/src/, frontend/tests/와 Python·npm lockfile,
pyproject·Ruff·Vite·Playwright·TypeScript 설정이다. __pycache__와 pyc는 제외했다.
환경은 Python 3.14.7, Node v24.13.1, lockfile의 워크트리별 설치다.

## 최종 확인

- `uv run --extra dev ruff check .`: 통과.
- `uv run --extra dev pytest -q tests/api/test_screener_rankings.py tests/unit/live/test_ranking_pagination.py tests/api/test_screener_history.py tests/api/test_screener_series.py --tb=short`: 79 통과. 기존 join_asof sortedness 경고 5건.
- `uv run --extra dev pytest -q tests/unit/api/test_rest_wire_schema_contract.py --tb=short`: 12 통과.
- wire 모델 필드를 임시 불일치시켜 drift 검사 실패를 확인하고 원복한 뒤 위 12건 재검증.
- frontend `npm run typecheck`: 앱·단위·E2E 3개 프로젝트 통과.
- frontend `npx vitest run src/screener/conditions/trade_value_rank.test.tsx src/screener/ResultTable.test.tsx src/screener/ScreenerDrawer.test.tsx src/pages/Screener.test.tsx`: 102 통과.
- 앞선 관련 프론트 범위 검사에서는 catalog·monitor·history·builder·API·occurrence를 포함해 151 통과. 최종 순위 근거 버튼의 변경 영향은 위 102건으로 재확인했다.
- frontend `npx playwright test tests/e2e/screener-trade-value-rank.spec.ts --reporter=line`: 1 통과. 해당 실행의 프로덕션 Vite 빌드도 통과.
- 앞선 기존 조건 편집 E2E 2건도 통과. 최종 순위 E2E는 추가·정수 검증·200 저장·재진입·요청 venue·순위/금액/시각 표시·Escape·좁은 화면·오류 문구를 검증한다.
- `git diff --check`: 통과.

## 동작과 검증 한계

200위는 모의 HTTP 응답의 1~100/101~200위 두 페이지를 공용 거버너로 각각
조회하는 통합 경로로 확인했다. ETF 후처리·원래 now_rank·AND/OR·미참조 조건
무호출·저장 HTTP 왕복·발생 제외·당일/신선도 검증·날짜 경계 캐시를 검증했다.
기존 계산과 가격/거래량 분리 계산을 모두 확인했다. 순위는 장중 페이지 사이 변할 수
있는 REST 관측이며 원자적 시점 순위를 보장하지 않는다.

실계정 API를 호출하거나 토큰을 발급하지 않았다. E2E는 빈 벤더 자격증명과
워크트리 전용 20383/21383 포트·data/dist 경로를 사용했다. 테스트 서버는 종료됐고
사용자 8000/5173 서버는 유지했다. 운영 배포·사용자 서버 재시작은 수행하지 않았다.
