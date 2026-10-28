# 토스 주문 평균가 차트 표시 검증

2026-10-28 사용자 승인에 따라 토스 계좌의 주문별 평균 체결가와 마지막 체결 시각을
일봉·분봉의 B/S 위치로 사용한다. 상세에는 **주문 평균가 기준**을 표시한다.

검증 기준 main: `084a33958d6541fc1e8fdfbcef7a636cdf64e559`.
최신 main의 독립 체결내역 창(#2309)과 영문 포함 Code 수정(#2310)을 fast-forward로 반영했다.
차트용 키움 조회 모듈을 `hoga/trading/chart_executions.py`로 분리해
기존 `hoga/trading/executions.py`와 두 API를 함께 유지했다. 검증에는 작업 트리의 변경을 포함한다.

## 검증 결과

PR 검토 시 최종 main이 같은 것을 다시 확인했고 변경 파일이 겹치는 열린 PR은 없었다.
토글 설명을 토스 평균가 표시에도 맞도록 정리했다. 표시 문구만 바뀌어 관련 설정·계좌 선택
단위 2개 파일 **7 passed**로 확인했다. 동작·타입·백엔드·의존성·테스트는 그대로이므로
나머지 기존 결과를 재사용한다. 최종 입력 지문은 아래 manifest에 갱신했다.

- `uv run --extra dev ruff check .`: 통과, 위반 0.
- 관련 백엔드 9개 파일: **152 passed**. 아래 명령을 최종 main 반영 후 실행했다.
- `cd frontend && npm run typecheck`: 앱·단위·E2E 세 프로젝트 통과.
- 관련 프런트 단위 60개 파일: **1,167 passed**.
- 차트 E2E: **3 passed** (일봉·1분봉·3분봉).
- 독립 내 체결내역 창 E2E: **2 passed**.
- 화면 보존·시각 확인용 3분봉 재실행: **1 passed**.
- `ExecutionBasis`를 일시적으로 잘못된 FE union으로 바꿔 계약 검사가 실패하는 것을 확인하고
  즉시 복원한 후 전체 wire 검사를 통과시켰다.
- `git diff --check`: 통과. 검증용 20224/21224 서버는 종료되었고 사용자 8000/5173 서버는 변경하지 않았다.

프런트 단위·최초 E2E는 main `65f6d7441e2cd1cb37bfb117fb0d03c45fa7362c`에서 실행했다.
이후 #2310은 독립 체결내역의 BE Code 필터·관련 BE 테스트만 변경했다.
프런트 소스·테스트·의존성·설정과 차트용 BE 입력은 같아 이 결과를 재사용하며,
영향받은 백엔드 9개 파일은 최종 main에서 재실행했다. 화면 확인용 차트 E2E도 최종 main에서 통과했다.

백엔드 명령:

```sh
uv run --extra dev pytest -q \
  tests/unit/api/test_account_executions.py \
  tests/unit/api/test_toss_account_executions.py \
  tests/unit/api/test_rest_wire_schema_contract.py \
  tests/unit/api/test_broker_trading.py \
  tests/unit/api/test_toss_trading.py \
  tests/unit/api/test_toss_rate_limits.py \
  tests/unit/api/test_trading_v2_wire.py \
  tests/unit/api/test_execution_history.py \
  tests/unit/live/test_kiwoom_trading_design_evidence.py -m 'not wallclock'
```

프런트 명령(working directory `frontend/`):

```sh
npm run typecheck
npx vitest run src/api/accountExecutions.test.tsx \
  src/chart/projectors/accountExecutions.test.ts src/chart/AccountExecutionsPrimitive.test.ts \
  src/live/workspace/ChartTradeAccountControl.test.tsx src/live/LiveChartRoot.test.tsx \
  src/api/executionHistory.test.tsx src/api/trading.test.tsx src/state \
  src/live/workspace/ChartWindowSettings.test.tsx src/live/workspace/ChartWindow.test.tsx \
  src/live/settings/SettingsSections.test.tsx src/live/workspace/ExecutionHistoryWindow.test.tsx \
  src/live/workspace/OrderWindow.test.tsx
npx playwright test account-executions.spec.ts --reporter=line
npx playwright test live-orders.spec.ts --grep '내 체결내역' --reporter=line
npx playwright test account-executions.spec.ts --grep '3m:' --reporter=line
```

화면 확보 재실행 중 `--grep '^3m:'`는 Playwright의 전체 테스트 이름과 맞지 않아
`No tests found`로 종료되었다. 제품 테스트 실패가 아니며 `--grep '3m:'`로 고친 실행이 통과했다.

## 확인한 동작

- OPEN 부분 체결과 CLOSED 체결·일부 체결 후 취소를 함께 조회하고 체결 수량 0은 제외한다.
- 이전 날짜에 주문한 건도 마지막 체결일에 포함하며, 접수 시각·주문 가격으로 체결 정보를 대체하지 않는다.
- 같은 주문의 ID를 유지해 누적 수량·평균가·마지막 시각을 갱신하고 페이지 간 오래된 요약이 덮어쓰지 않는다.
- 소수점 평균가를 반올림하지 않고 가격 좌표에 사용하며, 과거 일봉은 차트와 같은 거래소의
  원주가 종가로 좌표만 보정한다. 상세에는 원래 평균가·누적 수량·마지막 KST 시각을 표시한다.
- Canvas B/S 좌표를 기대 시간축·가격축 좌표와 대조하고 토스 상세의 기준·열 이름·수량을 확인했다.
- 계좌 변경·OFF의 마커/상세 제거와 재접속 계좌 복원을 유지했다.
- 개별 체결·주문 요약은 `basis=execution|order_average`로 wire에서 구분한다.
  토스의 변하는 요약은 개별 체결 SQLite 보존소에 저장하지 않는다.
- 영문 포함 Code 수정이 반영된 독립 체결내역 API 및 기존 주문 관련 검사를 함께 통과했다.

실제 앱의 가짜 계좌 화면을 시각 확인했다: [토스 3분봉과 상세](toss-order-averages-3m.png).
B/S 모양·평균가 상세·계좌 선택이 보이며 별도 화살표·연결선·건수 라벨을 추가하지 않았다.

## 입력과 실행 범위

[입력 지문](toss-chart-input-manifest.json): 소스·테스트·픽스처·설정·lockfile
2,835개 파일, SHA256 `6cb955b27edf23fbccabea74048f54570d6fdc195c1daf635d206f4332aa8b05`.
Python 3.14.7, uv 0.11.8, Node 24.13.1, npm 11.8.0, TypeScript 6.0.3,
Vitest 4.1.7, Playwright 1.60.0, Vite 8.0.16, Linux 시스템 Chrome.
워크트리의 기존 빈 `.env`와 E2E의 빈 벤더 환경변수를 유지했다.
슬롯 224, 데이터 `/tmp/hoga-e2e-data-224`, dist `/tmp/hoga-e2e-dist-224`를 사용했다.

모든 증권사 응답은 가짜 HTTP/WS 응답이다. 실계좌 조회·주문 전송·운영 배포는 하지 않았다.
공식 API에서 조회되지 않는 주문 유형이나 개별 분할 체결의 복원을 보장하지 않는다.
과거 일봉의 원주가 기준을 확인할 수 없으면 기존 미표시 내역 안내로 남기며 잘못된 배율을 추정하지 않는다.

공식 근거: [REST 1.2.24](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json),
[주문·체결 FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md).
